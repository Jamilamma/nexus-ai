import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ConnectionState, Participant, Room, RoomEvent } from "livekit-client";

/**
 * Owns the LiveKit (WebRTC SFU) connection for a meeting. All audio, video
 * and screen-share media flows browser <-> LiveKit directly; nothing here
 * goes through the NEXUS Express server.
 */

/** Turns a getUserMedia failure into something the person can act on (nothing is transcribed without a working mic). */
function mediaErrorMessage(err: unknown, what: string): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `Your browser blocked the ${what}. Click the lock icon in the address bar, allow it, then reload. Others can't hear you or see your words in the transcript until you do.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return `No ${what} was found. Plug one in or pick another device in your system sound settings.`;
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return `Your ${what} is in use by another app or tab. Close it and try again.`;
  }
  return `Couldn't access your ${what}. Check your browser permissions.`;
}

export type MediaConn = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export interface ConnectOptions {
  url: string;
  token: string;
  micEnabled: boolean;
  cameraEnabled: boolean;
}

export function useMeetingRoom(onUnexpectedDisconnect?: () => void) {
  const roomRef = useRef<Room | null>(null);
  const intentionalRef = useRef(false);
  const unexpectedCbRef = useRef(onUnexpectedDisconnect);
  unexpectedCbRef.current = onUnexpectedDisconnect;

  // LiveKit participants are mutable objects, so we re-render on its events
  // instead of copying their state.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [conn, setConn] = useState<MediaConn>("idle");
  const [mediaError, setMediaError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);

  const teardown = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    roomRef.current = null;
    room.removeAllListeners();
    void room.disconnect();
  }, []);

  const connect = useCallback(
    async ({ url, token, micEnabled, cameraEnabled }: ConnectOptions) => {
      intentionalRef.current = false;
      teardown();
      setMediaError("");
      setConn("connecting");

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      const bump = () => forceRender();

      room
        .on(RoomEvent.ParticipantConnected, bump)
        .on(RoomEvent.ParticipantDisconnected, bump)
        .on(RoomEvent.TrackSubscribed, bump)
        .on(RoomEvent.TrackUnsubscribed, bump)
        .on(RoomEvent.TrackMuted, bump)
        .on(RoomEvent.TrackUnmuted, bump)
        .on(RoomEvent.TrackPublished, bump)
        .on(RoomEvent.TrackUnpublished, bump)
        .on(RoomEvent.LocalTrackPublished, bump)
        .on(RoomEvent.LocalTrackUnpublished, bump)
        .on(RoomEvent.ActiveSpeakersChanged, bump)
        .on(RoomEvent.ParticipantNameChanged, bump)
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          setAudioBlocked(!room.canPlaybackAudio);
        })
        .on(RoomEvent.MediaDevicesError, (e: Error) => {
          setMediaError(mediaErrorMessage(e, "camera or microphone"));
        })
        .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          if (roomRef.current !== room) return;
          if (state === ConnectionState.Connected) setConn("connected");
          else if (state === ConnectionState.Connecting) setConn("connecting");
          else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) setConn("reconnecting");
          else if (state === ConnectionState.Disconnected) setConn("disconnected");
          bump();
        })
        .on(RoomEvent.Disconnected, () => {
          if (roomRef.current !== room) return;
          setConn("disconnected");
          // LiveKit already tried its own resume/ICE-restart before emitting
          // this; if the user didn't ask to leave, the page fetches a fresh
          // token and reconnects.
          if (!intentionalRef.current) unexpectedCbRef.current?.();
        });

      try {
        await room.connect(url, token);
      } catch (err) {
        if (roomRef.current === room) setConn("disconnected");
        throw err;
      }
      if (roomRef.current !== room) return; // superseded by a newer connect()/leave
      setConn("connected");
      setAudioBlocked(!room.canPlaybackAudio);
      room.startAudio().catch(() => {});

      const errors: string[] = [];
      let micError: unknown;
      try {
        await room.localParticipant.setMicrophoneEnabled(micEnabled);
      } catch (e) {
        errors.push("microphone");
        micError = e;
      }
      try {
        await room.localParticipant.setCameraEnabled(cameraEnabled);
      } catch {
        errors.push("camera");
      }
      if (errors.length) {
        setMediaError(
          errors.length === 1 && micError
            ? `${mediaErrorMessage(micError, "microphone")} You can still see and hear others.`
            : `Couldn't access your ${errors.join(" and ")}. You can still see and hear others.`
        );
      }
      bump();
    },
    [teardown]
  );

  const disconnect = useCallback(() => {
    intentionalRef.current = true;
    teardown();
    setConn("idle");
  }, [teardown]);

  const toggleMic = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
    } catch (e) {
      setMediaError(mediaErrorMessage(e, "microphone"));
    }
    forceRender();
  }, []);

  const toggleCamera = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      await lp.setCameraEnabled(!lp.isCameraEnabled);
    } catch {
      setMediaError("Couldn't access your camera.");
    }
    forceRender();
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      await lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true });
    } catch (err: any) {
      // Cancelling the browser's picker rejects with NotAllowedError — not an error worth showing.
      if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") {
        setMediaError("Screen sharing isn't available in this browser.");
      }
    }
    forceRender();
  }, []);

  const enableAudio = useCallback(() => {
    void roomRef.current?.startAudio().then(() => setAudioBlocked(false)).catch(() => {});
  }, []);

  // Safety net: never leave a live WebRTC connection behind on unmount.
  useEffect(() => {
    return () => {
      intentionalRef.current = true;
      teardown();
    };
  }, [teardown]);

  const room = roomRef.current;
  const local = room?.localParticipant;
  const participants: Participant[] = room ? [room.localParticipant, ...Array.from(room.remoteParticipants.values())] : [];

  return {
    conn,
    mediaError,
    clearMediaError: () => setMediaError(""),
    audioBlocked,
    enableAudio,
    participants,
    micOn: local?.isMicrophoneEnabled ?? false,
    camOn: local?.isCameraEnabled ?? false,
    screenOn: local?.isScreenShareEnabled ?? false,
    connect,
    disconnect,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}

export type MeetingRoomApi = ReturnType<typeof useMeetingRoom>;