import { askLLM, askLLMForJSON } from "./llmClient";
import { chunkTranscriptText } from "./chunking";

export interface SummaryResult {
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  topics: string[];
}

// Gemini Flash's context window is far larger than this — the cap here
// exists only to bound cost/latency on very long recordings, not because
// the model can't fit more. Keeping it too tight forces ordinary
// 45-90 minute multi-participant meetings through the lossy map-reduce
// path below more often than necessary, which is the main reason
// multi-speaker meetings were losing "who said what" accuracy.
const MAX_SINGLE_PASS_CHARS = 60000;

const TRANSCRIPT_NOTE =
  "The transcript is raw speech-recognition output in its ORIGINAL spoken language(s); one line may mix languages (for example Tamil with English words, or Hindi with English). Keep names and terms as written. " +
  'A line ending in "(low-confidence recognition)" may contain wrongly recognized words: never base a decision, name, number, date or action item on such a line alone, and do not guess what it meant.';

/**
 * Summarizes a transcript. For long transcripts, uses a map-reduce
 * strategy: summarize each chunk first, then summarize the summaries.
 * This keeps token usage and cost bounded regardless of recording length.
 *
 * fullText is expected in "[Speaker]: text" line-per-turn form (this is
 * how meetingManager/sessionManager persist Transcript.fullText).
 */
export async function summarizeTranscript(fullText: string, language = "English"): Promise<SummaryResult> {
  let workingText = fullText;

  if (fullText.length > MAX_SINGLE_PASS_CHARS) {
    // Line-boundary chunking (never cuts a "[Speaker]: ..." line in half —
    // see chunkTranscriptText's doc comment) instead of chunkPlainText's
    // blind character slicing, which was silently dropping/garbling
    // speaker attribution for whichever line happened to straddle a
    // chunk boundary — more likely the more participants/turns a meeting
    // has.
    const chunks = chunkTranscriptText(fullText, 8000);
    const partials: string[] = [];
    for (const chunk of chunks) {
      const partial = await askLLM(
        `This is one portion of a longer multi-speaker meeting transcript, formatted as "[Speaker]: text" per line. ` +
          `Summarize it in 3-5 sentences, preserving concrete facts, names, and numbers. ` +
          `Critically, keep every point attributed to the exact speaker name who said it (e.g. "Priya proposed...", "Arun disagreed...") — never merge different speakers' points together or drop the names:\n\n${chunk}`,
        { maxTokens: 500 }
      );
      partials.push(partial);
    }
    workingText = partials.join("\n\n");
  }

  const prompt = `You are analyzing a meeting/lecture transcript. It may include multiple speakers, each line tagged with the speaker's name. Attribute decisions, statements, and points to the correct speaker by name wherever the transcript makes that clear — do not blend different speakers' contributions together. Produce a JSON object with this exact shape:
{
  "shortSummary": "2-3 sentence summary",
  "detailedSummary": "a thorough multi-paragraph summary covering everything important, attributing points to speakers by name where relevant",
  "keyPoints": ["array of concise key points"],
  "topics": ["array of short topic labels"]
}

Respond in ${language}. Do not invent information that isn't in the transcript. ${TRANSCRIPT_NOTE}

Transcript:
${workingText}`;

  return askLLMForJSON<SummaryResult>(prompt, { maxTokens: 4000 });
}
