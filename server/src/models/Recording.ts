import { Schema, model, Document, Types } from "mongoose";

export type RecordingType = "meeting" | "lecture" | "interview" | "other";
export type RecordingSource = "upload" | "live";
export type RecordingStatus =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "analyzing"
  | "ready"
  | "failed";

export interface IRecording extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  type: RecordingType;
  source: RecordingSource;
  fileUrl: string;
  originalFileName: string;
  mimeType: string;
  durationSeconds?: number;
  language: string;
  status: RecordingStatus;
  errorMessage?: string;
  createdAt: Date;
  // Set when this Recording backs a shared multi-participant Meeting
  // (see models/Meeting.ts). `userId` above remains the host/creator for
  // backward compatibility with the original single-user pipeline;
  // `participantIds` lists every user authorized to view the transcript,
  // summary, and report — checked at the DB query level in
  // services/meeting/access.ts.
  meetingId?: Types.ObjectId;
  participantIds: Types.ObjectId[];
}

const RecordingSchema = new Schema<IRecording>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true, trim: true },
  type: { type: String, enum: ["meeting", "lecture", "interview", "other"], default: "meeting" },
  source: { type: String, enum: ["upload", "live"], default: "upload" },
  fileUrl: { type: String, required: true },
  originalFileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  durationSeconds: { type: Number },
  language: { type: String, default: "auto" },
  status: {
    type: String,
    enum: ["uploaded", "transcribing", "transcribed", "analyzing", "ready", "failed"],
    default: "uploaded",
  },
  errorMessage: { type: String },
  createdAt: { type: Date, default: Date.now },
  meetingId: { type: Schema.Types.ObjectId, ref: "Meeting", index: true },
  participantIds: { type: [Schema.Types.ObjectId], ref: "User", default: [] },
});

RecordingSchema.index({ userId: 1, createdAt: -1 });

export const Recording = model<IRecording>("Recording", RecordingSchema);
