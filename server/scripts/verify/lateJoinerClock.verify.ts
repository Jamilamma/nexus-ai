import { EventEmitter } from "events";
import Module from "module";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}`); }
}

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  sent: any[] = [];
  constructor(public url: string, public opts?: any) { super(); FakeWebSocket.instances.push(this); }
  static instances: FakeWebSocket[] = [];
  send(data: any) { this.sent.push(data); }
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this.emit("open"); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
  terminate() { this.readyState = FakeWebSocket.CLOSED; this.emit("close"); }
  emitMessage(obj: any) { this.emit("message", Buffer.from(JSON.stringify(obj)), false); }
}

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === "ws") return FakeWebSocket;
  return originalLoad.call(this, request, ...rest);
};

process.env.SONIOX_API_KEY = "fake-key";
const { startRealtimeTranscription } = require("../../src/services/speech/realtimeTranscribe");

// One finalized utterance in Soniox's token format (times are relative to THIS connection's audio).
const utterance = (text: string, startMs: number, endMs: number) => ({
  tokens: [{ text, start_ms: startMs, end_ms: endMs, confidence: 0.95, is_final: true, language: "en" }, { text: "<end>", is_final: true }],
});

console.log("\n=== Late-joining participant's timestamps land on the shared meeting clock ===");
{
  const realNow = Date.now.bind(Date);
  let fakeNow = realNow();
  Date.now = () => fakeNow;

  // Meeting starts right now. Alice is there from the start, so her STT
  // connection opens with ~0 clock offset from the meeting origin.
  const meetingStartedAt = Date.now();

  const eventsA: any[] = [];
  startRealtimeTranscription((e: any) => eventsA.push(e), () => {}, meetingStartedAt);
  const wsA = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  wsA.simulateOpen();
  // Alice's own connection clock: she says something at her connection's t=1.0s
  wsA.emitMessage(utterance("hello everyone", 1000, 1500));

  const finalsA = eventsA.filter((e) => e.type === "final");
  check("Alice (present since meeting start) gets a startTime of ~1s",
    finalsA.length === 1 && Math.abs(finalsA[0].startTime - 1.0) < 0.01);

  // 5 real minutes pass, then Bob joins. His STT connection is brand new,
  // so HIS OWN connection clock starts back at 0 again -- but he is passed
  // the SAME meetingStartedAt origin as Alice (this is exactly what
  // meetingManager.ts does: it always passes the shared `meeting.startedAt`,
  // never "now", to every participant's startRealtimeTranscription call).
  fakeNow += 300_000;

  const eventsB: any[] = [];
  startRealtimeTranscription((e: any) => eventsB.push(e), () => {}, meetingStartedAt);
  const wsB = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  wsB.simulateOpen();
  // Bob speaks almost immediately after joining -- his OWN connection reports t=0.2s
  wsB.emitMessage(utterance("hi, sorry I'm late", 200, 900));

  const finalsB = eventsB.filter((e) => e.type === "final");
  check("Bob (joined 5 min late) gets a startTime near ~300.2s, NOT ~0.2s",
    finalsB.length === 1 && Math.abs(finalsB[0].startTime - 300.2) < 0.5);

  check("Bob's segment sorts AFTER Alice's on the shared timeline (chronologically correct)",
    finalsB[0].startTime > finalsA[0].startTime);

  Date.now = realNow;
}

(Module as any)._load = originalLoad;
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
