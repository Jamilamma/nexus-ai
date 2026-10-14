import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "";

export function getRealtimeSocket(): Socket {
  if (socket) {
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  const token = localStorage.getItem("nexus_token");

  socket = io(`${SOCKET_URL}/realtime`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
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