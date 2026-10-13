import React, { useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import {
  AskNexusEntry,
  MeetingChatMessage,
  MeetingLiveSummary,
  MeetingParticipant,
  MeetingStatus,
  MeetingTranscriptSegment2,
  MeetingTranscriptPartial,
} from "../../types";
import { MeetingRoomApi } from "../../hooks/useMeetingRoom";
import { ParticipantAudio, ScreenShareView, VideoTile } from "./VideoTile";
import ChatPanel from "./ChatPanel";
import ParticipantsPanel from "./ParticipantsPanel";
import TranscriptPanel from "./TranscriptPanel";
import NexusAiPanel from "./NexusAiPanel";

type Panel = "chat" | "people" | "transcript" | null;

interface Props {
  title: string;
  meetingId: string;
  status: MeetingStatus;
  socketConnected: boolean;
  room: MeetingRoomApi;
  roster: MeetingParticipant[];
  maxParticipants: number;
  chat: MeetingChatMessage[];
  segments: MeetingTranscriptSegment2[];
  partials: MeetingTranscriptPartial[];
  viewMode: "original" | "translated";
  targetLanguage: string;
  spokenChoice: string;
  onViewModeChange: (mode: "original" | "translated") => void;
  onTargetLanguageChange: (language: string) => void;
  onSpokenChoiceChange: (choice: string) => void;
  onSendChat: (text: string) => void;
  // NEXUS AI (Summary + Ask NEXUS)
  nexusAvailable: boolean;
  summary: MeetingLiveSummary | null;
  summaryLoading: boolean;
  summaryError: string;
  onGenerateSummary: () => void;
  askEntries: AskNexusEntry[];
  onAsk: (question: string) => void;
  isHost: boolean;
  currentUserId: string;
  notice: string;
  onDismissNotice: () => void;
  videoGaveUp: boolean;
  onRetryVideo: () => void;
  onLeave: () => void;
  onEnd: () => void;
  /** The host pressed "Yes, end" and the server has not confirmed yet. */
  ending?: boolean;
}

export default function MeetingRoom(props: Props) {
  const { room, roster, chat, status, socketConnected } = props;
  const [panel, setPanel] = useState<Panel>("chat");
  const [copied, setCopied] = useState<"link" | "id" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [nexusOpen, setNexusOpen] = useState(false);

  // Unread badge for chat while its panel is closed or on another tab.
  const seenCount = useRef(chat.length);
  useEffect(() => {
    if (panel === "chat") seenCount.current = chat.length;
  }, [panel, chat.length]);
  const unread = panel === "chat" ? 0 : Math.max(0, chat.length - seenCount.current);

  const presenter = room.participants.find((p) => p.getTrackPublication(Track.Source.ScreenShare)?.track);
  const tiles = room.participants;

  function copy(kind: "link" | "id") {
    const value = kind === "link" ? `${window.location.origin}/meeting/${props.meetingId}` : props.meetingId;
    void navigator.clipboard.writeText(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1800);
  }

  // Combine socket + media state into one honest status indicator.
  let pill = { label: "LIVE", color: "bg-emerald-500/20 text-emerald-300" };
  if (status === "ended") pill = { label: "ENDED", color: "bg-slate-500/20 text-slate-300" };
  else if (!socketConnected || room.conn === "reconnecting") pill = { label: "RECONNECTING", color: "bg-amber-500/20 text-amber-300" };
  else if (room.conn === "connecting" || room.conn === "idle") pill = { label: "CONNECTING", color: "bg-amber-500/20 text-amber-300" };
  else if (room.conn === "disconnected") pill = { label: "VIDEO OFFLINE", color: "bg-red-500/20 text-red-300" };

  const gridCols =
    tiles.length <= 1 ? "grid-cols-1" : tiles.length <= 4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 lg:grid-cols-3";

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-base font-semibold">{props.title}</h1>
          <span className={`badge ${pill.color} flex items-center gap-1.5`}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            {pill.label}
          </span>
          <span className="text-sm text-slate-400">
            {roster.length}/{props.maxParticipants} in meeting
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => copy("link")} className="btn-secondary text-sm">
            {copied === "link" ? "Link copied!" : "Copy link"}
          </button>
          <button onClick={() => copy("id")} className="btn-secondary text-sm" title={props.meetingId}>
            {copied === "id" ? "ID copied!" : "Copy ID"}
          </button>
        </div>
      </div>

      {(props.notice || room.mediaError) && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <span>{props.notice || room.mediaError}</span>
          <button
            className="text-xs underline"
            onClick={() => {
              props.onDismissNotice();
              room.clearMediaError();
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {props.videoGaveUp && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-200">
          <span>Lost the connection to the video server.</span>
          <button className="btn-secondary text-xs" onClick={props.onRetryVideo}>
            Rejoin video
          </button>
        </div>
      )}

      {room.audioBlocked && (
        <button onClick={room.enableAudio} className="rounded-lg bg-brand-500/20 px-3 py-2 text-sm text-brand-400">
          🔈 Click to enable meeting audio (your browser blocked autoplay)
        </button>
      )}

      {/* Stage + side panel */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        <div className="min-h-0 overflow-y-auto">
          {presenter ? (
            <div className="flex h-full min-h-[300px] flex-col gap-3 lg:flex-row">
              <div className="min-h-[240px] flex-1">
                <ScreenShareView participant={presenter} />
              </div>
              <div className="flex gap-3 overflow-x-auto lg:w-48 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
                {tiles.map((p) => (
                  <div key={p.identity} className="w-40 shrink-0 lg:w-full">
                    <VideoTile participant={p} compact />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={`grid gap-3 ${gridCols}`}>
              {tiles.map((p) => (
                <VideoTile key={p.identity} participant={p} />
              ))}
              {tiles.length === 0 && (
                <div className="col-span-full flex h-64 items-center justify-center text-sm text-slate-500">
                  Connecting to the meeting…
                </div>
              )}
            </div>
          )}
        </div>

        {panel && (
          <div className="card flex min-h-[240px] flex-col overflow-hidden p-0 lg:min-h-0">
            <div className="flex shrink-0 border-b border-white/5">
              {(["chat", "transcript", "people"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setPanel(t)}
                  className={`flex-1 px-1 py-2.5 text-[11px] font-medium uppercase tracking-wide ${
                    panel === t ? "border-b-2 border-brand-400 text-brand-400" : "text-slate-500"
                  }`}
                >
                  {t === "people" ? `People (${roster.length})` : t === "transcript" ? "Transcript" : "Chat"}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {panel === "chat" ? (
                <ChatPanel messages={chat} currentUserId={props.currentUserId} onSend={props.onSendChat} />
              ) : panel === "transcript" ? (
                <TranscriptPanel
                  segments={props.segments}
                  partials={props.partials}
                  currentUserId={props.currentUserId}
                  viewMode={props.viewMode}
                  targetLanguage={props.targetLanguage}
                  spokenChoice={props.spokenChoice}
                  onViewModeChange={props.onViewModeChange}
                  onTargetLanguageChange={props.onTargetLanguageChange}
                  onSpokenChoiceChange={props.onSpokenChoiceChange}
                />
              ) : (
                <ParticipantsPanel
                  roster={roster}
                  media={room.participants}
                  currentUserId={props.currentUserId}
                  maxParticipants={props.maxParticipants}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Remote audio sinks (invisible) */}
      {room.participants.map((p) => (
        <ParticipantAudio key={p.identity} participant={p} />
      ))}

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-center gap-2 pb-1">
        <ControlButton active={room.micOn} onClick={room.toggleMic} label={room.micOn ? "Mute" : "Unmute"} icon={room.micOn ? "🎤" : "🔇"} />
        <ControlButton active={room.camOn} onClick={room.toggleCamera} label={room.camOn ? "Camera off" : "Camera on"} icon={room.camOn ? "📷" : "🚫"} />
        <ControlButton active={room.screenOn} highlight onClick={room.toggleScreenShare} label={room.screenOn ? "Stop sharing" : "Share screen"} icon="🖥" />
        <ControlButton
          active={panel === "chat"}
          highlight
          onClick={() => setPanel(panel === "chat" ? null : "chat")}
          label="Chat"
          icon="💬"
          badge={unread}
        />
        <ControlButton
          active={panel === "transcript"}
          highlight
          onClick={() => setPanel(panel === "transcript" ? null : "transcript")}
          label="Transcript"
          icon="📝"
        />
        <ControlButton active={panel === "people"} highlight onClick={() => setPanel(panel === "people" ? null : "people")} label="People" icon="👥" />
        {/* Always rendered while in the meeting; the modal explains if the server has NEXUS AI off. */}
        <button
          onClick={() => setNexusOpen(true)}
          className="btn-primary flex items-center gap-2 px-3 py-2 text-sm font-semibold"
          aria-haspopup="dialog"
          title="NEXUS AI: meeting summary and Ask NEXUS"
        >
          <span>✨</span>
          <span>NEXUS AI</span>
        </button>
        <button onClick={props.onLeave} className="btn-secondary text-sm">
          Leave
        </button>
        {props.isHost &&
          (confirmEnd ? (
            <span className="flex items-center gap-2 text-sm">
              End for everyone?
              <button
                onClick={props.onEnd}
                disabled={props.ending}
                className="btn-primary bg-red-500 text-sm hover:bg-red-600 disabled:opacity-60"
                style={{ backgroundImage: "none" }}
              >
                {props.ending ? "Ending…" : "Yes, end"}
              </button>
              <button onClick={() => setConfirmEnd(false)} disabled={props.ending} className="btn-secondary text-sm">
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmEnd(true)} className="btn-primary bg-red-500 text-sm hover:bg-red-600" style={{ backgroundImage: "none" }}>
              End meeting
            </button>
          ))}
      </div>

      {nexusOpen && (
        <NexusAiPanel
          available={props.nexusAvailable}
          transcriptLines={props.segments.length}
          summary={props.summary}
          summaryLoading={props.summaryLoading}
          summaryError={props.summaryError}
          onGenerateSummary={props.onGenerateSummary}
          askEntries={props.askEntries}
          onAsk={props.onAsk}
          onClose={() => setNexusOpen(false)}
        />
      )}
    </div>
  );
}

function ControlButton({
  active,
  highlight,
  onClick,
  label,
  icon,
  badge,
}: {
  active: boolean;
  highlight?: boolean;
  onClick: () => void;
  label: string;
  icon: string;
  badge?: number;
}) {
  // For mic/camera "active" = device on (neutral); for panel/screen buttons "active" is highlighted.
  const style = highlight
    ? active
      ? "bg-brand-500/25 text-brand-400"
      : "bg-white/5 text-slate-300 hover:bg-white/10"
    : active
    ? "bg-white/10 text-slate-100 hover:bg-white/15"
    : "bg-red-500/20 text-red-300 hover:bg-red-500/30";
  return (
    <button onClick={onClick} className={`relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${style}`}>
      <span>{icon}</span>
      <span className="hidden sm:inline">{label}</span>
      {!!badge && badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white">
          {badge}
        </span>
      )}
    </button>
  );
}