import { Types } from "mongoose";
import { randomUUID } from "crypto";
import { Recording } from "../../models/Recording";
import { Transcript, ITranscriptSegment } from "../../models/Transcript";
import { Meeting } from "../../models/Meeting";
import { LiveSessionMode } from "../../models/LiveSession";
import { startRealtimeTranscription, RealtimeSttSession, SttCapacityError, getOpenSttSessionCount } from "../speech/realtimeTranscribe";
import { translateTranscriptSegments, translatePlainText, isAlreadyInLanguage, isSupportedTranslationLanguage, TRANSLATION_LANGUAGES } from "../ai/translateSegments";
import { updateLiveInsights, emptyLiveInsightState, LiveInsightState } from "../ai/liveInsights";
import { indexNewSegmentsForRAG } from "../rag";
import { finalizeRecordingAnalysis } from "../pipeline/finalizeRecording";
import { assertRecordingAccess } from "../meeting/access";
import { Summary, IActionItem } from "../../models/Summary";
import { summarizeTranscript } from "../ai/summarize";
import { extractMeetingIntelligence } from "../ai/meetingIntelligence";
import { env } from "../../config/env";
import { answerMeetingQuestion, MeetingQAHistoryEntry, MeetingQAParticipant } from "../ai/meetingQA";

/**
 * Multi-participant version of services/realtime/sessionManager.ts.
 *
 * Key difference from the original single-user session manager: a Meeting
 * has ONE shared transcript fed by MULTIPLE independent microphone
 * streams, one per participant. Each participant's browser streams their
 * own mic (see IMPORTANT AUDIO LIMITATION in the product spec — a browser
 * cannot capture other participants' microphones; the LiveKit SFU carries the
 * actual call audio, NEXUS AI only ever sees audio explicitly streamed to it by each
 * participant's own client). So we run one AssemblyAI realtime session PER
 * participant PER meeting, and merge their finalized segments into a
 * single time-ordered shared transcript tagged with real display names.
 */

const RAG_INDEX_BATCH_SEGMENTS = 4;
const INSIGHT_BATCH_SEGMENTS = 8;
const INSIGHT_MIN_INTERVAL_MS = 45_000;

/** Interim (not yet final) transcript text for one participant. Replaced by the next partial, then by the final segment. */
export interface MeetingTranscriptPartial {
  meetingId: string;
  participantId: string; // LiveKit identity == NEXUS userId
  participantName: string;
  text: string;
  timestamp: string; // ISO
}

export interface MeetingRoomCallbacks {
  onTranscriptPartial: (partial: MeetingTranscriptPartial) => void;
  onTranscriptFinal: (segment: ITranscriptSegment) => void;
  // Identifies the segment by its stable segmentId (NOT a positional array
  // index — see the segmentId comment on ITranscriptSegment for why an
  // index is unsafe once multiple participants' streams can re-order the
  // shared segments array). Broadcast with the language tag; each client
  // only displays updates matching its own preferredLanguage.
  onTranslationUpdate: (segmentId: string, language: string, translatedText: string, detectedLanguage: string) => void;
  onInsightUpdate: (state: LiveInsightState) => void;
  onError: (userId: string | null, message: string) => void;
}

interface ParticipantAudio {
  userId: string;
  displayName: string;
  preferredLanguage: string;
  stt: RealtimeSttSession;
  closedByUs: boolean;
  /** Last time audio was pushed for this participant (drives idle reaping). */
  lastAudioAt: number;
}

interface ActiveMeeting {
  meetingId: string;
  recordingId: Types.ObjectId;
  mode: LiveSessionMode;
  segments: ITranscriptSegment[];
  pendingIndexing: ITranscriptSegment[];
  segmentsSinceLastInsight: number;
  lastInsightAt: number;
  insightState: LiveInsightState;
  startedAt: number;
  participants: Map<string, ParticipantAudio>; // keyed by userId string
  callbacks: MeetingRoomCallbacks;
  // Guards against duplicate finalized segments — e.g. a streaming STT
  // vendor occasionally redelivering the same "end_of_turn" event, or a
  // participant's audio momentarily reconnecting. Keyed by
  // participantId+startTime+text, which uniquely identifies "this speaker
  // said this exact text starting at this exact moment"; a second delivery
  // of the same key is a duplicate, not a new segment.
  recentSegmentKeys: Set<string>;
  // Reading-aid translation. A language is only translated while at least one participant has asked
  // to read the transcript in it (translation costs LLM quota), and results are stored next to --
  // never over -- the original text (segment.translations[language]).
  translationTargets: Map<string, Set<string>>; // language -> userIds who asked for it
  translationQueues: Map<string, ITranscriptSegment[]>;
  translationTimers: Map<string, NodeJS.Timeout>;
  translationChains: Map<string, Promise<void>>; // one LLM call at a time per language
  translating: Set<string>; // `${segmentId}|${language}` queued or in flight (avoids paying twice)
  lastTranslationErrorAt: number;
}

const activeMeetings = new Map<string, ActiveMeeting>();

/**
 * Short per-(meeting, asker) "Ask NEXUS" conversation history, kept only
 * so follow-up questions with pronouns ("When does he finish?") can be
 * resolved against the previous exchange (spec section 11). Capped at a
 * handful of turns and cleared when the meeting ends — this is
 * conversational scratch state, never treated as meeting evidence itself.
 */
const askHistory = new Map<string, MeetingQAHistoryEntry[]>();
const MAX_HISTORY_TURNS = 4;

function askHistoryKey(meetingId: string, userId: string): string {
  return `${meetingId}:${userId}`;
}

function clearAskHistoryForMeeting(meetingId: string) {
  const prefix = `${meetingId}:`;
  for (const key of askHistory.keys()) {
    if (key.startsWith(prefix)) askHistory.delete(key);
  }
}
// Guards ensureMeetingSessionStarted against the exact race the two-browser
// test would hit: two participants' join_meeting events arriving close
// together, both seeing "no recordingId yet", and each creating their own
// Recording — which would silently break the "one shared transcript"
// guarantee. Concurrent callers for the same meetingId await the same
// in-flight promise instead of racing.
const startInFlight = new Map<string, Promise<Types.ObjectId>>();

/** Idempotent: if the meeting session is already active, just returns its recordingId. */
export async function ensureMeetingSessionStarted(
  meetingId: string,
  hostId: Types.ObjectId,
  title: string,
  mode: LiveSessionMode,
  callbacks: MeetingRoomCallbacks
): Promise<Types.ObjectId> {
  const existing = activeMeetings.get(meetingId);
  if (existing) return existing.recordingId;

  const inFlight = startInFlight.get(meetingId);
  if (inFlight) return inFlight;

  const startPromise = (async () => {
    try {
      const meetingDoc = await Meeting.findById(meetingId);
      if (!meetingDoc) throw new Error("Meeting not found.");

      let recordingId = meetingDoc.recordingId;
      const resuming = Boolean(recordingId);
      if (!recordingId) {
        const recordingType = mode === "live_class" ? "lecture" : "meeting";
        const recording = await Recording.create({
          userId: hostId,
          title,
          type: recordingType,
          source: "live",
          fileUrl: "live-meeting",
          originalFileName: `${title}.live`,
          mimeType: "audio/live-stream",
          language: "auto",
          status: "transcribing",
          meetingId: meetingDoc._id,
          participantIds: [hostId],
        });
        await Transcript.create({ recordingId: recording._id, userId: hostId, language: "auto", fullText: "", segments: [] });
        recordingId = recording._id;
        meetingDoc.recordingId = recordingId;
        meetingDoc.status = "active";
        meetingDoc.startedAt = new Date();
        await meetingDoc.save();
      }

      // Resuming a meeting that already has a transcript (server restart, or
      // the in-memory session was dropped while people were still in the call):
      // reload what was already said and keep the ORIGINAL clock. Starting
      // from an empty array would make the next write overwrite the saved
      // transcript with only the new lines, and a new clock would make old
      // and new segment times inconsistent for Summary / Ask NEXUS.
      let resumedSegments: ITranscriptSegment[] = [];
      let sessionStartMs = Date.now();
      if (resuming) {
        const existingTranscript = await Transcript.findOne({ recordingId }).lean();
        resumedSegments = (existingTranscript?.segments as ITranscriptSegment[] | undefined) ?? [];
        if (meetingDoc.startedAt) sessionStartMs = meetingDoc.startedAt.getTime();
      }

      activeMeetings.set(meetingId, {
        meetingId,
        recordingId,
        mode,
        segments: resumedSegments,
        pendingIndexing: [],
        segmentsSinceLastInsight: 0,
        lastInsightAt: 0,
        insightState: emptyLiveInsightState(),
        startedAt: sessionStartMs,
        participants: new Map(),
        callbacks,
        recentSegmentKeys: new Set(resumedSegments.map((x) => segmentDedupeKey(x))),
        translationTargets: new Map(),
        translationQueues: new Map(),
        translationTimers: new Map(),
        translationChains: new Map(),
        translating: new Set(),
        lastTranslationErrorAt: 0,
      });

      return recordingId;
    } finally {
      startInFlight.delete(meetingId);
    }
  })();

  startInFlight.set(meetingId, startPromise);
  return startPromise;
}

/**
 * Starts a dedicated STT stream for ONE participant, identified by their
 * LiveKit identity (== NEXUS userId, set when the join token is minted in
 * meetingController.getMeetingToken). The speaker name is looked up from
 * the authoritative Meeting.participants record, never guessed by an LLM
 * and never taken from the audio itself.
 *
 * Idempotent: if a live stream already exists for this participant it is
 * reused, so a track re-subscribe / reconnect cannot create a second stream.
 */
/** "ready" = stream is open; "retry" = temporarily unavailable (backing off); "denied" = not an authorized participant. */
export type SttEnsureResult = "ready" | "retry" | "denied";

// Per-participant reconnect backoff. Without this, a vendor rejection (e.g.
// "Too many concurrent sessions") closed the socket, the very next audio
// frame (~100/sec) opened a new one, which was rejected again... a connection
// storm that kept the vendor's concurrency count pinned at its limit.
interface SttRetryState {
  attempts: number;
  notBefore: number;
  reportedAt: number;
}
const sttRetry = new Map<string, SttRetryState>();
const sttKey = (meetingId: string, userId: string) => `${meetingId}:${userId}`;
const STT_REPORT_INTERVAL_MS = 60_000;

function registerSttFailure(meetingId: string, userId: string, capacity: boolean, detail: string) {
  const key = sttKey(meetingId, userId);
  const now = Date.now();
  const prev = sttRetry.get(key) ?? { attempts: 0, notBefore: 0, reportedAt: 0 };
  const attempts = prev.attempts + 1;
  const base = capacity ? 10_000 : 1_000;
  const max = capacity ? 60_000 : 30_000;
  const delay = Math.min(max, base * 2 ** (attempts - 1)) * (1 + Math.random() * 0.2);
  const state: SttRetryState = { attempts, notBefore: now + delay, reportedAt: prev.reportedAt };
  console.warn(
    `[stt] ${capacity ? "capacity" : "failure"} for ${key} (attempt ${attempts}, retry in ${Math.round(delay / 1000)}s, ` +
      `${getOpenSttSessionCount()} stream(s) open): ${detail}`
  );

  const meeting = activeMeetings.get(meetingId);
  if (meeting && now - prev.reportedAt > STT_REPORT_INTERVAL_MS) {
    state.reportedAt = now;
    const name = meeting.participants.get(userId)?.displayName;
    meeting.callbacks.onError(
      userId,
      capacity
        ? `Live transcription is at its speech-to-text session limit right now (${detail}). NEXUS retries automatically in about ${Math.round(
            delay / 1000
          )}s; video, chat and people are unaffected.`
        : `Live transcription${name ? ` for ${name}` : ""} was interrupted (${detail}). Retrying automatically.`
    );
  }
  sttRetry.set(key, state);
}

/**
 * Starts a dedicated STT stream for ONE participant, identified by their
 * LiveKit identity (== NEXUS userId, set when the join token is minted in
 * meetingController.getMeetingToken). The speaker name is looked up from
 * the authoritative Meeting.participants record, never guessed by an LLM
 * and never taken from the audio itself.
 *
 * Idempotent: if a live stream already exists for this participant it is
 * reused, so a track re-subscribe / reconnect cannot create a second stream.
 * While a recent attempt failed it returns "retry" without touching the
 * vendor, so callers can call this per audio frame safely.
 */
export async function ensureParticipantStt(meetingId: string, userId: string): Promise<SttEnsureResult> {
  const meeting = activeMeetings.get(meetingId);
  if (!meeting) return "denied";
  if (meeting.participants.has(userId)) return "ready";

  const retry = sttRetry.get(sttKey(meetingId, userId));
  if (retry && Date.now() < retry.notBefore) return "retry";

  const inFlightKey = `${meetingId}:${userId}`;
  const pending = attachInFlight.get(inFlightKey);
  if (pending) return pending;

  const p = (async (): Promise<SttEnsureResult> => {
    try {
      const doc = await Meeting.findById(meetingId).select("participants").lean();
      const row = doc?.participants.find((x) => x.userId.toString() === userId);
      if (!row) return "denied"; // not an authorized participant of this meeting -> never transcribe
      if (!activeMeetings.has(meetingId)) return "denied";
      if (meeting.participants.has(userId)) return "ready";
      try {
        attachParticipantAudio(meetingId, userId, row.displayName, row.preferredLanguage);
        return "ready";
      } catch (err: any) {
        registerSttFailure(meetingId, userId, err instanceof SttCapacityError, err?.message || "unknown error");
        return "retry";
      }
    } finally {
      attachInFlight.delete(inFlightKey);
    }
  })();
  attachInFlight.set(inFlightKey, p);
  return p;
}
const attachInFlight = new Map<string, Promise<SttEnsureResult>>();

/**
 * Optional per-participant "I speak" override (ISO codes). It only BIASES recognition toward those
 * languages for that participant's stream (never restricts it). No entry == the server default
 * (SONIOX_LANGUAGE_HINTS, or pure auto-detection when that is empty).
 */
const SPOKEN_LANGUAGE_CODES = new Set(Object.values(TRANSLATION_LANGUAGES));
const spokenHints = new Map<string, string[]>();

/** Sets (or, with an empty list, clears) a participant's spoken-language hint and re-opens their stream so it takes effect. */
export function setSpokenLanguages(meetingId: string, userId: string, codes: string[]) {
  const clean = Array.from(new Set(codes.map((c) => String(c).toLowerCase()).filter((c) => SPOKEN_LANGUAGE_CODES.has(c))));
  if (clean.length === 0) spokenHints.delete(sttKey(meetingId, userId));
  else spokenHints.set(sttKey(meetingId, userId), clean);
  // Close the current stream gracefully (it flushes what was said); the next voiced audio reopens it with the new hints.
  detachParticipantAudio(meetingId, userId);
}

// Closes STT streams that have received no audio for a while (muted / silent
// participants), freeing their vendor slot. They re-open on the next audio.
let idleReaper: NodeJS.Timeout | undefined;
function ensureIdleReaper() {
  if (idleReaper || env.sttIdleCloseMs <= 0) return;
  idleReaper = setInterval(() => {
    const now = Date.now();
    for (const meeting of activeMeetings.values()) {
      for (const [userId, p] of meeting.participants) {
        if (now - p.lastAudioAt > env.sttIdleCloseMs) {
          p.closedByUs = true;
          p.stt.close();
          meeting.participants.delete(userId);
        }
      }
    }
  }, 15_000);
  idleReaper.unref();
}

export function attachParticipantAudio(
  meetingId: string,
  userId: string,
  rawDisplayName: string,
  preferredLanguage: string
) {
  // The speaker label comes ONLY from the verified LiveKit identity (userId). If the stored name is missing,
  // say so plainly instead of printing an empty or made-up name.
  const displayName = rawDisplayName?.trim() || "Unknown speaker";
  const meeting = activeMeetings.get(meetingId);
  if (!meeting) throw new Error("Meeting session is not active.");

  // Replace any stale stream for this participant (e.g. reconnect).
  const stale = meeting.participants.get(userId);
  if (stale) {
    stale.closedByUs = true;
    stale.stt.close();
  }

  let entry: ParticipantAudio | undefined;
  let lastPartialText = "";
  // Each stream reports at most one failure to the backoff tracker, even if
  // both an error frame and the socket close arrive for it.
  let failureNoted = false;
  const noteFailure = (capacity: boolean, detail: string) => {
    if (failureNoted) return;
    failureNoted = true;
    registerSttFailure(meetingId, userId, capacity, detail);
  };
  const stt = startRealtimeTranscription(
    (event) => {
      const startMs = meeting.startedAt + event.startTime * 1000;
      if (event.type === "partial") {
        // Interim text for the CURRENT turn only; empty text clears it on the client.
        if (event.text === lastPartialText) return;
        lastPartialText = event.text;
        meeting.callbacks.onTranscriptPartial({
          meetingId,
          participantId: userId,
          participantName: displayName,
          text: event.text,
          timestamp: new Date(startMs).toISOString(),
        });
        return;
      }
      lastPartialText = "";
      const segment: ITranscriptSegment = {
        speaker: displayName,
        participantId: userId,
        segmentId: randomUUID(),
        meetingId,
        timestamp: new Date(startMs),
        startTime: event.startTime,
        endTime: event.endTime,
        text: event.text,
        language: event.detectedLanguage, // as reported by the STT vendor; never overwritten by translation
        languages: event.languages,
        confidence: event.confidence,
        lowConfidence: event.confidence !== undefined ? event.confidence < env.sttMinConfidence : undefined,
      };
      handleFinalSegment(meetingId, segment).catch((err) =>
        meeting.callbacks.onError(userId, `Failed to process transcript segment: ${err.message}`)
      );
    },
    (err) => {
      // Capacity rejections go through the backoff tracker (which reports once
      // per minute); other errors are forwarded as before.
      if (err instanceof SttCapacityError) noteFailure(true, err.message);
      else meeting.callbacks.onError(userId, err.message);
    },
    meeting.startedAt,
    (info) => {
      // Whatever the reason, an unfinished interim line must not stay on screen.
      if (lastPartialText) {
        lastPartialText = "";
        meeting.callbacks.onTranscriptPartial({
          meetingId,
          participantId: userId,
          participantName: displayName,
          text: "",
          timestamp: new Date().toISOString(),
        });
      }
      // Vendor socket closed. If we didn't ask for it, forget the stream so a
      // later audio frame can open a new one -- but if it never worked or died
      // within seconds, back off first instead of reopening immediately.
      if (entry && !entry.closedByUs && meeting.participants.get(userId) === entry) {
        meeting.participants.delete(userId);
        if (info.capacity || !info.wasReady || info.lifetimeMs < 5000) {
          noteFailure(info.capacity, info.reason || `closed with code ${info.code}`);
        }
      }
    },
    () => {
      // Stream is healthy: clear any backoff.
      sttRetry.delete(sttKey(meetingId, userId));
    },
    {
      languageHints: spokenHints.get(sttKey(meetingId, userId)),
      // The participant's own name is the most likely proper noun in their speech.
      contextTerms: [displayName],
    }
  );

  entry = { userId, displayName, preferredLanguage, stt, closedByUs: false, lastAudioAt: Date.now() };
  meeting.participants.set(userId, entry);
  ensureIdleReaper();
}

export function updateParticipantLanguage(meetingId: string, userId: string, preferredLanguage: string) {
  const p = activeMeetings.get(meetingId)?.participants.get(userId);
  if (p) p.preferredLanguage = preferredLanguage;
}

export function detachParticipantAudio(meetingId: string, userId: string) {
  sttRetry.delete(sttKey(meetingId, userId));
  const meeting = activeMeetings.get(meetingId);
  const p = meeting?.participants.get(userId);
  if (!p) return;
  p.closedByUs = true;
  p.stt.close();
  meeting!.participants.delete(userId);
}

export function pushParticipantAudioChunk(meetingId: string, userId: string, chunk: Buffer, capturedAtMs?: number) {
  const p = activeMeetings.get(meetingId)?.participants.get(userId);
  if (!p) return;
  p.lastAudioAt = Date.now();
  p.stt.sendAudioChunk(chunk, capturedAtMs);
}

/**
 * Inserts a newly finalized segment into `segments` at the position its
 * startTime belongs, rather than assuming arrival order. Two independent
 * per-participant STT streams can finalize out of chronological order
 * (e.g. participant B's short "yeah" finalizes before participant A's
 * longer overlapping sentence that started earlier), so arrival order is
 * not a reliable proxy for speaking order. Segments almost always arrive
 * close to chronological, so we scan backward from the end — O(1) in the
 * common case, O(n) worst case, which is fine at meeting-transcript scale.
 */
export function insertInOrder(segments: ITranscriptSegment[], segment: ITranscriptSegment) {
  let i = segments.length;
  while (i > 0 && segments[i - 1].startTime > segment.startTime) i--;
  segments.splice(i, 0, segment);
}

const normalizeForCompare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * True when `segment` is a re-delivery of speech that is already in the transcript: the same
 * participant, overlapping in time with a recent segment, saying the same words (or a fragment of
 * them). One person cannot say two different things at the same moment, so an overlap with
 * identical/contained text is a duplicate, not a repeat. Legit repeats ("yes ... yes") are
 * separated in time and are kept. Exported for tests.
 */
export function isDuplicateOfRecent(segments: ITranscriptSegment[], segment: ITranscriptSegment): boolean {
  const n = normalizeForCompare(segment.text);
  if (!n) return true;
  let compared = 0;
  for (let i = segments.length - 1; i >= 0 && compared < 6; i--) {
    const prev = segments[i];
    if (prev.participantId !== segment.participantId) continue;
    compared++;
    const overlaps = segment.startTime <= prev.endTime + 0.3 && segment.endTime >= prev.startTime - 0.3;
    if (!overlaps) continue;
    const pn = normalizeForCompare(prev.text);
    if (pn === n || pn.includes(n)) return true;
  }
  return false;
}

/** Exported for tests: the exact key used to detect a duplicate finalized segment. */
export function segmentDedupeKey(segment: Pick<ITranscriptSegment, "participantId" | "startTime" | "text">): string {
  return `${segment.participantId ?? ""}|${segment.startTime.toFixed(2)}|${segment.text}`;
}

async function handleFinalSegment(meetingId: string, segment: ITranscriptSegment) {
  const meeting = activeMeetings.get(meetingId);
  if (!meeting) return;

  // Drop exact duplicates (same speaker, same start time, same text) before
  // they ever reach the shared transcript. Some streaming STT vendors can
  // redeliver the same finalized "turn" (e.g. around a brief reconnect), and
  // without this guard that redelivery would show up as a duplicated line
  // in the transcript for that participant.
  const dedupeKey = segmentDedupeKey(segment);
  if (meeting.recentSegmentKeys.has(dedupeKey)) return;
  if (isDuplicateOfRecent(meeting.segments, segment)) return;
  meeting.recentSegmentKeys.add(dedupeKey);

  insertInOrder(meeting.segments, segment);
  // Phase 3/4 work (translation, RAG indexing, live insights) only
  // accumulates when the AI add-on is on. Phase 2 stores the transcript only.
  if (env.enableMeetingAi) {
    meeting.pendingIndexing.push(segment);
    meeting.segmentsSinceLastInsight += 1;
  }
  // Translation is independent of ENABLE_MEETING_AI: it runs for whichever languages people asked for.
  queueForTranslation(meeting, segment);

  // Live captions still show each segment the moment it finalizes (see
  // onTranscriptFinal below) — only the persisted/shared transcript needs
  // to be chronologically ordered. We rewrite the full segments array
  // (rather than $push) so the DB always mirrors the reordered in-memory
  // array; at meeting-transcript scale this stays cheap.
  meeting.callbacks.onTranscriptFinal(segment);

  await Transcript.findOneAndUpdate(
    { recordingId: meeting.recordingId },
    { $set: { segments: meeting.segments, fullText: meeting.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n") } }
  );

  if (!env.enableMeetingAi) return;

  // --- Batched RAG indexing (recording-scoped; host userId used only as metadata, not for access control) ---
  if (meeting.pendingIndexing.length >= RAG_INDEX_BATCH_SEGMENTS) {
    const batch = meeting.pendingIndexing.splice(0, meeting.pendingIndexing.length);
    const meetingDoc = await Meeting.findById(meetingId).select("hostId").lean();
    if (meetingDoc) {
      indexNewSegmentsForRAG(meeting.recordingId, meetingDoc.hostId, batch).catch((err) =>
        meeting.callbacks.onError(null, `Live indexing failed: ${err.message}`)
      );
    }
  }

  // --- Batched shared AI insights, computed over ALL participants' merged transcript window ---
  const now = Date.now();
  const dueByCount = meeting.segmentsSinceLastInsight >= INSIGHT_BATCH_SEGMENTS;
  const dueByTime = now - meeting.lastInsightAt >= INSIGHT_MIN_INTERVAL_MS;
  if (dueByCount && dueByTime) {
    const windowText = meeting.segments.slice(-INSIGHT_BATCH_SEGMENTS).map((s) => `${s.speaker}: ${s.text}`).join("\n");
    meeting.segmentsSinceLastInsight = 0;
    meeting.lastInsightAt = now;

    updateLiveInsights(meeting.insightState, windowText, meeting.mode)
      .then((updated) => {
        meeting.insightState = updated;
        meeting.callbacks.onInsightUpdate(updated);
      })
      .catch((err) => meeting.callbacks.onError(null, `Live insight update failed: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Reading-aid translation of finalized segments
// ---------------------------------------------------------------------------

const TRANSLATION_BATCH_SEGMENTS = 3;
const TRANSLATION_FLUSH_MS = 2500;
const BACKFILL_BATCH_SEGMENTS = 10;
const BACKFILL_MAX_SEGMENTS = 300;
const TRANSLATION_ERROR_REPORT_MS = 30_000;

function languagesToTranslateInto(meeting: ActiveMeeting): Set<string> {
  const langs = new Set<string>(meeting.translationTargets.keys());
  if (env.enableMeetingAi) {
    // Legacy behaviour of the full AI add-on: also translate into each active speaker's preferred language.
    for (const p of meeting.participants.values()) if (isSupportedTranslationLanguage(p.preferredLanguage)) langs.add(p.preferredLanguage);
  }
  return langs;
}

function queueForTranslation(meeting: ActiveMeeting, segment: ITranscriptSegment) {
  if (!segment.segmentId) return;
  for (const language of languagesToTranslateInto(meeting)) {
    enqueueTranslation(meeting, segment, language);
  }
}

function enqueueTranslation(meeting: ActiveMeeting, segment: ITranscriptSegment, language: string) {
  if (!segment.segmentId || segment.translations?.[language] || isAlreadyInLanguage(segment, language)) return;
  const key = `${segment.segmentId}|${language}`;
  if (meeting.translating.has(key)) return;
  meeting.translating.add(key);
  const queue = meeting.translationQueues.get(language) ?? [];
  queue.push(segment);
  meeting.translationQueues.set(language, queue);
  if (queue.length >= TRANSLATION_BATCH_SEGMENTS) {
    flushTranslationQueue(meeting, language);
  } else if (!meeting.translationTimers.has(language)) {
    const timer = setTimeout(() => flushTranslationQueue(meeting, language), TRANSLATION_FLUSH_MS);
    timer.unref?.();
    meeting.translationTimers.set(language, timer);
  }
}

function flushTranslationQueue(meeting: ActiveMeeting, language: string) {
  const timer = meeting.translationTimers.get(language);
  if (timer) clearTimeout(timer);
  meeting.translationTimers.delete(language);
  const batch = meeting.translationQueues.get(language) ?? [];
  meeting.translationQueues.set(language, []);
  if (batch.length === 0) return;
  // One LLM call at a time per language (the free LLM tier is rate-limited), in arrival order.
  const prev = meeting.translationChains.get(language) ?? Promise.resolve();
  meeting.translationChains.set(language, prev.then(() => translateAndStore(meeting, batch, language)));
}

async function translateAndStore(meeting: ActiveMeeting, batch: ITranscriptSegment[], language: string) {
  try {
    const results = await translateTranscriptSegments(batch, language);
    const writes: any[] = [];
    for (const r of results) {
      const segment = batch[r.index];
      if (!segment?.segmentId) continue;
      // Stored beside the original; `text` and `language` are never touched by translation.
      segment.translations = { ...(segment.translations ?? {}), [language]: r.translatedText };
      meeting.callbacks.onTranslationUpdate(segment.segmentId, language, r.translatedText, segment.language ?? "");
      writes.push({
        updateOne: {
          filter: { recordingId: meeting.recordingId, "segments.segmentId": segment.segmentId },
          update: { $set: { [`segments.$.translations.${language}`]: r.translatedText } },
        },
      });
    }
    // Persist in the background, in one write: readers already have the text, and a slow database
    // must never hold up the next translation batch. (The full segments array is also rewritten on
    // every new final line, so a missed write here is repaired by the next one.)
    if (writes.length > 0) void Promise.resolve(Transcript.bulkWrite(writes)).catch(() => {});
  } catch (err: any) {
    // Leave those segments untranslated (the UI says so); never substitute made-up text.
    const now = Date.now();
    if (now - meeting.lastTranslationErrorAt > TRANSLATION_ERROR_REPORT_MS) {
      meeting.lastTranslationErrorAt = now;
      meeting.callbacks.onError(null, `Translation to ${language} is unavailable right now: ${err?.message || "unknown error"}`);
    }
  } finally {
    for (const s of batch) if (s.segmentId) meeting.translating.delete(`${s.segmentId}|${language}`);
  }
}

/** Drops every translation request this user had open in the meeting (leave, or switched back to the original view). */
export function clearTranslationTarget(meetingId: string, userId: string) {
  const meeting = activeMeetings.get(meetingId);
  if (!meeting) return;
  for (const [language, users] of meeting.translationTargets) {
    users.delete(userId);
    if (users.size === 0) meeting.translationTargets.delete(language);
  }
}

/**
 * The user wants to read the transcript in `language` (null = original only). Existing finalized
 * lines that have no translation yet are translated in the background (newest ~300), and new lines
 * are translated as they finalize for as long as anyone still wants that language.
 */
export function setTranslationTarget(meetingId: string, userId: string, language: string | null) {
  const meeting = activeMeetings.get(meetingId);
  if (!meeting) return;
  clearTranslationTarget(meetingId, userId);
  if (language === null) return;
  if (!isSupportedTranslationLanguage(language)) throw new Error(`Unsupported translation language "${language}".`);

  const users = meeting.translationTargets.get(language) ?? new Set<string>();
  users.add(userId);
  meeting.translationTargets.set(language, users);

  const missing = meeting.segments
    .filter((s) => s.segmentId && !s.translations?.[language] && !isAlreadyInLanguage(s, language))
    .slice(-BACKFILL_MAX_SEGMENTS);
  for (let i = 0; i < missing.length; i += BACKFILL_BATCH_SEGMENTS) {
    const batch = missing.slice(i, i + BACKFILL_BATCH_SEGMENTS).filter((s) => !meeting.translating.has(`${s.segmentId}|${language}`));
    if (batch.length === 0) continue;
    for (const s of batch) meeting.translating.add(`${s.segmentId}|${language}`);
    const prev = meeting.translationChains.get(language) ?? Promise.resolve();
    meeting.translationChains.set(language, prev.then(() => translateAndStore(meeting, batch, language)));
  }
}

/**
 * Ask NEXUS, scoped to the shared meeting transcript. Grounds
 * speaker-specific, time-window, "what did I miss", and self-referential
 * questions directly in the raw per-speaker transcript (see
 * services/ai/meetingQA.ts) for accuracy, and falls back to the existing
 * chunk-based RAG for open-ended questions. The answer is translated into
 * the asker's preferred language last, so grounding/refusal logic always
 * runs against the original English/auto-detected transcript text.
 */
export async function askAboutMeeting(
  meetingId: string,
  askerUserId: Types.ObjectId,
  question: string,
  askerLanguage: string
): Promise<{ answer: string; sources: any[]; segmentCount: number; timings: { contextMs: number; answerMs: number; translateMs: number; totalMs: number } }> {
  const startedAt = Date.now();
  const meeting = activeMeetings.get(meetingId);
  const meetingDoc = await Meeting.findById(meetingId);
  const recordingId = meeting?.recordingId ?? meetingDoc?.recordingId;
  if (!recordingId || !meetingDoc) {
    return { answer: "I couldn't find that information in this meeting.", sources: [], segmentCount: 0, timings: { contextMs: Date.now() - startedAt, answerMs: 0, translateMs: 0, totalMs: Date.now() - startedAt } };
  }

  // Re-checked here (not just at socket join time) so a question can never be answered
  // for a user who was never actually a participant on this recording.
  await assertRecordingAccess(recordingId, askerUserId);

  const asker = meetingDoc.participants.find((p) => p.userId.equals(askerUserId));
  const askerDisplayName = asker?.displayName || "You";

  const participants: MeetingQAParticipant[] = meetingDoc.participants.map((p) => ({
    userId: p.userId.toString(),
    displayName: p.displayName,
    joinedAt: p.joinedAt,
  }));

  // Segments: prefer the live in-memory shared transcript (already
  // chronologically merged across every participant's stream); if the
  // meeting has already ended, read the persisted Transcript instead so
  // Ask NEXUS keeps working against the completed transcript afterward.
  let segments = meeting?.segments;
  if (!segments) {
    const transcript = await Transcript.findOne({ recordingId }).lean();
    segments = transcript?.segments || [];
  }

  const meetingStartedAtMs = meeting?.startedAt ?? (meetingDoc.startedAt ? meetingDoc.startedAt.getTime() : Date.now());

  let actionItems = meeting?.insightState.actionItems || [];
  if (actionItems.length === 0) {
    const summary = await Summary.findOne({ recordingId }).select("actionItems").lean();
    if (summary) actionItems = summary.actionItems;
  }

  const historyKey = askHistoryKey(meetingId, askerUserId.toString());
  const history = askHistory.get(historyKey) || [];

  const contextMs = Date.now() - startedAt; // database reads + building the context
  const answerStartedAt = Date.now();
  const result = await answerMeetingQuestion({
    recordingId,
    askerUserId,
    askerDisplayName,
    question,
    segments,
    meetingStartedAtMs,
    participants,
    actionItems,
    history,
  });
  const answerMs = Date.now() - answerStartedAt; // routing + retrieval + the model call (see the [llm] line for the model alone)

  // Update this asker's short conversation history (English-language answer,
  // BEFORE translation, so future pronoun resolution stays consistent).
  const updatedHistory = [...history, { question, answer: result.answer }].slice(-MAX_HISTORY_TURNS);
  askHistory.set(historyKey, updatedHistory);

  const translateStartedAt = Date.now();
  if (askerLanguage && askerLanguage !== "English") {
    try {
      result.answer = await translatePlainText(result.answer, askerLanguage);
    } catch {
      // Still return the answer rather than losing it, but say plainly that it is not in the language they chose.
      result.answer = `${result.answer}\n\n(Couldn't translate this answer into ${askerLanguage} right now, so it is shown in English.)`;
    }
  }
  const translateMs = Date.now() - translateStartedAt;
  const timings = { contextMs, answerMs, translateMs, totalMs: Date.now() - startedAt };
  console.log(
    `[ask] ${meetingId}: ${segments.length} transcript lines | context ${timings.contextMs} ms | answer ${timings.answerMs} ms | translate ${timings.translateMs} ms | total ${timings.totalMs} ms`
  );
  return { ...result, segmentCount: segments.length, timings };
}

// ---------------------------------------------------------------------------
// NEXUS AI: on-demand live meeting summary
// ---------------------------------------------------------------------------

/** Errors the UI can show verbatim (as opposed to unexpected server errors). */
export class MeetingAiError extends Error {
  constructor(message: string, public code: "NO_TRANSCRIPT" | "UNAVAILABLE" | "BUSY") {
    super(message);
  }
}

export interface MeetingLiveSummary {
  meetingId: string;
  generatedAt: string; // ISO
  language: string;
  segmentCount: number; // how many transcript lines this summary is based on
  speakers: string[]; // everyone who has actually spoken so far
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  topics: string[];
  decisions: string[];
  actionItems: IActionItem[];
  questions: string[];
}

interface CachedSummary {
  segmentKey: string; // changes whenever the transcript changes
  generatedAtMs: number;
  summary: MeetingLiveSummary;
}

// One cached summary per (meeting, language). Everyone in the meeting shares it,
// so five people pressing "Summary" cost one LLM round, not five.
const summaryCache = new Map<string, CachedSummary>();
const summaryInFlight = new Map<string, Promise<MeetingLiveSummary>>();

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

function clearSummaryCacheForMeeting(meetingId: string) {
  const prefix = `${meetingId}:`;
  for (const key of summaryCache.keys()) if (key.startsWith(prefix)) summaryCache.delete(key);
}

/**
 * Summary of the meeting SO FAR, built from the shared speaker-tagged
 * transcript (the same segments the Transcript tab shows). Speaker names come
 * from each participant's own microphone track, so every point can be
 * attributed to the right person. Works with the live in-memory transcript
 * and, after the meeting ends, with the persisted one.
 */
export async function generateLiveMeetingSummary(
  meetingId: string,
  requesterUserId: Types.ObjectId,
  language: string
): Promise<MeetingLiveSummary> {
  const meetingDoc = await Meeting.findById(meetingId).select("recordingId").lean();
  const live = activeMeetings.get(meetingId);
  const recordingId = live?.recordingId ?? meetingDoc?.recordingId;
  if (!recordingId) throw new MeetingAiError("The meeting hasn't started recording yet.", "NO_TRANSCRIPT");

  // Re-checked here (not just at join time) so a summary can never be produced for a non-participant.
  await assertRecordingAccess(recordingId, requesterUserId);

  let segments = live?.segments;
  if (!segments) {
    const persisted = await Transcript.findOne({ recordingId }).lean();
    segments = (persisted?.segments as ITranscriptSegment[] | undefined) ?? [];
  }
  if (segments.length === 0) {
    throw new MeetingAiError("Nobody has spoken yet, so there is nothing to summarize.", "NO_TRANSCRIPT");
  }

  const lang = language || "English";
  const cacheKey = `${meetingId}:${lang}`;
  const last = segments[segments.length - 1];
  const segmentKey = `${segments.length}|${last.segmentId ?? last.startTime}`;

  const cached = summaryCache.get(cacheKey);
  // Reuse only when the transcript is identical; if anything new was said the
  // summary must reflect it (the per-socket rate limit protects LLM quota).
  if (cached && cached.segmentKey === segmentKey) {
    return cached.summary;
  }

  const inFlightKey = `${cacheKey}:${segmentKey}`;
  const running = summaryInFlight.get(inFlightKey);
  if (running) return running;

  // Snapshot now: the live array keeps growing while the LLM calls run.
  const snapshot = segments.slice();
  // Always the ORIGINAL recognized text (never a translation). Lines the recognizer was unsure about are
  // marked so the model does not build facts on them.
  const transcriptText = snapshot
    .map((s) => `[${s.speaker}]: ${s.text}${s.lowConfidence ? " (low-confidence recognition)" : ""}`)
    .join("\n");

  const job = (async () => {
    try {
      const [summary, intelligence] = await Promise.all([
        summarizeTranscript(transcriptText, lang),
        extractMeetingIntelligence(transcriptText, lang),
      ]);
      const result: MeetingLiveSummary = {
        meetingId,
        generatedAt: new Date().toISOString(),
        language: lang,
        segmentCount: snapshot.length,
        speakers: Array.from(new Set(snapshot.map((s) => s.speaker))),
        shortSummary: typeof summary.shortSummary === "string" ? summary.shortSummary : "",
        detailedSummary: typeof summary.detailedSummary === "string" ? summary.detailedSummary : "",
        keyPoints: asStringArray(summary.keyPoints),
        topics: asStringArray(summary.topics),
        decisions: asStringArray(intelligence.decisions),
        actionItems: (Array.isArray(intelligence.actionItems) ? intelligence.actionItems : [])
          .filter((a: any) => a && typeof a.task === "string" && a.task.trim())
          .map((a: any) => ({
            task: a.task.trim(),
            owner: typeof a.owner === "string" && a.owner.trim() ? a.owner.trim() : "Not specified",
            deadline: typeof a.deadline === "string" && a.deadline.trim() ? a.deadline.trim() : "Not specified",
            priority: a.priority ?? "not specified",
          })),
        questions: asStringArray(intelligence.questions),
      };
      summaryCache.set(cacheKey, { segmentKey, generatedAtMs: Date.now(), summary: result });
      return result;
    } catch (err: any) {
      throw new MeetingAiError(err?.message || "Couldn't generate the summary right now.", "UNAVAILABLE");
    } finally {
      summaryInFlight.delete(inFlightKey);
    }
  })();
  summaryInFlight.set(inFlightKey, job);
  return job;
}

export function getMeetingInsightState(meetingId: string): LiveInsightState | undefined {
  return activeMeetings.get(meetingId)?.insightState;
}

export function getMeetingRecordingId(meetingId: string): Types.ObjectId | undefined {
  return activeMeetings.get(meetingId)?.recordingId;
}

export function isMeetingActive(meetingId: string): boolean {
  return activeMeetings.has(meetingId);
}

export function activeParticipantCount(meetingId: string): number {
  return activeMeetings.get(meetingId)?.participants.size ?? 0;
}

/** Ends the shared meeting: closes every participant's STT stream, flushes pending work, finalizes the report. */
export async function endMeetingSession(meetingId: string): Promise<Types.ObjectId | null> {
  const meeting = activeMeetings.get(meetingId);
  if (!meeting) return null;

  // Let each participant's recogniser deliver the sentence it is still working on BEFORE the meeting is
  // removed from memory; otherwise the last words spoken before "End meeting" would be dropped.
  const flushing: Promise<void>[] = [];
  for (const p of meeting.participants.values()) {
    p.closedByUs = true;
    flushing.push(p.stt.closeAndFlush(10_000).catch(() => {}));
  }
  await Promise.all(flushing);
  meeting.participants.clear();
  for (const key of sttRetry.keys()) if (key.startsWith(`${meetingId}:`)) sttRetry.delete(key);
  activeMeetings.delete(meetingId);
  for (const timer of meeting.translationTimers.values()) clearTimeout(timer);
  for (const key of spokenHints.keys()) if (key.startsWith(`${meetingId}:`)) spokenHints.delete(key);
  clearAskHistoryForMeeting(meetingId);
  clearSummaryCacheForMeeting(meetingId);

  if (meeting.pendingIndexing.length > 0) {
    const meetingDoc = await Meeting.findById(meetingId).select("hostId").lean();
    if (meetingDoc) {
      await indexNewSegmentsForRAG(meeting.recordingId, meetingDoc.hostId, meeting.pendingIndexing).catch(() => {});
    }
  }

  await Meeting.findByIdAndUpdate(meetingId, { status: "ended", endedAt: new Date() });

  // Final transcript is already persisted incrementally; write it once more
  // authoritatively (ordered) so meeting history is complete even if a
  // late segment's incremental write raced the shutdown.
  await Transcript.findOneAndUpdate(
    { recordingId: meeting.recordingId },
    { $set: { segments: meeting.segments, fullText: meeting.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n") } }
  ).catch(() => {});

  if (!env.nexusAiActive) {
    // Transcript only: NEXUS AI is off, so no LLM analysis.
    await Recording.findByIdAndUpdate(
      meeting.recordingId,
      meeting.segments.length === 0
        ? { status: "failed", errorMessage: "No speech was detected during this meeting." }
        : { status: "transcribed" }
    );
    return meeting.recordingId;
  }

  if (meeting.segments.length === 0) {
    await Recording.findByIdAndUpdate(meeting.recordingId, {
      status: "failed",
      errorMessage: "No speech was detected during this meeting.",
    });
    return meeting.recordingId;
  }

  try {
    await finalizeRecordingAnalysis(meeting.recordingId);
  } catch (err: any) {
    // The transcript itself is saved and fine; only the AI report failed (e.g. LLM
    // rate limit). Don't mark the whole meeting "failed" and hide a good transcript.
    await Recording.findByIdAndUpdate(meeting.recordingId, { status: "transcribed", errorMessage: `Summary unavailable: ${err.message}` });
  }

  return meeting.recordingId;
}


/** In-memory ordered segments for a live meeting (undefined if not live). */
export function getLiveSegments(meetingId: string): ITranscriptSegment[] | undefined {
  return activeMeetings.get(meetingId)?.segments;
}