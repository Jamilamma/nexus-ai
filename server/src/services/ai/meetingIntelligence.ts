import { askLLMForJSON } from "./llmClient";
import { IActionItem } from "../../models/Summary";

export interface MeetingIntelligenceResult {
  decisions: string[];
  actionItems: IActionItem[];
  questions: string[];
  risks: string[];
  followUps: string[];
  importantDates: string[];
}

/**
 * Extracts structured meeting intelligence from a transcript.
 * Critical rule: never invent an owner, deadline, or fact that isn't
 * explicitly present in the transcript — use "Not specified" instead.
 */
export async function extractMeetingIntelligence(
  fullText: string,
  language = "English"
): Promise<MeetingIntelligenceResult> {
  const prompt = `Analyze this meeting transcript and extract structured information as JSON with this exact shape:
{
  "decisions": ["decisions actually made in the meeting"],
  "actionItems": [
    { "task": "string", "owner": "string or 'Not specified'", "deadline": "string or 'Not specified'", "priority": "low|medium|high|not specified" }
  ],
  "questions": ["questions raised but not answered"],
  "risks": ["potential problems or risks discussed"],
  "followUps": ["topics requiring future discussion"],
  "importantDates": ["dates explicitly mentioned"]
}

CRITICAL RULES:
- Do NOT invent an owner or deadline that isn't explicitly stated. Use "Not specified" instead.
- Only include information that is actually present in the transcript.
- Respond in ${language}.
- The transcript is raw speech-recognition output in its ORIGINAL spoken language(s); a line may mix languages (e.g. Tamil with English words). A line ending in "(low-confidence recognition)" may contain wrongly recognized words: never base a decision, owner, deadline, date or action item on such a line alone.

Transcript:
${fullText}`;

  // Meetings with more participants tend to produce more decisions/action
  // items/questions, so the JSON response is naturally longer. The default
  // 1500-token output cap was tight enough that a busy multi-participant
  // meeting could get its JSON cut off mid-object, which throws (invalid
  // JSON) and fails analysis for the whole recording, not just this call.
  return askLLMForJSON<MeetingIntelligenceResult>(prompt, { maxTokens: 3000 });
}
