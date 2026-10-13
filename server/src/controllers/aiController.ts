import { Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { rewriteText, translateText, RewriteMode } from "../services/ai/rewrite";

const VALID_MODES: RewriteMode[] = [
  "correct_grammar",
  "make_natural",
  "make_professional",
  "make_concise",
  "simplify",
  "explain",
  "summarize",
];

export async function rewrite(req: AuthedRequest, res: Response) {
  const { text, mode } = req.body;
  if (!text) return res.status(400).json({ error: "text is required." });
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(", ")}` });
  }

  const result = await rewriteText(text, mode);
  res.json({ original: text, result, mode });
}

export async function translate(req: AuthedRequest, res: Response) {
  const { text, targetLanguage } = req.body;
  if (!text || !targetLanguage) {
    return res.status(400).json({ error: "text and targetLanguage are required." });
  }

  const result = await translateText(text, targetLanguage);
  res.json({ original: text, result, targetLanguage });
}
