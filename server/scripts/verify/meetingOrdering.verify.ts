/**
 * Standalone verification for the multi-participant transcript-accuracy fix.
 *
 * This does NOT require a live MongoDB connection or a real AssemblyAI
 * connection — it exercises only the pure, exported ordering/dedupe logic
 * from meetingManager.ts directly, feeding it synthetic finalized segments
 * from 2 and 3 fake participants arriving in a deliberately non-chronological
 * order (the exact scenario that causes real-world "wrong speaker order" /
 * "wrongly assigned segment" bugs when multiple people talk close together).
 *
 * Run with (from server/):
 *   npx ts-node --transpile-only scripts/verify/meetingOrdering.verify.ts
 */

import { insertInOrder, segmentDedupeKey } from "../../src/services/realtime/meetingManager";
import { ITranscriptSegment } from "../../src/models/Transcript";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
}

function seg(participantId: string, speaker: string, startTime: number, text: string): ITranscriptSegment {
  return { participantId, speaker, segmentId: `${participantId}-${startTime}-${Math.random()}`, startTime, endTime: startTime + 1, text };
}

// ---------------------------------------------------------------------
// Scenario A: 2 participants, overlapping speech, out-of-order arrival.
// Alice starts a long sentence at t=0.0 but it doesn't finalize until
// later; Bob's short "yeah" (spoken WHILE Alice was still talking,
// starting at t=0.4) finalizes and arrives at the server FIRST. A naive
// "append in arrival order" transcript would show Bob's line before
// Alice's, even though Alice started speaking first.
// ---------------------------------------------------------------------
console.log("\n=== 2-participant test ===");
{
  const segments: ITranscriptSegment[] = [];
  const arrivalOrder = [
    seg("user_bob", "Bob", 0.4, "yeah"),
    seg("user_alice", "Alice", 0.0, "So I think we should ship the new pricing page next week"),
    seg("user_alice", "Alice", 2.1, "and then follow up with the email campaign"),
    seg("user_bob", "Bob", 1.9, "sounds good to me"),
  ];
  for (const s of arrivalOrder) insertInOrder(segments, s);

  check("segments end up sorted by startTime (chronological, not arrival order)",
    segments.every((s, i) => i === 0 || segments[i - 1].startTime <= s.startTime));

  check("first chronological line is Alice's (she spoke first even though Bob's 'yeah' arrived first)",
    segments[0].speaker === "Alice" && segments[0].text.includes("pricing page"));

  check("every segment kept its own correct participantId (no cross-assignment)",
    segments.filter((s) => s.speaker === "Alice").every((s) => s.participantId === "user_alice") &&
    segments.filter((s) => s.speaker === "Bob").every((s) => s.participantId === "user_bob"));

  check("every segment kept its own correct text and timestamp",
    segments.find((s) => s.text === "yeah")?.startTime === 0.4 &&
    segments.find((s) => s.text === "sounds good to me")?.startTime === 1.9);

  check("4 distinct segments present (none lost)", segments.length === 4);
}

// ---------------------------------------------------------------------
// Scenario B: 3 participants, heavier interleaving + a duplicate delivery
// (simulates an STT vendor redelivering the same finalized "turn").
// ---------------------------------------------------------------------
console.log("\n=== 3-participant test (with a duplicate delivery) ===");
{
  const segments: ITranscriptSegment[] = [];
  const seen = new Set<string>();

  function deliver(s: ITranscriptSegment) {
    const key = segmentDedupeKey(s);
    if (seen.has(key)) return; // mirrors handleFinalSegment's dedupe guard
    seen.add(key);
    insertInOrder(segments, s);
  }

  const carolLine1 = seg("user_carol", "Carol", 0.0, "Let's start with the roadmap review");
  const aliceLine1 = seg("user_alice", "Alice", 1.2, "I have an update on that");
  const bobLine1 = seg("user_bob", "Bob", 0.8, "quick question first");
  const carolLine2 = seg("user_carol", "Carol", 3.0, "go ahead Bob");

  deliver(carolLine1);
  deliver(bobLine1); // arrives before aliceLine1 even though it started after carolLine1 chronologically but before aliceLine1
  deliver(aliceLine1);
  deliver(carolLine2);
  deliver({ ...bobLine1 }); // duplicate redelivery of Bob's exact segment (same participant/startTime/text)

  check("duplicate redelivery was dropped (still only 4 segments, not 5)", segments.length === 4);

  check("segments sorted chronologically across all 3 participants",
    segments.every((s, i) => i === 0 || segments[i - 1].startTime <= s.startTime));

  const order = segments.map((s) => s.speaker);
  check("speaking order is Carol, Bob, Alice, Carol (by actual startTime, not arrival order)",
    JSON.stringify(order) === JSON.stringify(["Carol", "Bob", "Alice", "Carol"]));

  check("each segment retains its own correct participantId/speaker pairing",
    segments.every((s) =>
      (s.speaker === "Carol" && s.participantId === "user_carol") ||
      (s.speaker === "Bob" && s.participantId === "user_bob") ||
      (s.speaker === "Alice" && s.participantId === "user_alice")
    ));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
