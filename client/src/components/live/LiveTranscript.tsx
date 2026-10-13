import React, { useEffect, useRef } from "react";
import { LiveTranscriptSegment } from "../../types";

type ViewMode = "original" | "translated" | "both";

export default function LiveTranscript({
  segments,
  partialText,
  viewMode,
}: {
  segments: LiveTranscriptSegment[];
  partialText: string;
  viewMode: ViewMode;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments.length, partialText]);

  return (
    <div className="card p-4 h-full flex flex-col">
      <h3 className="font-medium mb-3 text-sm text-slate-400 uppercase tracking-wide">Live Transcript</h3>
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {segments.length === 0 && !partialText && (
          <p className="text-sm text-slate-600">Waiting for speech…</p>
        )}
        {segments.map((s, i) => (
          <div key={i} className="text-sm">
            <div className="text-xs text-slate-500 mb-0.5">
              [{formatTime(s.startTime)}] {s.speaker}
              {s.detectedLanguage && <span className="ml-2 badge bg-white/5">{s.detectedLanguage}</span>}
            </div>
            {(viewMode === "original" || viewMode === "both") && (
              <p className="text-slate-200">{s.text}</p>
            )}
            {(viewMode === "translated" || viewMode === "both") && s.translatedText && (
              <p className={`text-brand-400 ${viewMode === "both" ? "mt-1" : ""}`}>{s.translatedText}</p>
            )}
          </div>
        ))}
        {partialText && (
          <p className="text-sm text-slate-500 italic">{partialText}…</p>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
