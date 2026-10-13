import { askLLM } from "./llmClient";

export type RewriteMode =
  | "correct_grammar"
  | "make_natural"
  | "make_professional"
  | "make_concise"
  | "simplify"
  | "explain"
  | "summarize";

const MODE_INSTRUCTIONS: Record<RewriteMode, string> = {
  correct_grammar: "Correct all grammatical mistakes in the text without changing its meaning or tone.",
  make_natural: "Rewrite the text so it reads naturally and fluently, removing filler words like 'um', 'uh', 'actually', 'basically', while preserving meaning.",
  make_professional: "Rewrite the text in clear, professional English (or the target language) suitable for a workplace, preserving the original meaning.",
  make_concise: "Rewrite the text to be as concise as possible while keeping all essential meaning.",
  simplify: "Rewrite the text using simple, easy-to-understand language.",
  explain: "Explain what this text means in plain, simple terms.",
  summarize: "Summarize the text in 2-3 sentences.",
};

export async function rewriteText(text: string, mode: RewriteMode): Promise<string> {
  const instruction = MODE_INSTRUCTIONS[mode];
  if (!instruction) throw new Error(`Unknown rewrite mode: ${mode}`);

  return askLLM(
    `${instruction}\n\nDo not add commentary, only output the rewritten text.\n\nText:\n${text}`
  );
}

export async function correctGrammar(text: string): Promise<string> {
  return rewriteText(text, "correct_grammar");
}

export async function translateText(text: string, targetLanguage: string): Promise<string> {
  return askLLM(
    `Translate the following text into ${targetLanguage}. Preserve the original meaning as closely as possible. Only output the translation, nothing else.\n\nText:\n${text}`
  );
}
