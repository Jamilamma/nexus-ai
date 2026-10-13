import { Schema, model, Document, Types } from "mongoose";

export interface ITranscriptSegment {
  speaker: string; // display name shown in the transcript — never a fake/generic label for meeting mode
  participantId?: string; // userId string, set for shared Meeting transcripts so "who said what" is unambiguous
  // Stable unique id assigned once, server-side, when a shared-meeting segment is
  // finalized. Needed because segments in a shared meeting arrive from multiple
  // independent per-participant STT streams and are re-sorted into chronological
  // order server-side (see meetingManager.insertInOrder) — a positional array
  // index is NOT a safe way to refer back to "this exact segment" from an async
  // follow-up event (e.g. a translation finishing later), because the array can
  // be re-ordered/grown between when the index was computed and when it's used.
  segmentId?: string;
  meetingId?: string; // owning Meeting (denormalized so segments are self-describing for retrieval)
  timestamp?: Date; // absolute wall-clock time the segment started (startTime is relative to meeting start)
  startTime: number; // seconds
  endTime: number; // seconds
  text: string;
  language?: string; // dominant spoken language of this segment as reported by the STT vendor (ISO code, e.g. "ta"). Never overwritten by translation.
  languages?: string[]; // every language the vendor reported inside this segment (code-switching), dominant first
  translatedText?: string; // legacy single-language translation (single-user live sessions only)
  // Translations of the ORIGINAL `text`, keyed by target language name ("English" | "Tamil" | "Hindi" | "Arabic").
  // A translation is a separate reading aid: it never replaces or corrects `text`, and is never fed to Summary / Ask NEXUS.
  translations?: Record<string, string>;
  confidence?: number; // mean token confidence (0..1) reported by the STT vendor for this segment's text
  languageConfidence?: number; // legacy (previous STT vendor reported a per-turn language confidence)
  lowConfidence?: boolean; // true when `confidence` was below STT_MIN_CONFIDENCE (the text may contain recognition errors)
}

export interface ITranscript extends Document {
  _id: Types.ObjectId;
  recordingId: Types.ObjectId;
  userId: Types.ObjectId;
  language: string;
  fullText: string;
  segments: ITranscriptSegment[];
  createdAt: Date;
}

const SegmentSchema = new Schema<ITranscriptSegment>(
  {
    speaker: { type: String, default: "Speaker 1" },
    participantId: { type: String },
    segmentId: { type: String },
    meetingId: { type: String },
    timestamp: { type: Date },
    startTime: { type: Number, required: true },
    endTime: { type: Number, required: true },
    text: { type: String, required: true },
    language: { type: String },
    languages: { type: [String], default: undefined },
    translatedText: { type: String },
    translations: { type: Schema.Types.Mixed },
    confidence: { type: Number },
    languageConfidence: { type: Number },
    lowConfidence: { type: Boolean },
  },
  { _id: false }
);

const TranscriptSchema = new Schema<ITranscript>({
  recordingId: { type: Schema.Types.ObjectId, ref: "Recording", required: true, unique: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  language: { type: String, default: "en" },
  fullText: { type: String, default: "" },
  segments: { type: [SegmentSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

export const Transcript = model<ITranscript>("Transcript", TranscriptSchema);
