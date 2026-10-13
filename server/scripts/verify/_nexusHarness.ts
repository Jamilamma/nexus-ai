/**
 * Test harness (NOT production code). Boots the REAL realtime socket server
 * (src/realtime/socketServer.ts -> real meetingManager / meetingQA / summarize
 * code) with:
 *   - in-memory stand-ins for the Mongoose models (no MongoDB needed)
 *   - LiveKit transcriber stubbed out (no LiveKit server needed)
 *   - the Gemini HTTP call replaced by a deterministic fake that only
 *     "knows" what is in the prompt it receives (so output provably derives
 *     from the transcript the app sent). Every prompt is recorded.
 * It does NOT exercise real Gemini, AssemblyAI, LiveKit or MongoDB.
 */
// Neutralise anything in server/.env that would reach a real service.
process.env.LIVEKIT_URL = "";
process.env.LIVEKIT_API_KEY = "";
process.env.LIVEKIT_API_SECRET = "";
process.env.LLM_API_KEY = "fake-key-for-harness";
process.env.STT_API_KEY = "fake-key-for-harness";
process.env.SONIOX_API_KEY ||= "fake-soniox-key-for-harness";
process.env.JWT_SECRET = "harness-secret";
process.env.ENABLE_MEETING_TRANSCRIPTION ??= "true";
process.env.ENABLE_MEETING_AI = "false";

// The LiveKit native binding isn't available in every environment; this test
// never touches LiveKit, so load a stub for that one package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === "@livekit/rtc-node") return { Room: class {}, RoomEvent: {}, TrackKind: {}, TrackSource: {}, AudioStream: class {} };
  return origLoad.call(this, request, ...rest);
};

import http from "http";
import axios from "axios";
import { Types } from "mongoose";

/* eslint-disable @typescript-eslint/no-var-requires */
const { Meeting } = require("../../src/models/Meeting");
const { User } = require("../../src/models/User");
const { Recording } = require("../../src/models/Recording");
const { Transcript } = require("../../src/models/Transcript");
const { Summary } = require("../../src/models/Summary");
const { signToken } = require("../../src/utils/jwt");

export const hostId = new Types.ObjectId();
export const guestId = new Types.ObjectId();
export const meetingId = new Types.ObjectId();
const recordingId = new Types.ObjectId();
export const users: Record<string, string> = { [hostId.toString()]: "Priya", [guestId.toString()]: "Rahul" };
export const hostToken = signToken({ userId: hostId.toString() });
export const guestToken = signToken({ userId: guestId.toString() });

const meetingDoc: any = {
  _id: meetingId,
  title: "Q3 Planning",
  mode: "general_meeting",
  defaultLanguage: "English",
  status: "scheduled",
  hostId,
  participants: [] as any[],
  recordingId: undefined,
  startedAt: undefined,
  save: async () => meetingDoc,
};
const q = (value: any) => {
  const o: any = { select: () => o, lean: () => o, then: (res: any, rej: any) => Promise.resolve(value).then(res, rej) };
  return o;
};
const recordingDoc = { _id: recordingId, userId: hostId, participantIds: [hostId, guestId] };

Meeting.findById = () => q(meetingDoc);
Meeting.findOneAndUpdate = async (filter: any, update: any) => {
  const uid: Types.ObjectId | undefined = filter["participants.userId"]?.$ne ?? filter["participants.userId"];
  const isNe = Boolean(filter["participants.userId"]?.$ne);
  const row = uid ? meetingDoc.participants.find((p: any) => p.userId.equals(uid)) : undefined;
  if (update.$push) {
    if (row) return null;
    meetingDoc.participants.push({ ...update.$push.participants, leftAt: null });
    return meetingDoc;
  }
  if (!row || isNe) return null;
  for (const [k, v] of Object.entries(update.$set || {})) row[k.replace("participants.$.", "")] = v;
  return meetingDoc;
};
Meeting.updateOne = async (_f: any, u: any) => {
  if (u?.$set?.status) meetingDoc.status = u.$set.status;
  return {};
};
Meeting.findByIdAndUpdate = async () => meetingDoc;
User.findById = (id: any) => q({ name: users[String(id)] || "Someone" });
Recording.create = async () => recordingDoc;
Recording.findById = async () => ({ ...recordingDoc, userId: hostId, participantIds: recordingDoc.participantIds });
Recording.findByIdAndUpdate = async () => ({});
Transcript.create = async () => ({});
Transcript.findOneAndUpdate = async () => ({});
Transcript.bulkWrite = async () => ({});
Transcript.findOne = () => q({ segments: [] });
Summary.findOne = () => q(null);

// LiveKit is not available: stub the server-side transcriber + room close.
const tr = require("../../src/services/video/livekitTranscriber");
tr.startMeetingTranscriber = async () => {};
tr.stopMeetingTranscriber = async () => {};
const lk = require("../../src/services/video/livekit");
lk.closeLiveKitRoom = async () => {};

// ---------------------------------------------------------------- fake LLM
export const llmPrompts: string[] = [];
export let llmShouldFail = false;
export const setLlmFail = (v: boolean) => { llmShouldFail = v; };

function transcriptLinesIn(prompt: string): { speaker: string; text: string }[] {
  const out: { speaker: string; text: string }[] = [];
  for (const line of prompt.split("\n")) {
    const m = line.match(/^\[(?:\d+:\d{2}\] )?([^\]:]+?)\]?: (.+)$/) || line.match(/^\[(\d+:\d{2})\] ([^:]+): (.+)$/);
    if (!m) continue;
    if (m.length === 4) out.push({ speaker: m[2], text: m[3] });
    else out.push({ speaker: m[1], text: m[2] });
  }
  return out;
}
const STOP = new Set("what when where which who whom whose this that with from about have does did was were are the and for you your any there their they them will would could should been into than then also just over only most some such".split(" "));

(axios as any).post = async (url: string, body: any) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) throw new Error(`harness: unexpected network call to ${url}`);
  const prompt: string = body.contents[0].parts[0].text;
  llmPrompts.push(prompt);
  if (llmShouldFail) { const e: any = new Error("fake gemini 500"); e.response = { status: 400 }; throw e; }
  const lines = transcriptLinesIn(prompt);
  let text: string;
  if (prompt.includes('"shortSummary"')) {
    text = JSON.stringify({
      shortSummary: lines.length ? `The meeting covered ${lines.length} statements by ${[...new Set(lines.map((l) => l.speaker))].join(" and ")}.` : "",
      detailedSummary: lines.map((l) => `${l.speaker}: ${l.text}`).join(" "),
      keyPoints: lines.slice(0, 3).map((l) => `${l.speaker} — ${l.text}`),
      topics: [...new Set(lines.flatMap((l) => l.text.match(/\b[A-Z][a-z0-9]+\b/g) || []))].slice(0, 3),
    });
  } else if (prompt.includes('"actionItems"')) {
    text = JSON.stringify({
      decisions: lines.filter((l) => /decided/i.test(l.text)).map((l) => l.text),
      actionItems: lines.filter((l) => /\bI will\b/i.test(l.text)).map((l) => ({
        task: l.text, owner: l.speaker, deadline: (l.text.match(/by (\w+)/i) || [])[1] || "Not specified", priority: "not specified",
      })),
      questions: lines.filter((l) => l.text.trim().endsWith("?")).map((l) => l.text),
      risks: [], followUps: [], importantDates: [],
    });
  } else if (prompt.startsWith("Translate each numbered line of a meeting transcript into ")) {
    // PLUMBING STAND-IN, not a translator: echoes each line prefixed with the target language so tests can prove
    // which text was sent, where the result was stored, and that originals are never altered.
    const target = (prompt.match(/into (\w+), for someone/) || [])[1] || "?";
    const body = prompt.split("Lines:\n")[1] || "";
    const translations = body.split("\n").map((l) => l.match(/^\[(\d+)\] (.*)$/)).filter(Boolean).map((m: any) => ({ index: Number(m[1]), translatedText: `[${target}] ${m[2]}` }));
    text = JSON.stringify({ translations });
  } else if (prompt.includes("Question:")) {
    const question = (prompt.split("Question:")[1] || "").split("\n")[0].toLowerCase();
    const words = (question.match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w));
    const ctx = prompt.split("Transcript (chronological")[1] || "";
    const score = (l: { speaker: string; text: string }) =>
      words.reduce((n, w) => n + (l.text.toLowerCase().includes(w) ? 2 : 0) + (l.speaker.toLowerCase() === w ? 1 : 0), 0);
    const candidates = lines.filter((l) => ctx.includes(l.text)).map((l) => ({ l, s: score(l) })).filter((x) => x.s > 0);
    const hit = candidates.sort((a, b) => b.s - a.s)[0]?.l;
    text = hit ? `${hit.speaker} said: "${hit.text}"` : "I couldn't find that information in this meeting.";
  } else {
    text = "ok";
  }
  return { data: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] } };
};

export const segments = [
  ["Priya", hostId, "Let's start with the Q3 launch. We decided to ship the beta on October twentieth."],
  ["Rahul", guestId, "I will finish the payment API by Friday."],
  ["Priya", hostId, "Great. Who is handling the marketing page?"],
  ["Rahul", guestId, "Budget is capped at five thousand dollars."],
].map(([speaker, pid, text], i) => ({
  speaker: speaker as string, participantId: String(pid), segmentId: `seg-${i}`, meetingId: meetingId.toString(),
  timestamp: new Date(), startTime: i * 6, endTime: i * 6 + 5, text: text as string, language: "en",
}));

/** Boots the real socket server; pre-loads the live transcript so history replays on join. */
export async function startHarness(port: number, preloadTranscript = true) {
  const { attachRealtimeServer } = require("../../src/realtime/socketServer");
  const mm = require("../../src/services/realtime/meetingManager");
  const server = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  const io = attachRealtimeServer(server);
  await new Promise<void>((r) => server.listen(port, r));
  if (preloadTranscript) {
    await mm.ensureMeetingSessionStarted(meetingId.toString(), hostId, "Q3 Planning", "general_meeting", {
      onTranscriptPartial() {}, onTranscriptFinal() {}, onTranslationUpdate() {}, onInsightUpdate() {}, onError() {},
    });
    mm.getLiveSegments(meetingId.toString()).push(...segments);
  }
  return { server, io, meetingDoc };
}
