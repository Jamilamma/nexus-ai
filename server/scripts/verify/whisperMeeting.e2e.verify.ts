/**
 * End-to-end verification of live speech -> transcript for TWO participants speaking separately
 * (Priya: English, Rahul: Tamil + Tanglish) through the REAL code path:
 *   frames -> pumpAudio (voice gate) -> meetingManager -> realtimeTranscribe (endpointing, HTTP)
 *   -> REAL stt-service/app.py (HTTP, PCM decoding, language resolution, prompts, filters)
 *   -> segments -> socket.io -> client-side reducer.
 *
 * WHAT IS FAKE (be clear about this): only the Whisper MODEL. A stand-in measures which test tone it was
 * given and answers with a SCRIPTED sentence (scripts/verify/_whisperStandIn.py). So this proves plumbing,
 * speaker attribution by participantId, timestamps, ordering, dedupe, Unicode (Tamil script), language labels
 * and the language/prompt parameters -- NOT recognition accuracy (use stt-service/eval_accuracy.py for that).
 *
 * Run from server/:  npx ts-node --transpile-only scripts/verify/whisperMeeting.e2e.verify.ts
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";
import { startHarness, hostToken, guestToken, hostId, guestId, meetingId } from "./_nexusHarness";
import { Types } from "mongoose";
/* eslint-disable @typescript-eslint/no-var-requires */
const { io: connect } = require("../../../client/node_modules/socket.io-client");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STT_PORT = 9101;
const LOG = "/tmp/nexus_whisper_standin_calls.jsonl";
const frame = (freq: number, amp: number, t0: number) => {
  const d = new Int16Array(160); for (let i = 0; i < 160; i++) d[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * (t0 + i)) / 16000));
  return { data: d, sampleRate: 16000, channels: 1 };
};
async function* mic(freq: number, speech: [number, number][], totalMs: number, t0: number) {
  for (let ms = 0, n = 0; ms < totalMs; ms += 10, n++) {
    const elapsed = Date.now() - t0; if (elapsed < ms) await sleep(ms - elapsed);
    yield frame(freq, speech.some(([a, b]) => ms >= a && ms < b) ? 4000 : 0, n * 160);
  }
}

(async () => {
  try { fs.unlinkSync(LOG); } catch { /* none */ }
  const py = spawn("python3", [path.join(__dirname, "_whisperStandIn.py")], { env: { ...process.env, STANDIN_LOG: LOG, PORT: String(STT_PORT) }, stdio: ["ignore", "inherit", "inherit"] });
  const stopPy = () => { try { py.kill(); } catch { /* gone */ } };
  process.on("exit", stopPy);
  for (let i = 0; i < 100; i++) { try { const r = await axios.get(`http://127.0.0.1:${STT_PORT}/health`, { timeout: 500 }); if (r.data.status === "ok") break; } catch { /* starting */ } await sleep(200); }

  const { env } = require("../../src/config/env");
  env.whisperUrl = `http://127.0.0.1:${STT_PORT}`;
  // _nexusHarness replaces axios.post with a fake Gemini that rejects every other URL. Let the calls to the
  // Whisper service through to the real HTTP stack (everything else keeps the harness behaviour).
  const harnessPost = (axios as any).post, realAxios = axios.create();
  (axios as any).post = (url: string, ...rest: any[]) => (String(url).startsWith(env.whisperUrl) ? (realAxios.post as any)(url, ...rest) : harnessPost(url, ...rest));
  const { meetingDoc } = await startHarness(5645, false);
  const mm = require("../../src/services/realtime/meetingManager");
  const { pumpAudio } = require("../../src/services/video/livekitTranscriber");
  const sock = (tok: string) => connect("http://localhost:5645/realtime", { auth: { token: tok }, transports: ["websocket"], reconnection: false });
  const host = sock(hostToken), guest = sock(guestToken);
  await Promise.all([new Promise((r) => host.once("connection_status", r)), new Promise((r) => guest.once("connection_status", r))]);

  const view = { segments: [] as any[], finalsSeen: 0, errors: [] as string[] };
  guest.on("meeting_transcript_final", ({ segment }: any) => { view.finalsSeen++; if (!view.segments.some((s) => s.segmentId === segment.segmentId)) view.segments.push(segment); });
  guest.on("meeting_error", (e: any) => view.errors.push(e?.message || String(e)));
  const j1 = new Promise((r) => host.once("meeting_joined", r)); host.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Priya" }); await j1;
  const j2 = new Promise((r) => guest.once("meeting_joined", r)); guest.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Rahul" }); await j2;
  const meena = new Types.ObjectId(); meetingDoc.participants.push({ userId: meena, displayName: "Meena", preferredLanguage: "English", leftAt: null });
  const mid = meetingId.toString();

  const run = (identity: string, freq: number, speech: [number, number][], total: number, t0: number) => pumpAudio(mid, identity, mic(freq, speech, total, t0), () => true);
  console.log("\n=== Two participants, the first pair of sentences spoken AT THE SAME TIME (real-time paced, ~19 s) ===");
  const t0 = Date.now();
  const TOTAL = 15500;
  // Rahul picks "Tamil" in the 'I speak' selector between his two lines (forces the language for his next line).
  setTimeout(() => guest.emit("meeting_set_spoken_languages", { languages: ["ta"] }), 5800);
  await Promise.all([
    run(hostId.toString(), 300, [[200, 1700], [11000, 12500]], TOTAL, t0),
    run(guestId.toString(), 600, [[1000, 2500], [7000, 8500]], TOTAL, t0), // first Rahul sentence OVERLAPS Priya's first one
    run(meena.toString(), 440, [], TOTAL, t0), // muted
  ]);
  await sleep(2500);

  const lines = view.segments.map((s) => `${s.speaker}: ${s.text}`);
  console.log("\n--- transcript as the other participant sees it ---"); lines.forEach((l) => console.log("   " + l));
  const calls = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log(`--- Whisper service received ${calls.length} request(s) ---`);

  console.log("\n=== Results ===");
  check("exactly 4 transcript lines, one per spoken sentence (no duplicates, no empty lines)", view.segments.length === 4 && view.finalsSeen === 4, `${view.segments.length} lines, ${view.finalsSeen} finals broadcast`);
  check("exactly 4 requests reached the Whisper service (Meena, muted, sent nothing; nothing sent twice)", calls.length === 4, `${calls.length}`);
  const by = (n: string) => view.segments.filter((s) => s.speaker === n).map((s) => s.text);
  check("Priya's lines are exact and attributed to Priya", by("Priya").join("|") === "Let's review the launch plan for the Q3 release.|I will send the updated budget to finance by Friday.", by("Priya").join(" | "));
  check("Rahul's Tamil-script line is exact UTF-8, attributed to Rahul", by("Rahul")[0] === "நாளைக்கு மீட்டிங் இருக்கு, API ரெடி ஆயிடுச்சா?", by("Rahul")[0]);
  check("Rahul's Tanglish (Latin-script) line is attributed to Rahul", by("Rahul")[1] === "naalaiku deployment pannalam, client ku mail anuppiten.", by("Rahul")[1]);
  check("speaker identity comes from the audio source (participantId == LiveKit identity), not the text", view.segments.every((s) => s.participantId === (s.speaker === "Priya" ? hostId.toString() : guestId.toString())));
  check("Meena (muted) produced no lines", by("Meena").length === 0);
  check("lines are in chronological order on the shared clock", view.segments.every((s, i, a) => i === 0 || a[i - 1].startTime <= s.startTime), view.segments.map((s) => s.startTime.toFixed(2)).join(" < "));
  const expectedStart = [0.2, 1.0, 7.0, 11.0]; // when each sentence really began, in speaking order
  const off = view.segments.map((s, i) => Math.abs(s.startTime - expectedStart[i]));
  check("each line starts within 0.7 s of when it was actually spoken (capture time, not response time)", off.length === 4 && off.every((o) => o < 0.7), off.map((o) => o.toFixed(2)).join(", "));
  check("endTime >= startTime and the line has a plausible length", view.segments.every((s) => s.endTime > s.startTime && s.endTime - s.startTime < 3), view.segments.map((s) => (s.endTime - s.startTime).toFixed(2)).join(","));
  const tamil = view.segments.find((s) => s.text.startsWith("நாளை")), tang = view.segments.find((s) => s.text.startsWith("naala")), eng = view.segments.find((s) => s.text.startsWith("Let's"));
  check("Tamil sentence containing 'API' is labelled Tamil + English (Tamil dominant)", tamil?.language === "ta" && JSON.stringify(tamil?.languages) === '["ta","en"]', JSON.stringify(tamil?.languages));
  check("romanized Tamil keeps Whisper's 'ta' label (not relabelled English)", tang?.language === "ta" && JSON.stringify(tang?.languages) === '["ta"]', JSON.stringify(tang?.languages));
  check("English line labelled en", eng?.language === "en");
  check("low-confidence recognition is flagged (Tanglish line), confident lines are not", tang?.lowConfidence === true && view.segments.filter((s) => s !== tang).every((s) => s.lowConfidence === false), `tanglish conf=${tang?.confidence?.toFixed(2)}`);
  check("each speaker's own name was passed to Whisper as a hotword", calls.filter((c) => c.hotwords === "Priya").length === 2 && calls.filter((c) => c.hotwords === "Rahul").length === 2, JSON.stringify(calls.map((c) => c.hotwords)));
  const rahulCalls = calls.filter((c) => c.hotwords === "Rahul");
  check("before the selector: auto-detect among en/ta/hi/ar, Tamil + English-word prompt", /meeting/.test(rahulCalls[0].initial_prompt || "") && rahulCalls[0].language === "ta", JSON.stringify(rahulCalls[0]));
  check("after Rahul selects 'Tamil': language forced and the plain Tamil prompt is used", rahulCalls[1].language === "ta" && rahulCalls[1].initial_prompt && !/meeting/.test(rahulCalls[1].initial_prompt), JSON.stringify(rahulCalls[1]));
  check("final decoding uses beam search (beam_size 5)", calls.every((c) => c.beam_size === 5));
  check("no transcription error was shown to participants", view.errors.length === 0, view.errors.join(" / "));
  check("final transcript is stored server-side for Summary/Ask (4 lines)", mm.getLiveSegments(mid).length === 4);

  stopPy();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
