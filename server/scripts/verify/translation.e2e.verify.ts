/**
 * End-to-end verification of the original / translated transcript plumbing, through the REAL code:
 *   [fake Soniox] -> realtimeTranscribe -> meetingManager -> translateTranscriptSegments -> socket.io.
 *
 * WHAT IS FAKE: the vendor (scripted tokens) and the LLM. The fake LLM is a PLUMBING STAND-IN: it
 * returns "[<Language>] <the line it was sent>" so we can prove exactly which lines were sent for
 * translation, where results were stored, and that originals are never altered. It says NOTHING about
 * real translation quality (that needs a real LLM key and a human reader: see sttAccuracy.eval.ts --translate).
 *
 * Run from server/:  npx ts-node --transpile-only scripts/verify/translation.e2e.verify.ts   (~25 s)
 */
import { VENDOR_PORT } from "./_patchWs"; // must stay first
import { startHarness, hostToken, hostId, meetingId, llmPrompts, setLlmFail } from "./_nexusHarness";
/* eslint-disable @typescript-eslint/no-var-requires */
const { WebSocketServer } = require("ws");
const { io: connect } = require("../../../client/node_modules/socket.io-client");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const translationPrompts = () => llmPrompts.filter((p) => p.startsWith("Translate each numbered line"));
const sentForTranslation = () => translationPrompts().map((p) => (p.split("Lines:\n")[1] || "")).join("\n");

let conn: any = null;
const vws = new WebSocketServer({ port: VENDOR_PORT });
vws.on("connection", (ws: any) => { conn = ws; ws.on("message", (m: Buffer, bin: boolean) => { if (bin && m.length === 0) { ws.send(JSON.stringify({ tokens: [], finished: true })); setTimeout(() => ws.close(), 10); } }); });
let clockMs = 0;
/** The vendor "finalizes" one utterance. words: [text, lang]. */
function say(words: [string, string][]) {
  const toks = words.map(([w, l], i) => ({ text: (i === 0 ? "" : " ") + w, start_ms: clockMs + i * 200, end_ms: clockMs + i * 200 + 180, confidence: 0.95, is_final: true, language: l }));
  clockMs += words.length * 200 + 1500;
  conn.send(JSON.stringify({ tokens: [...toks, { text: "<end>", is_final: true }] }));
}
const en = (s: string): [string, string][] => s.split(" ").map((w) => [w, "en"]);
const ta = (s: string): [string, string][] => s.split(" ").map((w) => [w, "ta"]);

(async () => {
  const { meetingDoc } = await startHarness(5645, false);
  const mm = require("../../src/services/realtime/meetingManager");
  const mid = meetingId.toString();
  const host = connect("http://localhost:5645/realtime", { auth: { token: hostToken }, transports: ["websocket"], reconnection: false });
  await new Promise((r) => host.once("connection_status", r));
  const updates: any[] = []; const errors: any[] = [];
  host.on("meeting_translation_update", (u: any) => updates.push(u));
  host.on("meeting_error", (e: any) => errors.push(e));
  const joined = new Promise((r) => host.once("meeting_joined", r));
  host.emit("join_meeting", { meetingId: mid, displayName: "Priya" }); await joined;
  void meetingDoc;
  await mm.ensureParticipantStt(mid, hostId.toString()); await sleep(200);

  console.log("\n=== A. Nothing is translated (or paid for) until someone asks ===");
  const EN1 = "We will ship the beta on Monday.";
  const TA1 = "நாளைக்கு மீட்டிங் இருக்கு";
  say(en(EN1)); say(ta(TA1)); await sleep(3500);
  const segs = () => mm.getLiveSegments(mid) as any[];
  check("two original lines are in the transcript", segs().length === 2, String(segs().length));
  check("no translation request was made to the LLM", translationPrompts().length === 0);

  console.log("\n=== B. Reader picks Tamil: English lines are translated, the Tamil line is NOT (already Tamil) ===");
  host.emit("meeting_set_translation", { language: "Tamil" }); await sleep(3500);
  const enSeg = () => segs().find((s) => s.text === EN1), taSeg = () => segs().find((s) => s.text === TA1);
  check("English line was translated into Tamil and stored under translations.Tamil", enSeg().translations?.Tamil === `[Tamil] ${EN1}`, enSeg().translations?.Tamil);
  check("the Tamil line was never sent for translation", !sentForTranslation().includes(TA1) && taSeg().translations === undefined);
  check("the original text of both lines is unchanged", enSeg().text === EN1 && taSeg().text === TA1);
  check("language labels are the vendor's, unchanged by translation", enSeg().language === "en" && taSeg().language === "ta");
  check("clients were told per segment via meeting_translation_update", updates.length === 1 && updates[0].segmentId === enSeg().segmentId && updates[0].language === "Tamil", JSON.stringify(updates[0]));

  console.log("\n=== C. New lines are translated as they finalize while a target is active ===");
  const EN2 = "Please review the budget today.";
  say(en(EN2)); await sleep(5000);
  const en2 = segs().find((s) => s.text === EN2);
  check("new English line gets a Tamil translation (batched within a few seconds)", en2?.translations?.Tamil === `[Tamil] ${EN2}`, en2?.translations?.Tamil);

  console.log("\n=== D. Switch to English: the Tamil line and a Tamil-English mixed line are translated; pure English is not ===");
  const MIX: [string, string][] = [["naalaiku", "ta"], ["deployment", "en"], ["pannalam", "ta"]];
  say(MIX); await sleep(200);
  host.emit("meeting_set_translation", { language: "English" }); await sleep(3500);
  check("Tamil line translated into English", taSeg().translations?.English === `[English] ${TA1}`, taSeg().translations?.English);
  const mix = segs().find((s) => s.text === "naalaiku deployment pannalam");
  check("mixed Tamil+English line IS translated (not skipped as 'already English')", mix?.translations?.English === "[English] naalaiku deployment pannalam");
  check("pure-English lines were not sent to be 'translated' into English", !sentForTranslation().split("\n").some((l) => l.includes(EN1) && translationPrompts().some((p) => /into English/.test(p) && p.includes(EN1))));

  console.log("\n=== E. A late joiner's history replay carries both original and translations ===");
  const hist: any = await new Promise((resolve) => {
    const s2 = connect("http://localhost:5645/realtime", { auth: { token: hostToken }, transports: ["websocket"], reconnection: false });
    s2.once("meeting_transcript_history", (h: any) => { resolve(h); s2.close(); });
    s2.once("connection_status", () => s2.emit("join_meeting", { meetingId: mid, displayName: "Priya" }));
  });
  const hEn = hist.segments.find((s: any) => s.text === EN1);
  check("history includes original text AND translations", hEn?.text === EN1 && hEn?.translations?.Tamil === `[Tamil] ${EN1}`);

  console.log("\n=== F. Unsupported language is refused; stopping translation stops the cost ===");
  errors.length = 0;
  host.emit("meeting_set_translation", { language: "Klingon" }); await sleep(300);
  check("unsupported target -> meeting_error BAD_LANGUAGE", errors.some((e) => e.code === "BAD_LANGUAGE"));
  host.emit("meeting_set_translation", { language: null }); await sleep(200);
  const before = translationPrompts().length;
  say(en("This line should stay untranslated.")); await sleep(4000);
  check("with translation off, no new LLM translation calls are made", translationPrompts().length === before);

  console.log("\n=== G. Translation outage: originals untouched, nothing invented, user told once ===");
  host.emit("meeting_set_translation", { language: "Hindi" }); await sleep(100);
  setLlmFail(true); errors.length = 0;
  const EN3 = "Translation will fail for this one.";
  say(en(EN3)); await sleep(8000);
  const en3 = segs().find((s) => s.text === EN3);
  check("line stays untranslated (no fabricated text)", en3 && en3.translations?.Hindi === undefined && en3.text === EN3);
  check("the room was told translation is unavailable (not silently dropped)", errors.some((e) => /Translation to Hindi is unavailable/.test(e.message)), errors[0]?.message);
  setLlmFail(false);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
