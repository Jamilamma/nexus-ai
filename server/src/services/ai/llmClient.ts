import axios from "axios";
import { env } from "../../config/env";

/**
 * Provider-agnostic LLM client.
 *
 * Everything else in the codebase calls `askLLM()` / `askLLMForJSON()` —
 * never a provider SDK directly. To swap providers, only this file needs
 * to change.
 *
 * Currently wired to Google's Gemini API (generativelanguage.googleapis.com),
 * which has a genuinely free tier — get a key at https://aistudio.google.com/apikey
 * (no credit card required). Set LLM_MODEL in server/.env to a free-tier
 * model such as "gemini-2.5-flash".
 */

interface AskOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini's free tier has a low requests-per-minute quota, and this app can
// burst several calls close together (translation batches, live insights,
// summarization) especially once more than one participant is active — so
// 429 ("rate limited") responses are expected occasionally, not a sign of
// something broken. Retrying with backoff instead of surfacing the raw
// "status code 429" to the user smooths over exactly that.
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;

// A request that never gets an answer (stalled connection, overloaded machine) is retried ONCE on a fresh
// connection instead of making the user wait the full timeout and then fail. Tunable via server/.env:
//   LLM_TIMEOUT_MS      per-attempt timeout, default 28000 (two attempts must finish inside the browser's 60 s wait)
//   LLM_THINKING        "off" (default) = ask Gemini Flash models not to spend time "thinking" (much faster answers
//                       for summaries / Q&A); "auto" = leave the model's default behaviour
//   LLM_BASE_URL        override the API host (only for tests / proxies)
const REQUEST_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.LLM_TIMEOUT_MS || "28000", 10) || 28_000);
const MAX_NETWORK_RETRIES = 1;
const THINKING_OFF = (process.env.LLM_THINKING || "off").toLowerCase() !== "auto";
const BASE_URL = (process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");

// Newer Gemini models count their hidden "thinking" tokens against maxOutputTokens, so a small cap can be used up
// before any answer text is written (empty reply, finishReason MAX_TOKENS). This headroom is added to every cap;
// it does not make answers longer, the prompt still controls that.
const THINKING_HEADROOM_TOKENS = 1024;

// How we ask the model to think less. Older Flash models take { thinkingBudget: 0 }; newer ones take
// { thinkingLevel: "minimal" }. We try the first, move to the second if the first is rejected or ignored,
// and stop sending anything if neither is accepted.
type ThinkingMode = "budget" | "level" | "none";
let thinkingMode: ThinkingMode = "budget";

function thinkingConfigFor(mode: ThinkingMode): Record<string, unknown> | undefined {
  if (mode === "budget") return { thinkingBudget: 0 };
  if (mode === "level") return { thinkingLevel: "minimal" };
  return undefined;
}

function supportsThinkingOff(model: string): boolean {
  // Gemini 2.5 Pro cannot disable thinking; Flash / Flash-Lite can.
  return /flash/i.test(model) && !/pro/i.test(model);
}

function isNetworkFailure(err: any): boolean {
  if (err?.response) return false;
  const code = err?.code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN" || code === "ENOTFOUND" || /timeout/i.test(err?.message || "");
}

export async function askLLM(userPrompt: string, options: AskOptions = {}): Promise<string> {
  if (!env.llmApiKey) {
    throw new Error(
      "LLM_API_KEY is not set. Add your Gemini API key (from https://aistudio.google.com/apikey) to server/.env to enable AI features."
    );
  }

  const model = env.llmModel || "gemini-flash-latest";
  const startedAt = Date.now();

  let lastErr: any;
  let networkRetries = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const mode: ThinkingMode = THINKING_OFF && supportsThinkingOff(model) ? thinkingMode : "none";
    const thinkingConfig = thinkingConfigFor(mode);
    try {
      const response = await axios.post(
        `${BASE_URL}/v1beta/models/${model}:generateContent`,
        {
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          ...(options.system
            ? { systemInstruction: { parts: [{ text: options.system }] } }
            : {}),
          generationConfig: {
            temperature: options.temperature ?? 0.3,
            maxOutputTokens: (options.maxTokens ?? 1500) + THINKING_HEADROOM_TOKENS,
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        },
        {
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": env.llmApiKey,
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );

      const candidate = response.data?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .map((p: any) => p.text ?? "")
        .join("\n")
        .trim();

      if (!text) {
        throw new Error(
          `Gemini returned no text. finishReason: ${candidate?.finishReason ?? "unknown"}. ` +
            `Raw response: ${JSON.stringify(response.data).slice(0, 500)}`
        );
      }

      // We asked for no thinking but the model thought anyway: that setting is ignored by this model, try the other one.
      if (mode === "budget" && (response.data?.usageMetadata?.thoughtsTokenCount ?? 0) > 0) {
        thinkingMode = "level";
        console.warn(`[llm] ${model} ignored thinkingBudget; trying thinkingLevel from now on`);
      }

      // One line per call so a slow answer can be diagnosed from the server log instead of guessed at.
      console.log(`[llm] ${model} ok in ${Date.now() - startedAt} ms (prompt ${userPrompt.length} chars, answer ${text.length} chars${attempt > 0 ? `, attempt ${attempt + 1}` : ""})`);
      return text;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;

      // The model/API version doesn't know this "thinking" setting: move to the next option and resend (not counted as a retry).
      if (status === 400 && mode !== "none" && /thinking|thought|budget/i.test(JSON.stringify(err?.response?.data ?? ""))) {
        thinkingMode = mode === "budget" ? "level" : "none";
        console.warn(`[llm] ${model} rejected the "${mode}" thinking setting; ${thinkingMode === "none" ? "sending requests without it from now on" : "trying the other one"}`);
        attempt -= 1;
        continue;
      }

      // Stalled / timed-out connection: try once more on a new connection straight away.
      if (isNetworkFailure(err) && networkRetries < MAX_NETWORK_RETRIES) {
        networkRetries += 1;
        console.warn(`[llm] ${model} no answer within ${REQUEST_TIMEOUT_MS} ms (${err?.code || err?.message}); retrying once`);
        attempt -= 1;
        continue;
      }

      const isRetryable = status === 429 || status === 500 || status === 503;
      if (!isRetryable || attempt === MAX_RETRIES) break;

      // Respect the server's Retry-After header when it sends one,
      // otherwise back off exponentially with a little jitter.
      const retryAfterHeader = err?.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      const backoffMs = retryAfterMs || BASE_DELAY_MS * 2 ** attempt + Math.random() * 300;
      await sleep(backoffMs);
    }
  }

  const status = lastErr?.response?.status;
  // Google explains what is wrong in the response body ("model not found", "API key not valid", ...).
  // Without this the log only said "status code 400".
  const apiMessage: string | undefined = lastErr?.response?.data?.error?.message;
  console.error(`[llm] ${model} failed after ${Date.now() - startedAt} ms: ${status ?? lastErr?.code ?? lastErr?.message}${apiMessage ? ` - ${apiMessage}` : ""}`);
  if (status === 429) {
    throw new Error(
      "The AI provider is rate-limiting this app right now (Gemini free-tier quota). Retried automatically and still hit the limit — try again in a moment, or use an API key with a higher quota."
    );
  }
  if (isNetworkFailure(lastErr)) {
    throw new Error(
      `The AI service did not answer in time (tried twice, ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s each). Check your internet connection; if this only happens during a call, close other heavy programs and try again.`
    );
  }
  if (apiMessage) {
    throw new Error(`Gemini error ${status} (model "${model}"): ${apiMessage}`);
  }
  throw lastErr;
}

/**
 * Ask the LLM for a JSON-shaped answer. Strips markdown code fences and
 * throws a descriptive error if parsing fails, instead of silently
 * returning garbage to the caller.
 */
export async function askLLMForJSON<T = any>(
  userPrompt: string,
  options: AskOptions = {}
): Promise<T> {
  const system =
    (options.system ? options.system + "\n\n" : "") +
    "You must respond with ONLY valid JSON. No markdown code fences, no preamble, no explanation.";

  const raw = await askLLM(userPrompt, { ...options, system });
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new Error(`LLM did not return valid JSON. Raw response: ${cleaned.slice(0, 500)}`);
  }
}