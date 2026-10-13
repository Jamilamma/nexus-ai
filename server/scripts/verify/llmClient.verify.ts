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
let behave: (n: number, body: any) => "ok" | "hang" | "400thinking" | "400other" | "429" = () => "ok";
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
    if (mode === "400other") { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } })); }
    if (mode === "429") { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: "quota" } })); }
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "mock answer" }] } }], usageMetadata: { thoughtsTokenCount: 0 } }));
  });
});

const fresh = () => { delete require.cache[require.resolve("../../src/services/ai/llmClient")]; return require("../../src/services/ai/llmClient").askLLM; };
const tc = (b: any) => b?.generationConfig?.thinkingConfig;
const okBody = (thoughts = 0) => ({ candidates: [{ content: { parts: [{ text: "mock answer" }] } }], usageMetadata: { thoughtsTokenCount: thoughts } });

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "gemini-2.5-flash";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LLM_TIMEOUT_MS = "5000"; // clamped minimum is 5 s
  let askLLM = fresh();

  console.log("1. normal call");
  bodies = []; behave = () => "ok";
  check("returns the model text", (await askLLM("hi")) === "mock answer");
  check("Flash model: thinking switched off (thinkingBudget 0)", tc(bodies[0])?.thinkingBudget === 0, JSON.stringify(bodies[0]?.generationConfig));
  check("output cap gets 1024 tokens of headroom for hidden thinking (1500 -> 2524)", bodies[0]?.generationConfig?.maxOutputTokens === 2524, String(bodies[0]?.generationConfig?.maxOutputTokens));

  console.log("2. a stalled request is retried once, not failed");
  askLLM = fresh(); bodies = []; behave = (n) => (n === 1 ? "hang" : "ok");
  const t0 = Date.now();
  const a = await askLLM("hi");
  check("second attempt answers after the first times out", a === "mock answer" && bodies.length === 2, `${bodies.length} requests`);
  check("took about one timeout (5 s), not the old 60 s", Date.now() - t0 >= 4500 && Date.now() - t0 < 9000, `${Date.now() - t0} ms`);

  console.log("3. thinking setting rejected -> tries the other form -> then none");
  askLLM = fresh(); bodies = []; behave = (_n, b) => (tc(b)?.thinkingBudget === 0 ? "400thinking" : "ok");
  check("thinkingBudget rejected: resent with thinkingLevel 'minimal'", (await askLLM("hi")) === "mock answer" && bodies.length === 2 && tc(bodies[1])?.thinkingLevel === "minimal", JSON.stringify(bodies.map(tc)));
  askLLM = fresh(); bodies = []; behave = (_n, b) => (tc(b) ? "400thinking" : "ok");
  check("both rejected: resent with no thinking setting", (await askLLM("hi")) === "mock answer" && bodies.length === 3 && !tc(bodies[2]), JSON.stringify(bodies.map(tc)));
  bodies = []; behave = () => "ok";
  await askLLM("again");
  check("and the working form is remembered for later calls", bodies.length === 1 && !tc(bodies[0]));

  console.log("4. model ignores thinkingBudget (still reports thinking tokens)");
  askLLM = fresh(); bodies = []; behave = () => "ok";
  const origEnd = server.listeners("request")[0] as any;
  server.removeAllListeners("request");
  server.on("request", (req: any, res: any) => {
    const chunks: Buffer[] = []; req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); bodies.push(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(okBody(tc(body)?.thinkingBudget === 0 ? 16 : 0))); });
  });
  await askLLM("one"); await askLLM("two");
  check("first call sends thinkingBudget, the next one switches to thinkingLevel", tc(bodies[0])?.thinkingBudget === 0 && tc(bodies[1])?.thinkingLevel === "minimal", JSON.stringify(bodies.map(tc)));
  server.removeAllListeners("request"); server.on("request", origEnd);

  console.log("5. 429 still backs off and retries");
  askLLM = fresh(); bodies = []; behave = (n) => (n === 1 ? "429" : "ok");
  check("recovers on the retry", (await askLLM("hi")) === "mock answer" && bodies.length === 2);

  console.log("6. unreachable for both attempts");
  askLLM = fresh(); bodies = []; behave = () => "hang";
  let msg = "";
  try { await askLLM("hi"); } catch (e: any) { msg = e.message; }
  check("readable error, exactly two attempts", /did not answer in time/.test(msg) && bodies.length === 2, `${msg} / ${bodies.length}`);

  console.log("7. a 400 that is not about thinking shows Google's own reason");
  askLLM = fresh(); bodies = []; behave = () => "400other";
  let m400 = "";
  try { await askLLM("hi"); } catch (e: any) { m400 = e.message; }
  check("error text contains the reason from Google, not just 'status code 400'", /API key not valid/.test(m400) && /gemini-2.5-flash/.test(m400), m400);

  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
