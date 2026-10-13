import React, { useEffect, useRef } from "react";
import { Participant, Track } from "livekit-client";

/** Attaches a LiveKit track to an <audio>/<video> element and cleans up on change. */
function useAttach<T extends HTMLMediaElement>(ref: React.RefObject<T>, track: Track | undefined) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [ref, track]);
}

export function displayNameOf(p: Participant): string {
  return (p.name || p.identity || "Participant") + (p.isLocal ? " (You)" : "");
}

function initialsOf(p: Participant): string {
  const name = (p.name || p.identity || "?").trim();
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

export function VideoTile({ participant, compact = false }: { participant: Participant; compact?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const camPub = participant.getTrackPublication(Track.Source.Camera);
  const camTrack = camPub && !camPub.isMuted ? camPub.track : undefined;
  useAttach(videoRef, camTrack);

  const micMuted = !participant.isMicrophoneEnabled;
  const speaking = participant.isSpeaking;

  return (
    <div
      className={`relative aspect-video w-full overflow-hidden rounded-xl bg-slate-900 ${
        speaking ? "ring-2 ring-emerald-400" : "ring-1 ring-white/10"
      }`}
    >
      {/* Video element is always muted: remote audio is played by <ParticipantAudio/>. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-cover ${camTrack ? "" : "hidden"}`}
        style={participant.isLocal ? { transform: "scaleX(-1)" } : undefined}
      />
      {!camTrack && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={`flex items-center justify-center rounded-full bg-brand-500/30 font-semibold text-brand-400 ${
              compact ? "h-10 w-10 text-sm" : "h-20 w-20 text-2xl"
            }`}
          >
            {initialsOf(participant)}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2">
        <span className="truncate rounded-md bg-black/60 px-2 py-0.5 text-xs text-slate-100">{displayNameOf(participant)}</span>
        {micMuted && <span className="rounded-md bg-red-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white">MUTED</span>}
      </div>
    </div>
  );
}

function AudioSink({ track }: { track: Track | undefined }) {
  const ref = useRef<HTMLAudioElement>(null);
  useAttach(ref, track);
  return <audio ref={ref} autoPlay />;
}

/** Plays a remote participant's microphone (and shared-tab audio). Never rendered for yourself (no echo). */
export function ParticipantAudio({ participant }: { participant: Participant }) {
  if (participant.isLocal) return null;
  return (
    <>
      <AudioSink track={participant.getTrackPublication(Track.Source.Microphone)?.track} />
      <AudioSink track={participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track} />
    </>
  );
}

export function ScreenShareView({ participant }: { participant: Participant }) {
  const ref = useRef<HTMLVideoElement>(null);
  const track = participant.getTrackPublication(Track.Source.ScreenShare)?.track;
  // Showing your own screen inside the page you're sharing causes an infinite mirror.
  const showVideo = !participant.isLocal;
  useAttach(ref, showVideo ? track : undefined);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
      {showVideo ? (
        <video ref={ref} autoPlay playsInline muted className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-slate-300">You're sharing your screen</div>
      )}
      <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-slate-100">
        {participant.isLocal ? "You are presenting" : `${participant.name || participant.identity} is presenting`}
      </span>
    </div>
  );
}
