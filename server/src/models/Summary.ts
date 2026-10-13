import { Schema, model, Document, Types } from "mongoose";

export interface IActionItem {
  task: string;
  owner: string; // "Not specified" if unknown
  deadline: string; // "Not specified" if unknown
  priority: "low" | "medium" | "high" | "not specified";
}

export interface ISummary extends Document {
  _id: Types.ObjectId;
  recordingId: Types.ObjectId;
  userId: Types.ObjectId;
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: IActionItem[];
  questions: string[];
  risks: string[];
  followUps: string[];
  importantDates: string[];
  topics: string[];
  language: string;
  createdAt: Date;
}

const ActionItemSchema = new Schema<IActionItem>(
  {
    task: { type: String, required: true },
    owner: { type: String, default: "Not specified" },
    deadline: { type: String, default: "Not specified" },
    priority: { type: String, enum: ["low", "medium", "high", "not specified"], default: "not specified" },
  },
  { _id: false }
);

const SummarySchema = new Schema<ISummary>({
  recordingId: { type: Schema.Types.ObjectId, ref: "Recording", required: true, unique: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  shortSummary: { type: String, default: "" },
  detailedSummary: { type: String, default: "" },
  keyPoints: { type: [String], default: [] },
  decisions: { type: [String], default: [] },
  actionItems: { type: [ActionItemSchema], default: [] },
  questions: { type: [String], default: [] },
  risks: { type: [String], default: [] },
  followUps: { type: [String], default: [] },
  importantDates: { type: [String], default: [] },
  topics: { type: [String], default: [] },
  language: { type: String, default: "en" },
  createdAt: { type: Date, default: Date.now },
});

export const Summary = model<ISummary>("Summary", SummarySchema);
