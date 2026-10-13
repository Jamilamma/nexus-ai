import { Types } from "mongoose";
import { Recording } from "../../models/Recording";
import { Transcript, ITranscriptSegment } from "../../models/Transcript";
import { Summary } from "../../models/Summary";
import { summarizeTranscript } from "../ai/summarize";
import { extractMeetingIntelligence } from "../ai/meetingIntelligence";
import { indexTranscriptForRAG } from "../rag";

/**
 * Runs the "analyze a complete transcript" stage of the pipeline:
 * summarization + meeting intelligence extraction + RAG indexing,
 * then marks the Recording ready.
 *
 * This is the ONE place that logic lives. It is called:
 *  - after batch transcription finishes for an uploaded file, and
 *  - after a live session ends (transcript already fully populated
 *    incrementally during the session).
 *
 * Precondition: a Transcript document for this recording already
 * exists with a non-empty fullText/segments.
 */
export async function finalizeRecordingAnalysis(recordingId: Types.ObjectId): Promise<void> {
  const recording = await Recording.findById(recordingId);
  if (!recording) throw new Error("Recording not found during finalization.");

  const transcript = await Transcript.findOne({ recordingId });
  if (!transcript || !transcript.fullText || transcript.fullText.trim().length === 0) {
    throw new Error("No transcript content available to analyze.");
  }

  await Recording.findByIdAndUpdate(recordingId, { status: "analyzing" });

  const [summaryResult, intelligenceResult] = await Promise.all([
    summarizeTranscript(transcript.fullText),
    extractMeetingIntelligence(transcript.fullText),
    // Re-index is safe/idempotent — indexTranscriptForRAG deletes existing chunks first.
    indexTranscriptForRAG(recordingId, recording.userId, transcript.segments as ITranscriptSegment[]),
  ]);

  await Summary.findOneAndUpdate(
    { recordingId },
    {
      recordingId,
      userId: recording.userId,
      shortSummary: summaryResult.shortSummary,
      detailedSummary: summaryResult.detailedSummary,
      keyPoints: summaryResult.keyPoints,
      topics: summaryResult.topics,
      decisions: intelligenceResult.decisions,
      actionItems: intelligenceResult.actionItems,
      questions: intelligenceResult.questions,
      risks: intelligenceResult.risks,
      followUps: intelligenceResult.followUps,
      importantDates: intelligenceResult.importantDates,
    },
    { upsert: true }
  );

  await Recording.findByIdAndUpdate(recordingId, { status: "ready" });
}
