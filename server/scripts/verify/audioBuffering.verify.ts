/**
 * Standalone verification of the audio handling + session setup in realtimeTranscribe.ts (Soniox).
 *
 * Swaps in a fake `ws` WebSocket (no network) so we control exactly when the connection "opens" and
 * can assert: 10 ms LiveKit frames are re-cut into exact 100 ms messages in order, audio captured
 * while the socket is still connecting is queued (not dropped), the first message is the Soniox
 * config (the only place the API key appears), the close handshake flushes the last word, and
 * misconfiguration is refused with a clear message instead of connecting.
 *
 * Run with (from server/):
 *   npx ts-node --transpile-only scripts/verify/audioBuffering.verify.ts
 */

import { EventEmitter } from "events";
import Module from "module";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
}

// ---- Fake `ws` module, matching just the surface realtimeTranscribe.ts uses ----
class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Buffer | string> = [];
  terminated = false;

  constructor(public url: string, public opts?: any) {
    super();
    FakeWebSocket.instances.push(this);
  }

  static instances: FakeWebSocket[] = [];

  send(data: Buffer | string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send() called while not OPEN — this would throw with the real `ws` lib too");
    }
    this.sent.push(data);
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", 1000, Buffer.from(""));
  }

  terminate() {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", 1006, Buffer.from(""));
  }
}

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === "ws") return FakeWebSocket;
  return originalLoad.call(this, request, ...rest);
};

process.env.SONIOX_API_KEY = "fake-key";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startRealtimeTranscription } = require("../../src/services/speech/realtimeTranscribe");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { env } = require("../../src/config/env");

const frame = (n: number, fill: number) => Buffer.alloc(n, fill);
const CHUNK = 3200; // 100 ms of 16 kHz mono PCM16
const audioOf = (ws: FakeWebSocket) => ws.sent.filter((m) => Buffer.isBuffer(m) && m.length > 0) as Buffer[];
const configOf = (ws: FakeWebSocket) => JSON.parse(ws.sent.find((m) => typeof m === "string") as string);

console.log("\n=== 10 ms frames are re-cut into exact 100 ms messages, in order ===");
{
  const session = startRealtimeTranscription(() => {}, () => {}, Date.now());
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.simulateOpen();
  for (let i = 0; i < 25; i++) session.sendAudioChunk(frame(320, i)); // 25 x 10 ms = 250 ms
  check("first message on the socket is the JSON config (before any audio)", typeof ws.sent[0] === "string");
  check("250 ms of 10 ms frames -> exactly 2 audio messages so far", audioOf(ws).length === 2);
  check("every audio message is 100 ms (3200 bytes)", audioOf(ws).every((m) => m.length === CHUNK));
  check("audio order preserved (first byte of msg 1 = frame 0, of msg 2 = frame 10)", audioOf(ws)[0][0] === 0 && audioOf(ws)[1][0] === 10);
  session.close();
  const audio = audioOf(ws);
  check("close() flushes the 50 ms tail so the last word is not cut off", audio.length === 3 && audio[2].length === 1600);
  const last = ws.sent[ws.sent.length - 1];
  check("close() ends the stream with an empty frame (Soniox then flushes + replies `finished`)", Buffer.isBuffer(last) && last.length === 0);
  ws.terminate();
}

console.log("\n=== Audio captured while the socket is still CONNECTING is queued, not dropped ===");
{
  const session = startRealtimeTranscription(() => {}, () => {}, Date.now());
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  check("socket starts CONNECTING (not yet OPEN)", ws.readyState === FakeWebSocket.CONNECTING);
  for (let i = 0; i < 30; i++) session.sendAudioChunk(frame(320, 7)); // 300 ms
  check("nothing sent yet (socket not open)", ws.sent.length === 0);
  ws.simulateOpen();
  check("config is sent FIRST, then the 3 queued 100 ms messages in order", typeof ws.sent[0] === "string" && audioOf(ws).length === 3 && audioOf(ws).every((m) => m.length === CHUNK));
  session.close();
  ws.terminate();
}

console.log("\n=== A connection that never opens is aborted cleanly on close() ===");
{
  const session = startRealtimeTranscription(() => {}, () => {}, Date.now());
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  session.sendAudioChunk(Buffer.from([1]));
  session.close();
  check("still-connecting socket is terminated (not left dangling)", ws.terminated === true);
}

console.log("\n=== Session config: model, audio format, language handling, key placement ===");
{
  const session = startRealtimeTranscription(() => {}, () => {}, Date.now(), undefined, undefined, { contextTerms: ["Rahul"] });
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.simulateOpen();
  const cfg = configOf(ws);
  check("default model is stt-rt-v5", cfg.model === "stt-rt-v5");
  check("raw PCM16 / 16 kHz / mono declared (matches what LiveKit's resampler delivers)", cfg.audio_format === "pcm_s16le" && cfg.sample_rate === 16000 && cfg.num_channels === 1);
  check("automatic language identification is on", cfg.enable_language_identification === true);
  check("language hints bias toward en/ta/hi/ar", JSON.stringify(cfg.language_hints) === JSON.stringify(["en", "ta", "hi", "ar"]));
  check("language is NEVER forced: language_hints_strict is not sent", !("language_hints_strict" in cfg));
  check("endpoint detection on, with a bounded delay", cfg.enable_endpoint_detection === true && cfg.max_endpoint_delay_ms === env.sonioxMaxEndpointDelayMs);
  check("speaker diarization is off (the speaker is known from the LiveKit track)", !cfg.enable_speaker_diarization);
  check("participant name is passed as a recognition context term", JSON.stringify(cfg.context?.terms) === JSON.stringify(["Rahul"]));
  check("API key is in the backend->Soniox config only, never in the URL", cfg.api_key === "fake-key" && !ws.url.includes("fake-key"));
  session.close();
  ws.terminate();

  const auto = startRealtimeTranscription(() => {}, () => {}, Date.now(), undefined, undefined, { languageHints: [] });
  const wsAuto = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  wsAuto.simulateOpen();
  check("an explicit empty hint list means pure auto-detection (no language_hints sent)", !("language_hints" in configOf(wsAuto)));
  auto.close(); wsAuto.terminate();

  const ta = startRealtimeTranscription(() => {}, () => {}, Date.now(), undefined, undefined, { languageHints: ["ta", "en"] });
  const wsTa = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  wsTa.simulateOpen();
  check("a participant's own 'I speak Tamil + English' choice overrides the default hints", JSON.stringify(configOf(wsTa).language_hints) === JSON.stringify(["ta", "en"]));
  ta.close(); wsTa.terminate();
}

console.log("\n=== Misconfiguration is refused with a clear message instead of connecting ===");
{
  const before = FakeWebSocket.instances.length;
  const savedModel = env.sonioxModel;
  env.sonioxModel = "universal-3-6-pro"; // an old AssemblyAI model name left in config
  let message = "";
  try { startRealtimeTranscription(() => {}, () => {}, Date.now()); } catch (e: any) { message = e.message; }
  console.log("      message:", message);
  check("a non-Soniox model name is rejected, naming the expected form", /not a Soniox real-time model/.test(message) && /stt-rt-v5/.test(message));
  check("no socket was opened", FakeWebSocket.instances.length === before);
  env.sonioxModel = savedModel;

  const savedKey = env.sonioxApiKey;
  env.sonioxApiKey = "";
  message = "";
  try { startRealtimeTranscription(() => {}, () => {}, Date.now()); } catch (e: any) { message = e.message; }
  check("a missing key is refused (and the AssemblyAI upload key is never sent to Soniox)", /SONIOX_API_KEY is not set/.test(message) && FakeWebSocket.instances.length === before);
  env.sonioxApiKey = savedKey;
}

(Module as any)._load = originalLoad;

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
