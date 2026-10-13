/**
 * Checks the Node side of the faster-whisper integration (services/speech/realtimeTranscribe.ts) against a
 * MOCK Whisper HTTP service: utterance endpointing, ordering, timestamps on the meeting clock, no duplicated
 * or dropped audio, language parameters, language labelling, flush-on-close and error handling.
 *
 * It does NOT test recognition accuracy (the mock returns canned text) - use stt-service/eval_accuracy.py with
 * your own recordings for that.
 *
 * Run from server/:  npx ts-node --transpile-only scripts/verify/whisperSession.verify.ts
 */
import http from "http";
import { AddressInfo } from "net";
import { env } from "../../src/config/env";
import { startRealtimeTranscription, languagesForText, getOpenSttSessionCount, RealtimeTranscriptEvent } from "../../src/services/speech/realtimeTranscribe";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Req { query: Record<string, string>; bytes: number; auth?: string; at: number }
let requests: Req[] = [];
let respond: (req: Req, n: number) => { status?: number; body: any; delayMs?: number } = () => ({ body: { language: "en", language_probability: 0.95, language_source: "candidates", segments: [] } });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok", model: "mock", device: "cpu", compute_type: "int8" })); return; }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const r: Req = { query: Object.fromEntries(url.searchParams.entries()), bytes: Buffer.concat(chunks).length, auth: req.headers.authorization, at: Date.now() };
    requests.push(r);
    const out = respond(r, requests.length);
    setTimeout(() => { res.statusCode = out.status ?? 200; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out.body)); }, out.delayMs ?? 0);
  });
});

// ---- synthetic audio ---------------------------------------------------------------------------
const RATE = 16000;
const tone = (ms: number, amp = 8000) => { const n = Math.round((RATE * ms) / 1000); const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amp), i * 2); return b; };
const silence = (ms: number) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
const bytesPerMs = (RATE * 2) / 1000;

interface Harness { events: RealtimeTranscriptEvent[]; errors: Error[]; closes: any[]; feed: (b: Buffer, frameMs?: number) => void; now: () => number; session: ReturnType<typeof startRealtimeTranscription>; t0: number; meetingStart: number }
function open(opts: Parameters<typeof startRealtimeTranscription>[5] = {}, startedAtOffsetMs = 0): Harness {
  const events: RealtimeTranscriptEvent[] = []; const errors: Error[] = []; const closes: any[] = [];
  const t0 = Date.now(); // virtual audio clock starts now
  const meetingStart = t0 - startedAtOffsetMs;
  let virtual = t0;
  const session = startRealtimeTranscription((e) => events.push(e), (e) => errors.push(e), meetingStart, (i) => closes.push(i), undefined, opts);
  const feed = (b: Buffer, frameMs = 10) => {
    const step = frameMs * bytesPerMs;
    for (let off = 0; off < b.length; off += step) { const part = b.subarray(off, Math.min(b.length, off + step)); virtual += part.length / bytesPerMs; session.sendAudioChunk(Buffer.from(part), virtual); }
  };
  return { events, errors, closes, feed, now: () => virtual, session, t0, meetingStart };
}
const finals = (h: Harness) => h.events.filter((e) => e.type === "final");
const waitFor = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end && !cond()) await sleep(25); return cond(); };
const seg = (text: string, start = 0.3, end = 1.6, avg_logprob = -0.3) => ({ start, end, text, avg_logprob, no_speech_prob: 0.01 });

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  (env as any).whisperUrl = `http://127.0.0.1:${port}`;
  (env as any).whisperPartialsMs = 0;
  (env as any).whisperRequestTimeoutMs = 5000;
  const baseOpen = getOpenSttSessionCount();

  console.log("1. one utterance -> one request, one final, timestamps on the meeting clock");
  {
    requests = [];
    respond = () => ({ body: { language: "en", language_probability: 0.95, language_source: "candidates", segments: [seg("Let us start the meeting.", 0.3, 1.9)] } });
    const h = open({}, 0);
    h.feed(silence(10_000)); // 10 s of silence before speaking (nothing may be sent)
    h.feed(tone(1500));
    h.feed(silence(1500));
    await waitFor(() => finals(h).length === 1);
    check("exactly one request and one final", requests.length === 1 && finals(h).length === 1, `${requests.length} req / ${finals(h).length} finals`);
    const sentMs = requests[0].bytes / bytesPerMs;
    check("sent = 300 ms lead-in + speech + 300 ms tail pad (not the 10 s of silence)", Math.abs(sentMs - 2100) <= 120, `${sentMs} ms`);
    const f = finals(h)[0];
    // speech began at 10.0 s; request starts 0.3 s earlier; Whisper says speech starts 0.3 s into the clip -> ~10.0 s
    check("startTime is the capture time of the speech (~10.0 s), not when the response arrived", Math.abs(f.startTime - 10.0) < 0.2, `${f.startTime}`);
    check("endTime = start + Whisper's offset (~11.6 s)", Math.abs(f.endTime - 11.6) < 0.2, `${f.endTime}`);
    check("confidence = exp(avg_logprob)", Math.abs((f.confidence ?? 0) - Math.exp(-0.3)) < 1e-6);
    check("language reported", f.detectedLanguage === "en" && JSON.stringify(f.languages) === '["en"]');
    h.session.close(); await waitFor(() => h.closes.length === 1);
  }

  console.log("2. two utterances: ordered, no duplicate, no audio sent twice");
  {
    requests = [];
    respond = (_r, n) => ({ delayMs: n === 1 ? 250 : 0, body: { language: "en", language_probability: 0.95, language_source: "candidates", segments: [seg(n === 1 ? "First sentence." : "Second sentence.")] } });
    const h = open();
    h.feed(tone(1200)); h.feed(silence(900)); h.feed(tone(1200)); h.feed(silence(1200));
    await waitFor(() => finals(h).length === 2);
    check("two requests", requests.length === 2, `${requests.length}`);
    check("finals arrive in speaking order even when the first request is slower", finals(h).map((e) => e.text).join("|") === "First sentence.|Second sentence.", finals(h).map((e) => e.text).join("|"));
    check("second utterance starts after the first", finals(h)[1].startTime > finals(h)[0].startTime + 1.5, `${finals(h).map((e) => e.startTime.toFixed(2))}`);
    const total = requests.reduce((s, r) => s + r.bytes, 0) / bytesPerMs;
    check("total audio sent <= audio fed (nothing duplicated)", total <= 1200 + 900 + 1200 + 1200 && total >= 2400, `${total} ms`);
    h.session.close(); await waitFor(() => h.closes.length === 1);
  }

  console.log("3. endpointing details");
  {
    requests = []; respond = () => ({ body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg("Hello there everyone.")] } });
    let h = open();
    h.feed(tone(800)); h.feed(silence(400)); h.feed(tone(800)); h.feed(silence(1200));
    await waitFor(() => finals(h).length >= 1); await sleep(150);
    check("a 400 ms pause inside a sentence does not split it", requests.length === 1, `${requests.length} requests`);
    h.session.close();

    requests = []; h = open();
    h.feed(tone(100)); h.feed(silence(1500)); await sleep(300);
    check("a 100 ms click is never sent to Whisper", requests.length === 0, `${requests.length}`);
    h.session.close();

    requests = []; h = open();
    h.feed(tone(10)); h.feed(tone(10)); // 10 ms frames, like LiveKit
    h.feed(tone(1000), 10); h.feed(silence(1000), 10);
    await waitFor(() => finals(h).length === 1);
    check("10 ms LiveKit-sized frames are re-cut correctly (one utterance, ~1.0-1.7 s of audio)", requests.length === 1 && requests[0].bytes / bytesPerMs > 1000 && requests[0].bytes / bytesPerMs < 1900, `${requests[0]?.bytes / bytesPerMs} ms`);
    h.session.close();

    requests = []; h = open();
    h.feed(tone(1000));
    const before = h.now(); // voice gate closes: no silence frames are ever sent; next audio arrives 3 s later
    await waitFor(() => requests.length === 1, 3000);
    check("audio that simply stops arriving is flushed (voice-gate case), without waiting for silence frames", requests.length === 1, `${requests.length}`);
    void before;
    h.session.close();
  }

  console.log("4. long continuous speech is cut at its quietest point, losing / repeating nothing");
  {
    requests = []; respond = (_r, n) => ({ body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg(`part ${n}`)] } });
    const h = open();
    h.feed(tone(22_000)); h.feed(tone(200, 200)); h.feed(tone(18_000)); // ~140 RMS dip at 22.0-22.2 s, then 18 s more speech
    h.feed(silence(1500));
    await waitFor(() => finals(h).length === 2, 4000);
    const [a, b] = requests.map((r) => r.bytes / bytesPerMs);
    check("two requests, first <= 25 s", requests.length === 2 && a <= 25_100, `${requests.length} req, ${a} ms`);
    check("cut lands on the quiet dip (first request ~22.0-22.4 s)", a >= 21_900 && a <= 22_500, `${a} ms`);
    check("no audio lost or repeated (sum == 40.2 s of speech + 300 ms tail pad; no lead-in because nothing preceded it)", Math.abs(a + b - (22_000 + 200 + 18_000 + 300)) <= 150, `${a + b} ms`);
    h.session.close();
  }

  console.log("5. language parameters sent to the service");
  {
    requests = []; respond = () => ({ body: { language: "ta", language_probability: 0.92, language_source: "candidates", segments: [seg("இன்னைக்கு meeting இருக்கு")] } });
    let h = open({ languageHints: ["ta"], contextTerms: ["Jam|evil", "Priya"] });
    h.feed(tone(1000)); h.feed(silence(1200)); await waitFor(() => requests.length === 1);
    check("single hint => language forced, no candidates, no code-switch prompt", requests[0].query.language === "ta" && !requests[0].query.candidates && !requests[0].query.code_switch, JSON.stringify(requests[0].query));
    check("participant names are passed as terms ('|' stripped)", requests[0].query.terms === "Jam evil|Priya", requests[0].query.terms);
    h.session.close();

    requests = []; h = open({ languageHints: ["ta", "en"] });
    h.feed(tone(1000)); h.feed(silence(1200)); await waitFor(() => requests.length === 1);
    check("Tamil+English => candidates + code-switch prompt (Tanglish)", requests[0].query.candidates === "ta,en" && requests[0].query.code_switch === "true" && !requests[0].query.language, JSON.stringify(requests[0].query));
    h.session.close();

    requests = []; h = open({});
    h.feed(tone(1000)); h.feed(silence(1200)); await waitFor(() => finals(h).length === 1);
    check("no hint => server default languages as candidates (auto-detect)", requests[0].query.candidates === env.whisperLanguages.join(","), JSON.stringify(requests[0].query));
    h.feed(tone(1000)); h.feed(silence(1200)); await waitFor(() => requests.length === 2);
    check("2nd utterance carries the speaker's last confident language as fallback for short clips", requests[1].query.fallback_language === "ta", JSON.stringify(requests[1].query));
    const f = finals(h)[0];
    check("Tamil sentence with an English word is labelled Tamil + English, dominant Tamil", f.detectedLanguage === "ta" && JSON.stringify(f.languages) === '["ta","en"]', JSON.stringify(f.languages));
    h.session.close();

    (env as any).whisperApiToken = "tok";
    requests = []; h = open();
    h.feed(tone(1000)); h.feed(silence(1200)); await waitFor(() => requests.length === 1);
    check("bearer token is sent when configured", requests[0].auth === "Bearer tok");
    (env as any).whisperApiToken = "";
    h.session.close();
  }

  console.log("6. language labelling by script");
  check("Tamil only", JSON.stringify(languagesForText("வணக்கம் எல்லோருக்கும்", "ta")) === '["ta"]');
  check("English only", JSON.stringify(languagesForText("Good morning team", "en")) === '["en"]');
  check("Hindi + English", JSON.stringify(languagesForText("आज की meeting में हम बात करेंगे", "hi")) === '["hi","en"]');
  check("Arabic + English (dominant = most letters)", JSON.stringify(languagesForText("سنناقش المشروع الجديد مع الفريق project اليوم", "ar")) === '["ar","en"]' && JSON.stringify(languagesForText("ok سنناقش project status deadline", "ar")) === '["en","ar"]');
  check("Latin-only text that Whisper called Tamil (romanized Tamil) keeps 'ta', is NOT relabelled English", JSON.stringify(languagesForText("naalaikku meeting irukku", "ta")) === '["ta"]');
  check("digits / punctuation only => Whisper's label", JSON.stringify(languagesForText("12:30", "en")) === '["en"]');

  console.log("7. close flushes the last words and releases the session");
  {
    requests = []; respond = () => ({ delayMs: 150, body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg("Last words before leaving.")] } });
    const h = open();
    h.feed(tone(1500)); // still speaking when the participant leaves
    h.session.close();
    await waitFor(() => h.closes.length === 1);
    check("final emitted for speech that had not reached an endpoint, then onClose fired once", finals(h).length === 1 && h.closes.length === 1, `${finals(h).length} finals, ${h.closes.length} closes`);
    h.feed(tone(500));
    check("audio after close is ignored", requests.length === 1);
    check("open-session counter returns to its starting value", getOpenSttSessionCount() === baseOpen, `${getOpenSttSessionCount()} vs ${baseOpen}`);
  }

  console.log("7b. closeAndFlush waits for the last sentence (used when a meeting ends)");
  {
    requests = [];
    respond = () => ({ delayMs: 400, body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg("Final words before the meeting ended.")] } });
    const h = open();
    h.feed(tone(1500)); // host presses End while still talking
    await h.session.closeAndFlush(5000);
    check("the promise resolves only after the last sentence was delivered", finals(h).length === 1 && finals(h)[0].text === "Final words before the meeting ended.", `${finals(h).length} finals`);
    check("and the session is closed", h.closes.length === 1);
    const slow = open();
    respond = () => ({ delayMs: 3000, body: { language: "en", segments: [seg("too late")] } });
    slow.feed(tone(1500));
    const t0 = Date.now();
    await slow.session.closeAndFlush(600);
    check("a stuck service cannot hold the meeting open: gives up after the timeout", Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  }

  console.log("8. interim captions (optional)");
  {
    (env as any).whisperPartialsMs = 400;
    requests = [];
    respond = (r) => r.query.partial ? { body: { language: "en", segments: [seg("Hello wor", 0, 1)] } } : { body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg("Hello world.")] } };
    const h = open();
    for (let i = 0; i < 25; i++) { h.feed(tone(100)); await sleep(100); } // real-time pacing: 2.5 s of speech
    const sawPartial = h.events.some((e) => e.type === "partial" && e.text === "Hello wor");
    h.feed(silence(1200));
    await waitFor(() => finals(h).length === 1);
    await sleep(100);
    const lastEvent = h.events[h.events.length - 1];
    check("interim text appears while speaking", sawPartial);
    check("interim line is cleared once the final replaces it", lastEvent.type === "partial" && lastEvent.text === "", JSON.stringify(lastEvent));
    check("interim text is never emitted as a final", finals(h).every((e) => e.text === "Hello world."));
    h.session.close();

    respond = (r) => r.query.partial ? { body: { skipped: true, reason: "busy" } } : { body: { language: "en", segments: [seg("Hello world.")] } };
    const h2 = open();
    for (let i = 0; i < 15; i++) { h2.feed(tone(100)); await sleep(100); }
    h2.feed(silence(1200)); await waitFor(() => finals(h2).length === 1);
    check("a 'busy' answer for interim decode is ignored quietly", h2.events.filter((e) => e.type === "partial" && e.text).length === 0 && h2.errors.length === 0);
    h2.session.close();
    (env as any).whisperPartialsMs = 0;
  }

  console.log("9. service errors");
  {
    const realUrl = (env as any).whisperUrl;
    (env as any).whisperUrl = "http://127.0.0.1:1"; // nothing listens here
    requests = [];
    const h = open();
    h.feed(tone(1000)); h.feed(silence(1200));
    await sleep(2800); // 3 attempts with 0.5 s + 1.5 s backoff
    check("unreachable service => a clear error message (no crash, no fake transcript)", h.errors.length >= 1 && /not reachable/.test(h.errors[0].message) && finals(h).length === 0, h.errors[0]?.message);
    check("errors are rate-limited (one banner, not one per sentence)", h.errors.length === 1, `${h.errors.length}`);
    (env as any).whisperUrl = realUrl;
    respond = () => ({ body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg("Back online.")] } });
    h.feed(tone(1000)); h.feed(silence(1200));
    await waitFor(() => finals(h).length === 1, 4000);
    check("the same session recovers when the service comes back (and the failed sentence is not replayed)", finals(h).length === 1 && finals(h)[0].text === "Back online.", `${finals(h).length} finals`);
    h.session.close();

    requests = []; let n = 0;
    respond = () => (++n <= 2 ? { status: 503, body: { detail: "model is still loading" } } : { body: { language: "en", language_probability: 0.9, language_source: "candidates", segments: [seg("Loaded now.")] } });
    const h2 = open();
    h2.feed(tone(1000)); h2.feed(silence(1200));
    await waitFor(() => finals(h2).length === 1, 5000);
    check("503 (busy/loading) is retried with backoff and then succeeds", finals(h2).length === 1 && requests.length === 3, `${requests.length} requests`);
    h2.session.close();
  }

  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
