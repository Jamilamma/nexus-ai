/**
 * Socket-level verification of NEXUS AI in a meeting, against the REAL
 * server handlers (see _nexusHarness.ts for exactly what is stubbed).
 * Run from server/:  npx ts-node --transpile-only scripts/verify/nexusAi.e2e.verify.ts
 */
import { startHarness, hostToken, guestToken, meetingId, llmPrompts, setLlmFail, segments } from "./_nexusHarness";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io: connect } = require("../../../client/node_modules/socket.io-client");

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); if (!ok) failures++; };
const once = (s: any, ev: string, ms = 8000) => new Promise<any>((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms); s.once(ev, (d: any) => { clearTimeout(t); res(d); }); });
/** Resolves true if `ev` is NOT received within ms (used to prove replies are private). */
const silent = (s: any, ev: string, ms = 900) => new Promise<boolean>((res) => { const h = () => res(false); s.once(ev, h); setTimeout(() => { s.off(ev, h); res(true); }, ms); });
const either = (s: any, evs: string[], ms = 8000) => new Promise<{ ev: string; data: any }>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${evs}`)), ms);
  for (const ev of evs) s.once(ev, (data: any) => { clearTimeout(t); res({ ev, data }); });
});
const client = (token: string) => connect("http://localhost:5611/realtime", { auth: { token }, transports: ["websocket"], reconnection: false });

(async () => {
  await startHarness(5611);
  const host = client(hostToken), guest = client(guestToken);
  await Promise.all([once(host, "connection_status"), once(guest, "connection_status")]);

  console.log("\n=== Join: server tells the client NEXUS AI is available ===");
  const hostJoined = once(host, "meeting_joined"); const hostHist = once(host, "meeting_transcript_history");
  host.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Priya" });
  const joined = await hostJoined; const hist = await hostHist;
  check("meeting_joined.nexusAi === true", joined.nexusAi === true);
  check("meeting_joined.transcription === true", joined.transcription === true);
  check("live transcript replayed to joiner", hist.segments.length === segments.length, `${hist.segments.length} lines`);
  const guestJoined = once(guest, "meeting_joined");
  guest.emit("join_meeting", { meetingId: meetingId.toString(), displayName: "Rahul" });
  await guestJoined;

  console.log("\n=== Summary: built from the real transcript ===");
  llmPrompts.length = 0;
  host.emit("meeting_summary_request", { requestId: "s1" });
  const sum = (await either(host, ["meeting_summary", "meeting_ai_error"])).data;
  check("got a summary (not an error)", !!sum.summary, sum.message || "");
  const S = sum.summary;
  check("overview present", typeof S.shortSummary === "string" && S.shortSummary.length > 0, S.shortSummary);
  check("key topics array", Array.isArray(S.topics) && S.topics.length > 0, JSON.stringify(S.topics));
  check("key points array", Array.isArray(S.keyPoints) && S.keyPoints.length > 0);
  check("decision extracted from transcript", S.decisions.some((d: string) => /ship the beta/i.test(d)), JSON.stringify(S.decisions));
  const ai = S.actionItems[0];
  check("action item has task + responsible person + deadline", ai && /payment API/.test(ai.task) && ai.owner === "Rahul" && ai.deadline === "Friday", JSON.stringify(ai));
  check("unresolved question extracted", S.questions.some((x: string) => /marketing page/i.test(x)), JSON.stringify(S.questions));
  check("speakers are the real participants", S.speakers.sort().join() === "Priya,Rahul", S.speakers.join());
  check("segmentCount matches transcript", S.segmentCount === segments.length);
  const sent = llmPrompts.join("\n");
  check("every real transcript line was sent to the LLM, speaker-tagged", segments.every((s) => sent.includes(`[${s.speaker}]: ${s.text}`)));
  check("summary reply is private (guest got nothing)", await silent(guest, "meeting_summary"));

  console.log("\n=== Summary: identical transcript -> cached (no extra LLM spend); new speech -> regenerates ===");
  let n0 = llmPrompts.length;
  host.emit("meeting_summary_request", { requestId: "s2" }); await once(host, "meeting_summary");
  check("cached when transcript unchanged", llmPrompts.length === n0);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("../../src/services/realtime/meetingManager").getLiveSegments(meetingId.toString()).push({ ...segments[0], segmentId: "seg-new", startTime: 40, endTime: 44, text: "Also Jamil will review the contract." });
  host.emit("meeting_summary_request", { requestId: "s3" }); const s3 = await once(host, "meeting_summary");
  check("regenerated immediately after new speech (no stale 15s cache)", llmPrompts.length > n0 && s3.summary.segmentCount === segments.length + 1);

  console.log("\n=== Ask NEXUS ===");
  llmPrompts.length = 0;
  host.emit("meeting_ask", { question: "How much is the budget?", requestId: "a1" });
  const a1 = (await either(host, ["meeting_answer", "meeting_ai_error"])).data;
  check("answerable question answered from transcript", /five thousand dollars/.test(a1.answer || ""), a1.answer || a1.message);
  check("answer names who said it / has sources", a1.sources?.length > 0 && a1.sources.some((s: any) => s.speaker === "Rahul"));
  check("question sent to LLM together with real transcript", llmPrompts.some((p) => p.includes("Budget is capped at five thousand dollars.") && p.includes("How much is the budget?")));

  host.emit("meeting_ask", { question: "What colour is the office carpet?", requestId: "a2" });
  const a2 = (await either(host, ["meeting_answer", "meeting_ai_error"])).data;
  check('unanswerable -> exact "I couldn\'t find that information in this meeting."', a2.answer === "I couldn't find that information in this meeting.", a2.answer || a2.message);
  check("refusal carries no fake sources", Array.isArray(a2.sources) && a2.sources.length === 0);

  llmPrompts.length = 0;
  host.emit("meeting_ask", { question: "What did Rahul say?", requestId: "a3" });
  const a3 = (await either(host, ["meeting_answer", "meeting_ai_error"])).data;
  check("speaker question answered from that speaker's own lines", /Rahul said/.test(a3.answer), a3.answer || a3.message);
  check("app told the LLM to answer only about what Rahul actually said", llmPrompts.some((p) => p.includes("Answer about Rahul using only what Rahul actually said")));
  check("answer is private (guest got nothing)", await silent(guest, "meeting_answer"));

  host.emit("meeting_ask", { question: "   ", requestId: "a4" });
  const a4 = await once(host, "meeting_ai_error");
  check("empty question rejected with inline error", a4.kind === "ask" && a4.code === "EMPTY");
  host.emit("meeting_ask", { question: "x".repeat(501), requestId: "a5" });
  check("over-long question rejected", (await once(host, "meeting_ai_error")).code === "TOO_LONG");

  console.log("\n=== Failure is shown, not faked ===");
  setLlmFail(true);
  guest.emit("meeting_ask", { question: "How much is the budget?", requestId: "g1" });
  const g1 = await either(guest, ["meeting_answer", "meeting_ai_error"]);
  check("LLM failure -> inline error event, no invented answer", g1.ev === "meeting_ai_error", g1.data.message?.slice(0, 60));
  setLlmFail(false);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
