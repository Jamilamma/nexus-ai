import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { Types } from "mongoose";
import { verifyToken } from "../utils/jwt";
import { env } from "../config/env";
import { LiveSession, LiveSessionMode } from "../models/LiveSession";
import { Meeting, IMeeting } from "../models/Meeting";
import { User } from "../models/User";
import { answerFromRecording } from "../services/rag/retrieve";
import {
  createLiveSession,
  pushAudioChunk,
  pauseLiveSession,
  resumeLiveSession,
  changeOutputLanguage,
  endLiveSession,
  getRecordingId,
} from "../services/realtime/sessionManager";
import { addParticipant, markParticipantLeft, MeetingAccessError } from "../services/meeting/access";
import {
  ensureMeetingSessionStarted,
  detachParticipantAudio,
  updateParticipantLanguage,
  getLiveSegments,
  askAboutMeeting,
  endMeetingSession,
  isMeetingActive,
  generateLiveMeetingSummary,
  MeetingAiError,
} from "../services/realtime/meetingManager";
import {
  addSocket,
  removeSocket,
  isUserPresent,
  presentUserIds,
  presentUserCount,
  scheduleGrace,
  appendChat,
  getChat,
  clearRoom,
  MAX_CHAT_LENGTH,
} from "../services/meeting/roomState";
import { closeLiveKitRoom } from "../services/video/livekit";
import { startMeetingTranscriber, stopMeetingTranscriber } from "../services/video/livekitTranscriber";

interface AuthedSocket extends Socket {
  userId?: Types.ObjectId;
}

/**
 * Sets up the /realtime Socket.IO namespace on top of the existing
 * Express HTTP server (same port — no separate server process). Every
 * connection MUST present a valid JWT before joining any session, mirroring
 * requireAuth for REST routes (Express middleware doesn't apply to the
 * socket handshake automatically, so this re-implements that check).
 */
export function attachRealtimeServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.clientUrl, credentials: true },
    maxHttpBufferSize: 1e7, // 10MB — generous enough for binary audio frames
  });

  const realtime = io.of("/realtime");

  // Meetings that have been ended by this process (short-lived; blocks late rejoins / stale grace timers).
  const closedMeetings = new Set<string>();

  realtime.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required."));
    try {
      const payload = verifyToken(token);
      socket.userId = new Types.ObjectId(payload.userId);
      next();
    } catch {
      next(new Error("Invalid or expired token."));
    }
  });

  realtime.on("connection", (socket: AuthedSocket) => {
    socket.emit("connection_status", { status: "connected" });

    socket.on(
      "start_live_session",
      async (payload: { title: string; mode: LiveSessionMode; outputLanguage: string }) => {
        try {
          const { title, mode, outputLanguage } = payload;
          if (!socket.userId) return socket.emit("error", { message: "Not authenticated." });

          const { liveSessionId, recordingId } = await createLiveSession(
            socket.userId,
            title || "Live session",
            mode || "general_meeting",
            outputLanguage || "English",
            {
              onTranscriptPartial: (text) => socket.emit("transcript_partial", { text }),
              onTranscriptFinal: (segment) => socket.emit("transcript_final", { segment }),
              onTranslationUpdate: (segmentIndex, translatedText, detectedLanguage) =>
                socket.emit("translation_update", { segmentIndex, translatedText, detectedLanguage }),
              onInsightUpdate: (state) => socket.emit("ai_insight", state),
              onError: (message) => socket.emit("error", { message }),
            }
          );

          socket.join(liveSessionId);
          socket.data.liveSessionId = liveSessionId;

          socket.emit("session_started", { liveSessionId, recordingId: recordingId.toString() });
        } catch (err: any) {
          socket.emit("error", { message: err.message });
        }
      }
    );

    // Audio arrives as raw binary (16-bit PCM) — see client/src/hooks/useMicStream.ts
    socket.on("audio_chunk", (chunk: ArrayBuffer) => {
      const liveSessionId = socket.data.liveSessionId;
      if (!liveSessionId) return;
      pushAudioChunk(liveSessionId, Buffer.from(chunk));
    });

    socket.on("pause_session", async () => {
      const liveSessionId = socket.data.liveSessionId;
      if (!liveSessionId) return;
      await pauseLiveSession(liveSessionId);
      socket.emit("session_paused", {});
    });

    socket.on("resume_session", async () => {
      const liveSessionId = socket.data.liveSessionId;
      if (!liveSessionId) return;
      await resumeLiveSession(liveSessionId);
      socket.emit("session_resumed", {});
    });

    socket.on("change_language", async (payload: { outputLanguage: string }) => {
      const liveSessionId = socket.data.liveSessionId;
      if (!liveSessionId) return;
      await changeOutputLanguage(liveSessionId, payload.outputLanguage);
    });

    socket.on("ask_ai", async (payload: { question: string }) => {
      try {
        const liveSessionId = socket.data.liveSessionId;
        if (!liveSessionId || !socket.userId) {
          return socket.emit("error", { message: "No active session." });
        }
        const recordingId = getRecordingId(liveSessionId);
        if (!recordingId) return socket.emit("error", { message: "Session context not found." });

        // Reuses the EXACT same RAG retrieval used for uploaded recordings —
        // scoped by userId + recordingId at the DB query level, so this can
        // never answer from another session or another user's data.
        const result = await answerFromRecording(payload.question, socket.userId, recordingId);
        socket.emit("answer", result);
      } catch (err: any) {
        socket.emit("error", { message: err.message });
      }
    });

    socket.on("end_session", async () => {
      try {
        const liveSessionId = socket.data.liveSessionId;
        if (!liveSessionId) return;

        const recordingId = await endLiveSession(liveSessionId);
        socket.leave(liveSessionId);
        socket.data.liveSessionId = undefined;

        socket.emit("session_ended", { recordingId: recordingId?.toString() });
      } catch (err: any) {
        socket.emit("error", { message: err.message });
      }
    });

    // ================================================================
    // SHARED VIDEO MEETINGS
    //
    // This socket is the CONTROL plane only: roster, meeting status, chat,
    // join/leave/end. Audio/video/screen-share never touch this server —
    // they go browser <-> LiveKit SFU (see services/video/livekit.ts).
    // Room name is `meeting:<meetingId>`.
    //
    // Phase 2 transcription: participant audio is read SERVER-SIDE from the
    // LiveKit room (services/video/livekitTranscriber.ts), not streamed
    // through this socket. This socket only carries transcript text back to
    // authorized participants. Enabled by ENABLE_MEETING_TRANSCRIPTION=true.
    // ================================================================
    const roomOf = (meetingId: string) => `meeting:${meetingId}`;

    async function broadcastRoster(meetingId: string, knownMeeting?: IMeeting | null) {
      const meeting = knownMeeting ?? (await Meeting.findById(meetingId));
      if (!meeting) return;
      // Roster = people in the durable participant list who are ALSO
      // currently connected (so stale rows after a crash never show up).
      const present = new Set(presentUserIds(meetingId));
      const participants = meeting.participants
        .filter((p) => present.has(p.userId.toString()))
        .map((p) => ({
          userId: p.userId.toString(),
          displayName: p.displayName,
          preferredLanguage: p.preferredLanguage,
          role: p.role,
        }));
      realtime.to(roomOf(meetingId)).emit("participants_update", {
        participants,
        status: meeting.status,
        maxParticipants: env.maxMeetingParticipants,
      });
    }

    socket.on(
      "join_meeting",
      async (payload: { meetingId: string; displayName?: string; preferredLanguage?: string }) => {
        const meetingId = String(payload?.meetingId || "");
        let registered = false;
        try {
          if (!socket.userId) return socket.emit("meeting_error", { message: "Not authenticated.", code: "AUTH" });
          if (!Types.ObjectId.isValid(meetingId)) {
            return socket.emit("meeting_error", { message: "Meeting not found.", code: "NOT_FOUND" });
          }

          // Switching meetings on the same socket: leave the old one cleanly first.
          if (socket.data.meetingId && socket.data.meetingId !== meetingId) {
            await leaveCurrentMeeting(socket, true);
          }

          const meeting = await Meeting.findById(meetingId);
          if (!meeting) return socket.emit("meeting_error", { message: "Meeting not found.", code: "NOT_FOUND" });
          if (meeting.status === "ended" || closedMeetings.has(meetingId)) {
            return socket.emit("meeting_error", { message: "This meeting has already ended.", code: "ENDED" });
          }

          const userKey = socket.userId.toString();

          // Capacity check + registration happen synchronously back-to-back
          // (no await between them), so two people joining the last seat at
          // the same instant can't both get in.
          if (!isUserPresent(meetingId, userKey) && presentUserCount(meetingId) >= env.maxMeetingParticipants) {
            return socket.emit("meeting_error", {
              message: `This meeting is full (maximum ${env.maxMeetingParticipants} participants).`,
              code: "FULL",
            });
          }
          addSocket(meetingId, userKey, socket.id);
          registered = true;

          const user = await User.findById(socket.userId).select("name");
          const displayName = (payload.displayName || user?.name || "Participant").trim().slice(0, 60) || "Participant";
          const preferredLanguage = payload.preferredLanguage || meeting.defaultLanguage;
          const isHost = meeting.hostId.equals(socket.userId);

          const updatedMeeting = await addParticipant(meeting._id, socket.userId, displayName, preferredLanguage, isHost, meeting.defaultLanguage);

          // First person in flips the meeting to "active".
          if (updatedMeeting.status === "scheduled") {
            await Meeting.updateOne({ _id: meeting._id, status: "scheduled" }, { $set: { status: "active", startedAt: new Date() } });
            updatedMeeting.status = "active";
          }

          socket.join(roomOf(meetingId));
          socket.data.meetingId = meetingId;
          socket.data.meetingDisplayName = displayName;
          socket.data.meetingLanguage = preferredLanguage;

          // ---- Phase 2: participant-aware live transcription ----
          let recordingId: Types.ObjectId | undefined;
          if (env.transcriptionActive) {
            const roomName = roomOf(meetingId);
            try {
              recordingId = await ensureMeetingSessionStarted(meetingId, meeting.hostId, meeting.title, meeting.mode, {
                onTranscriptPartial: (partial) => realtime.to(roomName).emit("meeting_transcript_partial", partial),
                onTranscriptFinal: (segment) => realtime.to(roomName).emit("meeting_transcript_final", { segment }),
                onTranslationUpdate: (segmentId, language, translatedText, detectedLanguage) =>
                  realtime.to(roomName).emit("meeting_translation_update", { segmentId, language, translatedText, detectedLanguage }),
                onInsightUpdate: (state) => realtime.to(roomName).emit("meeting_insight", state),
                onError: (userId, message) => realtime.to(roomName).emit("meeting_error", { userId, message, code: "TRANSCRIPTION" }),
              });
              // Idempotent: a rejoin/reconnect reuses the existing subscriber, so no duplicate stream.
              await startMeetingTranscriber(meetingId);
            } catch (e: any) {
              console.warn(`[transcription] unavailable for meeting ${meetingId}: ${e?.message || e}`);
              socket.emit("meeting_error", {
                message: "Live transcription is temporarily unavailable. You can still see and hear everyone in the call.",
                code: "AI_UNAVAILABLE",
              });
            }
          }

          socket.emit("meeting_joined", {
            meetingId,
            status: updatedMeeting.status,
            maxParticipants: env.maxMeetingParticipants,
            recordingId: recordingId?.toString(),
            // Tells the client whether to offer the NEXUS AI panel (Summary + Ask NEXUS).
            nexusAi: env.nexusAiActive,
            transcription: env.transcriptionActive,
          });
          socket.emit("chat_history", { messages: getChat(meetingId) });
          // Late joiner / reconnect: replay what has been transcribed so far (this socket is already authorized).
          if (env.transcriptionActive) {
            socket.emit("meeting_transcript_history", { meetingId, segments: getLiveSegments(meetingId) ?? [] });
          }
          await broadcastRoster(meetingId, updatedMeeting);
        } catch (err: any) {
          if (registered && !socket.data.meetingId) removeSocket(meetingId, socket.userId!.toString(), socket.id);
          const message = err instanceof MeetingAccessError ? err.message : err.message || "Could not join meeting.";
          socket.emit("meeting_error", { message, code: "JOIN_FAILED" });
        }
      }
    );

    // ---- In-meeting text chat -------------------------------------------
    socket.on("chat_send", (payload: { text: string }) => {
      const meetingId = socket.data.meetingId as string | undefined;
      if (!meetingId || !socket.userId) return;

      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) return;
      if (text.length > MAX_CHAT_LENGTH) {
        return socket.emit("meeting_error", { message: `Messages are limited to ${MAX_CHAT_LENGTH} characters.`, code: "CHAT_TOO_LONG" });
      }

      // Simple per-socket rate limit: 8 messages per 10 seconds.
      const now = Date.now();
      const recent: number[] = (socket.data.chatTimes || []).filter((t: number) => now - t < 10_000);
      if (recent.length >= 8) {
        return socket.emit("meeting_error", { message: "You're sending messages too quickly.", code: "CHAT_RATE" });
      }
      recent.push(now);
      socket.data.chatTimes = recent;

      const message = appendChat(meetingId, socket.userId.toString(), socket.data.meetingDisplayName || "Participant", text);
      realtime.to(roomOf(meetingId)).emit("chat_message", message);
    });

    // NOTE: there is intentionally NO meeting audio socket event. Audio never
    // flows through Express/Socket.IO; it is subscribed from LiveKit server-side.

    // ---- Optional AI handlers (Phase 3+; dormant) ----
    socket.on("meeting_change_language", async (payload: { preferredLanguage: string }) => {
      const meetingId = socket.data.meetingId;
      if (!meetingId || !socket.userId) return;
      socket.data.meetingLanguage = payload.preferredLanguage;
      if (env.enableMeetingAi) updateParticipantLanguage(meetingId, socket.userId.toString(), payload.preferredLanguage);
      await Meeting.updateOne(
        { _id: meetingId, "participants.userId": socket.userId },
        { $set: { "participants.$.preferredLanguage": payload.preferredLanguage } }
      );
    });

    // ---- NEXUS AI (Summary + Ask NEXUS) ------------------------------------
    // Both are PRIVATE replies: emitted only to the socket that asked, never
    // to the meeting room. Errors use a dedicated event so the panel can show
    // them inline instead of as a call-wide banner.

    /** Simple per-socket sliding-window limiter (LLM calls are the scarce resource). */
    function aiRateLimited(key: string, max: number, windowMs: number): boolean {
      const now = Date.now();
      const times: number[] = (socket.data[key] || []).filter((t: number) => now - t < windowMs);
      if (times.length >= max) {
        socket.data[key] = times;
        return true;
      }
      times.push(now);
      socket.data[key] = times;
      return false;
    }

    function emitAiError(kind: "ask" | "summary", requestId: string | undefined, message: string, code?: string) {
      socket.emit("meeting_ai_error", { kind, requestId, message, code });
    }

    socket.on("meeting_ask", async (payload: { question: string; requestId?: string }) => {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId.slice(0, 64) : undefined;
      try {
        const meetingId = socket.data.meetingId;
        if (!meetingId || !socket.userId) return emitAiError("ask", requestId, "Join the meeting first.", "NOT_JOINED");
        if (!env.nexusAiActive) {
          return emitAiError("ask", requestId, "NEXUS AI is not enabled for this meeting.", "AI_DISABLED");
        }

        const question = typeof payload?.question === "string" ? payload.question.trim() : "";
        if (!question) return emitAiError("ask", requestId, "Type a question first.", "EMPTY");
        if (question.length > 500) {
          return emitAiError("ask", requestId, "Please keep questions under 500 characters.", "TOO_LONG");
        }
        if (aiRateLimited("askTimes", 6, 30_000)) {
          return emitAiError("ask", requestId, "You're asking too quickly. Wait a few seconds and try again.", "RATE");
        }

        const result = await askAboutMeeting(meetingId, socket.userId, question, socket.data.meetingLanguage || "English");
        socket.emit("meeting_answer", {
          requestId,
          question,
          askedBy: socket.data.meetingDisplayName,
          answer: result.answer,
          sources: result.sources,
        });
      } catch (err: any) {
        emitAiError("ask", requestId, err?.message || "Couldn't answer that right now.", "FAILED");
      }
    });

    socket.on("meeting_summary_request", async (payload: { requestId?: string }) => {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId.slice(0, 64) : undefined;
      try {
        const meetingId = socket.data.meetingId;
        if (!meetingId || !socket.userId) return emitAiError("summary", requestId, "Join the meeting first.", "NOT_JOINED");
        if (!env.nexusAiActive) {
          return emitAiError("summary", requestId, "NEXUS AI is not enabled for this meeting.", "AI_DISABLED");
        }
        if (aiRateLimited("summaryTimes", 4, 60_000)) {
          return emitAiError("summary", requestId, "Summary was requested too many times. Try again in a minute.", "RATE");
        }

        const summary = await generateLiveMeetingSummary(meetingId, socket.userId, socket.data.meetingLanguage || "English");
        socket.emit("meeting_summary", { requestId, summary });
      } catch (err: any) {
        const code = err instanceof MeetingAiError ? err.code : "FAILED";
        emitAiError("summary", requestId, err?.message || "Couldn't generate the summary right now.", code);
      }
    });

    // ---- End / leave -----------------------------------------------------
    socket.on("end_meeting", async () => {
      try {
        const meetingId = socket.data.meetingId;
        if (!meetingId || !socket.userId) return;
        const meeting = await Meeting.findById(meetingId);
        if (!meeting) return;
        if (!meeting.hostId.equals(socket.userId)) {
          return socket.emit("meeting_error", { message: "Only the host can end the meeting for everyone.", code: "NOT_HOST" });
        }
        await closeMeeting(meetingId);
      } catch (err: any) {
        socket.emit("meeting_error", { message: err.message });
      }
    });

    socket.on("leave_meeting", async () => {
      await leaveCurrentMeeting(socket, true).catch(() => {});
    });

    socket.on("disconnect", async () => {
      // Best-effort: if the socket drops without an explicit end_session
      // (network failure, tab closed), end the live session server-side too.
      const liveSessionId = socket.data.liveSessionId;
      if (liveSessionId) {
        await endLiveSession(liveSessionId).catch(() => {});
      }
      // Meeting presence gets a short grace period so a refresh or brief
      // network drop doesn't make the person vanish from the roster.
      await leaveCurrentMeeting(socket, false).catch(() => {});
    });

    async function leaveCurrentMeeting(sock: AuthedSocket, immediate: boolean) {
      const meetingId = sock.data.meetingId as string | undefined;
      if (!meetingId || !sock.userId) return;
      const userId = sock.userId;
      const userKey = userId.toString();

      sock.leave(roomOf(meetingId));
      sock.data.meetingId = undefined;

      const stillPresent = removeSocket(meetingId, userKey, sock.id);
      if (stillPresent) return; // same user still connected elsewhere (e.g. reconnected socket)
      if (closedMeetings.has(meetingId)) return;

      if (immediate) {
        await finalizeLeave(meetingId, userId);
      } else {
        scheduleGrace(meetingId, userKey, env.reconnectGraceMs, () => {
          finalizeLeave(meetingId, userId).catch(() => {});
        });
      }
    }

    async function finalizeLeave(meetingId: string, userId: Types.ObjectId) {
      if (isUserPresent(meetingId, userId.toString())) return; // they came back in the meantime
      if (env.transcriptionActive) {
        try {
          detachParticipantAudio(meetingId, userId.toString());
        } catch {
          /* AI is optional */
        }
      }
      const meeting = await markParticipantLeft(new Types.ObjectId(meetingId), userId);
      await broadcastRoster(meetingId, meeting);

      // Last one out ends the meeting, so nothing is left "active" forever.
      if (meeting && meeting.status !== "ended" && presentUserCount(meetingId) === 0) {
        await closeMeeting(meetingId);
      }
    }

    /** Single place a meeting ends — host action, or the last person leaving. */
    async function closeMeeting(meetingId: string): Promise<Types.ObjectId | null> {
      if (closedMeetings.has(meetingId)) return null;
      closedMeetings.add(meetingId);
      setTimeout(() => closedMeetings.delete(meetingId), 10 * 60 * 1000).unref();

      // Stop pulling audio first so no new STT input arrives while finalizing.
      await stopMeetingTranscriber(meetingId).catch(() => {});

      let recordingId: Types.ObjectId | null = null;
      if (isMeetingActive(meetingId)) {
        recordingId = await endMeetingSession(meetingId).catch(() => null);
      }

      const now = new Date();
      await Meeting.updateOne({ _id: meetingId, status: { $ne: "ended" } }, { $set: { status: "ended", endedAt: now } });
      await Meeting.updateOne(
        { _id: meetingId },
        { $set: { "participants.$[p].leftAt": now } },
        { arrayFilters: [{ "p.leftAt": null }] }
      );

      const room = roomOf(meetingId);
      realtime.to(room).emit("meeting_ended", { recordingId: recordingId?.toString() });
      realtime.in(room).socketsLeave(room);
      clearRoom(meetingId);
      await closeLiveKitRoom(meetingId);
      return recordingId;
    }
  });

  return io;
}

/** Ownership guard used by REST endpoints that reference a LiveSession (e.g. history views). */
export async function assertLiveSessionOwnership(liveSessionId: string, userId: Types.ObjectId) {
  const session = await LiveSession.findOne({ _id: liveSessionId, userId });
  if (!session) throw new Error("Live session not found.");
  return session;
}