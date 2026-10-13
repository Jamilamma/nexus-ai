import { askLLM, askLLMForJSON } from "./llmClient";
import { ITranscriptSegment } from "../../models/Transcript";

export interface TranslatedSegment {
  index: number; // index into the input array, so caller can map back
  detectedLanguage: string; // e.g. "English", "Tamil", "Hindi", "Arabic"
  translatedText: string;
}

/**
 * Translates a small batch of new transcript segments into the target
 * language, preserving meaning/context rather than translating word by
 * word, and detects the spoken language of each segment in the same
 * call (avoids a second LLM round-trip). Called on a timer/segment-count
 * trigger during a live session — NEVER per individual word or per
 * single segment — to control latency and LLM cost (see
 * services/realtime/sessionManager.ts for the batching trigger).
 */
export async function translateSegmentsBatch(
  segments: ITranscriptSegment[],
  targetLanguage: string
): Promise<TranslatedSegment[]> {
  if (segments.length === 0) return [];

  const numbered = segments.map((s, i) => `[${i}] (${s.speaker}): ${s.text}`).join("\n");

  const prompt = `For each numbered line below: (1) detect the spoken language, and (2) translate the meaning into ${targetLanguage} (preserving meaning/context — NOT word-by-word). If a line is already in ${targetLanguage}, still detect its language and set translatedText equal to the original text. Respond with JSON of this exact shape:
{ "translations": [ { "index": 0, "detectedLanguage": "English", "translatedText": "..." }, ... ] }

Lines:
${numbered}`;

  // 1000 tokens was cutting it close for a batch of 4 segments once
  // translated into a more verbose target language (e.g. Tamil/Hindi/Arabic
  // renderings routinely run longer than the English source), which could
  // truncate the JSON mid-object and drop the whole batch's translations.
  const result = await askLLMForJSON<{ translations: TranslatedSegment[] }>(prompt, { maxTokens: 1800 });
  return result.translations || [];
}

/**
 * Translates a single block of plain text (e.g. an "Ask NEXUS" answer)
 * into the target language, preserving meaning. Used sparingly — not on
 * transcript segments, which go through translateSegmentsBatch above.
 */
export async function translatePlainText(text: string, targetLanguage: string): Promise<string> {
  if (!text.trim()) return text;
  const prompt = `Translate the following text into ${targetLanguage}, preserving meaning and tone (not word-by-word). Respond with ONLY the translated text, nothing else.\n\nText:\n${text}`;
  const translated = await askLLM(prompt, { maxTokens: 800 });
  return translated.trim();
}

// ---------------------------------------------------------------------------------------------
// Reading-aid translation of FINALIZED transcript segments (never a correction of the original)
// ---------------------------------------------------------------------------------------------

/** Target languages the UI offers, and the ISO code the STT vendor uses for each. */
export const TRANSLATION_LANGUAGES: Record<string, string> = {
  English: "en",
  Tamil: "ta",
  Hindi: "hi",
  Arabic: "ar",
};

export function isSupportedTranslationLanguage(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRANSLATION_LANGUAGES, language);
}

/**
 * True when a segment was spoken ONLY in the target language, so there is nothing to translate.
 * A mixed segment (e.g. Tamil + English) still gets translated. Unknown language => translate.
 */
export function isAlreadyInLanguage(segment: Pick<ITranscriptSegment, "language" | "languages">, targetLanguage: string): boolean {
  const code = TRANSLATION_LANGUAGES[targetLanguage];
  if (!code) return false;
  const spoken = segment.languages && segment.languages.length > 0 ? segment.languages : segment.language ? [segment.language] : [];
  return spoken.length > 0 && spoken.every((l) => l.toLowerCase() === code);
}

export interface TranscriptTranslation {
  index: number; // index into the input array
  translatedText: string;
}

/**
 * Translates finalized segments into `targetLanguage` for reading. Differences from
 * translateSegmentsBatch (which the single-user live path still uses):
 *  - it does NOT ask the model to detect the language: the STT vendor's language label is the only
 *    source of truth for what was spoken, and translation must never overwrite it;
 *  - the prompt forbids correcting, completing or guessing: the input is raw recognizer output.
 * The caller stores the result in `segment.translations[targetLanguage]` and leaves `text` alone.
 */
export async function translateTranscriptSegments(
  segments: ITranscriptSegment[],
  targetLanguage: string
): Promise<TranscriptTranslation[]> {
  if (segments.length === 0) return [];
  if (!isSupportedTranslationLanguage(targetLanguage)) {
    throw new Error(`Unsupported translation language "${targetLanguage}".`);
  }

  const numbered = segments.map((s, i) => `[${i}] ${s.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
  const prompt = `Translate each numbered line of a meeting transcript into ${targetLanguage}, for someone who will read it next to the original.

The lines are raw speech-recognition output. They may mix languages (for example Tamil with English words, or Hindi with English) and may contain recognition mistakes.

Rules:
- Translate only what is written. Never add, infer, summarise or complete anything that is not in the line.
- Do not "fix" the line or guess what the speaker really meant. If a word or phrase is unclear, translate what is there as literally as is natural, and leave an unintelligible fragment unchanged.
- Keep names, numbers, dates, product names and technical terms unchanged.
- Convey the meaning naturally in ${targetLanguage}; do not translate word by word.
- If a line is already entirely in ${targetLanguage}, return it unchanged.
- Return exactly one entry per input line, using the same index.

Respond with JSON of this exact shape:
{ "translations": [ { "index": 0, "translatedText": "..." } ] }

Lines:
${numbered}`;

  const result = await askLLMForJSON<{ translations?: TranscriptTranslation[] }>(prompt, { maxTokens: 2500, temperature: 0.1 });
  const out: TranscriptTranslation[] = [];
  for (const t of result.translations ?? []) {
    if (!t || typeof t.index !== "number" || t.index < 0 || t.index >= segments.length) continue;
    if (typeof t.translatedText !== "string" || !t.translatedText.trim()) continue;
    out.push({ index: t.index, translatedText: t.translatedText.trim() });
  }
  return out;
}
