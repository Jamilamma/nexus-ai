import { askLLMForJSON } from "./llmClient";
import { MeetingIntelligenceResult } from "./meetingIntelligence";

export interface LiveInsightState {
  currentTopic: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: MeetingIntelligenceResult["actionItems"];
  questions: string[];
  risks: string[];
  importantDates: string[];
  runningSummary: string;
}

export function emptyLiveInsightState(): LiveInsightState {
  return {
    currentTopic: "",
    keyPoints: [],
    decisions: [],
    actionItems: [],
    questions: [],
    risks: [],
    importantDates: [],
    runningSummary: "",
  };
}

/**
 * Updates live insight state using ONLY the newest window of transcript
 * text plus the previous running summary — never the entire meeting
 * transcript. This keeps token usage (and therefore latency + cost)
 * roughly constant regardless of how long the meeting has been running.
 *
 * Called by the session manager on a timer/segment-count trigger (see
 * services/realtime/sessionManager.ts), not on every transcript event.
 */
export async function updateLiveInsights(
  previousState: LiveInsightState,
  newTranscriptWindow: string,
  mode: "business_meeting" | "general_meeting" | "live_class"
): Promise<LiveInsightState> {
  const modeInstruction =
    mode === "business_meeting"
      ? "Focus especially on decisions, action items (with owner/deadline when stated), risks, and follow-ups."
      : mode === "live_class"
      ? "Focus especially on topics, concepts, definitions, and points worth noting for study."
      : "Focus on a balanced summary, key points, and any questions raised.";

  const prompt = `You are maintaining a live, continuously-updating understanding of an ongoing meeting/class.

Previous running summary:
${previousState.runningSummary || "(meeting just started, no summary yet)"}

New transcript since the last update:
${newTranscriptWindow}

${modeInstruction}

Merge the new information into the existing understanding. Respond with JSON of this exact shape:
{
  "currentTopic": "one short phrase describing what is being discussed right now",
  "keyPoints": ["updated cumulative list of key points"],
  "decisions": ["updated cumulative list of decisions actually made"],
  "actionItems": [{ "task": "string", "owner": "string or 'Not specified'", "deadline": "string or 'Not specified'", "priority": "low|medium|high|not specified" }],
  "questions": ["updated cumulative list of unanswered questions"],
  "risks": ["updated cumulative list of risks discussed"],
  "importantDates": ["updated cumulative list of dates mentioned"],
  "runningSummary": "an updated 3-5 sentence summary of the whole meeting so far"
}

CRITICAL: Do not invent an owner or deadline that isn't explicitly stated. Use "Not specified" instead. Do not drop previously identified items unless the new transcript clearly contradicts them.`;

  return askLLMForJSON<LiveInsightState>(prompt, { maxTokens: 1500 });
}
