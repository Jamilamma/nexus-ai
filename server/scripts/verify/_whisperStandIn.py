"""
TEST INFRASTRUCTURE ONLY. Runs the REAL stt-service/app.py (HTTP layer, PCM decoding, language resolution,
prompting, filtering) with a stand-in for the Whisper model that does NOT recognise speech: it measures the
test tone it receives and answers with a scripted sentence. Used by whisperMeeting.e2e.verify.ts.
"""
import json, os, sys, types
import numpy as np

os.environ["WHISPER_PRELOAD"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "stt-service"))
import app as svc  # noqa: E402
import uvicorn  # noqa: E402

LOG = os.environ["STANDIN_LOG"]
SCRIPTS = {
    "en": [("Let's review the launch plan for the Q3 release.", -0.2), ("I will send the updated budget to finance by Friday.", -0.2)],
    "ta": [("நாளைக்கு மீட்டிங் இருக்கு, API ரெடி ஆயிடுச்சா?", -0.25), ("naalaiku deployment pannalam, client ku mail anuppiten.", -0.9)],
}
counters = {"en": 0, "ta": 0}


def tone_freq(audio):
    voiced = np.abs(audio) > 0.01
    n = int(voiced.sum())
    if n < 800:
        return 0.0
    a = audio[voiced]
    zc = int(((a[1:] >= 0) != (a[:-1] >= 0)).sum())
    return zc / 2 / (n / 16000)


class Fake:
    def detect_language(self, audio, vad_filter=False, **kw):
        lang = "ta" if tone_freq(audio) > 450 else "en"
        probs = [(lang, 0.9), ("ml" if lang == "ta" else "de", 0.07), ("hi", 0.02), ("ar", 0.01)]
        return probs[0][0], probs[0][1], probs

    def transcribe(self, audio, **kw):
        lang = kw["language"]
        with open(LOG, "a") as f:
            f.write(json.dumps({"language": lang, "initial_prompt": kw.get("initial_prompt"), "hotwords": kw.get("hotwords"), "beam_size": kw["beam_size"], "seconds": round(len(audio) / 16000, 2)}, ensure_ascii=False) + "\n")
        key = "ta" if lang == "ta" else "en"
        text, lp = SCRIPTS[key][counters[key] % len(SCRIPTS[key])]
        counters[key] += 1
        dur = len(audio) / 16000
        seg = types.SimpleNamespace(start=0.3, end=max(0.4, dur - 0.3), text=text, avg_logprob=lp, no_speech_prob=0.01, compression_ratio=1.3)
        return iter([seg]), types.SimpleNamespace()


# The test audio is pure tones, which the service's real speech pre-check (correctly) rejects as non-speech.
svc.has_speech = lambda audio: True
svc.holder.model, svc.holder.device, svc.holder.compute_type = Fake(), "cpu", "int8"
uvicorn.run(svc.app, host="127.0.0.1", port=int(os.environ.get("PORT", "9101")), log_level="warning")
