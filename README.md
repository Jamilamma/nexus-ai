# NEXUS AI — Multilingual Enterprise Intelligence Agent

A working full-stack implementation, now built around **live real-time meetings** as the primary workflow (per the product-direction upgrade), with recorded uploads, AI summarization, meeting intelligence, RAG-based "Ask Your Recording/Meeting," AI text rewriting/translation, the AI Interview Coach, and an AI Learning Assistant — all wired to a real React dashboard.

**Status: functional MVP+, live meeting core engine complete.** Live Class mode's dedicated frontend, platform integrations (Meet/Zoom/Teams), the browser extension, hardened security/testing, and deployment configs are the main pieces left — see "What's not built yet" below.

---

## 1. What's actually working

- **Auth** — register/login, JWT, bcrypt password hashing, protected routes
- **🔴 Live Meeting (real-time)** — mic capture → streaming speech-to-text (AssemblyAI realtime WebSocket) → live transcript → batched real-time translation (English/Tamil/Hindi/Arabic, meaning-preserving, not word-by-word) → sliding-window AI insights (topic/key points/decisions/action items/questions/risks, cost-bounded so it never re-sends the whole meeting to the LLM) → "Ask NEXUS AI" during the meeting (reuses the existing RAG retrieval, scoped per-user) → End Meeting hands off to the **same** finalize pipeline used for uploads, so the completed live meeting becomes a normal recording with full summary/RAG/reports
- **Recording upload** — audio/video file upload (local disk storage, swappable) *or* paste a transcript directly (useful without an STT API key) — unchanged, still fully working
- **Speech-to-text** — pluggable; ships with an AssemblyAI integration for **both** batch (`transcribe.ts`) and realtime streaming (`realtimeTranscribe.ts`) — two separate code paths, neither broke the other
- **AI summarization** — short + detailed summary, key points, topics (real Claude API calls, map-reduce chunking for long transcripts)
- **Meeting intelligence** — decisions, action items (task/owner/deadline/priority), questions, risks, follow-ups, important dates — never invents an owner/deadline that wasn't stated
- **RAG — "Ask Your Recording"** — transcript is chunked, embedded, and retrieved by cosine similarity; answers are grounded in retrieved excerpts and strictly scoped per-user at the database query level; now also supports **incremental** indexing during a live session in addition to the original batch index
- **AI Rewrite tool** — grammar correction, natural/professional/concise rewriting, simplify, explain, summarize
- **Translation** — English / Tamil / Hindi / Arabic (extendable)
- **AI Interview Coach** — multi-turn mock interview, per-answer scoring (technical/communication/grammar/clarity), filler-word count, improved sample answers, final report with strengths/weaknesses/prep plan
- **AI Learning Assistant** — notes, flashcards, quiz, exam questions generated from a lecture transcript
- **Dashboard analytics** — real usage data from MongoDB (no fake numbers)
- **Dashboard UI** — React + Tailwind, dark theme, responsive layout, status polling while a recording processes

## 2. What's not built yet (be honest about this in interviews)

- Live **Class** mode UI (the backend `mode` already supports `live_class` end-to-end, but a dedicated frontend setup screen distinct from Meeting mode isn't wired up yet)
- Google Meet / Zoom / Teams integration — no official real-time capture API exists for third parties; needs an official bot/recording API or a consent-based browser extension, neither built
- Browser extension
- Full multi-tool AI Agent orchestration layer (each feature currently calls its own dedicated service directly — simpler and equally valid to defend, but isn't a single agent choosing between tools)
- Automated test suite
- Production deployment configs / Docker
- Multi-instance horizontal scaling for live sessions (session state is in-memory per Node process — documented in code, fine for one server; would need Redis for multiple instances)

## 3. Tech stack

Backend: Node.js, Express, TypeScript, MongoDB/Mongoose, JWT auth, Multer (uploads), Socket.IO (live meeting realtime layer)
AI: Anthropic Claude API (`services/ai/llmClient.ts` — the only file that talks to the LLM, swap providers here)
RAG: Voyage AI embeddings if `VOYAGE_API_KEY` is set, otherwise a local fallback vector so it works with zero extra keys
Speech-to-text: AssemblyAI — batch (`services/speech/transcribe.ts`) and realtime streaming (`services/speech/realtimeTranscribe.ts`)
Frontend: React 18, TypeScript, Vite, Tailwind CSS, React Router, Socket.IO client, Web Audio API (mic capture/PCM16 downsampling)

## 4. Running it locally

### Prerequisites
- Node.js 18+
- A MongoDB instance (local `mongod`, or a free MongoDB Atlas cluster)
- An Anthropic API key from https://console.anthropic.com (required for all AI features)

### Backend

```bash
cd server
cp .env.example .env
# edit .env: set MONGODB_URI, JWT_SECRET, and LLM_API_KEY at minimum
npm install
npm run dev
```

Server runs on `http://localhost:5000`. Health check: `GET /api/health`.

### Frontend

```bash
cd client
npm install
npm run dev
```

App runs on `http://localhost:5173` and proxies `/api` to the backend.

### Try it without an STT key
When creating a **recorded** meeting, choose **"Paste transcript"** instead of uploading audio — the entire AI pipeline (summarization, meeting intelligence, RAG, learning content) works identically whether the transcript came from an STT provider or was pasted directly. This is the fastest way to see the recorded pipeline working end-to-end.

**Live Meeting mode requires `STT_API_KEY`** (no paste-based fallback for live audio — there's nothing to transcribe from without a provider). If you only want to demo the live UI without a key, you can still start a session; the mic/socket connection will work, but no transcript will appear until a valid `STT_API_KEY` is set — the server logs a warning on startup if it's missing.

### Enabling real audio transcription (recorded uploads AND live meetings)
Get an AssemblyAI key (free tier available) at https://www.assemblyai.com, then in `server/.env`:
```
STT_PROVIDER=assemblyai
STT_API_KEY=your_key_here
```
The same key powers both batch transcription (`transcribe.ts`) and live streaming transcription (`realtimeTranscribe.ts`) — no separate key needed for Live Meeting.

### Enabling higher-quality RAG embeddings (optional)
Get a Voyage AI key at https://www.voyageai.com and add to `server/.env`:
```
VOYAGE_API_KEY=your_key_here
```
Without this, RAG still works using a local fallback vector — good enough for demoing, not for production-quality retrieval.

## 5. Project structure

```
nexus-ai/
├── server/               # Express + TypeScript API
│   └── src/
│       ├── config/       # env, db connection
│       ├── controllers/  # request handlers
│       ├── middleware/   # auth, error handling
│       ├── models/       # Mongoose schemas (incl. LiveSession)
│       ├── routes/       # Express routers
│       ├── realtime/     # Socket.IO server (JWT-authed /realtime namespace)
│       └── services/
│           ├── ai/       # LLM client, summarization, rewrite, chunking, live insights, live translation
│           ├── rag/      # embeddings, batch + incremental indexing, retrieval
│           ├── speech/   # STT: batch (transcribe.ts) + realtime streaming (realtimeTranscribe.ts)
│           ├── realtime/ # LiveSessionManager — orchestrates a live session end-to-end
│           ├── pipeline/ # finalizeRecordingAnalysis — shared by uploads AND live-session-end
│           └── storage/  # file storage (local, swappable)
├── client/               # React + Vite + Tailwind
│   └── src/
│       ├── components/
│       │   └── live/     # LiveTranscript, LiveInsights, AskNexusLive, MeetingControls
│       ├── context/      # AuthContext
│       ├── hooks/        # useMicStream (mic capture -> 16kHz PCM16)
│       ├── pages/        # Login, Register, Dashboard, Recordings, LiveMeeting, etc.
│       └── services/     # axios API client, socket.io client
```

## 6. API overview

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me

POST   /api/recordings                (multipart: file OR pastedTranscript)
GET    /api/recordings
GET    /api/recordings/:id
DELETE /api/recordings/:id

POST   /api/ai/rewrite                { text, mode }
POST   /api/ai/translate              { text, targetLanguage }

POST   /api/rag/query                 { recordingId, question }

POST   /api/learning/generate         { recordingId }
GET    /api/learning/:recordingId

POST   /api/interview/start           { role, difficulty, jobDescription }
POST   /api/interview/answer          { interviewId, answer }
POST   /api/interview/finish          { interviewId }
GET    /api/interview
GET    /api/interview/:id

GET    /api/analytics/dashboard
```

### Realtime (Socket.IO, `/realtime` namespace)

Connects with `{ auth: { token: <JWT> } }`. Events:

```
Client → Server:
  start_live_session   { title, mode, outputLanguage }
  audio_chunk           <binary 16-bit PCM, 16kHz>
  pause_session
  resume_session
  change_language       { outputLanguage }
  ask_ai                { question }
  end_session

Server → Client:
  connection_status      { status }
  session_started         { liveSessionId, recordingId }
  transcript_partial      { text }
  transcript_final        { segment }
  translation_update      { segmentIndex, translatedText, detectedLanguage }
  ai_insight               LiveInsightState
  answer                   { answer, sources }
  session_paused / session_resumed
  session_ended            { recordingId }
  error                    { message }
```

## 7. Security notes

- Passwords hashed with bcrypt (cost factor 12)
- JWT-based auth on every protected REST route **and** on the Socket.IO `/realtime` namespace (connections are rejected at handshake without a valid token — Express middleware doesn't apply to WebSocket upgrades automatically, so this is implemented separately in `realtime/socketServer.ts`)
- RAG retrieval (including "Ask NEXUS AI" during a live meeting) is filtered by `userId` **at the MongoDB query level**, not just in application logic — one user's transcripts can never be retrieved by another user's questions
- File upload restricted by MIME type and size (`MAX_UPLOAD_MB`)
- `helmet`, CORS restricted to `CLIENT_URL`, and rate limiting (300 req/15min) applied globally to REST routes
- No secrets committed — `.env` is gitignored, `.env.example` documents required variables
- Live audio is never logged; only resulting transcript text is persisted

## 8. Next steps to reach 100%

1. Add automated tests (Jest for backend controllers/services, React Testing Library for key frontend flows)
2. Build the Live Class mode frontend (reuses the same live engine, just a different `mode` + post-session study material generation)
3. Consolidate the AI feature services behind a single tool-calling agent if you want to demonstrate agent orchestration specifically
4. Move live-session state from in-memory (`sessionManager.ts`) to Redis for multi-instance deployments
5. Investigate official Zoom/Google Meet recording-API integrations (async, not live) as a first step toward platform integration, before attempting the browser-extension route
4. Add Docker + a deployment guide (Railway/Render for the API, Vercel/Netlify for the frontend, MongoDB Atlas for the DB)
5. Swap local file storage for S3/Supabase/Firebase for production
