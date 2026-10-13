import { Schema, model, Document, Types } from "mongoose";

export interface IFlashcard {
  question: string;
  answer: string;
}

export interface IQuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
}

export interface ILearningContent extends Document {
  _id: Types.ObjectId;
  recordingId: Types.ObjectId;
  userId: Types.ObjectId;
  notes: string;
  importantConcepts: string[];
  definitions: { term: string; definition: string }[];
  flashcards: IFlashcard[];
  quiz: IQuizQuestion[];
  examQuestions: {
    twoMark: string[];
    fiveMark: string[];
    longAnswer: string[];
    viva: string[];
  };
  createdAt: Date;
}

const LearningContentSchema = new Schema<ILearningContent>({
  recordingId: { type: Schema.Types.ObjectId, ref: "Recording", required: true, unique: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  notes: { type: String, default: "" },
  importantConcepts: { type: [String], default: [] },
  definitions: {
    type: [{ term: String, definition: String }],
    default: [],
  },
  flashcards: {
    type: [{ question: String, answer: String }],
    default: [],
  },
  quiz: {
    type: [{ question: String, options: [String], correctIndex: Number }],
    default: [],
  },
  examQuestions: {
    twoMark: { type: [String], default: [] },
    fiveMark: { type: [String], default: [] },
    longAnswer: { type: [String], default: [] },
    viva: { type: [String], default: [] },
  },
  createdAt: { type: Date, default: Date.now },
});

export const LearningContent = model<ILearningContent>("LearningContent", LearningContentSchema);
