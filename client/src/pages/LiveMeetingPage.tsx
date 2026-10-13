import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getRealtimeSocket } from "../services/socket";
import { useMicStream } from "../hooks/useMicStream";
import { LiveSessionMode, LiveTranscriptSegment, LiveInsightState, LiveChatEntry } from "../types";
import LiveTranscript from "../components/live/LiveTranscript";
import LiveInsights from "../components/live/LiveInsights";
import AskNexusLive from "../components/live/AskNexusLive";
import MeetingControls from "../components/live/MeetingControls";

const MODES: { value: LiveSessionMode; label: string; hint: string }[] = [
  { value: "business_meeting", label: "Business Meeting", hint: "Decisions, action items, deadlines, risks" },
  { value: "general_meeting", label: "General Meeting", hint: "Summary, key points, questions, topics" },
  { value: "live_class", label: "Live Class", hint: "Learning, notes, concepts, exam prep" },
];

type Phase = "setup" | "live" | "ended";
type ConnectionStatus = "connecting" | "connected" | "disconnected";

export default function LiveMeetingPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("setup");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<LiveSessionMode>("business_meeting");
  const [outputLanguage, setOutputLanguage] = useState("English");
  const [viewMode, setViewMode] = useState<"original" | "translated" | "both">("both");

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [segments, setSegments] = useState<LiveTranscriptSegment[]>([]);
  const [partialText, setPartialText] = useState("");
  const [insights, setInsights] = useState<LiveInsightState | null>(null);
  const [chatHistory, setChatHistory] = useState<LiveChatEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState("");
  const [endedRecordingId, setEndedRecordingId] = useState<string | null>(null);

  const socketRef = useRef(getRealtimeSocket());

  const handleAudioChunk = useCallback((chunk: ArrayBuffer) => {
    socketRef.current.emit("audio_chunk", chunk);
  }, []);

  const mic = useMicStream(handleAudioChunk);

  useEffect(() => {
    const socket = socketRef.current;

    socket.on("connect", () => {
      setConnectionStatus("connected");
      setError("");
    });

    socket.on("disconnect", () => setConnectionStatus("disconnected"));

    socket.on("connect_error", (err) => {
      setConnectionStatus("disconnected");
      setError(
        `Can't reach the server (${err.message}). Make sure the backend (server/) is running ` +
          `on port 5000 — run "npm run dev" inside server/ and check its terminal output for errors.`
      );
    });

    socket.on("session_started", () => {
      setPhase("live");
      mic.start();
    });

    socket.on("transcript_partial", ({ text }: { text: string }) => setPartialText(text));

    socket.on("transcript_final", ({ segment }: { segment: LiveTranscriptSegment }) => {
      setPartialText("");
      setSegments((prev) => [...prev, segment]);
    });

    socket.on(
      "translation_update",
      ({ segmentIndex, translatedText, detectedLanguage }: { segmentIndex: number; translatedText: string; detectedLanguage: string }) => {
        setSegments((prev) =>
          prev.map((s, i) => (i === segmentIndex ? { ...s, translatedText, detectedLanguage } : s))
        );
      }
    );

    socket.on("ai_insight", (state: LiveInsightState) => setInsights(state));

    socket.on("answer", (result: { answer: string }) => {
      setChatHistory((prev) => {
        const updated = [...prev];
        if (updated.length > 0) updated[updated.length - 1].answer = result.answer;
        return updated;
      });
    });

    socket.on("session_paused", () => setIsPaused(true));
    socket.on("session_resumed", () => setIsPaused(false));

    socket.on("session_ended", ({ recordingId }: { recordingId?: string }) => {
      mic.stop();
      setPhase("ended");
      setEndedRecordingId(recordingId || null);
    });

    socket.on("error", ({ message }: { message: string }) => setError(message));

    return () => {
      socket.off();
      mic.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startMeeting(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!socketRef.current.connected) {
      setError(
        "Not connected to the server yet. Make sure the backend (server/) is running on port 5000, " +
          "then wait a moment and try again."
      );
      return;
    }

    socketRef.current.emit("start_live_session", {
      title: title || "Untitled meeting",
      mode,
      outputLanguage,
    });
  }

  function handlePause() {
    socketRef.current.emit("pause_session");
  }
  function handleResume() {
    socketRef.current.emit("resume_session");
  }
  function handleEnd() {
    socketRef.current.emit("end_session");
  }
  function handleLanguageChange(lang: string) {
    setOutputLanguage(lang);
    socketRef.current.emit("change_language", { outputLanguage: lang });
  }
  function handleAsk(question: string) {
    setChatHistory((prev) => [...prev, { question, answer: "…" }]);
    socketRef.current.emit("ask_ai", { question });
  }

  // Note: we intentionally do NOT disconnect the socket on unmount here.
  // In React 18 dev StrictMode, effects run mount -> cleanup -> mount once
  // on the very first render to surface effect bugs; disconnecting the
  // shared singleton socket in that cleanup killed the connection before
  // the "real" mount could ever use it. The socket is a lazy singleton
  // (see services/socket.ts) that's fine to stay connected in the
  // background; call disconnectRealtimeSocket() explicitly instead (e.g.
  // on logout) if you need to force it closed.

  if (phase === "setup") {
    return (
      <div className="max-w-lg space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Live Meeting</h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time transcript, translation, and AI insights — no upload required.
          </p>
        </div>

        {connectionStatus !== "connected" && (
          <div className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            {connectionStatus === "connecting"
              ? "Connecting to server…"
              : "Not connected to the server. The backend (server/) must be running on port 5000."}
          </div>
        )}

        <form onSubmit={startMeeting} className="card p-5 space-y-4">
          {error && <p className="text-sm text-red-300">{error}</p>}

          <div>
            <label className="label">Meeting title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="Weekly sync" />
          </div>

          <div>
            <label className="label">Mode</label>
            <div className="space-y-2">
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border ${
                    mode === m.value ? "border-brand-500 bg-brand-500/10" : "border-white/5 bg-white/5"
                  }`}
                >
                  <input
                    type="radio"
                    checked={mode === m.value}
                    onChange={() => setMode(m.value)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-slate-500">{m.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="label">Output language</label>
            <select value={outputLanguage} onChange={(e) => setOutputLanguage(e.target.value)} className="input">
              {["English", "Tamil", "Hindi", "Arabic"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-slate-500">
            Requires microphone access and a configured speech-to-text provider on the server
            (<code>STT_API_KEY</code> in <code>server/.env</code>).
          </p>

          <button type="submit" className="btn-primary w-full">
            Start Live Meeting
          </button>
        </form>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="max-w-md mx-auto text-center card p-8 space-y-4">
        <h2 className="text-lg font-semibold">Meeting ended</h2>
        <p className="text-sm text-slate-400">
          NEXUS AI is generating the final summary, meeting intelligence, and search index — this uses
          the same pipeline as an uploaded recording.
        </p>
        {endedRecordingId ? (
          <button onClick={() => navigate(`/recordings/${endedRecordingId}`)} className="btn-primary w-full">
            View meeting report
          </button>
        ) : (
          <button onClick={() => navigate("/recordings")} className="btn-secondary w-full">
            Go to Recordings
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 h-[calc(100vh-4rem)] flex flex-col">
      <MeetingControls
        micStatus={mic.status}
        isPaused={isPaused}
        outputLanguage={outputLanguage}
        onLanguageChange={handleLanguageChange}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onPause={handlePause}
        onResume={handleResume}
        onEnd={handleEnd}
        connectionStatus={connectionStatus}
      />

      {error && (
        <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 min-h-0">
        <div className="lg:col-span-2 min-h-0">
          <LiveTranscript segments={segments} partialText={partialText} viewMode={viewMode} />
        </div>
        <div className="min-h-0 overflow-y-auto space-y-4">
          <LiveInsights insights={insights} />
          <AskNexusLive history={chatHistory} onAsk={handleAsk} disabled={isPaused} />
        </div>
      </div>
    </div>
  );
}