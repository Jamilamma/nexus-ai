import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    console.warn(`[env] Warning: ${name} is not set.`);
    return "";
  }
  return val;
}

export const env = {
  port: parseInt(process.env.PORT || "5000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",

  mongoUri: required("MONGODB_URI", "mongodb://localhost:27017/nexus-ai"),

  // A missing secret must never fall back to a value that is public in the source code on a real deployment.
  jwtSecret: (() => {
    const fromEnv = process.env.JWT_SECRET;
    if (fromEnv) return fromEnv;
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET is not set. Refusing to start in production with a default signing secret.");
    }
    console.warn("[env] Warning: JWT_SECRET is not set; using an insecure development-only secret.");
    return "dev_only_insecure_secret_change_me";
  })(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",

  llmApiKey: process.env.LLM_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "gemini-flash-latest",

  sttApiKey: process.env.STT_API_KEY || "",
  sttProvider: process.env.STT_PROVIDER || "none",
  // --- Live (microphone) speech-to-text: self-hosted faster-whisper (Whisper large-v3) ------------
  // Audio never leaves your infrastructure and no API key is needed. The Python service in
  // /stt-service does the recognition; this server only cuts each participant's LiveKit audio into
  // utterances and sends them to it. STT_PROVIDER / STT_API_KEY above still drive ONLY the
  // recorded-upload path (see services/speech/transcribe.ts; set STT_PROVIDER=whisper to self-host that too).
  whisperUrl: (process.env.WHISPER_URL || "http://127.0.0.1:9000").replace(/\/+$/, ""),
  // Optional shared secret; must equal WHISPER_API_TOKEN of the Python service.
  whisperApiToken: process.env.WHISPER_API_TOKEN || "",
  // Languages automatic detection may choose from (ISO codes). Restricting the choice is the biggest
  // accuracy lever for a known audience (it stops Tamil being "detected" as Malayalam/Telugu). A speaker
  // using the in-meeting "I speak" selector overrides this; set to an empty string for Whisper's full
  // ~99-language detection. A single code here FORCES that language for everyone.
  whisperLanguages: (process.env.WHISPER_LANGUAGES ?? "en,ta,hi,ar")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean),
  // Your own vocabulary: names of people, places, companies, products and jargon that Whisper keeps
  // mishearing (e.g. "Sathyabama University|BSc Computer Science|NLC|NEXUS AI"), separated by "|" or ",".
  // Sent with every request as hint words; each speaker's display name is added automatically.
  // Keep it short (about 15 items): hints share a small prompt budget with the language prompt.
  whisperHotwords: (process.env.WHISPER_HOTWORDS || "")
    .split(/[|,]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 15),
  // When a non-English language is detected and English is allowed, prime Whisper with a sentence that
  // keeps English words in Latin script (Tanglish / Hinglish style speech). Set false to disable.
  whisperCodeSwitchPrompt: process.env.WHISPER_CODE_SWITCH_PROMPT !== "false",
  // Utterance endpointing (done here, on the participant's own audio): a line is sent for recognition
  // after this much silence (300-3000 ms). Lower = lines appear sooner but long sentences get split.
  whisperEndpointSilenceMs: Math.min(3000, Math.max(300, parseInt(process.env.WHISPER_ENDPOINT_SILENCE_MS || "700", 10) || 700)),
  // Longest single utterance sent to Whisper (5-28 s; Whisper's window is 30 s). Longer continuous
  // speech is cut at its quietest point.
  whisperMaxUtteranceMs: Math.min(28_000, Math.max(5_000, parseInt(process.env.WHISPER_MAX_UTTERANCE_MS || "25000", 10) || 25_000)),
  // Voiced audio shorter than this is treated as a click / noise burst and never sent.
  whisperMinSpeechMs: Math.max(100, parseInt(process.env.WHISPER_MIN_SPEECH_MS || "200", 10) || 200),
  // Interim ("live caption") text while someone is still speaking. 0 = off (recommended on CPU).
  // On a GPU, 1500-2500 gives captions that update every couple of seconds; interim lines are never saved.
  whisperPartialsMs: Math.max(0, parseInt(process.env.WHISPER_PARTIALS_MS || "0", 10) || 0),
  whisperRequestTimeoutMs: Math.max(5_000, parseInt(process.env.WHISPER_REQUEST_TIMEOUT_MS || "60000", 10) || 60_000),
  // Utterances waiting for the Whisper service per participant before new ones are dropped (with a visible error).
  whisperMaxPending: Math.max(1, parseInt(process.env.WHISPER_MAX_PENDING || "10", 10) || 10),
  // Recorded-file transcription (STT_PROVIDER=whisper) can take many minutes for a long recording.
  whisperFileTimeoutMs: Math.max(60_000, parseInt(process.env.WHISPER_FILE_TIMEOUT_MS || "3600000", 10) || 3_600_000),
  // A finalized segment whose confidence (0..1) is below this is flagged "low confidence" in the UI and
  // in Summary / Ask NEXUS context. For Whisper, confidence = exp(avg token log-probability), which is
  // NOT calibrated like a vendor score and runs lower for Tamil/Hindi/Arabic: treat 0.5 as a starting
  // point and tune it on your own recordings (see stt-service/eval_accuracy.py).
  sttMinConfidence: parseFloat(process.env.STT_MIN_CONFIDENCE || "0.5"),
  // Voice gate / voice-activity level: a participant's audio is only forwarded while it is above this
  // RMS level (int16 scale, 0-32767) and for this long after the last voiced frame, and the same level
  // decides where an utterance ends. Tune down for very quiet microphones, up for noisy rooms.
  sttVoiceRms: parseInt(process.env.STT_VOICE_RMS || "150", 10),
  sttSilenceHangoverMs: parseInt(process.env.STT_SILENCE_HANGOVER_MS || "2500", 10),
  // Sanity ceiling on simultaneously open per-participant STT sessions in this process. With a local
  // model a session is just an audio buffer, so this is a safety net, not a vendor limit; the real
  // capacity limit is the Whisper service's GPU/CPU (see WHISPER_CONCURRENCY in stt-service).
  sttMaxConcurrentSessions: parseInt(process.env.STT_MAX_CONCURRENT_SESSIONS || "50", 10),
  // A participant whose audio has been silent/absent this long has their STT
  // session closed (it flushes what was said); it re-opens on their next audio.
  sttIdleCloseMs: parseInt(process.env.STT_IDLE_CLOSE_MS || "60000", 10),

  // --- Video meetings (LiveKit SFU) ---
  // Media (audio/video/screen) flows browser <-> LiveKit directly. This
  // server only mints join tokens and manages meeting state/signaling.
  livekitUrl: process.env.LIVEKIT_URL || "", // e.g. ws://localhost:7880 or wss://<project>.livekit.cloud
  livekitApiKey: process.env.LIVEKIT_API_KEY || "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || "",
  maxMeetingParticipants: parseInt(process.env.MAX_MEETING_PARTICIPANTS || "5", 10),
  // How long a dropped participant is kept "in the meeting" so a quick
  // network blip / page refresh can rejoin without the roster flapping.
  reconnectGraceMs: parseInt(process.env.MEETING_RECONNECT_GRACE_MS || "20000", 10),
  // Phase 1 ships the video core only. The existing AI transcription
  // pipeline is left intact but dormant unless this is "true".
  enableMeetingAi: process.env.ENABLE_MEETING_AI === "true",
  // Phase 2: participant-aware live transcription (no translation, insights
  // or RAG indexing — those stay behind ENABLE_MEETING_AI). The in-meeting
  // Summary + Ask NEXUS panel is controlled separately by ENABLE_NEXUS_AI.
  enableMeetingTranscription: process.env.ENABLE_MEETING_TRANSCRIPTION === "true",
  // NEXUS AI inside a live meeting: on-demand Summary + Ask NEXUS, grounded
  // ONLY in the speaker-tagged transcript (no background translation, RAG
  // indexing or periodic insight calls, so it stays cheap on LLM quota).
  // Default ON; it still needs transcription to be on (nothing to summarize
  // otherwise). Set ENABLE_NEXUS_AI=false to turn it off.
  enableNexusAi: process.env.ENABLE_NEXUS_AI !== "false",

  /** True when participant-aware live transcription runs (either flag). */
  get transcriptionActive(): boolean {
    return this.enableMeetingTranscription || this.enableMeetingAi;
  },
  /** True when the in-meeting NEXUS AI panel (Summary + Ask NEXUS) is available. */
  get nexusAiActive(): boolean {
    return this.transcriptionActive && (this.enableNexusAi || this.enableMeetingAi);
  },

  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || "200", 10),
  uploadDir: process.env.UPLOAD_DIR || "uploads",
};