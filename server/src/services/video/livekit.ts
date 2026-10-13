import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { env } from "../../config/env";

/**
 * LiveKit (SFU) integration.
 *
 * IMPORTANT ARCHITECTURE NOTE: no audio/video ever passes through this
 * Node process. Browsers publish/subscribe media directly to the LiveKit
 * server over WebRTC. All this file does is:
 *   1. mint short-lived join tokens (signed with the API secret), and
 *   2. best-effort room housekeeping through LiveKit's admin API.
 */

export function roomNameFor(meetingId: string): string {
  return `nexus-${meetingId}`;
}

export function isLiveKitConfigured(): boolean {
  return Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret);
}

function serviceClient(): RoomServiceClient {
  // RoomServiceClient talks HTTP(S); the browser URL is ws(s)://.
  const httpUrl = env.livekitUrl.replace(/^ws/i, "http");
  return new RoomServiceClient(httpUrl, env.livekitApiKey, env.livekitApiSecret);
}

export async function createJoinToken(params: { meetingId: string; identity: string; name: string }): Promise<string> {
  const at = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: params.identity,
    name: params.name,
    ttl: "6h",
  });
  at.addGrant({
    roomJoin: true,
    room: roomNameFor(params.meetingId),
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return await at.toJwt();
}

/** Identity prefix reserved for the server-side transcription subscriber; never a real user id. */
export const TRANSCRIBER_IDENTITY_PREFIX = "nexus-stt-";

/**
 * Token for the server-side transcription subscriber. It is HIDDEN (not
 * shown to participants), can only subscribe (cannot publish audio/video
 * or data), and is scoped to this one room. Minted and used only on the
 * server — never sent to a browser.
 */
export async function createTranscriberToken(meetingId: string): Promise<string> {
  const at = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: `${TRANSCRIBER_IDENTITY_PREFIX}${meetingId}`,
    name: "NEXUS Transcriber",
    ttl: "6h",
  });
  at.addGrant({
    roomJoin: true,
    room: roomNameFor(meetingId),
    canPublish: false,
    canPublishData: false,
    canSubscribe: true,
    hidden: true,
  });
  return await at.toJwt();
}

/**
 * Creates the room with a hard participant cap enforced by LiveKit itself
 * (defence in depth on top of the check in the socket join handler).
 * Best-effort: if the admin API is unreachable the room is still
 * auto-created on first join by the token's roomJoin grant.
 */
export async function ensureLiveKitRoom(meetingId: string): Promise<void> {
  if (!isLiveKitConfigured()) return;
  try {
    await serviceClient().createRoom({
      name: roomNameFor(meetingId),
      maxParticipants: env.maxMeetingParticipants + 1, // +1 seat for the hidden server-side transcriber
      emptyTimeout: 5 * 60,
    });
  } catch (err: any) {
    console.warn(`[livekit] ensureRoom failed (non-fatal): ${err?.message || err}`);
  }
}

/** Ends the media room for everyone (used when the host ends the meeting). Best-effort. */
export async function closeLiveKitRoom(meetingId: string): Promise<void> {
  if (!isLiveKitConfigured()) return;
  try {
    await serviceClient().deleteRoom(roomNameFor(meetingId));
  } catch (err: any) {
    console.warn(`[livekit] deleteRoom failed (non-fatal): ${err?.message || err}`);
  }
}
