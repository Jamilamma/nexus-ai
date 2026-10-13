import { Types } from "mongoose";
import { KnowledgeChunk } from "../../models/KnowledgeChunk";
import { ITranscriptSegment } from "../../models/Transcript";
import { chunkSegments } from "../ai/chunking";
import { embedTexts } from "./embed";

/**
 * Indexes a recording's transcript for RAG: chunk -> embed -> store.
 * Always scoped with userId so retrieval can never cross user boundaries.
 *
 * Used for the "transcript is already complete" case (uploaded files,
 * and as the final re-index pass when a live session ends).
 */
export async function indexTranscriptForRAG(
  recordingId: Types.ObjectId,
  userId: Types.ObjectId,
  segments: ITranscriptSegment[]
): Promise<number> {
  // Remove any previous chunks for this recording (re-indexing case)
  await KnowledgeChunk.deleteMany({ recordingId });

  const chunks = chunkSegments(segments, 1200);
  if (chunks.length === 0) return 0;

  const embeddings = await embedTexts(chunks.map((c) => c.text));

  const docs = chunks.map((chunk, i) => ({
    recordingId,
    userId,
    text: chunk.text,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    speaker: chunk.speaker,
    embedding: embeddings[i],
  }));

  await KnowledgeChunk.insertMany(docs);
  return docs.length;
}

/**
 * Incrementally indexes NEW segments only, without touching previously
 * indexed chunks. Used during a live session so "Ask NEXUS AI" can
 * retrieve context from earlier in the meeting while it's still running,
 * without re-embedding the whole transcript on every batch.
 */
export async function indexNewSegmentsForRAG(
  recordingId: Types.ObjectId,
  userId: Types.ObjectId,
  newSegments: ITranscriptSegment[]
): Promise<number> {
  if (newSegments.length === 0) return 0;

  const chunks = chunkSegments(newSegments, 1200);
  if (chunks.length === 0) return 0;

  const embeddings = await embedTexts(chunks.map((c) => c.text));

  const docs = chunks.map((chunk, i) => ({
    recordingId,
    userId,
    text: chunk.text,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    speaker: chunk.speaker,
    embedding: embeddings[i],
  }));

  await KnowledgeChunk.insertMany(docs);
  return docs.length;
}