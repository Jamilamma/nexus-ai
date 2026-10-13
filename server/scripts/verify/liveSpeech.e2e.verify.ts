/**
 * End-to-end verification of live speech -> transcript for TWO participants speaking separately
 * (Priya: English, Rahul: Tamil + Tanglish), through the REAL code path:
 *   frames -> pumpAudio (voice gate) -> meetingManager -> realtimeTranscribe (batching, config)
 *   -> [fake Soniox] -> tokens -> segments -> socket.io -> client-side reducer -> Summary/Ask.
 *
 * WHAT IS FAKE (be clear about this): the vendor. It enforces Soniox's documented protocol rules
 * (config message with key/model/format, 100 ms binary messages, token replies with is_final and
 * "<end>", empty-frame end of stream) but it does NOT recognise speech: it identifies which test tone
 * it received and replies with a SCRIPTED sentence. So this proves plumbing, speaker attribution,
 * interim->final replacement, dedupe, Unicode (Tamil script), language labels and gating -- NOT
 * recognition accuracy (see sttAccuracy.eval.ts for that).
 *
 * Run from server/:  npx ts-node --transpile-only scripts/verify/liveSpeech.e2e.verify.ts
 */
import { VENDOR_PORT } from "./_patchWs"; // must stay first
import { startHarness, hostToken, guestToken, hostId, guestId, meetingId, llmPrompts } from "./_nexusHarness";
import { Types } from "mongoose";
/* eslint-disable @typescript-eslint/no-var-requires */
const { WebSocketServer } = require("ws");
const { io: connect } = require("../../../client/node_modules/socket.io-client");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fake Soniox
// words[i] = [text, language, confidence]. Tokens carry their own leading spaces, as Soniox's do.
type W = [string, string, number];
const SCRIPTS: Record<string, { text: string; words: W[] }[]> = {
  en: [
    { text: "Let's review the launch plan for the Q3 release.", words: "Let's review the launch plan for the Q3 release.".split(" ").map((w): W => [w, "en", 0.97]) },
    { text: "I will send the updated budget to finance by Friday.", words: "I will send the updated budget to finance by Friday.".split(" ").map((w): W => [w, "en", 0.96]) },
  ],
  ta: [
    { text: "நாளைக்கு மீட்டிங் இருக்கு, API ரெடி ஆயிடுச்சா?", words: "நாளைக்கு மீட்டிங் இருக்கு, API ரெடி ஆயிடுச்சா?".split(" ").map((w): W => [w, w === "API" ? "en" : "ta", 0.92]) },
    // Tanglish (Tamil + English words, Latin script), scripted as LOW confidence
    { text: "naalaiku deployment pannalam, client ku mail anuppiten.", words: [["naalaiku", "ta", 0.4], ["deployment", "en", 0.5], ["pannalam,", "ta", 0.4], ["client", "en", 0.5], ["ku", "ta", 0.4], ["mail", "en", 0.5], ["anuppiten.", "ta", 0.4]] },
  ],
};
const vendor = { connections: 0, maxConcurrent: 0, live: 0, badMessages: [] as string[], configs: [] as any[], urls: [] as string[], msgMs: new Set<number>(), duplicateSent: false };
const vws = new WebSocketServer({ port: VENDOR_PORT });
vws.on("connection", (ws: any, req: any) => {
  vendor.connections++; vendor.live++; vendor.maxConcurrent = Math.max(vendor.maxConcurrent, vendor.live); vendor.urls.push(req.url);
  ws.on("close", () => { vendor.live--; });
  let config: any = null;
  let sentence: Record<string, number> = {}, voicedMs = 0, silentMs = 0, spoken = false, speaker = "en", lastPartialAt = 0, audioMs = 0;
  const tokensFor = (sc: { words: W[] }, a: number, b: number, final: boolean, from = 0, to = sc.words.length) =>
    sc.words.slice(from, to).map(([w, lang, conf], i) => ({ text: (from + i === 0 ? "" : " ") + w, start_ms: Math.round(a + ((b - a) * (from + i)) / sc.words.length), end_ms: Math.round(a + ((b - a) * (from + i + 1)) / sc.words.length), confidence: conf, is_final: final, language: lang }));
  ws.on("message", (m: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const obj = JSON.parse(m.toString());
      if (!config && obj.api_key) {
        config = obj; vendor.configs.push(obj);
        const bad = obj.api_key !== "fake-soniox-key" || !/^stt-rt-/.test(obj.model) || obj.audio_format !== "pcm_s16le" || obj.sample_rate !== 16000 || obj.num_channels !== 1;
        if (bad) { ws.send(JSON.stringify({ tokens: [], error_code: 400, error_message: "Invalid config" })); setTimeout(() => ws.close(1008), 10); }
      }
      return; // keepalive / finalize not needed: the scripted endpoint comes from silence below
    }
    if (m.length === 0) { ws.send(JSON.stringify({ tokens: [], finished: true })); return setTimeout(() => ws.close(1000), 10); }
    const ms = (m.length / 2 / 16000) * 1000; vendor.msgMs.add(Math.round(ms));
    if (ms > 100.5) { vendor.badMessages.push(`${ms.toFixed(0)}ms`); ws.send(JSON.stringify({ tokens: [], error_code: 400, error_message: `audio message too large: ${ms.toFixed(0)}ms` })); return ws.close(1008); }
    const sa = new Int16Array(m.buffer, m.byteOffset, m.length / 2);
    let sq = 0, zc = 0; for (let i = 0; i < sa.length; i++) { sq += sa[i] * sa[i]; if (i && (sa[i] >= 0) !== (sa[i - 1] >= 0)) zc++; }
    const rms = Math.sqrt(sq / sa.length), freq = zc / 2 / (ms / 1000);
    audioMs += ms;
    if (rms > 150) {
      speaker = freq > 450 ? "ta" : "en"; voicedMs += ms; silentMs = 0; spoken = true;
      const sc = SCRIPTS[speaker][(sentence[speaker] ?? 0) % SCRIPTS[speaker].length];
      if (voicedMs - lastPartialAt >= 300) {
        lastPartialAt = voicedMs;
        const n = Math.min(sc.words.length, Math.max(1, Math.ceil((voicedMs / 1500) * sc.words.length)));
        ws.send(JSON.stringify({ tokens: tokensFor(sc, audioMs - voicedMs, audioMs, false, 0, n), final_audio_proc_ms: 0, total_audio_proc_ms: audioMs })); // interim: revisable
      }
    } else if (spoken) {
      silentMs += ms;
      if (silentMs >= 700) {
        const idx = sentence[speaker] ?? 0; const sc = SCRIPTS[speaker][idx % SCRIPTS[speaker].length];
        const a = audioMs - silentMs - voicedMs, b = audioMs - silentMs;
        const finalMsg = { tokens: [...tokensFor(sc, a, b, true), { text: "<end>", is_final: true }], final_audio_proc_ms: b, total_audio_proc_ms: audioMs };
        ws.send(JSON.stringify(finalMsg));
        if (speaker === "en" && idx === 0 && !vendor.duplicateSent) { vendor.duplicateSent = true; ws.send(JSON.stringify(finalMsg)); } // vendor re-delivers the same utterance
        ws.send(JSON.stringify({ tokens: [{ text: "<end>", is_final: true }] })); // empty utterance: must not become a line
        sentence[speaker] = idx + 1; voicedMs = 0; silentMs = 0; spoken = false; lastPartialAt = 0;
      }
    }
  });
});

// ------------------------------------------------------------------ synthetic microphones
const frame = (freq: number, amp: number, t0: number) => {
  const d = new Int16Array(160); for (let i = 0; i < 160; i++) d[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * (t0 + i)) / 16000));
  return { data: d, sampleRate: 16000, channels: 1 };
};
/** timeline: array of [startMs, endMs] spoken segments; everything else is silence. Real-time paced. */
async function* mic(freq: number, speech: [number, number][], totalMs: number, t0: number) {
  for (let ms = 0, n = 0; ms < totalMs; ms += 10, n++) {
    const elapsed = Date.now() - t0; if (elapsed < ms) await sleep(ms - elapsed);
    const talking = speech.some(([a, b]) => ms >= a && ms < b);
    yield frame(freq, talking ? 4000 : 0, n * 160);
  }
}

(async () => {
  const { meetingDoc } = await startHarness(5644, false);
  const mm = require("../../src/services/realtime/meetingManager");
  const { env } = require("../../src/config/env");
  const { pumpAudio } = require("../../src/services/video/livekitTranscriber");
  const sock = (tok: string) => connect("http://localhost:5644/realtime", { auth: { token: tok }, transports: ["websocket"], reconnection: false });
  const host = sock(hostToken), guest = sock(guestToken);
  await Promise.all([new Promise((r) => host.once("connection_status", r)), new Promise((r) => guest.once("connection_status", r))]);

  // client-side state, using the same reducer rules as MeetingPage (partial per participant, final replaces it, merge by segmentId)
  const view = { segments: [] as any[], partials: {} as Record<string, any>, partialHistory: [] as string[], finalsSeen: 0 };
  guest.on("meeting_transcript_partial", (p: any) => { if (p.text) { view.partials[p.participantId] = p; view.partialHistory.push(`${p.participantName}: ${p.text}`); } else delete view.partials[p.participantId]; });
  guest.on("meeting_transcript_final", ({ segment }: any) => {
    view.finalsSeen++;
    if (!view.segments.some((s) => s.segmentId === segment.segmentId)) view.segments.push(segment);
    if (segment.participantId) delete view.partials[segment.participantId];
  });
  const j1 = new Promise((r) => host.once("meeting_joined", r)); host.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Priya" }); await j1;
  const j2 = new Promise((r) => guest.once("meeting_joined", r)); guest.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Rahul" }); await j2;
  // third participant, muted the whole time
  const meena = new Types.ObjectId(); meetingDoc.participants.push({ userId: meena, displayName: "Meena", preferredLanguage: "English", leftAt: null });
  const mid = meetingId.toString();

  const run = async (identity: string, freq: number, speech: [number, number][], total: number, t0: number) => {
    const src = mic(freq, speech, total, t0);
    return pumpAudio(mid, identity, src, () => true);
  };
  console.log("\n=== Two participants speak separately ===");
  const t0 = Date.now();
  const TOTAL = 15500;
  await Promise.all([
    // Priya (300 Hz): English sentence 1 at 0.2-1.7s, sentence 2 at 11-12.5s
    run(hostId.toString(), 300, [[200, 1700], [11000, 12500]], TOTAL, t0),
    // Rahul (600 Hz): Tamil at 3.5-5s, Tanglish at 7-8.5s
    run(guestId.toString(), 600, [[3500, 5000], [7000, 8500]], TOTAL, t0),
    // Meena: muted -> tiny noise only (below the voice gate) for the entire meeting
    run(meena.toString(), 440, [], TOTAL, t0),
  ]);
  await sleep(800);

  const lines = view.segments.map((s) => `${s.speaker}: ${s.text}`);
  console.log("\n--- transcript as the other participant sees it ---"); lines.forEach((l) => console.log("   " + l));
  console.log(`--- vendor: ${vendor.connections} connection(s), max ${vendor.maxConcurrent} at once, message sizes ms: ${[...vendor.msgMs].join(",")} ---`);
  if (vendor.badMessages.length) console.log("   vendor rejected message sizes:", vendor.badMessages.slice(0, 3).join(", "), `(+${Math.max(0, vendor.badMessages.length - 3)} more)`);

  console.log("\n=== Results ===");
  check("vendor accepted every stream's config and never saw an oversized audio message", vendor.badMessages.length === 0 && vendor.msgMs.size > 0, [...vendor.msgMs].join(","));
  check("every stream asked for stt-rt-v5 with auto language identification and en/ta/hi/ar hints, never strict", vendor.configs.length === 2 && vendor.configs.every((c) => c.model === "stt-rt-v5" && c.enable_language_identification === true && JSON.stringify(c.language_hints) === JSON.stringify(["en", "ta", "hi", "ar"]) && !("language_hints_strict" in c)));
  check("each stream was given its own participant's name as a context term", vendor.configs.map((c) => (c.context?.terms || []).join()).sort().join("|") === "Priya|Rahul", vendor.configs.map((c) => (c.context?.terms || []).join()).join("|"));
  check("the API key never appears in a URL", vendor.urls.every((u) => !u.includes("fake-soniox-key")));
  check("each participant has exactly one STT stream; muted participant opened none", vendor.connections === 2 && vendor.maxConcurrent <= 2, `${vendor.connections} connections, max ${vendor.maxConcurrent} concurrent`);
  check("4 transcript lines, one per spoken sentence (no duplicates, no empty lines)", view.segments.length === 4, `${view.segments.length} lines`);
  const by = (n: string) => view.segments.filter((s) => s.speaker === n).map((s) => s.text);
  check("Priya's lines are attributed to Priya (English)", by("Priya").join("|") === SCRIPTS.en.map((x) => x.text).join("|"), by("Priya").join(" | "));
  check("Rahul's Tamil-script line is exact UTF-8 and attributed to Rahul", by("Rahul")[0] === SCRIPTS.ta[0].text, by("Rahul")[0]);
  check("Rahul's Tanglish line is attributed to Rahul", by("Rahul")[1] === SCRIPTS.ta[1].text, by("Rahul")[1]);
  check("speaker came from the audio source (participantId), not from the text", view.segments.every((s) => (s.speaker === "Priya" ? s.participantId === hostId.toString() : s.participantId === guestId.toString())));
  check("Meena (muted) produced no lines", by("Meena").length === 0);
  check("lines are in chronological order on the shared clock", view.segments.every((s, i, a) => i === 0 || a[i - 1].startTime <= s.startTime), view.segments.map((s) => s.startTime.toFixed(1)).join(" < "));
  check("interim text appeared while speaking (>=3 growing partials)", view.partialHistory.length >= 3, `${view.partialHistory.length} partials, e.g. "${view.partialHistory[1] || ""}"`);
  check("partials grow within a turn (later partial contains earlier words)", (() => { const p = view.partialHistory.filter((x) => x.startsWith("Priya")).slice(0, 2); return p.length === 2 && p[1].length > p[0].length; })());
  check("no interim line is left on screen after the final", Object.keys(view.partials).length === 0, JSON.stringify(Object.keys(view.partials)));
  check("vendor's re-delivered utterance did not create a duplicate (finals broadcast = lines)", view.finalsSeen === view.segments.length, `${view.finalsSeen} finals broadcast`);
  const tang = view.segments.find((s) => s.text.startsWith("naalaiku"));
  check("low-confidence recognition is flagged, confident lines are not", tang?.lowConfidence === true && view.segments.filter((s) => s !== tang).every((s) => s.lowConfidence === false), `tanglish conf=${tang?.confidence?.toFixed(2)}`);
  const tamil = view.segments.find((s) => s.text.startsWith("நாளை"));
  check("vendor language label is stored with the line (Tamil dominant, English also listed for the English word)", tamil?.language === "ta" && JSON.stringify(tamil?.languages) === JSON.stringify(["ta", "en"]), JSON.stringify(tamil?.languages));
  check("English line is labelled en, Tanglish keeps the vendor's ta+en mix (labels are never rewritten)", view.segments.find((s) => s.text.startsWith("Let's"))?.language === "en" && JSON.stringify(tang?.languages) === JSON.stringify(["ta", "en"]));
  const stored = mm.getLiveSegments(mid);
  check("final transcript is stored server-side for Summary/Ask (4 lines)", stored.length === 4);

  console.log("\n=== NEXUS Summary + Ask use that stored transcript ===");
  llmPrompts.length = 0;
  host.emit("meeting_summary_request", { requestId: "s" });
  const sum: any = await new Promise((r) => host.once("meeting_summary", r));
  const sent = llmPrompts.join("\n");
  check("Tamil-script and Tanglish lines reached the LLM with the right speaker tag", sent.includes("[Rahul]: நாளைக்கு மீட்டிங் இருக்கு") && sent.includes("[Rahul]: naalaiku deployment pannalam"));
  check("summary lists the real speakers", sum.summary.speakers.sort().join() === "Priya,Rahul");
  host.emit("meeting_ask", { question: "What did Rahul say about deployment?", requestId: "a" });
  const ans: any = await new Promise((r) => host.once("meeting_answer", r));
  check("Ask NEXUS answers from Rahul's Tanglish line", /Rahul/.test(ans.answer) && /deployment/.test(ans.answer), ans.answer);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
