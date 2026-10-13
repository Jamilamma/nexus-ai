import { Schema, model, Document, Types } from "mongoose";

export interface IInterviewTurn {
  question: string;
  answer: string;
  scores?: {
    technical: number;
    communication: number;
    grammar: number;
    clarity: number;
  };
  fillerWordCount?: number;
  feedback?: string;
  improvedAnswer?: string;
}

export interface IInterview extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  role: string;
  jobDescription?: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  turns: IInterviewTurn[];
  overallScore?: number;
  strongAreas?: string[];
  weakAreas?: string[];
  preparationPlan?: string;
  status: "in_progress" | "completed";
  createdAt: Date;
}

const TurnSchema = new Schema<IInterviewTurn>(
  {
    question: { type: String, required: true },
    answer: { type: String, default: "" },
    scores: {
      technical: { type: Number },
      communication: { type: Number },
      grammar: { type: Number },
      clarity: { type: Number },
    },
    fillerWordCount: { type: Number },
    feedback: { type: String },
    improvedAnswer: { type: String },
  },
  { _id: false }
);

const InterviewSchema = new Schema<IInterview>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  role: { type: String, required: true },
  jobDescription: { type: String },
  difficulty: { type: String, enum: ["beginner", "intermediate", "advanced"], default: "intermediate" },
  turns: { type: [TurnSchema], default: [] },
  overallScore: { type: Number },
  strongAreas: { type: [String], default: [] },
  weakAreas: { type: [String], default: [] },
  preparationPlan: { type: String },
  status: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },
  createdAt: { type: Date, default: Date.now },
});

export const Interview = model<IInterview>("Interview", InterviewSchema);
