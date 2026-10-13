/**
 * Quick real-world check of the Gemini connection from THIS machine (uses your server/.env key).
 * Run it twice: once with nothing else going on, once while a meeting with Whisper is running, and compare.
 *   cd server
 *   npx ts-node --transpile-only scripts/verify/llmPing.ts
 */
import { env } from "../../src/config/env";
import { askLLM } from "../../src/services/ai/llmClient";

(async () => {
  console.log(`model: ${env.llmModel || "gemini-flash-latest"}  key set: ${env.llmApiKey ? "yes" : "NO"}`);
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    try {
      const a = await askLLM("Reply with the single word OK.", { maxTokens: 20 });
      console.log(`call ${i}: ${Date.now() - t0} ms -> ${a}`);
    } catch (e: any) {
      console.log(`call ${i}: FAILED after ${Date.now() - t0} ms -> ${e.message}`);
    }
  }
  process.exit(0);
})();
