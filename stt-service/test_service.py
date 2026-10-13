"""
Offline tests for app.py using a stand-in model (no weights/GPU needed):  python test_service.py
They verify request handling, language resolution, prompts, filtering and queueing -- NOT recognition
accuracy (that needs the real model: see eval_accuracy.py).
"""
import asyncio
import os
import sys
import types

os.environ["WHISPER_PRELOAD"] = "false"
os.environ["WHISPER_LANGUAGES"] = "en,ta,hi,ar"
import numpy as np
from fastapi.testclient import TestClient

import app as svc

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def seg(text, start=0.0, end=1.0, lp=-0.3, ns=0.01):
    return types.SimpleNamespace(start=start, end=end, text=text, avg_logprob=lp, no_speech_prob=ns, compression_ratio=1.2)


class FakeModel:
    def __init__(self):
        self.calls = []
        self.detect_probs = [("ml", 0.45), ("ta", 0.40), ("en", 0.10), ("hi", 0.03), ("ar", 0.02)]
        self.next_segments = [seg("hello team", 0.2, 1.4)]

    def detect_language(self, audio, vad_filter=False, **kw):
        self.calls.append(("detect", len(audio)))
        return self.detect_probs[0][0], self.detect_probs[0][1], self.detect_probs

    def transcribe(self, audio, **kw):
        self.calls.append(("transcribe", kw))
        return iter(self.next_segments), types.SimpleNamespace()


def pcm(seconds, amp=8000):
    t = np.arange(int(16000 * seconds)) / 16000
    return (np.sin(2 * np.pi * 220 * t) * amp).astype("<i2").tobytes()


fake = FakeModel()
_real_has_speech = svc.has_speech
svc.has_speech = lambda audio: True  # the stand-in audio is a pure tone, which a real VAD (rightly) does not call speech
svc.holder.model, svc.holder.device, svc.holder.compute_type = fake, "cpu", "int8"
client = TestClient(svc.app)

print("health / loading")
check("health ok when model loaded", client.get("/health").json()["status"] == "ok")
svc.holder.model = None
r = client.post("/transcribe", content=pcm(1))
check("503 + Retry-After while the model is loading", r.status_code == 503 and r.headers.get("retry-after") == "5")
svc.holder.model = fake

print("language handling")
r = client.post("/transcribe?language=ta", content=pcm(2)).json()
kw = fake.calls[-1][1]
check("manual language is forced (no detection call)", r["language_source"] == "forced" and r["language"] == "ta" and kw["language"] == "ta" and not any(c[0] == "detect" for c in fake.calls[-2:-1]))
check("never translates, never conditions on previous text", kw["task"] == "transcribe" and kw["condition_on_previous_text"] is False)
fake.calls.clear()
r = client.post("/transcribe?candidates=en,ta,hi,ar", content=pcm(2)).json()
check("detection is restricted to candidates (ml ignored, ta beats en)", r["language"] == "ta" and r["language_source"] == "candidates", r)
r = client.post("/transcribe", content=pcm(2)).json()
check("no query = server default candidates", r["language"] == "ta", r)
fake.calls.clear()
r = client.post("/transcribe?fallback_language=hi", content=pcm(0.6)).json()
check("clip < 1.2 s inherits fallback_language without detecting", r["language"] == "hi" and r["language_source"] == "fallback" and not any(c[0] == "detect" for c in fake.calls))
r = client.post("/transcribe?fallback_language=hi", content=pcm(3)).json()
check("longer clip is detected normally even with a fallback", r["language_source"] == "candidates")

print("prompt / hotwords")
client.post("/transcribe?language=ta&code_switch=true&terms=Jam|Priya", content=pcm(2))
kw = fake.calls[-1][1]
check("code-switch prompt keeps English words in Latin script", "meeting" in kw["initial_prompt"] and kw["hotwords"] == "Jam, Priya", kw)
client.post("/transcribe?language=ta", content=pcm(2))
check("plain Tamil prompt is native script only", "meeting" not in fake.calls[-1][1]["initial_prompt"])
client.post("/transcribe?language=en", content=pcm(2))
check("English gets no prompt", fake.calls[-1][1]["initial_prompt"] is None)

print("filters")
fake.next_segments = [seg("Thanks for watching!", 0, 1, lp=-1.2, ns=0.5), seg("Thank you.", 2, 3, lp=-0.2, ns=0.01)]
r = client.post("/transcribe?language=en", content=pcm(4)).json()
check("hallucinated sign-off on near-silence is dropped, a real 'Thank you.' is kept", [s["text"] for s in r["segments"]] == ["Thank you."], r["segments"])
fake.next_segments = [seg("so " * 30)]
r = client.post("/transcribe?language=en", content=pcm(4)).json()
check("runaway repetition is collapsed", r["segments"][0]["text"] == "so" and r["segments"][0].get("repetition_trimmed"), r["segments"])
fake.next_segments = [seg("no no no no", 0, 1)]
r = client.post("/transcribe?language=en", content=pcm(4)).json()
check("a real 4x 'no' is NOT collapsed", r["segments"][0]["text"] == "no no no no")
fake.next_segments = [seg(svc.SCRIPT_PROMPTS["ta"], 0, 1)]
r = client.post("/transcribe?language=ta", content=pcm(4)).json()
check("echo of the priming prompt is dropped", r["segments"] == [])
fake.next_segments = [seg("...", 0, 1), seg("   ", 1, 2), seg("வணக்கம் team", 2, 3)]
r = client.post("/transcribe?language=ta", content=pcm(4)).json()
check("punctuation-only / empty segments dropped; Tamil+English text preserved verbatim", [s["text"] for s in r["segments"]] == ["வணக்கம் team"])
fake.next_segments = [seg("hello team", 0.2, 1.4)]

print("speech pre-check")
svc.has_speech = _real_has_speech
fake.calls.clear()
silent = (np.zeros(16000 * 3, dtype="<i2")).tobytes()
r = client.post("/transcribe?language=ta", content=silent).json()
check("silence is skipped without detection or decoding", r.get("no_speech") is True and r["segments"] == [] and fake.calls == [], r)
check("timings are reported", "timings_ms" in r)
svc.has_speech = lambda audio: True
r = client.post("/transcribe?language=ta", content=pcm(2)).json()
check("normal clips report per-stage timings", set(r["timings_ms"]) == {"vad", "detect", "transcribe"}, r.get("timings_ms"))

print("limits, auth, queue")
check("too-long body -> 413", client.post("/transcribe", content=pcm(61)).status_code == 413)
check("tiny body -> empty result, no model call", client.post("/transcribe", content=b"\0\0" * 100).json()["segments"] == [])
svc.API_TOKEN = "s3cret"
check("missing token -> 401", client.post("/transcribe", content=pcm(1)).status_code == 401)
check("right token -> 200", client.post("/transcribe", content=pcm(1), headers={"Authorization": "Bearer s3cret"}).status_code == 200)
svc.API_TOKEN = ""


async def busy_partial():
    sem = svc._semaphore()
    await sem.acquire()
    try:
        audio = np.zeros(16000, dtype=np.float32)
        return await svc._run(audio, svc.Params(language="en", partial=True))
    finally:
        sem.release()


check("partial request is skipped (not queued) while a final is running", asyncio.run(busy_partial()).get("skipped") is True)
svc._slots = None  # semaphore belongs to the loop that created it
svc._waiting = svc.MAX_QUEUE
check("full queue -> 503 instead of unbounded memory", client.post("/transcribe", content=pcm(1)).status_code == 503)
svc._waiting = 0

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
