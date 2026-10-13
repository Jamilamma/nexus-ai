import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * Returns a singleton authenticated socket connection to the /realtime
 * namespace. Created lazily so we don't open a socket until the user
 * actually visits Live Meeting.
 *
 * If a socket already exists but got disconnected (e.g. React
 * StrictMode's dev-only mount -> cleanup -> remount cycle called
 * disconnectRealtimeSocket() on the "fake" unmount), we reconnect the
 * *same* instance instead of silently creating a second, orphaned one.
 */
export function getRealtimeSocket(): Socket {
  if (socket) {
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  const token = localStorage.getItem("nexus_token");

  socket = io("/realtime", {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    // Keep trying: after a few failed attempts the old limit (10) left the socket dead until a page reload,
    // so the host could no longer end the meeting from that tab.
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
  });

  return socket;
}

export function disconnectRealtimeSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}