import { Types } from "mongoose";
import { Meeting, IMeeting } from "../../models/Meeting";
import { Recording } from "../../models/Recording";

/** Thrown for any authorization failure — callers map this to 403/404. */
export class MeetingAccessError extends Error {}

/** Loads a meeting and confirms the given user is the host or a current participant. */
export async function getMeetingForUser(meetingId: string, userId: Types.ObjectId): Promise<IMeeting> {
  const meeting = await Meeting.findById(meetingId);
  if (!meeting) throw new MeetingAccessError("Meeting not found.");

  const isHost = meeting.hostId.equals(userId);
  const isParticipant = meeting.participants.some((p) => p.userId.equals(userId));
  if (!isHost && !isParticipant) {
    throw new MeetingAccessError("You are not a participant of this meeting.");
  }
  return meeting;
}

/**
 * Authorizes access to a Recording that may be backing a shared Meeting.
 * - Personal (non-meeting) recordings: only the original creator (unchanged behavior).
 * - Meeting recordings: the creator OR anyone listed in `participantIds`
 *   (kept in sync with Meeting.participants whenever someone joins).
 * This is the single choke point RAG/summary/transcript access all go
 * through, so a participant list mistake can't silently leak data via a
 * different code path.
 */
export async function assertRecordingAccess(recordingId: Types.ObjectId, userId: Types.ObjectId) {
  const recording = await Recording.findById(recordingId);
  if (!recording) throw new MeetingAccessError("Recording not found.");

  if (recording.userId.equals(userId)) return recording;
  if (recording.participantIds?.some((id) => id.equals(userId))) return recording;

  throw new MeetingAccessError("You do not have access to this recording.");
}

/**
 * Adds (or re-activates) a participant on a meeting and keeps Recording.participantIds in sync.
 *
 * Uses two atomic findOneAndUpdate calls rather than load→modify→save.
 * That matters here specifically: two participants joining within the same
 * tick (the exact scenario the two-browser test exercises) would otherwise
 * race — both load the same `participants` array, both append locally,
 * and whichever call to `.save()` finishes second overwrites the first
 * participant's addition. Atomic array operators avoid that entirely
 * because MongoDB applies each update to the document as it exists at
 * that instant, not to a snapshot read earlier in JS.
 */
export async function addParticipant(
  meetingId: Types.ObjectId,
  userId: Types.ObjectId,
  displayName: string,
  preferredLanguage: string,
  isHost: boolean,
  fallbackDefaultLanguage: string
): Promise<IMeeting> {
  // Case 1: already a participant (rejoining) — update their row in place.
  const rejoin = await Meeting.findOneAndUpdate(
    { _id: meetingId, "participants.userId": userId },
    {
      $set: {
        "participants.$.leftAt": null,
        "participants.$.displayName": displayName,
        "participants.$.preferredLanguage": preferredLanguage || fallbackDefaultLanguage,
      },
    },
    { new: true }
  );
  if (rejoin) {
    await syncRecordingParticipant(rejoin, userId);
    return rejoin;
  }

  // Case 2: first time joining — atomically push, guarded so a
  // concurrent joiner can't have snuck in as a duplicate between the
  // check above and this write.
  const joined = await Meeting.findOneAndUpdate(
    { _id: meetingId, "participants.userId": { $ne: userId } },
    {
      $push: {
        participants: {
          userId,
          displayName,
          preferredLanguage: preferredLanguage || fallbackDefaultLanguage,
          role: isHost ? "host" : "participant",
          joinedAt: new Date(),
        },
      },
    },
    { new: true }
  );
  if (joined) {
    await syncRecordingParticipant(joined, userId);
    return joined;
  }

  // Extremely narrow window: someone else's join for this exact userId landed
  // between the two calls above. Just return the current state — they're in.
  const current = await Meeting.findById(meetingId);
  if (!current) throw new MeetingAccessError("Meeting not found.");
  await syncRecordingParticipant(current, userId);
  return current;
}

async function syncRecordingParticipant(meeting: IMeeting, userId: Types.ObjectId) {
  if (meeting.recordingId) {
    await Recording.findByIdAndUpdate(meeting.recordingId, { $addToSet: { participantIds: userId } });
  }
}

export async function markParticipantLeft(meetingId: Types.ObjectId, userId: Types.ObjectId): Promise<IMeeting | null> {
  return Meeting.findOneAndUpdate(
    { _id: meetingId, "participants.userId": userId },
    { $set: { "participants.$.leftAt": new Date() } },
    { new: true }
  );
}
