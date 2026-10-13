/**
 * Verifies the vendor-rejection / concurrency handling (connection-storm protection, the
 * local stream cap, idle release, immediate reconnect after a late drop) against a
 * FAKE Soniox server that sends Soniox's documented error frame (error_code 429). The real
 * realtimeTranscribe.ts + meetingManager.ts code runs unchanged; only the Soniox URL is
 * redirected to a local fake.
 * Run from server/:  npx ts-node --transpile-only scripts/verify/sttConcurrency.verify.ts
 */
process.env.STT_IDLE_CLOSE_MS = "1000";
process.env.STT_MAX_CONCURRENT_SESSIONS = "5"; // keep the scenario below (7 participants vs a cap of 5) independent of the production default
import { VENDOR_PORT } from "./_patchWs"; // must stay first
import { startHarness, meetingId, hostId } from "./_nexusHarness";
import { Types } from "mongoose";
/* eslint-disable @typescript-eslint/no-var-requires */
const { WebSocketServer } = require("ws");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mode: "reject" | "ok" = "reject";
let attempts = 0;
let liveVendorSockets = 0;
const vendorSockets: any[] = [];
const vendor = new WebSocketServer({ port: VENDOR_PORT });
vendor.on("connection", (ws: any) => {
  attempts++;
  vendorSockets.push(ws);
  if (mode === "reject") {
    ws.send(JSON.stringify({ tokens: [], error_code: 429, error_message: "Too many concurrent requests" }));
    setTimeout(() => ws.close(1008, "rate limited"), 20);
    return;
  }
  liveVendorSockets++;
  // Soniox has no "Begin" ack. End of stream = an empty frame: reply `finished`, then close.
  ws.on("message", (m: any, isBinary: boolean) => {
    if (isBinary && m.length === 0) { ws.send(JSON.stringify({ tokens: [], finished: true })); setTimeout(() => ws.close(), 10); }
  });
  ws.on("close", () => { liveVendorSockets--; });
});

(async () => {
  const { meetingDoc } = await startHarness(5644, false);
  const mm = require("../../src/services/realtime/meetingManager");
  const reported: string[] = [];
  await mm.ensureMeetingSessionStarted(meetingId.toString(), hostId, "t", "general_meeting", {
    onTranscriptPartial() {}, onTranscriptFinal() {}, onTranslationUpdate() {}, onInsightUpdate() {},
    onError: (_u: string | null, m: string) => reported.push(m),
  });
  const addUser = (name: string) => { const id = new Types.ObjectId(); meetingDoc.participants.push({ userId: id, displayName: name, preferredLanguage: "English" }); return id.toString(); };
  const mid = meetingId.toString();

  console.log("\n=== A. Vendor rejects with 429 'Too many concurrent requests'; audio arrives every 10 ms (like livekitTranscriber) ===");
  const u1 = addUser("Rahul");
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) { await mm.ensureParticipantStt(mid, u1); await sleep(10); }
  console.log(`      vendor connection attempts in 6s: ${attempts}; error messages broadcast to the room: ${reported.length}`);
  check("connection storm is gone (<= 2 attempts in 6s)", attempts <= 2, `${attempts} attempts`);
  check("room is told at most once", reported.length <= 1, `${reported.length} message(s)`);
  if (reported[0]) console.log(`      message shown to users: "${reported[0]}"`);

  if (typeof require("../../src/services/speech/realtimeTranscribe").getOpenSttSessionCount !== "function") {
    console.log("\n(original code: no session accounting, skipping B-D)");
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED"); process.exit(failures ? 1 : 0);
  }
  const { getOpenSttSessionCount } = require("../../src/services/speech/realtimeTranscribe");

  console.log("\n=== B. Healthy vendor: never exceed the cap of 5 open streams; slot is freed on close ===");
  mode = "ok"; attempts = 0;
  const users = Array.from({ length: 7 }, (_, i) => addUser(`P${i}`));
  const results = await Promise.all(users.map((u) => mm.ensureParticipantStt(mid, u)));
  await sleep(300);
  check("exactly 5 vendor sockets open for 7 participants", liveVendorSockets === 5, `${liveVendorSockets} open`);
  check("the other 2 get 'retry' (not an error storm)", results.filter((r: string) => r === "retry").length === 2, JSON.stringify(results));
  check("local accounting matches the vendor's view", getOpenSttSessionCount() === 5, String(getOpenSttSessionCount()));
  mm.detachParticipantAudio(mid, users[0]);
  await sleep(1000);
  check("closing one frees its slot (4 open)", liveVendorSockets === 4 && getOpenSttSessionCount() === 4, `${liveVendorSockets} vendor / ${getOpenSttSessionCount()} local`);

  console.log("\n=== C. Idle (muted) participants release their slot (STT_IDLE_CLOSE_MS=1000, reaper runs every 15 s) ===");
  const before = liveVendorSockets;
  await sleep(16500);
  check("idle streams were closed to free vendor capacity", liveVendorSockets < before, `${before} -> ${liveVendorSockets}`);
  check("local accounting still matches vendor", getOpenSttSessionCount() === liveVendorSockets, `${getOpenSttSessionCount()} vs ${liveVendorSockets}`);

  console.log("\n=== D. A healthy stream that the vendor drops later reconnects immediately (no penalty) ===");
  const u = addUser("Healthy");
  await sleep(11000); // cap now has room; let any earlier capacity backoff for this user not apply (new user)
  attempts = 0;
  await mm.ensureParticipantStt(mid, u); await sleep(5600); // stream lived > 5 s
  vendorSockets[vendorSockets.length - 1].close(); await sleep(200);
  const r = await mm.ensureParticipantStt(mid, u); await sleep(200);
  check("reopened right away after a late vendor drop", r === "ready" && attempts === 2, `result=${r}, attempts=${attempts}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
