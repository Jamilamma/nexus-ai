import axios from "axios";
import { env } from "../../config/env";

/**
 * Real-time speech-to-text backed by a SELF-HOSTED faster-whisper service (Whisper large-v3; see
 * /stt-service). Same exported interface as the previous vendor client, so meetingManager,
 * sessionManager and the LiveKit audio pump are unchanged.
 *
 * Whisper is not a streaming model, so each STT session (one per speaking participant) does the
 * streaming part itself:
 *   audio chunks (100 ms, 16 kHz mono PCM16) -> energy-based utterance endpointing
 *   -> one HTTP request per utterance to the Whisper service -> one "final" event per Whisper segment.
 * Optional interim ("partial") captions re-decode the utterance in progress every WHISPER_PARTIALS_MS.
 *
 * TRANSCRIPT INTEGRITY RULES implemented here
 *  - Every audio chunk belongs to exactly one utterance and every utterance is sent once, in order
 *    (a per-session promise chain), so the same speech cannot be delivered twice. (meetingManager
 *    still has its own duplicate guards as a second line of defence.)
 *  - Interim text is only ever a "partial". A "final" comes only from a completed utterance request.
 *  - Text is Whisper's output verbatim (the service only drops hallucinated / looping segments); the
 *    original language is never translated here.
 *  - Timestamps come from the moment each chunk was CAPTURED on the shared meeting clock, plus Whisper's
 *    offset inside the utterance - not from when the HTTP response arrived.
 *  - Speaker identity is not decided here: one session == one LiveKit participant (see meetingManager).
 */

export interface RealtimeTranscriptEvent {
  type: "partial" | "final";
  text: string;
  startTime: number; // seconds, relative to the shared meeting clock
  endTime: number;
  /** Dominant spoken language of this segment (ISO 639-1, e.g. "ta"). */
  detectedLanguage?: string;
  /** Every language found inside this segment (code-switching), dominant first. */
  languages?: string[];
  /** Whisper confidence 0..1 = exp(mean token log-probability). Not a calibrated probability. */
  confidence?: number;
}

export interface RealtimeSttSession {
  /** `capturedAtMs` = wall-clock time (Date.now()) the END of this audio was captured; used to place transcripts on the meeting clock. */
  sendAudioChunk: (pcm16Chunk: Buffer, capturedAtMs?: number) => void;
  close: () => void;
  /**
   * Closes the session and resolves once the speech still being recognised has been delivered through
   * onTranscript (or after `timeoutMs`, whichever comes first). Used when a meeting ends so the last
   * sentence is not thrown away while Whisper is still working on it.
   */
  closeAndFlush: (timeoutMs?: number) => Promise<void>;
}

/** Per-stream options chosen by the caller (never forced on the speaker unless a single language is given). */
export interface RealtimeSttOptions {
  /**
   * ISO codes from the "I speak" selector. One code = that language is FORCED (most accurate when you
   * know it). Two or more = automatic detection restricted to those languages. Empty/undefined = the
   * server default (WHISPER_LANGUAGES).
   */
  languageHints?: string[];
  /** Names / domain words that help recognition (e.g. the participant's own display name). */
  contextTerms?: string[];
}

/** Thrown/reported when our own session cap is reached. */
export class SttCapacityError extends Error {
  readonly capacity = true;
  constructor(message: string) {
    super(message);
    this.name = "SttCapacityError";
  }
}

export interface SttCloseInfo {
  code: number;
  reason: string;
  /** The service answered at least once. */
  wasReady: boolean;
  /** How long the session lived, ms. */
  lifetimeMs: number;
  capacity: boolean;
}

const CAPACITY_RE = /too many|concurrent|rate.?limit|max_concurrent|\b429\b/i;
export function isCapacityMessage(message: string): boolean {
  return CAPACITY_RE.test(message || "");
}

/** Number of STT sessions that exist in this process and have not fully closed. */
let openSessions = 0;
export function getOpenSttSessionCount(): number {
  return openSessions;
}

export const STT_SAMPLE_RATE = 16000;
export const STT_CHUNK_MS = 100;
export const STT_CHUNK_BYTES = (STT_SAMPLE_RATE * 2 * STT_CHUNK_MS) / 1000; // 3200

const LEAD_CHUNKS = 3; // 300 ms of audio kept before the first voiced chunk
const TAIL_PAD_CHUNKS = 3; // 300 ms of trailing silence kept after the last voiced chunk
const GAP_MS = 300; // no audio delivered for this long (voice gate closed) == end of speech
const AUDIO_STOPPED_MS = 900; // flush an utterance when audio stops arriving without a gap marker
const PARTIAL_WINDOW_CHUNKS = 150; // interim decode looks at the last 15 s only
const PARTIAL_MIN_VOICED_MS = 800;
const ERROR_REPORT_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;
// One log line per recognised utterance: audio length, wait in our queue, round trip, time inside the model.
// This is what shows whether delay comes from waiting for the speaker to finish, our queue, or the model.
const TIMING_LOG = process.env.WHISPER_TIMING_LOG !== "false";

interface Chunk {
  pcm: Buffer;
  endAt: number; // wall-clock ms when the END of this chunk was captured
  level: number; // RMS, int16 scale
  voiced: boolean;
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}
interface WhisperResponse {
  language?: string;
  language_probability?: number;
  language_source?: "forced" | "fallback" | "candidates" | "detected" | "none";
  segments?: WhisperSegment[];
  skipped?: boolean;
  no_speech?: boolean;
  processing_ms?: number;
  timings_ms?: { vad: number; detect: number; transcribe: number };
}

const hasContent = (s: string) => /[\p{L}\p{N}]/u.test(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function chunkRms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/**
 * Languages present in `text`, dominant first, derived from the SCRIPT of the letters Whisper wrote.
 * Whisper itself only reports one language per window; this is what lets a Tamil sentence containing
 * English words be labelled "Tamil + English". Latin-only text keeps Whisper's own label (romanized
 * Tamil/Hindi is indistinguishable from English by script, so we never relabel it as English).
 * Exported for tests.
 */
export function languagesForText(text: string, whisperLang?: string): string[] {
  const counts: Record<string, number> = { ta: 0, hi: 0, ar: 0, en: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0b80 && cp <= 0x0bff) counts.ta++;
    else if (cp >= 0x0900 && cp <= 0x097f) counts.hi++;
    else if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) counts.ar++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) counts.en++;
  }
  const w = whisperLang?.toLowerCase();
  const nonLatin = (["ta", "hi", "ar"] as const).filter((l) => counts[l] > 0);
  if (nonLatin.length === 0) return w ? [w] : counts.en > 0 ? ["en"] : [];
  const present: string[] = [...nonLatin, ...(counts.en > 0 ? ["en"] : [])];
  return present.sort((a, b) => counts[b] - counts[a]);
}

/** Probe used at startup and when a session opens. Never throws. */
export async function checkWhisperHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await axios.get(`${env.whisperUrl}/health`, { timeout: 3000 });
    const d = r.data || {};
    if (d.status === "ok") return { ok: true, detail: `${d.model} on ${d.device} (${d.compute_type})` };
    return { ok: false, detail: "Whisper service is up but the model is still loading (the first start downloads ~3 GB)." };
  } catch (err) {
    return { ok: false, detail: describeError(err) };
  }
}

function describeError(err: unknown): string {
  const e = err as any;
  if (e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND" || e?.code === "ECONNRESET") {
    return `Whisper STT service is not reachable at ${env.whisperUrl}. Start it (see stt-service/README.md).`;
  }
  if (e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") {
    return `Whisper STT service did not answer in time (${env.whisperUrl}); it is probably overloaded - use a GPU or a smaller model.`;
  }
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail;
  if (status === 401) return "Whisper STT service rejected the token - WHISPER_API_TOKEN must match on both sides.";
  if (status === 503) return `Whisper STT service is busy or still loading (${detail || "503"}).`;
  if (status) return `Whisper STT service error ${status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}.`;
  return `Whisper STT request failed: ${e?.message || String(err)}`;
}

function isRetryable(err: unknown): boolean {
  const e = err as any;
  const status = e?.response?.status;
  if (status) return status === 503 || status === 502 || status === 504 || status === 429;
  return true; // network errors / timeouts
}

export function startRealtimeTranscription(
  onTranscript: (event: RealtimeTranscriptEvent) => void,
  onError: (err: Error) => void,
  sessionStartedAt: number,
  // Fired once when this session has fully closed (after the final flush) so the caller can re-open on the next audio.
  onClose?: (info: SttCloseInfo) => void,
  // Fired once when the Whisper service has answered.
  onReady?: () => void,
  options: RealtimeSttOptions = {}
): RealtimeSttSession {
  if (openSessions >= env.sttMaxConcurrentSessions) {
    throw new SttCapacityError(`Speech-to-text session limit reached (${openSessions}/${env.sttMaxConcurrentSessions} sessions open on this server).`);
  }
  openSessions += 1;
  const openedAt = Date.now();

  // ---- language request parameters (fixed for the life of this session) ----------------------
  const hints = (options.languageHints ?? env.whisperLanguages).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const forcedLanguage = hints.length === 1 ? hints[0] : undefined;
  const codeSwitch = env.whisperCodeSwitchPrompt && !forcedLanguage && (hints.length === 0 || hints.includes("en"));
  const terms = [...(options.contextTerms ?? []), ...env.whisperHotwords].map((t) => t.replace(/[|\r\n]+/g, " ").trim()).filter(Boolean).slice(0, 20).join("|");
  let lastLanguage: string | undefined = forcedLanguage; // used by the service for clips too short to detect

  // ---- state -----------------------------------------------------------------------------------
  let closeRequested = false;
  let released = false;
  let ready = false;
  let lastErrorAt = 0;
  let carry: Buffer = Buffer.alloc(0);
  let lastEndAt = 0; // wall-clock end of the last audio received
  let lastFeedWall = 0;
  let lead: Chunk[] = [];
  let utt: Chunk[] = [];
  let inSpeech = false;
  let voicedMs = 0;
  let trailingSilentMs = 0;
  let uttId = 0;
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  let lastPartialText = "";
  let lastPartialAt = 0;
  let partialInFlight = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const reportError = (err: Error) => {
    const now = Date.now();
    if (now - lastErrorAt < ERROR_REPORT_INTERVAL_MS) return;
    lastErrorAt = now;
    onError(err);
  };
  const markReady = () => {
    if (ready) return;
    ready = true;
    onReady?.();
  };

  // ---- Whisper request --------------------------------------------------------------------------
  const callWhisper = async (pcm: Buffer, partial: boolean): Promise<WhisperResponse> => {
    const params: Record<string, string | boolean> = {};
    if (forcedLanguage) params.language = forcedLanguage;
    else if (hints.length > 1) params.candidates = hints.join(",");
    if (!forcedLanguage && lastLanguage) params.fallback_language = lastLanguage;
    if (codeSwitch) params.code_switch = true;
    if (terms) params.terms = terms;
    if (partial) params.partial = true;
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (env.whisperApiToken) headers.Authorization = `Bearer ${env.whisperApiToken}`;
    const res = await axios.post<WhisperResponse>(`${env.whisperUrl}/transcribe`, pcm, {
      params,
      headers,
      timeout: env.whisperRequestTimeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res.data;
  };

  const emitPartial = (text: string, startS: number, endS: number) => {
    const shown = hasContent(text) ? text.trim() : "";
    if (shown === lastPartialText) return;
    lastPartialText = shown;
    onTranscript({ type: "partial", text: shown, startTime: startS, endTime: Math.max(startS, endS) });
  };
  const clearPartial = () => {
    if (lastPartialText) emitPartial("", 0, 0);
  };

  // ---- utterance processing (strictly sequential per session) ---------------------------------
  const label = options.contextTerms?.[0] || "participant";
  const processUtterance = async (u: { pcm: Buffer; startAt: number; queuedAt: number }) => {
    const startS = (u.startAt - sessionStartedAt) / 1000;
    const began = Date.now();
    let res: WhisperResponse | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        res = await callWhisper(u.pcm, false);
        break;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS - 1) break;
        await sleep(500 * 3 ** attempt);
      }
    }
    if (!res) {
      reportError(new Error(`${describeError(lastErr)} A spoken segment (${(u.pcm.length / 32000).toFixed(1)} s) could not be transcribed.`));
      return;
    }
    markReady();
    if (TIMING_LOG) {
      const t = res.timings_ms;
      console.log(
        `[stt] ${label}: ${(u.pcm.length / 32000).toFixed(1)}s audio | waited ${began - u.queuedAt} ms | whisper round trip ${Date.now() - began} ms` +
          (t ? ` (vad ${t.vad} / detect ${t.detect} / decode ${t.transcribe})` : "") +
          ` | ${res.no_speech ? "no speech" : `${res.language ?? "?"}/${res.language_source ?? "?"}`} | ${(res.segments ?? []).length} segment(s)`
      );
    }
    if (res.language && (res.language_source === "forced" || (res.language_source !== "fallback" && (res.language_probability ?? 0) >= 0.6))) {
      lastLanguage = res.language;
    }
    for (const seg of res.segments ?? []) {
      const text = (seg.text || "").trim();
      if (!hasContent(text)) continue;
      const segStart = Math.max(0, startS + (seg.start || 0));
      const segEnd = Math.max(segStart, startS + (seg.end || 0));
      const confidence = typeof seg.avg_logprob === "number" ? Math.min(1, Math.max(0, Math.exp(seg.avg_logprob))) : undefined;
      const langs = languagesForText(text, res.language);
      onTranscript({
        type: "final",
        text,
        startTime: segStart,
        endTime: segEnd,
        detectedLanguage: langs[0] ?? res.language,
        languages: langs.length ? langs : undefined,
        confidence,
      });
    }
  };

  const enqueue = (chunks: Chunk[]) => {
    if (chunks.length === 0) return;
    if (pending >= env.whisperMaxPending) {
      reportError(new Error("Transcription is falling behind (the Whisper service is too slow for this meeting); a spoken segment was skipped. Use a GPU or a smaller model."));
      return;
    }
    const u = { pcm: Buffer.concat(chunks.map((c) => c.pcm)), startAt: chunks[0].endAt - STT_CHUNK_MS, queuedAt: Date.now() };
    pending += 1;
    chain = chain
      .then(() => processUtterance(u))
      .catch((err) => reportError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        pending -= 1;
      });
    // The interim line for this utterance is replaced by its final segments (emitted above, in order).
    chain = chain.then(() => clearPartial());
  };

  // ---- endpointing ------------------------------------------------------------------------------
  const resetUtterance = () => {
    utt = [];
    inSpeech = false;
    voicedMs = 0;
    trailingSilentMs = 0;
    uttId += 1;
  };

  const endUtterance = () => {
    if (!inSpeech) return;
    const chunks = utt;
    const voiced = voicedMs;
    resetUtterance();
    lead = [];
    if (voiced < env.whisperMinSpeechMs) {
      chain = chain.then(() => clearPartial());
      return; // a click / noise burst, not speech
    }
    // Keep only a short pad of trailing silence.
    let tail = 0;
    while (tail < chunks.length && !chunks[chunks.length - 1 - tail].voiced) tail++;
    enqueue(chunks.slice(0, chunks.length - Math.max(0, tail - TAIL_PAD_CHUNKS)));
  };

  /** Continuous speech reached the length cap: send everything up to its quietest point, keep going with the rest. */
  const splitAtQuietest = () => {
    const from = Math.max(1, utt.length - 60); // look in the last 6 s
    const to = utt.length - 2;
    let cut = to;
    for (let i = to; i >= from; i--) if (utt[i].level < utt[cut].level) cut = i;
    const left = utt.slice(0, cut + 1);
    const right = utt.slice(cut + 1);
    uttId += 1;
    utt = right;
    voicedMs = right.filter((c) => c.voiced).length * STT_CHUNK_MS;
    trailingSilentMs = 0;
    for (let i = right.length - 1; i >= 0 && !right[i].voiced; i--) trailingSilentMs += STT_CHUNK_MS;
    enqueue(left);
  };

  const processChunk = (chunk: Chunk) => {
    if (!inSpeech) {
      if (!chunk.voiced) {
        lead.push(chunk);
        if (lead.length > LEAD_CHUNKS) lead.shift();
        return;
      }
      inSpeech = true;
      utt = [...lead, chunk];
      lead = [];
      voicedMs = STT_CHUNK_MS;
      trailingSilentMs = 0;
      lastPartialAt = Date.now();
      return;
    }
    utt.push(chunk);
    if (chunk.voiced) {
      voicedMs += STT_CHUNK_MS;
      trailingSilentMs = 0;
    } else {
      trailingSilentMs += STT_CHUNK_MS;
    }
    if (trailingSilentMs >= env.whisperEndpointSilenceMs) {
      endUtterance();
      return;
    }
    if (utt.length * STT_CHUNK_MS >= env.whisperMaxUtteranceMs) splitAtQuietest();
  };

  const feed = (data: Buffer, capturedAtEnd: number) => {
    const dataMs = (data.length / 2 / STT_SAMPLE_RATE) * 1000;
    // The voice gate stopped delivering audio for a while: that is the end of the utterance, and
    // whatever partial 100 ms fragment is still buffered belongs to the old speech, not the new.
    if (lastEndAt && capturedAtEnd - dataMs - lastEndAt > GAP_MS) {
      endUtterance();
      carry = Buffer.alloc(0);
    }
    lastEndAt = capturedAtEnd;
    lastFeedWall = Date.now();
    carry = carry.length ? Buffer.concat([carry, data]) : data;
    while (carry.length >= STT_CHUNK_BYTES) {
      const remainingMs = ((carry.length - STT_CHUNK_BYTES) / 2 / STT_SAMPLE_RATE) * 1000;
      const pcm = Buffer.from(carry.subarray(0, STT_CHUNK_BYTES));
      const level = chunkRms(pcm);
      processChunk({ pcm, endAt: capturedAtEnd - remainingMs, level, voiced: level >= env.sttVoiceRms });
      carry = carry.subarray(STT_CHUNK_BYTES);
    }
  };

  // ---- timers: flush when audio stops, optional interim captions ----------------------------------
  const startPartial = () => {
    partialInFlight = true;
    lastPartialAt = Date.now();
    const id = uttId;
    const window = utt.slice(-PARTIAL_WINDOW_CHUNKS);
    const startAt = window[0].endAt - STT_CHUNK_MS;
    const pcm = Buffer.concat(window.map((c) => c.pcm));
    callWhisper(pcm, true)
      .then((res) => {
        if (res.skipped || closeRequested || id !== uttId || !inSpeech) return; // the final line owns this speech now
        markReady();
        const text = (res.segments ?? []).map((s) => (s.text || "").trim()).filter(Boolean).join(" ");
        const startS = (startAt - sessionStartedAt) / 1000;
        emitPartial(text, startS, startS + pcm.length / 2 / STT_SAMPLE_RATE);
      })
      .catch(() => {
        /* interim text is best-effort; the final transcript reports real errors */
      })
      .finally(() => {
        partialInFlight = false;
      });
  };

  const timer = setInterval(() => {
    if (closeRequested) return;
    const now = Date.now();
    if (inSpeech && now - lastFeedWall >= AUDIO_STOPPED_MS) {
      endUtterance();
      return;
    }
    if (env.whisperPartialsMs > 0 && inSpeech && !partialInFlight && pending === 0 && voicedMs >= PARTIAL_MIN_VOICED_MS && now - lastPartialAt >= env.whisperPartialsMs) {
      startPartial();
    }
  }, 250);
  timer.unref?.();

  // Tell the user right away if the service is down / still loading, instead of on the first sentence.
  void checkWhisperHealth().then((h) => {
    if (closeRequested) return;
    if (h.ok) markReady();
    else reportError(new Error(h.detail));
  });

  const finish = () => {
    clearInterval(timer);
    clearPartial();
    if (!released) {
      released = true;
      openSessions = Math.max(0, openSessions - 1);
    }
    console.log(`[realtime-stt] session closed (${openSessions} open)`);
    resolveClosed();
    onClose?.({ code: 1000, reason: "closed by caller", wasReady: ready, lifetimeMs: Date.now() - openedAt, capacity: false });
  };

  const closeNow = () => {
    if (closeRequested) return;
    // Flush the utterance in progress (so the last words are not lost), then finish after every
    // queued request has been answered.
    endUtterance();
    closeRequested = true;
    carry = Buffer.alloc(0);
    chain = chain.then(finish, finish);
  };

  console.log(`[realtime-stt] session opened (faster-whisper @ ${env.whisperUrl}, languages: ${forcedLanguage ? `${forcedLanguage} (forced)` : hints.join(",") || "auto (all)"})`);

  return {
    sendAudioChunk: (pcm16Chunk: Buffer, capturedAtMs?: number) => {
      if (closeRequested) return;
      feed(pcm16Chunk, capturedAtMs ?? Date.now());
    },
    close: () => closeNow(),
    closeAndFlush: (timeoutMs = 10_000) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn(`[realtime-stt] flush on close timed out after ${timeoutMs} ms`);
          resolve();
        }, timeoutMs);
        timer.unref?.();
        closeNow();
        void closedPromise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
