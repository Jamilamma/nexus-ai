import * as dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import http from "http";
import { env } from "./config/env";
import { connectDB } from "./config/db";
import app from "./app";
import { attachRealtimeServer } from "./realtime/socketServer";
import { checkWhisperHealth } from "./services/speech/realtimeTranscribe";

async function main() {
  console.log("[server] Connecting to MongoDB...");
  await connectDB();

  const httpServer = http.createServer(app);
  attachRealtimeServer(httpServer);

  httpServer.listen(env.port, () => {
    console.log(`[server] NEXUS AI API running on http://localhost:${env.port}`);
    console.log(`[server] Health check: http://localhost:${env.port}/api/health`);
    console.log(`[server] Realtime (live meeting) namespace ready at /realtime`);
    if (!env.llmApiKey) {
      console.warn("[server] LLM_API_KEY is not set — AI features will fail until you add it to server/.env");
    }
    if (env.transcriptionActive) {
      // Non-blocking: the server starts either way; this only tells you early if live transcription cannot work yet.
      checkWhisperHealth().then((h) => {
        if (h.ok) console.log(`[server] Whisper STT service ready at ${env.whisperUrl}: ${h.detail}`);
        else console.warn(`[server] Live transcription is NOT ready: ${h.detail}`);
      });
    }
  });
}

main().catch((err) => {
  console.error("[server] Failed to start:");
  console.error(err instanceof Error ? err.message : err);
  console.error(
    "\n[server] The server could not start (see error above). The client will show " +
      "'nothing works' / broken pages until this is fixed, because every page and the " +
      "Live Meeting socket both depend on this process being up.\n"
  );
  process.exit(1);
});