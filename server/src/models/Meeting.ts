import { Schema, model, Document, Types } from "mongoose";
import { LiveSessionMode } from "./LiveSession";

export type MeetingStatus = "scheduled" | "active" | "ended";
export type ParticipantRole = "host" | "participant";

/**
 * A participant's presence in a Meeting. `userId` is always set — the
 * current auth architecture requires every socket connection to present a
 * valid JWT (see realtime/socketServer.ts), so there is no anonymous/guest
 * join path yet. Anyone joining a meeting link must be logged in, same as
 * every other part of the product. Display name defaults to the user's
 * account name but can be overridden per-meeting (e.g. "Arun (Backend)").
 */
export interface IMeetingParticipant {
  userId: Types.ObjectId;
  displayName: string;
  // The language this participant wants the shared transcript TRANSLATED
  // into for their own reading. Has nothing to do with what language they
  // actually speak — STT always auto-detects the spoken language for
  // every participant (see services/speech/realtimeTranscribe.ts), so
  // nobody needs to declare what they're about to speak.
  preferredLanguage: string;
  role: ParticipantRole;
  joinedAt: Date;
  leftAt?: Date;
}

export interface IMeeting extends Document {
  _id: Types.ObjectId;
  hostId: Types.ObjectId;
  title: string;
  mode: LiveSessionMode;
  status: MeetingStatus;
  defaultLanguage: string;
  participants: IMeetingParticipant[];
  recordingId?: Types.ObjectId; // set once the meeting actually starts (backs transcript/summary)
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
}

const MeetingParticipantSchema = new Schema<IMeetingParticipant>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    displayName: { type: String, required: true },
    preferredLanguage: { type: String, default: "English" },
    role: { type: String, enum: ["host", "participant"], default: "participant" },
    joinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date },
  },
  { _id: false }
);

const MeetingSchema = new Schema<IMeeting>({
  hostId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true, trim: true },
  mode: { type: String, enum: ["business_meeting", "general_meeting", "live_class"], default: "business_meeting" },
  status: { type: String, enum: ["scheduled", "active", "ended"], default: "scheduled", index: true },
  defaultLanguage: { type: String, default: "English" },
  participants: { type: [MeetingParticipantSchema], default: [] },
  recordingId: { type: Schema.Types.ObjectId, ref: "Recording" },
  createdAt: { type: Date, default: Date.now },
  startedAt: { type: Date },
  endedAt: { type: Date },
});

MeetingSchema.index({ hostId: 1, createdAt: -1 });
MeetingSchema.index({ "participants.userId": 1, createdAt: -1 });

export const Meeting = model<IMeeting>("Meeting", MeetingSchema);
