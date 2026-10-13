/**
 * Lists the Gemini models YOUR api key can actually use (names to put in LLM_MODEL).
 *   cd server
 *   npx ts-node --transpile-only scripts/verify/llmModels.ts
 */
import axios from "axios";
import { env } from "../../src/config/env";

(async () => {
  const base = (process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  if (!env.llmApiKey) { console.log("LLM_API_KEY is not set in server/.env"); process.exit(1); }
  try {
    const models: any[] = [];
    let pageToken = "";
    do {
      const r = await axios.get(`${base}/v1beta/models`, { headers: { "x-goog-api-key": env.llmApiKey }, params: { pageSize: 200, ...(pageToken ? { pageToken } : {}) }, timeout: 20000 });
      models.push(...(r.data?.models ?? []));
      pageToken = r.data?.nextPageToken || "";
    } while (pageToken);
    const usable = models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
    console.log(`${usable.length} models support generateContent for this key. Flash-type ones (use the name WITHOUT "models/"):\n`);
    for (const m of usable.filter((x) => /flash/i.test(x.name))) {
      console.log(`  ${String(m.name).replace(/^models\//, "").padEnd(42)} out-limit ${m.outputTokenLimit ?? "?"}   ${m.displayName ?? ""}`);
    }
    console.log(`\nCurrently in .env: LLM_MODEL=${env.llmModel || "(not set -> gemini-flash-latest)"}`);
  } catch (e: any) {
    console.log(`FAILED: ${e?.response?.status ?? e?.code ?? ""} ${e?.response?.data?.error?.message ?? e?.message}`);
  }
  process.exit(0);
})();
