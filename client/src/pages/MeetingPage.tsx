import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api, apiErrorMessage } from "../services/api";
import { getRealtimeSocket } from "../services/socket";
import { useAuth } from "../context/AuthContext";
import { useMeetingRoom } from "../hooks/useMeetingRoom";
import MeetingRoom from "../components/meeting/MeetingRoom";
import { SPOKEN_CHOICES } from "../components/meeting/TranscriptPanel";
import {
  AskNexusEntry,
  MeetingAiErrorEvent,
  MeetingAnswer,
  MeetingChatMessage,
  MeetingLiveSummary,
  MeetingParticipant,
  MeetingPreview,
  MeetingStatus,
  MeetingTranscriptSegment2,
  MeetingTranscriptPartial,
} from "../types";

/**
 * NEXUS-owned meeting screen (Phase 1: video core).
 *
 *  - Media (audio / video / screen share): browser <-> LiveKit SFU over WebRTC.
 *  - Control plane (roster, status, chat, join/leave/end): Socket.IO /realtime.
 *  - Auth + meeting state: Express + MongoDB. Express also mints the LiveKit
 *    join token, but never carries any media.
 */

type Phase = "loading" | "preview" | "live" | "ended" | "not_found";

const MAX_VIDEO_RETRIES = 6;

/** Transcript reading preferences (UI only; remembered on this device). */
type TranscriptView = "original" | "translated";
const PREF_TARGET = "nexus.meeting.targetLanguage";
const PREF_SPOKEN = "nexus.meeting.spokenChoice";
const readPref = (key: string, fallback: string) => {
  try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; }
};
const writePref = (key: string, value: string) => {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable: the choice just isn't remembered */ }
};
const SUMMARY_TIMEOUT_MS = 90_000;
const ASK_TIMEOUT_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRequestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default function MeetingPage() {
  const { id: meetingId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<MeetingPreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Join-screen inputs
  const [displayName, setDisplayName] = useState(user?.name || "");
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [joining, setJoining] = useState(false);
  const [ending, setEnding] = useState(false); // host pressed "Yes, end" and the server has not confirmed yet

  // Live state
  const [socketConnected, setSocketConnected] = useState(false);
  const [roster, setRoster] = useState<MeetingParticipant[]>([]);
  const [status, setStatus] = useState<MeetingStatus>("active");
  const [maxParticipants, setMaxParticipants] = useState(5);
  const [chat, setChat] = useState<MeetingChatMessage[]>([]);
  const [endedHasReport, setEndedHasReport] = useState(false);
  const [videoGaveUp, setVideoGaveUp] = useState(false);
  const [segments, setSegments] = useState<MeetingTranscriptSegment2[]>([]);
  const [partials, setPartials] = useState<Record<string, MeetingTranscriptPartial>>({});
  // Original / translated transcript view. The target language also sets the language of NEXUS Summary + Ask answers.
  const [viewMode, setViewMode] = useState<TranscriptView>("original");
  const [targetLanguage, setTargetLanguage] = useState(() => readPref(PREF_TARGET, "English"));
  const [spokenChoice, setSpokenChoice] = useState(() => (SPOKEN_CHOICES[readPref(PREF_SPOKEN, "auto")] ? readPref(PREF_SPOKEN, "auto") : "auto"));
  const prefsRef = useRef({ viewMode, targetLanguage, spokenChoice });
  prefsRef.current = { viewMode, targetLanguage, spokenChoice };

  // NEXUS AI (Summary + Ask NEXUS) — replies are private to this user.
  const [nexusAvailable, setNexusAvailable] = useState(false);
  const [summary, setSummary] = useState<MeetingLiveSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [askEntries, setAskEntries] = useState<AskNexusEntry[]>([]);
  const summaryReqRef = useRef("");
  const summaryTimerRef = useRef<number | undefined>(undefined);
  const askTimersRef = useRef<Record<string, number>>({});

  const socketRef = useRef(getRealtimeSocket());
  const joinedRef = useRef(false); // user has joined (so socket reconnects must re-join)
  const leavingRef = useRef(false);
  const startingMediaRef = useRef(false);
  const retriesRef = useRef(0);
  const noticeIsTranscriptionRef = useRef(false); // current banner is a transcription-capacity notice

  // Latest values for use inside long-lived socket handlers.
  const wantsRef = useRef({ mic: true, camera: true, displayName: "" });
  wantsRef.current = { mic: micOn, camera: cameraOn, displayName: displayName.trim() || user?.name || "Participant" };

  const reconnectMediaRef = useRef<() => void>(() => {});
  const room = useMeetingRoom(() => reconnectMediaRef.current());
  const roomRef = useRef(room);
  roomRef.current = room;

  const isHost = roster.find((p) => p.userId === user?.id)?.role === "host";

  // ---- Media (LiveKit) ------------------------------------------------------

  /** Fetch a join token and connect to the SFU. Requires an active socket join (server checks). */
  const startMedia = useCallback(async () => {
    if (!meetingId || startingMediaRef.current || leavingRef.current) return;
    startingMediaRef.current = true;
    try {
      const { data } = await api.post(`/meetings/${meetingId}/token`);
      // On a reconnect keep whatever mic/camera state the user currently has.
      const current = roomRef.current;
      const first = current.conn === "idle";
      await current.connect({
        url: data.url,
        token: data.token,
        micEnabled: first ? wantsRef.current.mic : current.micOn,
        cameraEnabled: first ? wantsRef.current.camera : current.camOn,
      });
      retriesRef.current = 0;
      setVideoGaveUp(false);
    } catch (err) {
      setNotice(`Video connection problem: ${apiErrorMessage(err)}`);
      throw err;
    } finally {
      startingMediaRef.current = false;
    }
  }, [meetingId]);

  /** LiveKit gave up on its own resume attempts: back off, fetch a fresh token, reconnect. */
  const reconnectMedia = useCallback(async () => {
    if (leavingRef.current || !joinedRef.current) return;
    if (!socketRef.current.connected) return; // the socket 'connect' handler re-joins, then restarts media
    if (retriesRef.current >= MAX_VIDEO_RETRIES) {
      setVideoGaveUp(true);
      return;
    }
    retriesRef.current += 1;
    await sleep(Math.min(1000 * 2 ** (retriesRef.current - 1), 8000));
    if (leavingRef.current || !joinedRef.current) return;
    try {
      await startMedia();
    } catch {
      void reconnectMedia();
    }
  }, [startMedia]);
  reconnectMediaRef.current = () => void reconnectMedia();

  // ---- Preview --------------------------------------------------------------

  useEffect(() => {
    if (!meetingId) return;
    api
      .get(`/meetings/${meetingId}/preview`)
      .then((res) => {
        setPreview(res.data);
        setMaxParticipants(res.data.maxParticipants ?? 5);
        setEndedHasReport(Boolean(res.data.hasReport));
        setPhase(res.data.status === "ended" ? "ended" : "preview");
      })
      .catch(() => setPhase("not_found"));
  }, [meetingId]);

  // ---- Socket (control plane) ----------------------------------------------

  useEffect(() => {
    const socket = socketRef.current;
    setSocketConnected(socket.connected);

    const onConnect = () => {
      setSocketConnected(true);
      // After a network drop the server has a fresh socket with no meeting
      // attached — re-join. The server treats this as a rejoin (no duplicate).
      if (joinedRef.current && !leavingRef.current && meetingId) {
        socket.emit("join_meeting", { meetingId, displayName: wantsRef.current.displayName });
      }
    };
    const onDisconnect = () => setSocketConnected(false);
    const onConnectError = (err: Error) => {
      setSocketConnected(false);
      setNotice(`Can't reach the server (${err.message}). Retrying…`);
    };

    const onJoined = (p: { status: MeetingStatus; maxParticipants: number; nexusAi?: boolean }) => {
      joinedRef.current = true;
      setNexusAvailable(Boolean(p.nexusAi));
      setJoining(false);
      setError("");
      setStatus(p.status);
      setMaxParticipants(p.maxParticipants);
      setPhase("live");
      setNotice("");
      // The server forgets per-socket choices after a reconnect: re-apply them.
      const prefs = prefsRef.current;
      const socket = socketRef.current;
      socket.emit("meeting_change_language", { preferredLanguage: prefs.targetLanguage });
      socket.emit("meeting_set_translation", { language: prefs.viewMode === "translated" ? prefs.targetLanguage : null });
      if (SPOKEN_CHOICES[prefs.spokenChoice]?.codes.length) socket.emit("meeting_set_spoken_languages", { languages: SPOKEN_CHOICES[prefs.spokenChoice].codes });
      // Start media if we don't have a healthy connection (first join, or rejoin after the SFU dropped us).
      const c = roomRef.current.conn;
      if (c === "idle" || c === "disconnected") {
        retriesRef.current = 0;
        startMedia().catch(() => reconnectMediaRef.current());
      }
    };

    const onRoster = (p: { participants: MeetingParticipant[]; status?: MeetingStatus; maxParticipants?: number }) => {
      setRoster(p.participants);
      if (p.status) setStatus(p.status);
      if (p.maxParticipants) setMaxParticipants(p.maxParticipants);
    };

    const onChatHistory = ({ messages }: { messages: MeetingChatMessage[] }) => setChat(messages);
    const onChatMessage = (m: MeetingChatMessage) =>
      setChat((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));

    // Insert by startTime and drop duplicates by segmentId (history replay + live events can overlap on reconnect).
    const mergeSegments = (prev: MeetingTranscriptSegment2[], incoming: MeetingTranscriptSegment2[]) => {
      const seen = new Set(prev.map((x) => x.segmentId).filter(Boolean));
      const fresh = incoming.filter((x) => !x.segmentId || !seen.has(x.segmentId));
      if (fresh.length === 0) return prev;
      return [...prev, ...fresh].sort((a, b) => a.startTime - b.startTime);
    };
    const onTranscriptHistory = ({ segments: hist }: { segments: MeetingTranscriptSegment2[] }) =>
      setSegments((prev) => mergeSegments(prev, hist));
    const onTranscriptFinal = ({ segment }: { segment: MeetingTranscriptSegment2 }) => {
      // Transcription is flowing again: drop the stale "transcription interrupted" banner.
      if (noticeIsTranscriptionRef.current) {
        noticeIsTranscriptionRef.current = false;
        setNotice("");
      }
      setSegments((prev) => mergeSegments(prev, [segment]));
      // The final replaces that participant's interim line.
      if (segment.participantId) {
        setPartials((prev) => {
          if (!prev[segment.participantId!]) return prev;
          const next = { ...prev };
          delete next[segment.participantId!];
          return next;
        });
      }
    };
    // A translation arrived for a finalized line: attach it beside the original (the original text is never touched).
    const onTranslationUpdate = (u: { segmentId: string; language: string; translatedText: string }) =>
      setSegments((prev) =>
        prev.map((s) => (s.segmentId === u.segmentId ? { ...s, translations: { ...(s.translations ?? {}), [u.language]: u.translatedText } } : s))
      );
    const onTranscriptPartial = (p: MeetingTranscriptPartial) =>
      setPartials((prev) => {
        const next = { ...prev };
        if (p.text) next[p.participantId] = p;
        else delete next[p.participantId];
        return next;
      });

    // ---- NEXUS AI replies (sent only to this socket) ----
    const onSummary = ({ requestId, summary: s }: { requestId?: string; summary: MeetingLiveSummary }) => {
      if (requestId && requestId !== summaryReqRef.current) return; // stale reply from an older request
      summaryReqRef.current = "";
      window.clearTimeout(summaryTimerRef.current);
      setSummary(s);
      setSummaryLoading(false);
      setSummaryError("");
    };
    const onAnswer = (a: MeetingAnswer) => {
      if (a.requestId) {
        window.clearTimeout(askTimersRef.current[a.requestId]);
        delete askTimersRef.current[a.requestId];
      }
      setAskEntries((prev) =>
        prev.map((e) =>
          e.id === a.requestId
            ? {
                ...e,
                pending: false,
                answer: a.answer,
                sources: a.sources,
                error: undefined,
                tookMs: a.timings?.totalMs,
                note:
                  a.segmentCount === 0
                    ? "Nothing has been transcribed in this meeting yet, so there was nothing to answer from. Speak for a moment, wait for the lines to appear in the Transcript tab, then ask again."
                    : undefined,
              }
            : e
        )
      );
    };
    const onAiError = (e: MeetingAiErrorEvent) => {
      if (e.kind === "summary") {
        summaryReqRef.current = "";
        window.clearTimeout(summaryTimerRef.current);
        setSummaryLoading(false);
        setSummaryError(e.message);
        return;
      }
      if (e.requestId) {
        window.clearTimeout(askTimersRef.current[e.requestId]);
        delete askTimersRef.current[e.requestId];
      }
      setAskEntries((prev) => prev.map((x) => (x.id === e.requestId ? { ...x, pending: false, error: e.message } : x)));
    };

    // Server-confirmed end (event for everyone, or the host's own acknowledgement; whichever arrives first).
    const onEnded = ({ recordingId }: { recordingId?: string }) => applyEnded(recordingId);

    const onMeetingError = (e: { message: string; code?: string }) => {
      if (e.code === "AI_DISABLED") return;
      if (e.code === "ENDED") {
        joinedRef.current = false;
        setJoining(false);
        setPhase("ended");
        return;
      }
      if (e.code === "FULL" || e.code === "NOT_FOUND" || e.code === "JOIN_FAILED" || e.code === "AUTH") {
        // Join was refused. If we were mid-rejoin after a drop, tell the user in-call; otherwise show on the join screen.
        setJoining(false);
        if (phase !== "live") {
          joinedRef.current = false;
          setError(e.message);
          return;
        }
      }
      noticeIsTranscriptionRef.current = e.code === "TRANSCRIPTION";
      setNotice(e.message);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("meeting_joined", onJoined);
    socket.on("participants_update", onRoster);
    socket.on("chat_history", onChatHistory);
    socket.on("chat_message", onChatMessage);
    socket.on("meeting_transcript_history", onTranscriptHistory);
    socket.on("meeting_transcript_final", onTranscriptFinal);
    socket.on("meeting_transcript_partial", onTranscriptPartial);
    socket.on("meeting_translation_update", onTranslationUpdate);
    socket.on("meeting_ended", onEnded);
    socket.on("meeting_error", onMeetingError);
    socket.on("meeting_summary", onSummary);
    socket.on("meeting_answer", onAnswer);
    socket.on("meeting_ai_error", onAiError);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("meeting_joined", onJoined);
      socket.off("participants_update", onRoster);
      socket.off("chat_history", onChatHistory);
      socket.off("chat_message", onChatMessage);
      socket.off("meeting_transcript_history", onTranscriptHistory);
      socket.off("meeting_transcript_final", onTranscriptFinal);
      socket.off("meeting_transcript_partial", onTranscriptPartial);
      socket.off("meeting_translation_update", onTranslationUpdate);
      socket.off("meeting_ended", onEnded);
      socket.off("meeting_error", onMeetingError);
      socket.off("meeting_summary", onSummary);
      socket.off("meeting_answer", onAnswer);
      socket.off("meeting_ai_error", onAiError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, startMedia, phase]);

  // Don't leave NEXUS AI timers running after the page is gone.
  useEffect(() => {
    return () => {
      window.clearTimeout(summaryTimerRef.current);
      Object.values(askTimersRef.current).forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // Leaving the page (route change / tab close handled by server grace timer) must drop the call.
  useEffect(() => {
    return () => {
      if (joinedRef.current && !leavingRef.current) {
        socketRef.current.emit("leave_meeting");
      }
      roomRef.current.disconnect();
    };
  }, []);

  // ---- Actions ---------------------------------------------------------------

  function joinMeeting() {
    if (!meetingId || joining) return;
    setError("");
    setJoining(true);
    leavingRef.current = false;
    socketRef.current.emit("join_meeting", { meetingId, displayName: wantsRef.current.displayName });
  }

  function leaveMeeting() {
    leavingRef.current = true;
    joinedRef.current = false;
    socketRef.current.emit("leave_meeting");
    room.disconnect();
    navigate("/meetings");
  }

  /** Shows the "meeting ended" screen. Only ever called after the server confirmed the end. */
  function applyEnded(recordingId?: string) {
    leavingRef.current = true;
    joinedRef.current = false;
    roomRef.current.disconnect();
    setEnding(false);
    setEndedHasReport(Boolean(recordingId));
    setStatus("ended");
    setPhase("ended");
  }

  function endForEveryone() {
    if (ending) return; // ignore repeated clicks while the first request is in flight
    const socket = socketRef.current;
    if (!socket.connected) {
      noticeIsTranscriptionRef.current = false;
      setNotice("You're offline right now, so the meeting could not be ended. Wait for the connection to return and try again.");
      return;
    }
    setEnding(true);
    socket.timeout(20_000).emit(
      "end_meeting",
      {},
      (err: Error | null, res?: { ok: boolean; message?: string; recordingId?: string }) => {
        if (err) {
          // No answer from the server: the meeting may or may not have ended. If it did, `meeting_ended` still arrives.
          setEnding(false);
          noticeIsTranscriptionRef.current = false;
          setNotice("The server did not confirm that the meeting ended. Check your connection and try again; the meeting is still open.");
          return;
        }
        if (!res?.ok) {
          setEnding(false);
          noticeIsTranscriptionRef.current = false;
          setNotice(res?.message || "Couldn't end the meeting. Please try again.");
          return;
        }
        applyEnded(res.recordingId);
      }
    );
  }

  function sendChat(text: string) {
    socketRef.current.emit("chat_send", { text });
  }

  /** Summary of the meeting so far (the server shares one cached result between participants). */
  function requestSummary() {
    if (summaryLoading) return;
    const requestId = newRequestId();
    summaryReqRef.current = requestId;
    setSummaryLoading(true);
    setSummaryError("");
    window.clearTimeout(summaryTimerRef.current);
    summaryTimerRef.current = window.setTimeout(() => {
      if (summaryReqRef.current !== requestId) return;
      summaryReqRef.current = "";
      setSummaryLoading(false);
      setSummaryError("The summary took too long. Please try again.");
    }, SUMMARY_TIMEOUT_MS);
    socketRef.current.emit("meeting_summary_request", { requestId });
  }

  /** Ask NEXUS a question about this meeting; the answer comes back privately to this user only. */
  function askNexus(question: string) {
    const text = question.trim();
    if (!text) return;
    const id = newRequestId();
    setAskEntries((prev) => [...prev, { id, question: text, pending: true }]);
    askTimersRef.current[id] = window.setTimeout(() => {
      delete askTimersRef.current[id];
      setAskEntries((prev) =>
        prev.map((e) => (e.id === id && e.pending ? { ...e, pending: false, error: "NEXUS took too long to answer. Please try again." } : e))
      );
    }, ASK_TIMEOUT_MS);
    socketRef.current.emit("meeting_ask", { question: text, requestId: id });
  }

  /** Switch between the original transcript and the translated reading view. */
  function changeViewMode(mode: TranscriptView) {
    setViewMode(mode);
    socketRef.current.emit("meeting_set_translation", { language: mode === "translated" ? targetLanguage : null });
  }

  /** Target language for translation AND for the language of NEXUS Summary / Ask answers. */
  function changeTargetLanguage(language: string) {
    setTargetLanguage(language);
    writePref(PREF_TARGET, language);
    socketRef.current.emit("meeting_change_language", { preferredLanguage: language });
    if (viewMode === "translated") socketRef.current.emit("meeting_set_translation", { language });
  }

  /** Optional "I speak" hint for my own microphone; "auto" returns to automatic language detection. */
  function changeSpokenChoice(choice: string) {
    if (!SPOKEN_CHOICES[choice]) return;
    setSpokenChoice(choice);
    writePref(PREF_SPOKEN, choice);
    socketRef.current.emit("meeting_set_spoken_languages", { languages: SPOKEN_CHOICES[choice].codes });
  }

  function retryVideo() {
    retriesRef.current = 0;
    setVideoGaveUp(false);
    startMedia().catch(() => reconnectMediaRef.current());
  }

  // ---- Render ------------------------------------------------------------------

  if (phase === "loading") return <div className="text-sm text-slate-500">Loading meeting…</div>;

  if (phase === "not_found") {
    return (
      <div className="card mx-auto max-w-md space-y-3 p-8 text-center">
        <h2 className="text-lg font-semibold">Meeting not found</h2>
        <p className="text-sm text-slate-400">This meeting link is invalid or the meeting no longer exists.</p>
        <Link to="/meetings" className="btn-primary inline-block">
          Back to Meetings
        </Link>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="card mx-auto max-w-md space-y-4 p-8 text-center">
        <h2 className="text-lg font-semibold">Meeting ended</h2>
        <p className="text-sm text-slate-400">This meeting has finished.</p>
        <div className="flex gap-2">
          {endedHasReport && (
            <Link to={`/meetings/${meetingId}/report`} className="btn-primary w-full text-center">
              View meeting report
            </Link>
          )}
          <Link to="/meetings" className="btn-secondary w-full text-center">
            Back to Meetings
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "preview" && preview) {
    const full = preview.participantCount >= preview.maxParticipants;
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <h1 className="text-xl font-semibold">{preview.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Hosted by {preview.host} · {preview.participantCount}/{preview.maxParticipants} in the meeting
          </p>
        </div>

        <div className="card space-y-4 p-5">
          {error && <p className="text-sm text-red-300">{error}</p>}
          {!preview.videoConfigured && (
            <p className="text-sm text-amber-300">
              The video server isn't configured yet (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET), so video won't connect.
            </p>
          )}
          {full && <p className="text-sm text-amber-300">This meeting is currently full.</p>}

          <div>
            <label className="label">Your name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" placeholder="Your name" maxLength={60} />
          </div>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={cameraOn} onChange={(e) => setCameraOn(e.target.checked)} />
              Camera on
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={micOn} onChange={(e) => setMicOn(e.target.checked)} />
              Microphone on
            </label>
          </div>

          <button onClick={joinMeeting} className="btn-primary w-full" disabled={joining || !socketConnected || full}>
            {joining ? "Joining…" : !socketConnected ? "Connecting to server…" : "Join Meeting"}
          </button>
        </div>
      </div>
    );
  }

  // phase === "live"
  return (
    <MeetingRoom
      title={preview?.title || "Meeting"}
      meetingId={meetingId || ""}
      status={status}
      socketConnected={socketConnected}
      room={room}
      roster={roster}
      maxParticipants={maxParticipants}
      chat={chat}
      segments={segments}
      partials={Object.values(partials)}
      viewMode={viewMode}
      targetLanguage={targetLanguage}
      spokenChoice={spokenChoice}
      onViewModeChange={changeViewMode}
      onTargetLanguageChange={changeTargetLanguage}
      onSpokenChoiceChange={changeSpokenChoice}
      onSendChat={sendChat}
      nexusAvailable={nexusAvailable}
      summary={summary}
      summaryLoading={summaryLoading}
      summaryError={summaryError}
      onGenerateSummary={requestSummary}
      askEntries={askEntries}
      onAsk={askNexus}
      isHost={isHost}
      currentUserId={user?.id || ""}
      notice={notice}
      onDismissNotice={() => setNotice("")}
      videoGaveUp={videoGaveUp}
      onRetryVideo={retryVideo}
      onLeave={leaveMeeting}
      onEnd={endForEveryone}
      ending={ending}
    />
  );
}