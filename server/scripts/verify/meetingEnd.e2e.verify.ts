/**
 * End Meeting, end to end through the real Socket.IO server (in-memory models, no LiveKit, no real LLM):
 *  - only the host can end it; others get a clear error (with or without an acknowledgement callback)
 *  - the host's acknowledgement and `meeting_ended` arrive quickly even when the AI report is SLOW (5 s here)
 *  - repeated clicks do not break anything and every client is notified exactly once
 *  - the meeting is saved as ended, and the slow finalization still completes in the background
 * Run from server/:  npx ts-node --transpile-only scripts/verify/meetingEnd.e2e.verify.ts
 */
import axios from "axios";
import { startHarness, hostToken, guestToken, hostId, meetingId } from "./_nexusHarness";
/* eslint-disable @typescript-eslint/no-var-requires */
const { io: connect } = require("../../../client/node_modules/socket.io-client");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Make the report step slow, like a busy Gemini: the first thing the analysis does is read the transcript.
  void axios;
  const { Transcript } = require("../../src/models/Transcript");
  (Transcript as any).findOne = async () => { await sleep(5000); throw new Error("simulated slow analysis"); };
  // Capture the server's own "finalized after N ms" log line to know when the background work really finished.
  let finalizedAfterMs = -1;
  const origLog = console.log;
  console.log = (...args: any[]) => { const m = /finalized after (\d+) ms/.exec(String(args[0])); if (m) finalizedAfterMs = Number(m[1]); origLog(...args); };

  // The harness leaves the AI report off; switch it on (as in a real deployment with NEXUS AI enabled) so
  // ending the meeting has to build a report, which is the slow part.
  require("../../src/config/env").env.enableNexusAi = true;
  const { meetingDoc } = await startHarness(5646, true);
  const mm = require("../../src/services/realtime/meetingManager");
  const sock = (tok: string) => connect("http://localhost:5646/realtime", { auth: { token: tok }, transports: ["websocket"], reconnection: false });
  const host = sock(hostToken), guest = sock(guestToken), lurker = sock(hostToken);
  await Promise.all([host, guest, lurker].map((s) => new Promise((r) => s.once("connection_status", r))));

  const ended = { host: 0, guest: 0 };
  host.on("meeting_ended", () => ended.host++);
  guest.on("meeting_ended", () => ended.guest++);
  const guestErrors: any[] = [];
  guest.on("meeting_error", (e: any) => guestErrors.push(e));

  const j1 = new Promise((r) => host.once("meeting_joined", r)); host.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Priya" }); await j1;
  const j2 = new Promise((r) => guest.once("meeting_joined", r)); guest.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Rahul" }); await j2;
  const ask = (s: any) => new Promise<any>((r) => s.emit("end_meeting", {}, r));

  console.log("1. who may end the meeting");
  const notJoined = await ask(lurker);
  check("a connection that never joined gets NOT_JOINED", notJoined.ok === false && notJoined.code === "NOT_JOINED", JSON.stringify(notJoined));
  const g = await ask(guest);
  check("a participant gets NOT_HOST (acknowledgement form)", g.ok === false && g.code === "NOT_HOST", JSON.stringify(g));
  guest.emit("end_meeting"); await sleep(300);
  check("an older client without a callback still gets a meeting_error NOT_HOST", guestErrors.some((e) => e.code === "NOT_HOST"));
  check("the meeting is still running after those attempts", meetingDoc.status !== "ended" && ended.host === 0 && ended.guest === 0);

  console.log("2. host ends it (two quick clicks) while the AI report is slow");
  const t0 = Date.now();
  const [a1, a2] = await Promise.all([ask(host), ask(host)]);
  const took = Date.now() - t0;
  check("both clicks are acknowledged ok", a1.ok === true && a2.ok === true, JSON.stringify([a1, a2]));
  check("acknowledged in under 3 s although the report needs 5+ s (old behaviour: waited for the report)", took < 3000, `${took} ms`);
  check("a recording id is returned so the 'view report' link works", Boolean(a1.recordingId));
  await sleep(300);
  check("host and participant were each notified exactly once", ended.host === 1 && ended.guest === 1, JSON.stringify(ended));
  check("the meeting is saved as ended", meetingDoc.status === "ended");
  check("the report is still being built when the host is told (finalization has not finished yet)", finalizedAfterMs === -1);

  console.log("3. background finalization completes");
  for (let i = 0; i < 40 && finalizedAfterMs < 0; i++) await sleep(250);
  check("finalization still runs to the end in the background (~5 s later)", finalizedAfterMs >= 4500 && finalizedAfterMs < 9000, `${finalizedAfterMs} ms`);
  check("the meeting is released from server memory afterwards", mm.isMeetingActive(meetingId.toString()) === false);

  console.log("4. clicking again afterwards");
  const again = await ask(host).catch(() => null);
  check("a later click is confirmed ok (no silent failure)", again?.ok === true, JSON.stringify(again));
  void hostId;

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
