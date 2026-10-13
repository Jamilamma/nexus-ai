/**
 * Verifies the REAL realtimeTranscribe.ts client against a local FAKE Soniox server that follows
 * Soniox's documented real-time WebSocket protocol (config message, binary audio, token replies with
 * is_final / "<end>" / "<fin>", error frames, `finished`, keepalive, finalize, empty-frame end).
 *
 * WHAT THIS PROVES: transcript-integrity rules -- interim text is never saved as final; each
 * utterance becomes exactly one line; Tamil/Hindi/Arabic text and mixed-language tokens survive
 * byte-for-byte; language labels come from the vendor tokens; timestamps land on the shared meeting
 * clock; vendor errors map to clear messages; idle streams are kept alive and flushed.
 * WHAT IT CANNOT PROVE: recognition accuracy (the fake never hears audio). Use sttAccuracy.eval.ts with
 * real recordings and a real SONIOX_API_KEY for that.
 *
 * Run from server/:  npx ts-node --transpile-only scripts/verify/sonioxProtocol.verify.ts   (~20 s)
 */
import { VENDOR_PORT } from "./_patchWs"; // must stay first
/* eslint-disable @typescript-eslint/no-var-requires */
const { WebSocketServer } = require("ws");
const rt = require("../../src/services/speech/realtimeTranscribe");
const { env } = require("../../src/config/env");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake Soniox
interface Conn { ws: any; config: any; audio: number[]; text: any[]; gotEmptyFrame: boolean; closed: boolean }
const conns: Conn[] = [];
const server = new WebSocketServer({ port: VENDOR_PORT });
server.on("connection", (ws: any) => {
  const c: Conn = { ws, config: null, audio: [], text: [], gotEmptyFrame: false, closed: false };
  conns.push(c);
  ws.on("message", (m: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const obj = JSON.parse(m.toString());
      if (!c.config && obj.api_key) { c.config = obj; return; }
      if (obj.type === "finalize") { c.text.push(obj); return; }
      c.text.push(obj);
      return;
    }
    if (m.length === 0) {
      c.gotEmptyFrame = true;
      ws.send(JSON.stringify({ tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0, finished: true }));
      setTimeout(() => ws.close(1000), 10);
      return;
    }
    c.audio.push(m.length);
  });
  ws.on("close", () => { c.closed = true; });
});
const nextConn = async (): Promise<Conn> => { const n = conns.length; for (let i = 0; i < 100 && conns.length === n; i++) await sleep(20); await sleep(30); return conns[conns.length - 1]; };

const tok = (text: string, o: Partial<{ s: number; e: number; c: number; l: string; f: boolean }> = {}) =>
  ({ text, start_ms: o.s ?? 0, end_ms: o.e ?? 100, confidence: o.c ?? 0.95, is_final: o.f ?? true, ...(o.l ? { language: o.l } : {}) });
const END = { text: "<end>", is_final: true };
const send = (c: Conn, tokens: any[], extra: any = {}) => c.ws.send(JSON.stringify({ tokens, final_audio_proc_ms: 0, total_audio_proc_ms: 0, ...extra }));

async function session(opts: any = {}, startedAt = Date.now()) {
  const events: any[] = []; const errors: Error[] = []; const closes: any[] = [];
  const s = rt.startRealtimeTranscription((e: any) => events.push(e), (e: Error) => errors.push(e), startedAt, (i: any) => closes.push(i), undefined, opts);
  const c = await nextConn();
  return { s, c, events, errors, closes, finals: () => events.filter((e) => e.type === "final"), partials: () => events.filter((e) => e.type === "partial") };
}

(async () => {
  console.log("\n=== 1. Interim text is never saved as final; one utterance = one line ===");
  {
    const { s, c, events, finals, partials } = await session();
    send(c, [tok("Hello", { f: false, l: "en" }), tok(" wor", { f: false, l: "en" })]); await sleep(60);
    check("interim tokens produce a partial, no final", partials().length === 1 && finals().length === 0, JSON.stringify(partials().map((p: any) => p.text)));
    send(c, [tok("Hello", { s: 600, e: 800, l: "en" }), tok(" world", { s: 800, e: 1000, l: "en" })], {}); await sleep(30);
    send(c, [tok(" again", { f: false, l: "en" })]); await sleep(60);
    check("partial shows final-so-far + interim tail", partials()[partials().length - 1].text === "Hello world again", partials()[partials().length - 1].text);
    check("still no final before the endpoint", finals().length === 0);
    send(c, [tok(" again.", { s: 1000, e: 1300, l: "en" }), END]); await sleep(60);
    check("exactly one final when <end> arrives", finals().length === 1);
    check("final text is the exact concatenation of final tokens only", finals()[0].text === "Hello world again.", finals()[0].text);
    check("interim line is cleared after the final (empty partial)", partials()[partials().length - 1].text === "");
    s.close(); await sleep(100);
  }

  console.log("\n=== 2. Tamil, Hindi and Arabic text survives byte-for-byte; language label comes from the vendor ===");
  {
    const cases: [string, string[], string][] = [
      ["ta", ["நாளைக்கு", " மீட்டிங்", " இருக்கு,", " API", " ரெடி", " ஆயிடுச்சா?"], "நாளைக்கு மீட்டிங் இருக்கு, API ரெடி ஆயிடுச்சா?"],
      ["hi", ["कल", " की", " मीटिंग", " का", " एजेंडा", " क्या", " है?"], "कल की मीटिंग का एजेंडा क्या है?"],
      ["ar", ["متى", " سنبدأ", " الاجتماع", " غدا؟"], "متى سنبدأ الاجتماع غدا؟"],
    ];
    for (const [lang, parts, expected] of cases) {
      const { s, c, finals } = await session();
      send(c, [...parts.map((p, i) => tok(p, { s: i * 200, e: i * 200 + 180, l: lang })), END]); await sleep(60);
      check(`${lang}: one final, text exact`, finals().length === 1 && finals()[0].text === expected, finals()[0]?.text);
      check(`${lang}: detectedLanguage is the vendor's code`, finals()[0]?.detectedLanguage === lang && JSON.stringify(finals()[0]?.languages) === JSON.stringify([lang]));
      s.close(); await sleep(60);
    }
  }

  console.log("\n=== 3. Tamil-English code-switching (Tanglish): dominant language + all languages, low confidence flagged by the value ===");
  {
    const { s, c, finals } = await session();
    const words: [string, string, number][] = [["naalaiku", "ta", 0.4], [" deployment", "en", 0.5], [" pannalam,", "ta", 0.4], [" client", "en", 0.5], [" ku", "ta", 0.4], [" mail", "en", 0.5], [" anuppiten.", "ta", 0.4]];
    send(c, [...words.map(([t, l, cf], i) => tok(t, { s: i * 300, e: i * 300 + 250, l, c: cf })), END]); await sleep(60);
    const f = finals()[0];
    check("text is exactly what was recognised (nothing added or corrected)", f?.text === "naalaiku deployment pannalam, client ku mail anuppiten.", f?.text);
    check("dominant language by letters spoken is Tamil, and English is listed too", f?.detectedLanguage === "ta" && JSON.stringify(f?.languages) === JSON.stringify(["ta", "en"]), JSON.stringify(f?.languages));
    check("confidence is the mean token confidence", Math.abs(f?.confidence - (0.4 * 4 + 0.5 * 3) / 7) < 1e-9, String(f?.confidence));
    s.close(); await sleep(60);
  }

  console.log("\n=== 4. Duplicates, empty and punctuation-only turns ===");
  {
    const { s, c, finals } = await session();
    send(c, [tok("Okay", { l: "en" }), END, END, END]); await sleep(60);
    check("repeated <end> markers do not create extra lines", finals().length === 1);
    send(c, [END]); send(c, [tok(".", { l: "en" }), END]); send(c, [tok(" ", {}), END]); await sleep(80);
    check("empty / punctuation-only turns never become a line", finals().length === 1);
    send(c, [tok("Okay", { s: 5000, e: 5200, l: "en" }), END]); await sleep(60);
    check("a genuinely repeated word later IS kept at this layer (cross-segment duplicate rules live in meetingManager)", finals().length === 2);
    s.close(); await sleep(60);
  }

  console.log("\n=== 5. Timestamps land on the shared meeting clock (speaker joins 10 minutes into the meeting) ===");
  {
    const meetingStart = Date.now() - 600_000;
    const { s, c, finals } = await session({}, meetingStart);
    const T = Date.now();
    for (let i = 0; i < 10; i++) s.sendAudioChunk(Buffer.alloc(3200), T - (9 - i) * 100); // 1.0 s of audio that ENDED "now" (chunk i ends at T-(9-i)*100 ms)
    await sleep(60);
    send(c, [tok("Hi", { s: 200, e: 500, l: "en" }), tok(" there", { s: 500, e: 800, l: "en" }), END]); await sleep(60);
    check("a line spoken ~0.2-0.8 s into this stream, ~10 min into the meeting, is stamped ~599 s (not ~0.2 s)", Math.abs(finals()[0].startTime - 599.2) < 0.6, finals()[0].startTime.toFixed(2));
    check("endTime >= startTime", finals()[0].endTime >= finals()[0].startTime);
    s.close(); await sleep(60);
  }

  console.log("\n=== 6. Stream end: finals without <end> are flushed once; interim is dropped ===");
  {
    const { s, c, finals, closes } = await session();
    send(c, [tok("last", { l: "en" }), tok(" words", { l: "en" }), tok(" maybe", { f: false, l: "en" })]); await sleep(50);
    s.close(); await sleep(250);
    check("close() sent the empty-frame end-of-stream the vendor requires", c.gotEmptyFrame);
    check("final tokens became exactly one line on `finished`; the unconfirmed interim word was NOT saved", finals().length === 1 && finals()[0].text === "last words", finals()[0]?.text);
    check("onClose reported", closes.length === 1);
  }
  {
    const { s, c, finals, closes } = await session();
    send(c, [tok("dropped", { l: "en" }), tok(" connection", { l: "en" })]); await sleep(50);
    c.ws.terminate(); await sleep(150);
    check("an abrupt vendor disconnect still commits already-final speech (nothing lost) ", finals().length === 1 && finals()[0].text === "dropped connection" && closes.length === 1);
    s.close();
  }

  console.log("\n=== 7. Vendor errors become clear, correctly-typed errors ===");
  {
    const a = await session(); a.c.ws.send(JSON.stringify({ tokens: [], error_code: 429, error_message: "Too many concurrent requests" })); await sleep(60);
    check("429 -> SttCapacityError (drives the existing backoff)", a.errors[0] instanceof rt.SttCapacityError, a.errors[0]?.message);
    a.s.close(); await sleep(60);
    const b = await session(); b.c.ws.send(JSON.stringify({ tokens: [], error_code: 401, error_message: "Invalid or expired API key" })); await sleep(60);
    check("401 -> message tells the operator to check SONIOX_API_KEY", /SONIOX_API_KEY/.test(b.errors[0]?.message || "") && !(b.errors[0] instanceof rt.SttCapacityError), b.errors[0]?.message);
    b.s.close(); await sleep(60);
    const d = await session(); d.c.ws.send(JSON.stringify({ tokens: [], error_code: 402, error_message: "Payment required" })); await sleep(60);
    check("402 -> message names the billing/balance problem", /balance|billing/i.test(d.errors[0]?.message || ""), d.errors[0]?.message);
    d.s.close(); await sleep(60);
  }

  console.log("\n=== 8. Very long uninterrupted speech is cut into readable lines ===");
  {
    const { s, c, finals } = await session();
    send(c, [tok("Start", { s: 0, e: 200, l: "en" }), tok(" of a very long thought", { s: 200, e: 15000, l: "en" })]); await sleep(40);
    check("no cut before 30 s", finals().length === 0);
    send(c, [tok(" that finally ends here.", { s: 15000, e: 31000, l: "en" })]); await sleep(60);
    check("cut at a sentence end once it spans > 30 s (no endpoint needed)", finals().length === 1 && finals()[0].text.endsWith("ends here."), finals()[0]?.text);
    send(c, [tok("no punctuation", { s: 31000, e: 40000, l: "en" })]); send(c, [tok(" ever", { s: 40000, e: 92000, l: "en" })]); await sleep(60);
    check("hard cap at 60 s even with no sentence end", finals().length === 2);
    s.close(); await sleep(60);
  }

  console.log("\n=== 9. Concurrency cap is enforced locally ===");
  {
    const saved = env.sttMaxConcurrentSessions; env.sttMaxConcurrentSessions = rt.getOpenSttSessionCount() + 2;
    const a = await session(), b = await session();
    let err: any; try { rt.startRealtimeTranscription(() => {}, () => {}, Date.now()); } catch (e) { err = e; }
    check("third stream beyond the cap throws SttCapacityError without connecting", err instanceof rt.SttCapacityError);
    a.s.close(); b.s.close(); await sleep(150);
    env.sttMaxConcurrentSessions = saved;
    check("slots are released only when sockets really close", rt.getOpenSttSessionCount() === 0, String(rt.getOpenSttSessionCount()));
  }

  console.log("\n=== 10. Idle stream: pending speech is finalized, keepalive keeps the stream open (takes ~12 s) ===");
  {
    const { s, c, finals } = await session();
    s.sendAudioChunk(Buffer.alloc(3200));
    await sleep(40);
    send(c, [tok("trailing", { l: "en" }), tok(" speech", { f: false, l: "en" })]); await sleep(40);
    await sleep(2400); // voice gate stopped sending audio; vendor never sent <end>
    check("client asked the vendor to finalize once audio stopped", c.text.some((m) => m.type === "finalize"));
    send(c, [tok(" speech", { l: "en" }), { text: "<fin>", is_final: true }]); await sleep(60); // vendor finalizes only the remaining token; "trailing" was already final
    check("the <fin> answer commits exactly one line", finals().length === 1 && finals()[0].text === "trailing speech", finals()[0]?.text);
    await sleep(9500);
    const keepalives = c.text.filter((m) => m.type === "keepalive").length;
    check("keepalive sent while no audio flows (vendor drops streams silent for > 20 s) but not spammed", keepalives >= 1 && keepalives <= 2, `${keepalives} in ~12 s`);
    check("stream is still open", !c.closed);
    s.close(); await sleep(100);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
