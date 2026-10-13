import React from "react";
import { MicStatus } from "../../hooks/useMicStream";

const LANGUAGES = ["English", "Tamil", "Hindi", "Arabic"];

export default function MeetingControls({
  micStatus,
  isPaused,
  outputLanguage,
  onLanguageChange,
  viewMode,
  onViewModeChange,
  onPause,
  onResume,
  onEnd,
  connectionStatus,
}: {
  micStatus: MicStatus;
  isPaused: boolean;
  outputLanguage: string;
  onLanguageChange: (lang: string) => void;
  viewMode: "original" | "translated" | "both";
  onViewModeChange: (mode: "original" | "translated" | "both") => void;
  onPause: () => void;
  onResume: () => void;
  onEnd: () => void;
  connectionStatus: "connecting" | "connected" | "disconnected";
}) {
  return (
    <div className="card p-4 flex flex-wrap items-center gap-4">
      <StatusPill micStatus={micStatus} connectionStatus={connectionStatus} isPaused={isPaused} />

      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">View:</span>
        {(["original", "translated", "both"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onViewModeChange(m)}
            className={`px-2.5 py-1 rounded-md capitalize ${
              viewMode === m ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-400"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">Output language:</span>
        <select
          value={outputLanguage}
          onChange={(e) => onLanguageChange(e.target.value)}
          className="input py-1 w-32"
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="ml-auto flex gap-2">
        {isPaused ? (
          <button onClick={onResume} className="btn-secondary text-sm">
            Resume
          </button>
        ) : (
          <button onClick={onPause} className="btn-secondary text-sm">
            Pause
          </button>
        )}
        <button onClick={onEnd} className="btn-primary text-sm bg-red-500 hover:bg-red-600">
          End Meeting
        </button>
      </div>
    </div>
  );
}

function StatusPill({
  micStatus,
  connectionStatus,
  isPaused,
}: {
  micStatus: MicStatus;
  connectionStatus: "connecting" | "connected" | "disconnected";
  isPaused: boolean;
}) {
  let label = "Listening…";
  let color = "bg-emerald-500/20 text-emerald-300";

  if (connectionStatus === "connecting") {
    label = "Connecting…";
    color = "bg-amber-500/20 text-amber-300";
  } else if (connectionStatus === "disconnected") {
    label = "Reconnecting…";
    color = "bg-red-500/20 text-red-300";
  } else if (isPaused) {
    label = "Paused";
    color = "bg-slate-500/20 text-slate-300";
  } else if (micStatus === "denied") {
    label = "Microphone denied";
    color = "bg-red-500/20 text-red-300";
  } else if (micStatus === "requesting") {
    label = "Requesting microphone…";
    color = "bg-amber-500/20 text-amber-300";
  }

  return (
    <span className={`badge ${color} flex items-center gap-1.5`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      {label}
    </span>
  );
}
