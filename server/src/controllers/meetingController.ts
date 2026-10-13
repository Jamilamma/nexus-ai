import { Response } from "express";
import { Types } from "mongoose";
import { AuthedRequest } from "../middleware/auth";
import { Meeting } from "../models/Meeting";
import { Recording } from "../models/Recording";
import { Transcript } from "../models/Transcript";
import { Summary } from "../models/Summary";
import { User } from "../models/User";
import { KnowledgeChunk } from "../models/KnowledgeChunk";
import { createJoinToken, ensureLiveKitRoom, isLiveKitConfigured } from "../services/video/livekit";
import { getMeetingForUser, MeetingAccessError } from "../services/meeting/access";
import { isMeetingActive, getLiveSegments } from "../services/realtime/meetingManager";
import { isUserPresent, presentUserCount } from "../services/meeting/roomState";
import { env } from "../config/env";

const SUPPORTED_LANGUAGES = ["English", "Tamil", "Hindi", "Arabic"];

export async function createMeeting(req: AuthedRequest, res: Response) {
  const { title, mode, defaultLanguage } = req.body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "Meeting title is required." });
  }

  const host = await User.findById(req.userId).select("name");

  const meeting = await Meeting.create({
    hostId: req.userId,
    title: title.trim(),
    mode: mode || "business_meeting",
    defaultLanguage: SUPPORTED_LANGUAGES.includes(defaultLanguage) ? defaultLanguage : "English",
    participants: [
      {
        userId: req.userId,
        displayName: host?.name || "Host",
        preferredLanguage: SUPPORTED_LANGUAGES.includes(defaultLanguage) ? defaultLanguage : "English",
        role: "host",
        joinedAt: new Date(),
      },
    ],
  });

  res.status(201).json({
    meetingId: meeting._id.toString(),
    // The meeting ID doubles as the shareable code; the client builds the
    // full link as `${origin}${joinUrl}`.
    joinUrl: `/meeting/${meeting._id}`,
    title: meeting.title,
  });
}

/** Public-to-authenticated-users preview shown on the join screen, before the participant commits to joining. */
export async function getMeetingPreview(req: AuthedRequest, res: Response) {
  if (!Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "Meeting not found." });
  const meeting = await Meeting.findById(req.params.id).populate("hostId", "name");
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });

  res.json({
    meetingId: meeting._id.toString(),
    title: meeting.title,
    host: (meeting.hostId as any)?.name || "Unknown host",
    status: meeting.status,
    supportedLanguages: SUPPORTED_LANGUAGES,
    defaultLanguage: meeting.defaultLanguage,
    participantCount: presentUserCount(meeting._id.toString()),
    maxParticipants: env.maxMeetingParticipants,
    videoConfigured: isLiveKitConfigured(),
    hasReport: Boolean(meeting.recordingId),
  });
}

/**
 * Mints a LiveKit join token. Deliberately requires that the caller has
 * already joined the meeting over the realtime socket (join_meeting) — that
 * step is where the participant cap and "meeting ended" checks happen, so
 * a token can never be obtained by skipping them.
 */
export async function getMeetingToken(req: AuthedRequest, res: Response) {
  const meetingId = req.params.id;
  if (!Types.ObjectId.isValid(meetingId)) return res.status(404).json({ error: "Meeting not found." });

  if (!isLiveKitConfigured()) {
    return res.status(503).json({
      error: "The video server is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in server/.env.",
    });
  }

  const meeting = await Meeting.findById(meetingId);
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });
  if (meeting.status === "ended") return res.status(410).json({ error: "This meeting has ended." });

  const userId = (req.userId as Types.ObjectId).toString();
  if (!isUserPresent(meetingId, userId)) {
    return res.status(403).json({ error: "Join the meeting before requesting video access." });
  }

  const me = meeting.participants.find((p) => p.userId.equals(req.userId as Types.ObjectId));
  const user = await User.findById(req.userId).select("name");
  const name = (me?.displayName || user?.name || "Participant").slice(0, 60);

  await ensureLiveKitRoom(meetingId);
  const token = await createJoinToken({ meetingId, identity: userId, name });

  res.json({ token, url: env.livekitUrl, identity: userId, name });
}

export async function listMyMeetings(req: AuthedRequest, res: Response) {
  const userId = req.userId as Types.ObjectId;
  const meetings = await Meeting.find({
    $or: [{ hostId: userId }, { "participants.userId": userId }],
  })
    .sort({ createdAt: -1 })
    .limit(25)
    .lean();

  const recordingIds = meetings.map((m) => m.recordingId).filter(Boolean) as Types.ObjectId[];
  const recordings = await Recording.find({ _id: { $in: recordingIds } }).lean();
  const recordingById = new Map(recordings.map((r) => [r._id.toString(), r]));

  res.json(
    meetings.map((m) => {
      const recording = m.recordingId ? recordingById.get(m.recordingId.toString()) : undefined;
      return {
        meetingId: m._id.toString(),
        title: m.title,
        status: m.status,
        createdAt: m.createdAt,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        durationSeconds:
          m.startedAt && m.endedAt ? Math.round((new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 1000) : undefined,
        participantCount: m.participants.length,
        summaryStatus: recording?.status || (m.status === "ended" ? "failed" : "not_started"),
        recordingId: recording?._id.toString(),
        // Only the host can delete a meeting (see deleteMeeting) — surfaced
        // here so the UI only shows the Delete button to the host instead
        // of showing it to everyone and then failing with a 403.
        isHost: m.hostId.equals(userId),
      };
    })
  );
}

/**
 * Phase 2: participant-aware transcript for a meeting (live or ended).
 * Authorization: host or listed participant only (getMeetingForUser).
 * Each segment is self-describing (meetingId, participantId, speaker name,
 * timestamp, language, text) so Phase 3 retrieval/Ask NEXUS can consume it directly.
 */
export async function getMeetingTranscript(req: AuthedRequest, res: Response) {
  if (!Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "Meeting not found." });
  try {
    const meeting = await getMeetingForUser(req.params.id, req.userId as Types.ObjectId);
    const meetingId = meeting._id.toString();

    let segments = getLiveSegments(meetingId);
    if (!segments && meeting.recordingId) {
      const transcript = await Transcript.findOne({ recordingId: meeting.recordingId }).lean();
      segments = transcript?.segments || [];
    }

    res.json({
      meetingId,
      title: meeting.title,
      status: meeting.status,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      segments: (segments || []).map((s) => ({
        segmentId: s.segmentId,
        meetingId,
        participantId: s.participantId,
        participantName: s.speaker,
        text: s.text,
        language: s.language,
        timestamp: s.timestamp ?? (meeting.startedAt ? new Date(meeting.startedAt.getTime() + s.startTime * 1000) : undefined),
        startTime: s.startTime,
        endTime: s.endTime,
        isFinal: true,
      })),
    });
  } catch (err) {
    if (err instanceof MeetingAccessError) return res.status(403).json({ error: err.message });
    throw err;
  }
}

/** Full report for an ended meeting: summary, decisions, action items, and full transcript. Any participant may view it. */
export async function getMeetingReport(req: AuthedRequest, res: Response) {
  try {
    const meeting = await getMeetingForUser(req.params.id, req.userId as Types.ObjectId);
    if (!meeting.recordingId) {
      return res.status(404).json({ error: "This meeting never started, so there is no report." });
    }

    const [recording, transcript, summary] = await Promise.all([
      Recording.findById(meeting.recordingId).lean(),
      Transcript.findOne({ recordingId: meeting.recordingId }).lean(),
      Summary.findOne({ recordingId: meeting.recordingId }).lean(),
    ]);

    // Personal report (spec section 16): "what I said", "my action items",
    // "decisions affecting me". Deliberately built by filtering data that's
    // already been extracted and verified (no extra LLM call, no risk of
    // inventing something for this participant) rather than asking the
    // model to re-derive "what's relevant to me" per viewer.
    const asker = meeting.participants.find((p) => p.userId.equals(req.userId));
    const myReport =
      asker && transcript
        ? {
            whatISaid: transcript.segments.filter(
              (s) => (s.participantId && s.participantId === (req.userId as Types.ObjectId).toString()) || s.speaker === asker.displayName
            ),
            myActionItems: (summary?.actionItems || []).filter(
              (a) => a.owner.trim().toLowerCase() === asker.displayName.trim().toLowerCase()
            ),
            decisions: summary?.decisions || [],
            importantPoints: summary?.keyPoints || [],
          }
        : null;

    res.json({
      meeting: {
        meetingId: meeting._id.toString(),
        title: meeting.title,
        status: meeting.status,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        participants: meeting.participants.map((p) => ({
          displayName: p.displayName,
          preferredLanguage: p.preferredLanguage,
          role: p.role,
        })),
        isHost: meeting.hostId.equals(req.userId as Types.ObjectId),
      },
      recordingStatus: recording?.status,
      transcript: transcript ? { fullText: transcript.fullText, segments: transcript.segments } : null,
      summary: summary || null,
      myReport,
    });
  } catch (err) {
    if (err instanceof MeetingAccessError) return res.status(403).json({ error: err.message });
    throw err;
  }
}

/**
 * Deletes an ended meeting and everything derived from it: the Meeting
 * record itself, its Recording, Transcript, Summary, and any indexed RAG
 * chunks. Restricted to the host (ownership check) and to meetings that
 * have already ended:
 *  - Only the host may delete — participants can view/leave a meeting but
 *    should not be able to erase it out from under the host or the rest
 *    of the group.
 *  - Only "ended" meetings are deletable — a meeting that is still
 *    "active" has a live STT session and connected participants
 *    (see services/realtime/meetingManager.ts); deleting its data out
 *    from under that in-memory session would corrupt the live transcript.
 */
export async function deleteMeeting(req: AuthedRequest, res: Response) {
  const meeting = await Meeting.findById(req.params.id);
  if (!meeting) return res.status(404).json({ error: "Meeting not found." });

  // Ownership check: only the host can delete.
  if (!meeting.hostId.equals(req.userId as Types.ObjectId)) {
    return res.status(403).json({ error: "Only the meeting host can delete this meeting." });
  }

  // Belt-and-braces: even if the DB says "ended", never delete out from
  // under a meeting the in-memory realtime manager still thinks is live.
  if (meeting.status !== "ended" || isMeetingActive(meeting._id.toString())) {
    return res.status(400).json({ error: "Only ended meetings can be deleted." });
  }

  const recordingId = meeting.recordingId;

  await Promise.all([
    Meeting.deleteOne({ _id: meeting._id }),
    recordingId ? Recording.deleteOne({ _id: recordingId }) : Promise.resolve(),
    recordingId ? Transcript.deleteOne({ recordingId }) : Promise.resolve(),
    recordingId ? Summary.deleteOne({ recordingId }) : Promise.resolve(),
    recordingId ? KnowledgeChunk.deleteMany({ recordingId }) : Promise.resolve(),
  ]);

  res.json({ success: true, meetingId: meeting._id.toString() });
}
