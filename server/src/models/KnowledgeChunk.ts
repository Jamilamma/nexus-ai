import { Schema, model, Document, Types } from "mongoose";

/**
 * Each transcript is split into overlapping text chunks for retrieval.
 * `embedding` holds a numeric vector (from services/rag/embed.ts).
 *
 * For local/dev use without a dedicated vector database, we store the
 * embedding as a plain number array and do cosine-similarity search in
 * application code (services/rag/retrieve.ts). This is swappable for
 * MongoDB Atlas Vector Search or a dedicated vector DB in production
 * (see docs/RAG.md).
 */
export interface IKnowledgeChunk extends Document {
  _id: Types.ObjectId;
  recordingId: Types.ObjectId;
  userId: Types.ObjectId;
  text: string;
  startTime: number;
  endTime: number;
  speaker: string;
  embedding: number[];
  createdAt: Date;
}

const KnowledgeChunkSchema = new Schema<IKnowledgeChunk>({
  recordingId: { type: Schema.Types.ObjectId, ref: "Recording", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  text: { type: String, required: true },
  startTime: { type: Number, default: 0 },
  endTime: { type: Number, default: 0 },
  speaker: { type: String, default: "Speaker 1" },
  embedding: { type: [Number], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// Compound index: RAG queries must always be scoped to a single user
// (and usually a single recording) to prevent cross-user data leakage.
KnowledgeChunkSchema.index({ userId: 1, recordingId: 1 });

export const KnowledgeChunk = model<IKnowledgeChunk>("KnowledgeChunk", KnowledgeChunkSchema);
