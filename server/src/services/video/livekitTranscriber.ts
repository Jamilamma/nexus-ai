import { Room, RoomEvent, TrackKind, TrackSource, AudioStream, RemoteTrack, RemoteTrackPublication, RemoteParticipant } from "@livekit/rtc-node";
import { env } from "../../config/env";
import { createTranscriberToken, isLiveKitConfigured, TRANSCRIBER_IDENTITY_PREFIX } from "./livekit";
import { ensureParticipantStt, detachParticipantAudio, pushParticipantAudioChunk } from "../realtime/meetingManager";
import { STT_SAMPLE_RATE } from "../speech/realtimeTranscribe";

/**
 * Phase 2: server-side LiveKit subscriber that turns each participant's
 * microphone TRACK into a participant-specific audio stream for STT.
 *
 * Why this gives trustworthy "who said what":
 *   - Each remote audio track belongs to exactly one LiveKit participant.
 *   - participant.identity is the NEXUS userId (set when the join token is
 *     minted), so the speaker is known from the audio SOURCE. No diarization,
 *     no LLM guessing, no "Speaker 1".
 *   - Audio goes browser -> LiveKit -> this subscriber. It never passes
 *     through Express/Socket.IO.
 *
 * One bot per meeting. It is a hidden, subscribe-only participant.
 */

interface TrackPump {
  stream: AudioStream;
  active: boolean;
}

interface Bot {
  meetingId: string;
  room: Room;
  // key: `${participantIdentity}:${trackSid}`
  pumps: Map<string, TrackPump>;
  stopped: boolean;
}

const bots = new Map<string, Bot>();
const starting = new Map<string, Promise<void>>();
// Meetings whose transcriber was stopped while it was still connecting. Without this, "end meeting" during a
// (re)connect found no bot to stop and the bot then joined the dead room and kept running.
const cancelledStarts = new Set<string>();

const STT_CHANNELS = 1;
const PREROLL_MS = 1000; // audio kept from just before speech starts / while the STT stream is (re)opening

/** RMS level of an int16 frame (0-32767). Exported for tests. */
export function frameRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function isTranscriberRunning(meetingId: string): boolean {
  return bots.has(meetingId);
}

/** Idempotent: starting twice for the same meeting reuses the existing bot (no duplicate streams). */
export async function startMeetingTranscriber(meetingId: string): Promise<void> {
  if (!isLiveKitConfigured()) throw new Error("LiveKit is not configured.");
  if (bots.has(meetingId)) return;
  const inFlight = starting.get(meetingId);
  if (inFlight) return inFlight;

  const p = (async () => {
    try {
      const room = new Room();
      const bot: Bot = { meetingId, room, pumps: new Map(), stopped: false };

      // Only the participant's MICROPHONE is transcribed (screen-share audio is
      // a second audio track from the same identity and would otherwise
      // replace the mic stream and attribute system audio to the speaker).
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) return;
        void startPump(bot, track, participant);
      });

      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) return;
        stopPump(bot, participant.identity, track.sid);
      });

      // Participant left (or dropped). Stop their stream; if they reconnect,
      // TrackSubscribed fires again and ensureParticipantStt opens one fresh stream.
      room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        stopAllPumpsFor(bot, participant.identity);
        detachParticipantAudio(meetingId, participant.identity);
      });

      room.on(RoomEvent.Disconnected, () => {
        if (bot.stopped) return;
        // Unexpected drop of the bot itself: clean up and try to come back.
        teardown(bot);
        bots.delete(meetingId);
        setTimeout(() => {
          if (!bot.stopped) startMeetingTranscriber(meetingId).catch((e) => console.warn("[transcriber] rejoin failed:", e?.message || e));
        }, 2000).unref();
      });

      const token = await createTranscriberToken(meetingId);
      await room.connect(env.livekitUrl, token, { autoSubscribe: true, dynacast: false });
      if (cancelledStarts.has(meetingId)) {
        bot.stopped = true;
        await room.disconnect().catch(() => {});
        console.log(`[transcriber] start for meeting ${meetingId} was cancelled while connecting`);
        return;
      }
      bots.set(meetingId, bot);

      // Tracks already published before the bot joined (late start / server restart).
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO && pub.source === TrackSource.SOURCE_MICROPHONE) void startPump(bot, pub.track as RemoteTrack, participant);
        }
      }
      console.log(`[transcriber] joined room for meeting ${meetingId}`);
    } finally {
      starting.delete(meetingId);
      cancelledStarts.delete(meetingId);
    }
  })();

  starting.set(meetingId, p);
  return p;
}

/** Stops transcription for the meeting: leaves the room and drops every audio stream. */
export async function stopMeetingTranscriber(meetingId: string): Promise<void> {
  if (starting.has(meetingId)) cancelledStarts.add(meetingId);
  const bot = bots.get(meetingId);
  if (!bot) return;
  bot.stopped = true;
  bots.delete(meetingId);
  teardown(bot);
  await bot.room.disconnect().catch(() => {});
  console.log(`[transcriber] stopped for meeting ${meetingId}`);
}

function pumpKey(identity: string, trackSid?: string) {
  return `${identity}:${trackSid ?? ""}`;
}

async function startPump(bot: Bot, track: RemoteTrack, participant: RemoteParticipant) {
  const identity = participant.identity;
  if (!identity || identity.startsWith(TRANSCRIBER_IDENTITY_PREFIX)) return;

  const key = pumpKey(identity, track.sid);
  if (bot.pumps.has(key)) return; // already pumping this exact track -> no duplicate stream

  // A participant has one mic stream at a time. If an older track for the
  // same identity is still being pumped (reconnect re-publish), stop it so
  // only ONE audio source feeds that participant's STT session.
  stopAllPumpsFor(bot, identity);

  const stream = new AudioStream(track, STT_SAMPLE_RATE, STT_CHANNELS);
  const pump: TrackPump = { stream, active: true };
  bot.pumps.set(key, pump);

  try {
    await pumpAudio(bot.meetingId, identity, stream, () => pump.active && !bot.stopped);
  } catch (err: any) {
    if (pump.active) console.warn(`[transcriber] audio stream error for ${identity}: ${err?.message || err}`);
  } finally {
    pump.active = false;
    if (bot.pumps.get(key) === pump) bot.pumps.delete(key);
  }
}

export interface AudioFrameLike {
  data: Int16Array;
  sampleRate: number;
  channels: number;
}

/**
 * Core audio loop for ONE participant microphone: voice-gates the frames and feeds the
 * participant's single STT stream. Exported so tests can drive it with synthetic frames;
 * production passes LiveKit's AudioStream.
 *
 * Voice gate: the vendor stream is opened lazily when the participant actually speaks and
 * fed until `sttSilenceHangoverMs` after the last voiced frame (that trailing silence is
 * what lets the vendor end the turn). While silent/muted nothing is sent, so the idle
 * reaper closes the stream and the vendor slot is released.
 * Only authorized meeting participants are ever transcribed: ensureParticipantStt returns
 * "denied" for anyone not in Meeting.participants.
 */
export async function pumpAudio(
  meetingId: string,
  identity: string,
  frames: AsyncIterable<AudioFrameLike>,
  isActive: () => boolean,
  now: () => number = Date.now
): Promise<void> {
  let lastVoiceAt = -Infinity;
  let preroll: { buf: Buffer; at: number }[] = [];
  let prerollMs = 0;
  let warnedFormat = false;
  const remember = (b: Buffer, ms: number, at: number) => {
    preroll.push({ buf: b, at });
    prerollMs += ms;
    while (prerollMs > PREROLL_MS && preroll.length > 1) {
      const dropped = preroll.shift()!;
      prerollMs -= (dropped.buf.length / 2 / STT_SAMPLE_RATE) * 1000;
    }
  };

  for await (const frame of frames) {
    if (!isActive()) break;

    if (frame.sampleRate !== STT_SAMPLE_RATE || frame.channels !== STT_CHANNELS) {
      // The native resampler should always deliver 16 kHz mono; never forward anything else
      // (wrong-rate audio is transcribed as garbled text).
      if (!warnedFormat) {
        warnedFormat = true;
        console.warn(`[transcriber] unexpected audio format for ${identity}: ${frame.sampleRate} Hz x${frame.channels}; frames skipped`);
      }
      continue;
    }
    // Copy: the native buffer is reused by LiveKit.
    const bytes = Buffer.from(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
    const frameMs = (bytes.length / 2 / STT_SAMPLE_RATE) * 1000;
    const t = now();
    if (frameRms(frame.data) >= env.sttVoiceRms) lastVoiceAt = t;

    if (t - lastVoiceAt > env.sttSilenceHangoverMs) {
      remember(bytes, frameMs, t); // silent: keep a short pre-roll, send nothing
      continue;
    }

    // Speaking (or just stopped): make sure this participant's single STT stream is open.
    // Backoff-aware, so calling it per frame cannot cause a connection storm.
    const state = await ensureParticipantStt(meetingId, identity);
    if (state === "denied") break;
    if (state !== "ready") {
      remember(bytes, frameMs, t); // vendor unavailable/backing off: keep recent audio instead of dropping the start of the sentence
      continue;
    }
    // Held audio keeps its ORIGINAL capture time so transcript timestamps stay correct.
    for (const q of preroll) pushParticipantAudioChunk(meetingId, identity, q.buf, q.at);
    preroll = [];
    prerollMs = 0;
    pushParticipantAudioChunk(meetingId, identity, bytes, t);
  }
}

function stopPump(bot: Bot, identity: string, trackSid?: string) {
  const key = pumpKey(identity, trackSid);
  const pump = bot.pumps.get(key);
  if (!pump) return;
  pump.active = false;
  bot.pumps.delete(key);
  void cancelStream(pump.stream);
}

function stopAllPumpsFor(bot: Bot, identity: string) {
  for (const [key, pump] of bot.pumps) {
    if (key.startsWith(`${identity}:`)) {
      pump.active = false;
      bot.pumps.delete(key);
      void cancelStream(pump.stream);
    }
  }
}

function teardown(bot: Bot) {
  for (const pump of bot.pumps.values()) {
    pump.active = false;
    void cancelStream(pump.stream);
  }
  bot.pumps.clear();
}

async function cancelStream(stream: AudioStream) {
  try {
    await (stream as unknown as { cancel?: () => Promise<void> }).cancel?.();
  } catch {
    /* stream already closed */
  }
}
