/**
 * Unit checks for isDuplicateOfRecent (meetingManager.ts): re-deliveries / fragments of speech that is
 * already in the transcript are dropped; genuine repeats and other people's identical words are kept.
 * Run from server/:  npx ts-node --transpile-only scripts/verify/duplicateSegments.verify.ts
 */
import "./_patchWs";
import { isDuplicateOfRecent } from "../../src/services/realtime/meetingManager";
import { ITranscriptSegment } from "../../src/models/Transcript";

let failures = 0;
const check = (label: string, ok: boolean) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };
const seg = (pid: string, start: number, end: number, text: string): ITranscriptSegment => ({ participantId: pid, speaker: pid, segmentId: `${pid}-${start}`, startTime: start, endTime: end, text });

const base = [seg("A", 10, 14, "We should ship the beta on Monday."), seg("B", 14.5, 16, "Sounds good.")];

check("same words, overlapping time (re-delivery) -> duplicate", isDuplicateOfRecent(base, seg("A", 10.2, 14, "We should ship the beta on Monday.")));
check("punctuation / case differences do not hide a re-delivery", isDuplicateOfRecent(base, seg("A", 10, 14.1, "we should ship the beta on monday")));
check("a fragment of an overlapping earlier line (vendor re-segmenting) -> duplicate", isDuplicateOfRecent(base, seg("A", 12, 14, "ship the beta on Monday")));
check("Tamil script re-delivery is detected too", isDuplicateOfRecent([seg("A", 1, 3, "நாளைக்கு மீட்டிங் இருக்கு")], seg("A", 1, 3, "நாளைக்கு மீட்டிங் இருக்கு")));
check("the same words said LATER (a real repeat) are kept", !isDuplicateOfRecent(base, seg("A", 30, 33, "We should ship the beta on Monday.")));
check("another participant saying the same words at the same time is kept", !isDuplicateOfRecent(base, seg("C", 10, 14, "We should ship the beta on Monday.")));
check("a different sentence overlapping in time is kept", !isDuplicateOfRecent(base, seg("A", 10, 14, "Actually, let us wait until Tuesday.")));
check("a line with no letters or digits is dropped", isDuplicateOfRecent(base, seg("A", 40, 41, " . ")));
check("short 'yes' twice, 5 s apart, is kept", !isDuplicateOfRecent([seg("A", 20, 20.5, "Yes.")], seg("A", 25, 25.5, "Yes.")));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
