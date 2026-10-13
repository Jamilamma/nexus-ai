/**
 * Verifies services/ai/llmClient.ts against a MOCK Gemini server (no real API calls, no key needed):
 * thinking is switched off for Flash models, a stalled request is retried once instead of failing,
 * a rejected "thinking" setting falls back automatically, 429 backoff still works, errors are readable.
 * Run from server/:  npx ts-node --transpile-only scripts/verify/llmClient.verify.ts
 */
import http from "http";
import { AddressInfo } from "net";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failures++; };

let bodies: any[] = [];
let behave: (n: number, body: any) => "ok" | "hang" | "400thinking" | "429" = () => "ok";
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    bodies.push(body);
    const mode = behave(bodies.length, body);
    if (mode === "hang") return; // never answers: the client's timeout must fire
    res.setHeader("content-type", "application/json");
    if (mode === "400thinking") { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "Unknown field thinkingConfig / thinking not supported" } })); }
    if (mode === "429") { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: "quota" } })); }
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "mock answer" }] } }] }));
  });
});

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "gemini-2.5-flash";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LLM_TIMEOUT_MS = "5000"; // clamped minimum is 5 s
  const { askLLM } = require("../../src/services/ai/llmClient");

  console.log("1. normal call");
  bodies = []; behave = () => "ok";
  check("returns the model text", (await askLLM("hi")) === "mock answer");
  check("Flash model: thinking is switched off (thinkingBudget 0)", bodies[0]?.generationConfig?.thinkingConfig?.thinkingBudget === 0, JSON.stringify(bodies[0]?.generationConfig));
  check("answer-length cap is still sent", bodies[0]?.generationConfig?.maxOutputTokens === 1500);

  console.log("2. a stalled request is retried once, not failed");
  bodies = []; behave = (n) => (n === 1 ? "hang" : "ok");
  const t0 = Date.now();
  const a = await askLLM("hi");
  check("second attempt answers after the first times out", a === "mock answer" && bodies.length === 2, `${bodies.length} requests`);
  check("took about one timeout (5 s), not the old 60 s", Date.now() - t0 >= 4500 && Date.now() - t0 < 9000, `${Date.now() - t0} ms`);

  console.log("3. API rejects the thinking setting");
  bodies = []; behave = (_n, b) => (b?.generationConfig?.thinkingConfig ? "400thinking" : "ok");
  check("resent automatically without it", (await askLLM("hi")) === "mock answer" && bodies.length === 2 && !bodies[1].generationConfig.thinkingConfig);
  bodies = []; behave = () => "ok";
  await askLLM("again");
  check("and it is not sent again afterwards", bodies.length === 1 && !bodies[0].generationConfig.thinkingConfig);

  console.log("4. 429 still backs off and retries");
  bodies = []; behave = (n) => (n === 1 ? "429" : "ok");
  check("recovers on the retry", (await askLLM("hi")) === "mock answer" && bodies.length === 2);

  console.log("5. unreachable for both attempts");
  bodies = []; behave = () => "hang";
  let msg = "";
  try { await askLLM("hi"); } catch (e: any) { msg = e.message; }
  check("readable error, exactly two attempts", /did not answer in time/.test(msg) && bodies.length === 2, `${msg} / ${bodies.length}`);

  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
