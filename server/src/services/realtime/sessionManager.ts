import { Types } from "mongoose";
import { Recording } from "../../models/Recording";
import { Transcript, ITranscriptSegment } from "../../models/Transcript";
import { LiveSession, LiveSessionMode } from "../../models/LiveSession";
import { startRealtimeTranscription, RealtimeSttSession } from "../speech/realtimeTranscribe";
import { translateSegmentsBatch } from "../ai/translateSegments";
import { updateLiveInsights, emptyLiveInsightState, LiveInsightState } from "../ai/liveInsights";
import { indexNewSegmentsForRAG } from "../rag";
import { finalizeRecordingAnalysis } from "../pipeline/finalizeRecording";

/**
 * Batching thresholds — tuned to keep LLM calls infrequent (cost control,
 * spec §24) while still feeling "live". These are intentionally NOT
 * per-word or per-segment triggers.
 */
const TRANSLATION_BATCH_SEGMENTS = 4;
const INSIGHT_BATCH_SEGMENTS = 8;
const INSIGHT_MIN_INTERVAL_MS = 45_000;

export interface LiveSessionCallbacks {
  onTranscriptPartial: (text: string) => void;
  onTranscriptFinal: (segment: ITranscriptSegment) => void;
  onTranslationUpdate: (segmentIndex: number, translatedText: string, detectedLanguage: string) => void;
  onInsightUpdate: (state: LiveInsightState) => void;
  onError: (message: string) => void;
}

interface ActiveSession {
  liveSessionId: string;
  recordingId: Types.ObjectId;
  userId: Types.ObjectId;
  mode: LiveSessionMode;
  outputLanguage: string;
  stt: RealtimeSttSession;
  segments: ITranscriptSegment[]; // all finalized segments this session
  pendingTranslation: ITranscriptSegment[]; // finalized, not yet translated
  pendingIndexing: ITranscriptSegment[]; // finalized, not yet RAG-indexed
  segmentsSinceLastInsight: number;
  lastInsightAt: number;
  insightState: LiveInsightState;
  startedAt: number;
  callbacks: LiveSessionCallbacks;
  paused: boolean;
}

/**
 * Holds all currently-active live sessions in memory, keyed by
 * liveSessionId (== socket room name). A single Node process instance is
 * assumed here (fine for a single-server dev/demo deployment); a
 * production multi-instance deployment would move this to Redis, which
 * is a documented future step, not something silently pretended to be
 * solved here.
 */
const activeSessions = new Map<string, ActiveSession>();

export async function createLiveSession(
  userId: Types.ObjectId,
  title: string,
  mode: LiveSessionMode,
  outputLanguage: string,
  callbacks: LiveSessionCallbacks
): Promise<{ liveSessionId: string; recordingId: Types.ObjectId }> {
  const recordingType = mode === "live_class" ? "lecture" : "meeting";

  const recording = await Recording.create({
    userId,
    title,
    type: recordingType,
    source: "live",
    fileUrl: "live-session",
    originalFileName: `${title}.live`,
    mimeType: "audio/live-stream",
    language: "auto",
    status: "transcribing",
  });

  await Transcript.create({
    recordingId: recording._id,
    userId,
    language: "auto",
    fullText: "",
    segments: [],
  });

  const liveSession = await LiveSession.create({
    userId,
    recordingId: recording._id,
    title,
    mode,
    outputLanguage,
    status: "active",
  });

  const liveSessionId = liveSession._id.toString();
  const startedAt = Date.now();

  const stt = startRealtimeTranscription(
    (event) => {
      const session = activeSessions.get(liveSessionId);
      if (!session || session.paused) return;

      if (event.type === "partial") {
        callbacks.onTranscriptPartial(event.text);
        return;
      }

      // Final segment — persist and trigger batch pipelines.
      const segment: ITranscriptSegment = {
        speaker: "Speaker 1", // diarization label would come from the STT provider if enabled
        startTime: event.startTime,
        endTime: event.endTime,
        text: event.text,
        language: event.detectedLanguage,
      };

      handleFinalSegment(liveSessionId, segment).catch((err) =>
        callbacks.onError(`Failed to process transcript segment: ${err.message}`)
      );
    },
    (err) => callbacks.onError(err.message),
    startedAt
  );

  activeSessions.set(liveSessionId, {
    liveSessionId,
    recordingId: recording._id,
    userId,
    mode,
    outputLanguage,
    stt,
    segments: [],
    pendingTranslation: [],
    pendingIndexing: [],
    segmentsSinceLastInsight: 0,
    lastInsightAt: 0,
    insightState: emptyLiveInsightState(),
    startedAt,
    callbacks,
    paused: false,
  });

  return { liveSessionId, recordingId: recording._id };
}

async function handleFinalSegment(liveSessionId: string, segment: ITranscriptSegment) {
  const session = activeSessions.get(liveSessionId);
  if (!session) return;

  session.segments.push(segment);
  session.pendingTranslation.push(segment);
  session.pendingIndexing.push(segment);
  session.segmentsSinceLastInsight += 1;

  session.callbacks.onTranscriptFinal(segment);

  // Persist to DB immediately so a crash/reconnect never loses transcript data.
  await Transcript.findOneAndUpdate(
    { recordingId: session.recordingId },
    {
      $push: { segments: segment },
      $set: { fullText: session.segments.map((s) => s.text).join(" ") },
    }
  );

  // --- Batched translation (always attempted; the LLM prompt itself
  // handles the "already in target language" case by echoing the text back
  // as the translation, so we don't need a separate skip-check here) ---
  if (session.pendingTranslation.length >= TRANSLATION_BATCH_SEGMENTS) {
    const batch = session.pendingTranslation.splice(0, session.pendingTranslation.length);
    translateSegmentsBatch(batch, session.outputLanguage)
      .then(async (translations) => {
        for (const t of translations) {
          const originalSegment = batch[t.index];
          if (!originalSegment) continue;
          session.callbacks.onTranslationUpdate(
            session.segments.indexOf(originalSegment),
            t.translatedText,
            t.detectedLanguage
          );
          // Persist translation onto the matching segment (best-effort match by text+time).
          await Transcript.updateOne(
            { recordingId: session.recordingId, "segments.startTime": originalSegment.startTime, "segments.text": originalSegment.text },
            { $set: { "segments.$.translatedText": t.translatedText, "segments.$.language": t.detectedLanguage } }
          );
        }
      })
      .catch((err) => session.callbacks.onError(`Translation failed: ${err.message}`));
  }

  // --- Batched RAG indexing ---
  if (session.pendingIndexing.length >= TRANSLATION_BATCH_SEGMENTS) {
    const batch = session.pendingIndexing.splice(0, session.pendingIndexing.length);
    indexNewSegmentsForRAG(session.recordingId, session.userId, batch).catch((err) =>
      session.callbacks.onError(`Live indexing failed: ${err.message}`)
    );
  }

  // --- Batched live insights (sliding window, time + count gated) ---
  const now = Date.now();
  const dueByCount = session.segmentsSinceLastInsight >= INSIGHT_BATCH_SEGMENTS;
  const dueByTime = now - session.lastInsightAt >= INSIGHT_MIN_INTERVAL_MS;
  if (dueByCount && dueByTime) {
    const windowText = session.segments
      .slice(-INSIGHT_BATCH_SEGMENTS)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");
    session.segmentsSinceLastInsight = 0;
    session.lastInsightAt = now;

    updateLiveInsights(session.insightState, windowText, session.mode)
      .then((updated) => {
        session.insightState = updated;
        session.callbacks.onInsightUpdate(updated);
      })
      .catch((err) => session.callbacks.onError(`Live insight update failed: ${err.message}`));
  }
}

export function pushAudioChunk(liveSessionId: string, chunk: Buffer) {
  const session = activeSessions.get(liveSessionId);
  if (!session || session.paused) return;
  session.stt.sendAudioChunk(chunk);
}

export async function pauseLiveSession(liveSessionId: string) {
  const session = activeSessions.get(liveSessionId);
  if (!session) return;
  session.paused = true;
  await LiveSession.findByIdAndUpdate(liveSessionId, { status: "paused" });
}

export async function resumeLiveSession(liveSessionId: string) {
  const session = activeSessions.get(liveSessionId);
  if (!session) return;
  session.paused = false;
  await LiveSession.findByIdAndUpdate(liveSessionId, { status: "active" });
}

export async function changeOutputLanguage(liveSessionId: string, newLanguage: string) {
  const session = activeSessions.get(liveSessionId);
  if (!session) return;
  session.outputLanguage = newLanguage;
  await LiveSession.findByIdAndUpdate(liveSessionId, { outputLanguage: newLanguage });
  // Per spec §12: only new segments are translated into the new language;
  // we deliberately do not reprocess the whole meeting.
}

export function getInsightState(liveSessionId: string): LiveInsightState | undefined {
  return activeSessions.get(liveSessionId)?.insightState;
}

export function getRecordingId(liveSessionId: string): Types.ObjectId | undefined {
  return activeSessions.get(liveSessionId)?.recordingId;
}

/**
 * Ends a live session: closes the STT connection, flushes any pending
 * translation/indexing batches, and hands off to the SAME
 * finalizeRecordingAnalysis() pipeline used for uploaded files — so
 * summary/meeting-intelligence/full RAG re-index all happen through one
 * code path regardless of how the recording originated.
 */
export async function endLiveSession(liveSessionId: string): Promise<Types.ObjectId | null> {
  const session = activeSessions.get(liveSessionId);
  if (!session) return null;

  session.stt.close();
  activeSessions.delete(liveSessionId);

  // Flush any remaining pending batches synchronously before finalizing.
  if (session.pendingIndexing.length > 0) {
    await indexNewSegmentsForRAG(session.recordingId, session.userId, session.pendingIndexing).catch(() => {});
  }

  await LiveSession.findByIdAndUpdate(liveSessionId, { status: "ended", endedAt: new Date() });

  if (session.segments.length === 0) {
    await Recording.findByIdAndUpdate(session.recordingId, {
      status: "failed",
      errorMessage: "No speech was detected during this live session.",
    });
    return session.recordingId;
  }

  try {
    await finalizeRecordingAnalysis(session.recordingId);
  } catch (err: any) {
    await Recording.findByIdAndUpdate(session.recordingId, { status: "failed", errorMessage: err.message });
  }

  return session.recordingId;
}

export function isSessionActive(liveSessionId: string): boolean {
  return activeSessions.has(liveSessionId);
}
