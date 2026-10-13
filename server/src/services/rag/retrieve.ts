import { Types } from "mongoose";
import { KnowledgeChunk } from "../../models/KnowledgeChunk";
import { embedTexts, cosineSimilarity } from "./embed";
import { askLLM } from "../ai/llmClient";

export interface RAGAnswer {
  answer: string;
  sources: { text: string; startTime: number; endTime: number; speaker: string }[];
}

/**
 * Answers a natural-language question about a recording using RAG.
 *
 * SECURITY: filters by recordingId at the database query level, always.
 * For personal (non-meeting) recordings, `userId` is also enforced in the
 * query so one user's chunks can never be retrieved by another user. For
 * shared Meeting recordings, the caller (socket layer / meetingController)
 * must already have authorized the asker via
 * services/meeting/access.ts::assertRecordingAccess before calling this
 * with `allowAnyAuthorizedParticipant = true` — the chunks themselves are
 * still scoped to exactly this one recordingId, so no cross-recording
 * leakage is possible either way.
 */
export async function answerFromRecording(
  question: string,
  userId: Types.ObjectId,
  recordingId: Types.ObjectId,
  topK = 5,
  allowAnyAuthorizedParticipant = false
): Promise<RAGAnswer> {
  const query = allowAnyAuthorizedParticipant ? { recordingId } : { userId, recordingId };
  const chunks = await KnowledgeChunk.find(query).lean();

  if (chunks.length === 0) {
    return {
      answer:
        "This recording hasn't been indexed for search yet, or has no transcript content. Try again after processing completes.",
      sources: [],
    };
  }

  const [queryEmbedding] = await embedTexts([question]);

  const ranked = chunks
    .map((c) => ({ chunk: c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const context = ranked
    .map(
      (r, i) =>
        `[Source ${i + 1} | ${formatTime(r.chunk.startTime)}-${formatTime(r.chunk.endTime)}]\n${r.chunk.text}`
    )
    .join("\n\n");

  const prompt = `Answer the user's question using ONLY the transcript excerpts below. If the answer isn't in the excerpts, say so honestly rather than guessing.

Transcript excerpts:
${context}

Question: ${question}

Provide a clear, direct answer. Reference source numbers like [Source 1] where relevant.`;

  const answer = await askLLM(prompt);

  return {
    answer,
    sources: ranked.map((r) => ({
      text: r.chunk.text.slice(0, 300),
      startTime: r.chunk.startTime,
      endTime: r.chunk.endTime,
      speaker: r.chunk.speaker,
    })),
  };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
