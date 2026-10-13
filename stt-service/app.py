"""
NEXUS AI - self-hosted speech-to-text service (faster-whisper, Whisper large-v3).

A small HTTP service that the NEXUS Node server calls. It never leaves your machine/network:
no audio is sent to any third party and no API key is needed (the model weights are downloaded
once from the Hugging Face hub on first start, then cached on disk).

Endpoints
  GET  /health            model / device / queue status
  POST /transcribe        body = raw PCM16 little-endian, 16 kHz, mono (one utterance, <= 60 s)
                          query: language, candidates, fallback_language, code_switch, terms, partial
  POST /transcribe-file   multipart upload of an audio/video file (recorded meetings)

Accuracy notes (honest):
  * Whisper decides ONE language per audio window. Code-switching inside one sentence (Tamil+English,
    Hindi+English) is handled with a prompt that biases the output, not "solved".
  * Language detection on very short clips (< ~1.2 s) is unreliable, so such clips inherit the
    language the caller last saw for that speaker (`fallback_language`).
  * Whisper can hallucinate on silence/noise. Silero VAD + no-speech / log-prob / repetition filters are
    applied here, but they reduce, not eliminate, the problem.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import tempfile
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse

log = logging.getLogger("nexus-stt")
logging.basicConfig(level=os.environ.get("WHISPER_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

SAMPLE_RATE = 16000


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v.strip() == "" else v.strip()


MODEL_NAME = _env("WHISPER_MODEL", "large-v3")
DEVICE = _env("WHISPER_DEVICE", "auto")  # auto | cuda | cpu
COMPUTE_TYPE = _env("WHISPER_COMPUTE_TYPE", "auto")  # auto | float16 | int8_float16 | int8 | float32
DEVICE_INDEX = int(_env("WHISPER_DEVICE_INDEX", "0"))
CPU_THREADS = int(_env("WHISPER_CPU_THREADS", "0"))  # 0 = library default
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR") or None
BEAM_SIZE = int(_env("WHISPER_BEAM_SIZE", "5"))
BEST_OF = int(_env("WHISPER_BEST_OF", "5"))
CONCURRENCY = max(1, int(_env("WHISPER_CONCURRENCY", "1")))  # simultaneous inferences on this GPU/CPU
MAX_QUEUE = max(1, int(_env("WHISPER_MAX_QUEUE", "16")))  # requests allowed to wait before answering 503
API_TOKEN = os.environ.get("WHISPER_API_TOKEN", "").strip()
VAD_THRESHOLD = float(_env("WHISPER_VAD_THRESHOLD", "0.45"))
# Languages the auto-detector may choose from when the caller does not pass `candidates`.
# Restricting the choice (e.g. Tamil vs Malayalam/Telugu confusion) is the single biggest accuracy lever
# for a known audience. Empty string = let Whisper pick from all ~99 languages.
DEFAULT_CANDIDATES = [c for c in (x.strip().lower() for x in _env("WHISPER_LANGUAGES", "en,ta,hi,ar").split(",")) if c]
SHORT_AUDIO_S = float(_env("WHISPER_SHORT_AUDIO_S", "1.2"))
MAX_AUDIO_S = 60.0
TEMPERATURES = [0.0, 0.2, 0.4]

# Short prompts in the native script keep Whisper writing Tamil in Tamil script, Hindi in Devanagari,
# Arabic in Arabic script (without a prompt it sometimes transliterates or translates to English).
SCRIPT_PROMPTS = {
    "ta": "இது தமிழில் நடக்கும் கூட்ட உரையாடல்.",
    "hi": "यह हिंदी में हो रही बैठक की बातचीत है।",
    "ar": "هذه محادثة اجتماع باللغة العربية.",
}
# Code-switching prompts: native script with English words left in Latin script, which nudges the
# decoder to keep English terms in English instead of transliterating them.
CODE_SWITCH_PROMPTS = {
    "ta": "இன்னைக்கு meeting-ல project status பத்தி discuss பண்ணலாம்.",
    "hi": "आज की meeting में हम project status को discuss करेंगे।",
    "ar": "في اجتماع اليوم سنناقش project status مع الفريق.",
}

HALLUCINATION_RE = re.compile(
    r"(thanks? for watching|thank you for watching|please subscribe|like and subscribe|subtitles? by|"
    r"amara\.org|www\.\w+\.\w+|ترجمة\s+\S+|اشتركوا|للمزيد من الفيديوهات|சந்தா|उपशीर्षक)",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------------------------
class Holder:
    model: Any = None
    device: str = "unloaded"
    compute_type: str = "unloaded"
    load_seconds: float = 0.0
    lock = threading.Lock()


holder = Holder()


def resolve_device_and_compute() -> tuple[str, str]:
    device = DEVICE
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"
    compute = COMPUTE_TYPE
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    return device, compute


def load_model() -> None:
    with holder.lock:
        if holder.model is not None:
            return
        from faster_whisper import WhisperModel

        device, compute = resolve_device_and_compute()
        log.info("Loading %s on %s (%s) ... first start downloads the weights (~3 GB)", MODEL_NAME, device, compute)
        t0 = time.perf_counter()
        kwargs: dict[str, Any] = dict(device=device, compute_type=compute, num_workers=CONCURRENCY, download_root=MODEL_DIR)
        if device == "cuda":
            kwargs["device_index"] = DEVICE_INDEX
        if CPU_THREADS > 0:
            kwargs["cpu_threads"] = CPU_THREADS
        holder.model = WhisperModel(MODEL_NAME, **kwargs)
        holder.device, holder.compute_type = device, compute
        holder.load_seconds = time.perf_counter() - t0
        log.info("Model ready in %.1fs", holder.load_seconds)


# --------------------------------------------------------------------------------------------
# Request parameters, language resolution, prompt
# --------------------------------------------------------------------------------------------
@dataclass
class Params:
    language: Optional[str] = None  # forced language (manual selector); None = detect
    candidates: list[str] = field(default_factory=list)  # detect only among these
    fallback_language: Optional[str] = None  # used for very short clips
    code_switch: bool = False
    terms: list[str] = field(default_factory=list)  # names / domain words (hotwords)
    partial: bool = False  # cheap interim decode


def parse_codes(value: Optional[str]) -> list[str]:
    return [c for c in (x.strip().lower() for x in (value or "").split(",")) if re.fullmatch(r"[a-z]{2,3}", c)]


def parse_terms(value: Optional[str]) -> list[str]:
    out = []
    for t in (value or "").split("|"):
        t = re.sub(r"\s+", " ", t).strip()[:40]
        if t and t not in out:
            out.append(t)
    return out[:20]


def resolve_language(model: Any, audio: np.ndarray, p: Params) -> tuple[str, float, str]:
    """Returns (language, probability, source). source: forced | fallback | candidates | detected."""
    if p.language:
        return p.language, 1.0, "forced"
    duration = len(audio) / SAMPLE_RATE
    candidates = p.candidates or DEFAULT_CANDIDATES
    if duration < SHORT_AUDIO_S and p.fallback_language:
        return p.fallback_language, 0.0, "fallback"
    try:
        lang, prob, all_probs = model.detect_language(audio, vad_filter=True)
        probs = {k: float(v) for k, v in all_probs}
    except Exception as exc:  # noqa: BLE001  (e.g. VAD found no speech)
        log.debug("language detection failed: %s", exc)
        return (p.fallback_language or (candidates[0] if candidates else "en")), 0.0, "fallback"
    if candidates:
        best = max(candidates, key=lambda c: probs.get(c, 0.0))
        mass = sum(probs.get(c, 0.0) for c in candidates)
        share = (probs.get(best, 0.0) / mass) if mass > 0 else 0.0
        return best, share, "candidates"
    return lang, float(prob), "detected"


def build_prompt(lang: str, p: Params) -> str:
    base = ""
    if lang in SCRIPT_PROMPTS:
        base = CODE_SWITCH_PROMPTS[lang] if p.code_switch else SCRIPT_PROMPTS[lang]
    return base[:300]


# --------------------------------------------------------------------------------------------
# Output cleaning (hallucination / repetition guards)
# --------------------------------------------------------------------------------------------
def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", " ", text.lower()).strip()


def compression_ratio(text: str) -> float:
    b = text.encode("utf-8")
    return len(b) / max(1, len(zlib.compress(b)))


def collapse_repetition(text: str) -> tuple[str, bool]:
    """Collapses a word/phrase looped many times ("so so so so ...") to a single occurrence."""
    words = text.split()
    changed = False
    for n in range(1, 7):
        min_repeats = 6 if n == 1 else 4
        i = 0
        out: list[str] = []
        while i < len(words):
            unit = words[i : i + n]
            reps = 1
            while len(unit) == n and words[i + reps * n : i + (reps + 1) * n] == unit:
                reps += 1
            if len(unit) == n and reps >= min_repeats:
                out.extend(unit)
                i += reps * n
                changed = True
            else:
                out.append(words[i])
                i += 1
        words = out
    return " ".join(words), changed


def clean_segments(raw: list[dict[str, Any]], prompt: str, partial: bool) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    prompt_norm = _norm(prompt)
    for s in raw:
        text = (s["text"] or "").strip()
        if not re.search(r"[\w\u0900-\u097F\u0B80-\u0BFF\u0600-\u06FF]", text):
            continue
        no_speech = s.get("no_speech_prob") or 0.0
        logprob = s.get("avg_logprob") if s.get("avg_logprob") is not None else 0.0
        if no_speech > 0.6 and logprob < -1.0:
            continue  # Whisper itself says: probably not speech
        if prompt_norm and _norm(text) == prompt_norm:
            continue  # the model echoed the priming prompt
        if HALLUCINATION_RE.search(text) and (no_speech > 0.3 or logprob < -0.9):
            continue  # classic training-data hallucination on near-silence
        text, trimmed = collapse_repetition(text)
        if len(text.encode("utf-8")) >= 60 and compression_ratio(text) > 3.5:
            continue  # still degenerate after collapsing
        s = dict(s, text=text)
        if trimmed:
            s["repetition_trimmed"] = True
        kept.append(s)
    return kept


def has_speech(audio: np.ndarray) -> bool:
    """Cheap Silero-VAD pre-check (milliseconds). Noise-only clips skip language detection AND decoding."""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        opts = VadOptions(threshold=VAD_THRESHOLD, min_silence_duration_ms=500, speech_pad_ms=200)
        return len(get_speech_timestamps(audio, opts)) > 0
    except Exception as exc:  # noqa: BLE001  (VAD unavailable: let the normal path decide)
        log.debug("VAD pre-check failed: %s", exc)
        return True


# --------------------------------------------------------------------------------------------
# Inference (runs in a worker thread)
# --------------------------------------------------------------------------------------------
def transcribe_array(audio: np.ndarray, p: Params, *, file_mode: bool = False) -> dict[str, Any]:
    model = holder.model
    if model is None:
        raise RuntimeError("model not loaded")
    t0 = time.perf_counter()
    audio_s = len(audio) / SAMPLE_RATE
    if not file_mode and not has_speech(audio):
        vad_ms = int((time.perf_counter() - t0) * 1000)
        log.info("stt audio=%.1fs NO SPEECH (vad %d ms) -> skipped, nothing decoded", audio_s, vad_ms)
        return {
            "language": p.language or p.fallback_language or "",
            "language_probability": 0.0,
            "language_source": "none",
            "duration": round(audio_s, 3),
            "segments": [],
            "no_speech": True,
            "model": MODEL_NAME,
            "processing_ms": vad_ms,
            "timings_ms": {"vad": vad_ms, "detect": 0, "transcribe": 0},
        }
    t_vad = time.perf_counter()
    lang, lang_prob, lang_source = resolve_language(model, audio, p)
    t_detect = time.perf_counter()
    prompt = build_prompt(lang, p)
    kwargs: dict[str, Any] = dict(
        language=lang,
        task="transcribe",  # never translate: the original speech is what we store
        beam_size=1 if p.partial else BEAM_SIZE,
        best_of=1 if p.partial else BEST_OF,
        temperature=0.0 if p.partial else TEMPERATURES,
        condition_on_previous_text=False,  # the main cause of runaway repetition loops
        initial_prompt=prompt or None,
        hotwords=", ".join(p.terms) if p.terms else None,
        vad_filter=True,
        vad_parameters=dict(threshold=VAD_THRESHOLD, min_silence_duration_ms=500, speech_pad_ms=200),
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )
    segments_iter, _info = model.transcribe(audio, **kwargs)
    raw = [
        {
            "start": round(float(s.start), 3),
            "end": round(float(s.end), 3),
            "text": s.text,
            "avg_logprob": float(s.avg_logprob),
            "no_speech_prob": float(s.no_speech_prob),
            "compression_ratio": float(s.compression_ratio),
        }
        for s in segments_iter
    ]
    segments = clean_segments(raw, prompt, p.partial)
    t_end = time.perf_counter()
    timings = {
        "vad": int((t_vad - t0) * 1000),
        "detect": int((t_detect - t_vad) * 1000),
        "transcribe": int((t_end - t_detect) * 1000),
    }
    log.info(
        "stt audio=%.1fs lang=%s(%s) vad=%dms detect=%dms decode=%dms total=%dms segments=%d%s",
        audio_s, lang, lang_source, timings["vad"], timings["detect"], timings["transcribe"],
        int((t_end - t0) * 1000), len(segments), " [partial]" if p.partial else "",
    )
    return {
        "language": lang,
        "language_probability": round(lang_prob, 4),
        "language_source": lang_source,
        "duration": round(len(audio) / SAMPLE_RATE, 3),
        "segments": segments,
        "model": MODEL_NAME,
        "processing_ms": int((t_end - t0) * 1000),
        "timings_ms": timings,
    }


# --------------------------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------------------------

_executor = ThreadPoolExecutor(max_workers=CONCURRENCY, thread_name_prefix="whisper")
_slots: Optional[asyncio.Semaphore] = None
_waiting = 0


def _semaphore() -> asyncio.Semaphore:
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(CONCURRENCY)
    return _slots


def check_auth(authorization: Optional[str]) -> None:
    if API_TOKEN and not hmac.compare_digest(authorization or "", f"Bearer {API_TOKEN}"):
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    if os.environ.get("WHISPER_PRELOAD", "true").lower() != "false":
        await asyncio.get_running_loop().run_in_executor(None, load_model)
    yield


app = FastAPI(title="NEXUS AI STT (faster-whisper)", version="1.0.0", lifespan=_lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok" if holder.model is not None else "loading",
        "model": MODEL_NAME,
        "device": holder.device,
        "compute_type": holder.compute_type,
        "concurrency": CONCURRENCY,
        "beam_size": BEAM_SIZE,
        "cpu_threads": CPU_THREADS or "default",
        "vad_threshold": VAD_THRESHOLD,
        "languages": DEFAULT_CANDIDATES,
        "waiting": _waiting,
    }


async def _run(audio: np.ndarray, p: Params, *, file_mode: bool = False) -> dict[str, Any]:
    global _waiting
    if holder.model is None:
        raise HTTPException(status_code=503, detail="model is still loading", headers={"Retry-After": "5"})
    sem = _semaphore()
    if p.partial and sem.locked():
        return {"skipped": True, "reason": "busy"}  # interim text must never delay a final transcript
    if _waiting >= MAX_QUEUE:
        raise HTTPException(status_code=503, detail="transcription queue is full", headers={"Retry-After": "2"})
    _waiting += 1
    try:
        async with sem:
            return await asyncio.get_running_loop().run_in_executor(_executor, lambda: transcribe_array(audio, p, file_mode=file_mode))
    finally:
        _waiting -= 1


@app.post("/transcribe")
async def transcribe(
    request: Request,
    language: Optional[str] = Query(None),
    candidates: Optional[str] = Query(None),
    fallback_language: Optional[str] = Query(None),
    code_switch: bool = Query(False),
    terms: Optional[str] = Query(None),
    partial: bool = Query(False),
    authorization: Optional[str] = Header(None),
) -> JSONResponse:
    check_auth(authorization)
    body = await request.body()
    if len(body) % 2:
        body = body[:-1]
    if len(body) > int(MAX_AUDIO_S * SAMPLE_RATE * 2):
        raise HTTPException(status_code=413, detail=f"audio longer than {MAX_AUDIO_S:.0f}s; send one utterance per request")
    audio = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
    if len(audio) < int(0.1 * SAMPLE_RATE):
        return JSONResponse({"language": language or "", "segments": [], "duration": len(audio) / SAMPLE_RATE})
    forced = parse_codes(language)
    p = Params(
        language=forced[0] if forced else None,
        candidates=parse_codes(candidates),
        fallback_language=(parse_codes(fallback_language) or [None])[0],
        code_switch=code_switch,
        terms=parse_terms(terms),
        partial=partial,
    )
    return JSONResponse(await _run(audio, p))


@app.post("/transcribe-file")
async def transcribe_file(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    candidates: Optional[str] = Form(None),
    authorization: Optional[str] = Header(None),
) -> JSONResponse:
    """Recorded meetings. Single language per file; NO speaker diarization (Whisper does not do it)."""
    check_auth(authorization)
    suffix = os.path.splitext(file.filename or "")[1][:10] or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        while chunk := await file.read(1024 * 1024):
            tmp.write(chunk)
        path = tmp.name
    try:
        from faster_whisper.audio import decode_audio

        audio = await asyncio.get_running_loop().run_in_executor(None, lambda: decode_audio(path, sampling_rate=SAMPLE_RATE))
        forced = parse_codes(language)
        p = Params(language=forced[0] if forced else None, candidates=parse_codes(candidates), code_switch=True)
        return JSONResponse(await _run(np.asarray(audio, dtype=np.float32), p, file_mode=True))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"could not decode/transcribe file: {exc}") from exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=_env("WHISPER_HOST", "127.0.0.1"), port=int(_env("WHISPER_PORT", "9000")), log_level="info")
