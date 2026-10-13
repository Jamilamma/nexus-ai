import React from "react";
import { Participant } from "livekit-client";
import { MeetingParticipant } from "../../types";

export default function ParticipantsPanel({
  roster,
  media,
  currentUserId,
  maxParticipants,
}: {
  roster: MeetingParticipant[];
  media: Participant[];
  currentUserId: string;
  maxParticipants: number;
}) {
  const byIdentity = new Map(media.map((p) => [p.identity, p]));
  return (
    <div className="h-full overflow-y-auto p-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-slate-500">
        In this meeting ({roster.length}/{maxParticipants})
      </p>
      <ul className="space-y-2">
        {roster.map((p) => {
          const m = byIdentity.get(p.userId);
          return (
            <li key={p.userId} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="truncate text-slate-200">
                  {p.displayName}
                  {p.userId === currentUserId ? " (You)" : ""}
                </span>
                {p.role === "host" && <span className="ml-2 rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] text-brand-400">HOST</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                {!m && <span className="text-amber-300">connecting…</span>}
                {m && (
                  <>
                    <span title={m.isMicrophoneEnabled ? "Mic on" : "Mic off"}>{m.isMicrophoneEnabled ? "🎤" : "🔇"}</span>
                    <span title={m.isCameraEnabled ? "Camera on" : "Camera off"}>{m.isCameraEnabled ? "📷" : "🚫"}</span>
                    {m.isScreenShareEnabled && <span title="Sharing screen">🖥</span>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
