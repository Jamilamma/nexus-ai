import { randomUUID } from "crypto";

/**
 * In-memory, per-process live state for meeting rooms: who is currently
 * connected, reconnect grace timers, and recent chat.
 *
 * Mongo (Meeting.participants) remains the durable record of who took part;
 * this is only the "right now" view. Single-process by design (same
 * limitation already documented for live sessions) — a multi-instance
 * deployment would move this to Redis / the Socket.IO Redis adapter.
 */

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  text: string;
  sentAt: string; // ISO timestamp
}

interface RoomState {
  // userId -> set of connected socket ids (a user may briefly hold two
  // sockets during a reconnect, or have two tabs open).
  sockets: Map<string, Set<string>>;
  graceTimers: Map<string, NodeJS.Timeout>;
  chat: ChatMessage[];
}

const MAX_CHAT_HISTORY = 200;
export const MAX_CHAT_LENGTH = 2000;

const rooms = new Map<string, RoomState>();

function getRoom(meetingId: string): RoomState {
  let room = rooms.get(meetingId);
  if (!room) {
    room = { sockets: new Map(), graceTimers: new Map(), chat: [] };
    rooms.set(meetingId, room);
  }
  return room;
}

export function addSocket(meetingId: string, userId: string, socketId: string) {
  const room = getRoom(meetingId);
  cancelGrace(meetingId, userId);
  let set = room.sockets.get(userId);
  if (!set) {
    set = new Set();
    room.sockets.set(userId, set);
  }
  set.add(socketId);
}

/** Returns true if the user still has at least one other live socket in the room. */
export function removeSocket(meetingId: string, userId: string, socketId: string): boolean {
  const room = rooms.get(meetingId);
  if (!room) return false;
  const set = room.sockets.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    room.sockets.delete(userId);
    return false;
  }
  return true;
}

export function isUserPresent(meetingId: string, userId: string): boolean {
  return rooms.get(meetingId)?.sockets.has(userId) ?? false;
}

export function presentUserIds(meetingId: string): string[] {
  const room = rooms.get(meetingId);
  return room ? Array.from(room.sockets.keys()) : [];
}

export function presentUserCount(meetingId: string): number {
  return rooms.get(meetingId)?.sockets.size ?? 0;
}

/**
 * Users in grace (socket dropped, waiting to see if they come back) have NO
 * sockets but must still count as present until the timer fires. Track them
 * by keeping a placeholder entry.
 */
export function scheduleGrace(meetingId: string, userId: string, ms: number, onExpire: () => void) {
  const room = getRoom(meetingId);
  cancelGrace(meetingId, userId);
  // Placeholder socket id keeps the user counted as present during grace.
  if (!room.sockets.has(userId)) room.sockets.set(userId, new Set(["__grace__"]));
  const timer = setTimeout(() => {
    room.graceTimers.delete(userId);
    const set = room.sockets.get(userId);
    if (set) {
      set.delete("__grace__");
      if (set.size === 0) room.sockets.delete(userId);
    }
    onExpire();
  }, ms);
  room.graceTimers.set(userId, timer);
}

export function cancelGrace(meetingId: string, userId: string) {
  const room = rooms.get(meetingId);
  if (!room) return;
  const timer = room.graceTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    room.graceTimers.delete(userId);
  }
  const set = room.sockets.get(userId);
  if (set) {
    set.delete("__grace__");
    if (set.size === 0) room.sockets.delete(userId);
  }
}

export function appendChat(meetingId: string, userId: string, displayName: string, text: string): ChatMessage {
  const room = getRoom(meetingId);
  const message: ChatMessage = {
    id: randomUUID(),
    userId,
    displayName,
    text,
    sentAt: new Date().toISOString(),
  };
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT_HISTORY) room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
  return message;
}

export function getChat(meetingId: string): ChatMessage[] {
  return rooms.get(meetingId)?.chat.slice() ?? [];
}

/** Drops every timer and all state for a meeting (called when it ends). */
export function clearRoom(meetingId: string) {
  const room = rooms.get(meetingId);
  if (!room) return;
  for (const timer of room.graceTimers.values()) clearTimeout(timer);
  rooms.delete(meetingId);
}
