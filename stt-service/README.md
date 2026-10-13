# NEXUS AI – self-hosted speech-to-text (faster-whisper, Whisper large-v3)

Free, no API key, audio never leaves your machine. The Node server (`server/`) cuts each LiveKit participant's
microphone into utterances and POSTs them here; speaker identity still comes from the LiveKit participant ID.

## Hardware (read before deploying)
Numbers are approximate, from faster-whisper's published benchmarks; I could not measure them in my sandbox.

| Setup | Fits live meetings? |
|---|---|
| NVIDIA GPU, **>= 6 GB VRAM** (RTX 3060/4060 and up), `float16` ~4-5 GB or `int8_float16` ~3 GB | **Yes** - large-v3 is several times faster than real time; ~1 s lag per sentence. 8 GB+ recommended. |
| CPU only, 8+ fast cores, 8 GB RAM, `int8` | **Marginal** - large-v3 runs around real-time or slower, so 5 people talking will lag and drop segments. Use `WHISPER_MODEL=medium` or `small` (less accurate, esp. Tamil) or a GPU. |
| Apple Silicon / AMD GPU | Not supported by this setup (CTranslate2 has no Metal/ROCm build); runs CPU-only. |

Disk: ~3 GB for weights (downloaded from Hugging Face on first start, then cached). The service has no auth by
default and binds to `127.0.0.1`; if the Node server is on another machine set `WHISPER_HOST`, `WHISPER_API_TOKEN`
(same value in `server/.env`) and put it on a private network/TLS. **Never expose it to the internet.**
Hosting: any Linux/Windows box with an NVIDIA GPU (own PC, a GPU VPS). Typical serverless/free tiers have no GPU. 

## Install
```bash
cd stt-service
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# GPU only: CUDA 12 + cuDNN 9 must be installed (pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.* works on Linux)
python app.py            # first start downloads the model; wait for "Model ready"
curl http://127.0.0.1:9000/health
```
Then start the NEXUS server as usual (`cd server && npm run dev`); it logs `Whisper STT service ready`.

## Environment – stt-service (all optional)
`WHISPER_MODEL=large-v3` · `WHISPER_DEVICE=auto|cuda|cpu` · `WHISPER_COMPUTE_TYPE=auto` (float16 on GPU, int8 on CPU)
· `WHISPER_HOST=127.0.0.1` · `WHISPER_PORT=9000` · `WHISPER_API_TOKEN=` · `WHISPER_LANGUAGES=en,ta,hi,ar`
· `WHISPER_CONCURRENCY=1` (raise only with spare VRAM) · `WHISPER_MAX_QUEUE=16` · `WHISPER_BEAM_SIZE=5`
· `WHISPER_MODEL_DIR=` · `WHISPER_CPU_THREADS=0` · `WHISPER_PRELOAD=true`

## Environment – server/.env
See the block in the hand-off message: `WHISPER_URL`, `WHISPER_API_TOKEN`, `WHISPER_LANGUAGES`,
`WHISPER_CODE_SWITCH_PROMPT`, `WHISPER_ENDPOINT_SILENCE_MS`, `WHISPER_MAX_UTTERANCE_MS`, `WHISPER_PARTIALS_MS`,
`STT_MIN_CONFIDENCE`, optional `STT_PROVIDER=whisper` for recorded uploads.

## Tests
`python test_service.py` (service logic, stand-in model) · from `server/`: `npx ts-node --transpile-only scripts/verify/whisperSession.verify.ts`
and `.../whisperMeeting.e2e.verify.ts` · real accuracy on your recordings: `python eval_accuracy.py eval_samples`.

## Known limits
- Whisper picks ONE language per utterance. Tamil sentences with English words are helped by a prompt, not solved;
  romanized Tamil ("Tanglish" in Latin letters) is inconsistent - Whisper may answer in Tamil script or English-like spelling.
- Language detection on clips under ~1.2 s is unreliable; such clips inherit the speaker's last language.
- Detection is restricted to `WHISPER_LANGUAGES`; a speaker of another language is forced into one of them.
- Whisper can hallucinate on noise/silence; filters reduce this but do not eliminate it. Tamil/Hindi/Arabic WER is clearly worse than English.
- Recorded uploads (`STT_PROVIDER=whisper`) have no speaker diarization; live meetings do (LiveKit participant IDs).
