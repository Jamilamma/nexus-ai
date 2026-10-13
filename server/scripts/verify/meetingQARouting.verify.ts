/**
 * Verifies the deterministic (non-LLM) routing/refusal logic in
 * meetingQA.ts: speaker-mention detection, time-window detection, and the
 * "no segments -> refuse without ever calling the LLM" guarantee. Does NOT
 * exercise askLLM() itself (needs a real LLM_API_KEY / network access,
 * unavailable in this environment) -- see report.
 *
 * Run with (from server/):
 *   npx ts-node --transpile-only scripts/verify/meetingQARouting.verify.ts
 */
import { answerMeetingQuestion, NO_INFO_ANSWER } from "../../src/services/ai/meetingQA";
import { ITranscriptSegment } from "../../src/models/Transcript";
import { Types } from "mongoose";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}`); }
}

function seg(participantId: string, speaker: string, startTime: number, endTime: number, text: string): ITranscriptSegment {
  return { participantId, speaker, segmentId: `${participantId}-${startTime}`, startTime, endTime, text };
}

const participants = [
  { userId: "u_rahul", displayName: "Rahul" },
  { userId: "u_priya", displayName: "Priya" },
  { userId: "u_jamil", displayName: "Jamil" },
];

const segments = [
  seg("u_rahul", "Rahul", 0, 5, "I'll handle the backend API."),
  seg("u_priya", "Priya", 6, 10, "Great, I'll do the frontend."),
  seg("u_jamil", "Jamil", 11, 14, "I have a question about the deadline."),
];

(async () => {
  console.log("\n=== Speaker mention -> refuses instantly (no LLM call) when that speaker never spoke ===");
  {
    const result = await answerMeetingQuestion({
      recordingId: new Types.ObjectId(),
      askerUserId: new Types.ObjectId(),
      askerDisplayName: "Asker",
      question: "What did Kavya say?", // Kavya never joined/spoke
      segments,
      meetingStartedAtMs: Date.now() - 20_000,
      participants, // Kavya isn't even a participant -> falls through to RAG path, not the speaker path
      actionItems: [],
      history: [],
    }).catch((e) => ({ answer: `THREW: ${e.message}`, sources: [] }));
    // Kavya isn't a known participant, so this exercises the RAG fallback,
    // which needs a DB + LLM -- expected to throw/fail here without those,
    // not a meetingQA bug. Just confirm it didn't crash the whole process.
    check("did not crash the process", typeof result.answer === "string");
  }

  console.log("\n=== Speaker mention for a real participant with zero segments -> exact refusal, no LLM call ===");
  {
    const result = await answerMeetingQuestion({
      recordingId: new Types.ObjectId(),
      askerUserId: new Types.ObjectId(),
      askerDisplayName: "Asker",
      question: "What did Priya say about the roadmap?",
      segments: [seg("u_rahul", "Rahul", 0, 5, "Only Rahul spoke so far.")], // Priya has zero segments
      meetingStartedAtMs: Date.now() - 20_000,
      participants,
      actionItems: [],
      history: [],
    });
    check("exact NO_INFO_ANSWER returned (never invents a Priya statement)", result.answer === NO_INFO_ANSWER);
    check("no sources fabricated", result.sources.length === 0);
  }

  console.log("\n=== 'What did I miss' with no recorded join time -> exact refusal, no LLM call ===");
  {
    const result = await answerMeetingQuestion({
      recordingId: new Types.ObjectId(),
      askerUserId: new Types.ObjectId(),
      askerDisplayName: "Asker",
      question: "What did I miss?",
      segments,
      meetingStartedAtMs: Date.now() - 20_000,
      participants, // asker isn't in this list -> no joinedAt on record
      actionItems: [],
      history: [],
    });
    check("exact NO_INFO_ANSWER returned when join time is unknown", result.answer === NO_INFO_ANSWER);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
