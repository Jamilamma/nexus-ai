import { Types } from "mongoose";
import { ITranscriptSegment } from "../../models/Transcript";
import { IActionItem } from "../../models/Summary";
import { askLLM } from "./llmClient";
import { answerFromRecording } from "../rag/retrieve";

/**
 * Dedicated "Ask NEXUS during a meeting" answer engine. This sits ON TOP of
 * the existing RAG pipeline rather than replacing it.
 *
 * Accuracy strategy (in order of preference):
 *  1. Deterministic routing for high-value question shapes — "what did I
 *     miss", "last N minutes", "what did <name> say", "what do I need to do"
 *     — grounded directly in the raw, per-speaker transcript.
 *  2. For everything else, if the whole transcript fits in the model's
 *     context budget, send THE WHOLE TRANSCRIPT. This is the most accurate
 *     option (no retrieval recall to miss anything) and needs no embeddings,
 *     so it works even when the meeting isn't RAG-indexed (live-only mode).
 *  3. Only for very long meetings: chunk-based RAG, falling back to the most
 *     recent part of the transcript if nothing has been indexed.
 */

export const NO_INFO_ANSWER = "I couldn't find that information in this meeting.";
export const UNCLEAR_ANSWER = "The meeting transcript doesn't make this completely clear.";

const MAX_CONTEXT_CHARS = 12000; // cap for filtered / windowed questions
// Gemini Flash has a very large context window; this bounds cost/latency, not capability.
// A typical 30-45 minute multi-person meeting is well below this.
const FULL_TRANSCRIPT_CHARS = 30000;

export interface MeetingQAParticipant {
  userId: string;
  displayName: string;
  joinedAt?: Date; // first time this user joined the meeting (wall clock)
}

export interface MeetingQAHistoryEntry {
  question: string;
  answer: string;
}

export interface MeetingQAParams {
  recordingId: Types.ObjectId;
  askerUserId: Types.ObjectId;
  askerDisplayName: string;
  question: string;
  /** Full chronological shared transcript for this meeting. */
  segments: ITranscriptSegment[];
  /** Wall-clock ms timestamp the meeting/recording started at. */
  meetingStartedAtMs: number;
  /** Every participant who has ever joined (used for name + join-time lookups). */
  participants: MeetingQAParticipant[];
  /** Known action items so far (from live insights, or the final Summary once ended). */
  actionItems: IActionItem[];
  /** Short recent Q&A history for THIS asker, most recent last (pronoun resolution). */
  history: MeetingQAHistoryEntry[];
}

export interface MeetingQAResult {
  answer: string;
  sources: { text: string; startTime: number; endTime: number; speaker: string }[];
}

export async function answerMeetingQuestion(params: MeetingQAParams): Promise<MeetingQAResult> {
  const rawQuestion = params.question.trim();
  if (!rawQuestion) return { answer: NO_INFO_ANSWER, sources: [] };

  // Resolve bare he/she/him/her/his against whoever was named most recently
  // in this asker's own conversation history, so follow-ups like "When does
  // he finish?" work without repeating the name. ("they/them/their" is NOT
  // rewritten: it usually means the group, and swapping in one person's
  // name would silently change the question.)
  const question = resolvePronouns(rawQuestion, params.history, params.participants);

  // --- 1. "What did I miss?" -------------------------------------------------
  if (isMissedQuestion(rawQuestion)) {
    return answerMissed(params);
  }

  // --- 2. Time-window questions ("last 10 minutes", "so far", "beginning") ---
  const window = detectTimeWindow(question, params);
  if (window) {
    return answerFromSegments(
      params,
      question,
      filterByTimeWindow(params.segments, window),
      `Answer using only the meeting discussion from ${window.label}.`
    );
  }

  // --- 3. Speaker-specific questions ("what did Rahul say", "what do I need to do") ---
  // Only route to a single speaker when the question really is about ONE
  // person: either exactly one participant is named, or the asker is asking
  // about their OWN statements/tasks ("what did I say", "my action items").
  // A stray "me"/"I" in an ordinary question ("can you tell me what was
  // decided?") must NOT narrow the answer to the asker's own lines.
  const named = findParticipantMentions(question, params.participants);
  let speaker: MeetingQAParticipant | null = null;
  if (named.length === 1) {
    speaker = named[0];
  } else if (named.length === 0 && isSelfOwnQuestion(rawQuestion)) {
    speaker = params.participants.find((p) => p.userId === params.askerUserId.toString()) ?? null;
  }

  if (speaker) {
    const speakerSegments = params.segments.filter(
      (s) => (s.participantId && s.participantId === speaker!.userId) || s.speaker === speaker!.displayName
    );
    // Never invent a statement for someone who hasn't spoken, and never call the LLM for it.
    if (speakerSegments.length === 0) return { answer: NO_INFO_ANSWER, sources: [] };

    const ownedItems = params.actionItems.filter((a) => matchesName(a.owner, speaker!.displayName));
    const instruction = `Answer about ${speaker.displayName} using only what ${speaker.displayName} actually said in the meeting${
      ownedItems.length > 0
        ? `, plus these action items already recorded as assigned to ${speaker.displayName}: ${ownedItems
            .map((a) => `"${a.task}"${a.deadline !== "Not specified" ? ` (deadline: ${a.deadline})` : ""}`)
            .join("; ")}.`
        : "."
    } Never attribute another participant's words to ${speaker.displayName}.`;

    // If the whole meeting fits, give the model ALL of it (so replies like
    // "did anyone respond to Rahul's idea?" still work) and let the speaker
    // tags do the attribution; only filter to this speaker's own lines when
    // the transcript is too long to send whole.
    const useFull = totalChars(params.segments) <= FULL_TRANSCRIPT_CHARS;
    return answerFromSegments(
      params,
      question,
      useFull ? params.segments : speakerSegments,
      instruction,
      useFull ? FULL_TRANSCRIPT_CHARS : MAX_CONTEXT_CHARS,
      speakerSegments
    );
  }

  if (params.segments.length === 0) return { answer: NO_INFO_ANSWER, sources: [] };

  // --- 4a. General question, transcript fits: ground in the WHOLE transcript ---
  if (totalChars(params.segments) <= FULL_TRANSCRIPT_CHARS) {
    return answerFromSegments(
      params,
      question,
      params.segments,
      "Answer using the full meeting transcript below.",
      FULL_TRANSCRIPT_CHARS
    );
  }

  // --- 4b. Very long meeting: chunk-based RAG, else the most recent part ---
  try {
    const ragResult = await answerFromRecording(question, params.askerUserId, params.recordingId, 5, true);
    if (ragResult.sources.length > 0) {
      return { answer: enforceRefusalWording(ragResult.answer), sources: ragResult.sources };
    }
  } catch {
    /* not indexed / embeddings unavailable: fall through to recency-based grounding */
  }
  return answerFromSegments(
    params,
    question,
    params.segments,
    "Answer using the most recent part of the meeting transcript below (earlier discussion may be cut off).",
    FULL_TRANSCRIPT_CHARS
  );
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

function isMissedQuestion(q: string): boolean {
  return /what\s+(did|have)\s+i\s+miss|missed\s+(any|the)?\s*(discussion|meeting|conversation)|catch\s+me\s+up/i.test(
    q
  );
}

/** The asker is asking about their OWN statements / commitments / tasks. */
function isSelfOwnQuestion(q: string): boolean {
  return (
    /\bwhat\s+(did|have)\s+i\s+(say|said|mention|promise|commit|agree|suggest|propose)/i.test(q) ||
    /\bmy\s+(action\s*items?|tasks?|to-?dos?|responsibilit\w*|deadlines?|part|points?|contributions?|commitments?)/i.test(q) ||
    /\bwhat\s+(do|should|must|am|will)\s+i\s+(need|have|supposed|to|do)\b/i.test(q) ||
    /\bassigned\s+to\s+me\b/i.test(q) ||
    /\bi\s+(need|have|must)\s+to\s+do\b/i.test(q)
  );
}

interface TimeWindow {
  fromSeconds: number; // inclusive, relative to meeting start
  toSeconds: number; // inclusive, relative to meeting start
  label: string;
}

function detectTimeWindow(q: string, params: MeetingQAParams): TimeWindow | null {
  const nowSeconds = (Date.now() - params.meetingStartedAtMs) / 1000;

  const lastNMinutes = q.match(/last\s+(\d+)\s*(minute|minutes|min|mins)\b/i);
  if (lastNMinutes) {
    const n = parseInt(lastNMinutes[1], 10);
    return { fromSeconds: Math.max(0, nowSeconds - n * 60), toSeconds: nowSeconds, label: `the last ${n} minutes` };
  }

  if (/\b(so far|until now|up to now|so far today|as of now)\b/i.test(q)) {
    return { fromSeconds: 0, toSeconds: nowSeconds, label: "the meeting so far" };
  }

  if (/\b(beginning|start of the meeting|when the meeting started|earlier on)\b/i.test(q)) {
    const window = Math.min(300, nowSeconds / 2);
    return { fromSeconds: 0, toSeconds: window, label: "the beginning of the meeting" };
  }

  return null;
}

function filterByTimeWindow(segments: ITranscriptSegment[], window: TimeWindow): ITranscriptSegment[] {
  return segments.filter((s) => s.startTime >= window.fromSeconds && s.startTime <= window.toSeconds);
}

// ---------------------------------------------------------------------------
// Pronoun / name resolution
// ---------------------------------------------------------------------------

function resolvePronouns(
  question: string,
  history: MeetingQAHistoryEntry[],
  participants: MeetingQAParticipant[]
): string {
  if (!/\b(he|she|him|her|his|hers)\b/i.test(question)) return question;

  for (let i = history.length - 1; i >= 0; i--) {
    const text = `${history[i].answer} ${history[i].question}`;
    const found = participants.find((p) => new RegExp(`\\b${escapeRegex(p.displayName)}\\b`, "i").test(text));
    if (found) {
      return question.replace(/\b(he|she|him|her|his|hers)\b/gi, found.displayName);
    }
  }
  return question;
}

/**
 * Every participant whose display name appears in the question. If one name
 * is contained in another ("Sarah" inside "Sarah Jane") only the longer
 * match is kept, so "Sarah Jane" doesn't count as two people.
 */
function findParticipantMentions(question: string, participants: MeetingQAParticipant[]): MeetingQAParticipant[] {
  const matches = participants.filter((p) => new RegExp(`\\b${escapeRegex(p.displayName)}\\b`, "i").test(question));
  return matches.filter(
    (m) =>
      !matches.some(
        (o) => o !== m && o.displayName.length > m.displayName.length && o.displayName.toLowerCase().includes(m.displayName.toLowerCase())
      )
  );
}

function matchesName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Grounded answering
// ---------------------------------------------------------------------------

async function answerMissed(params: MeetingQAParams): Promise<MeetingQAResult> {
  const asker = params.participants.find((p) => p.userId === params.askerUserId.toString());
  if (!asker?.joinedAt) {
    return { answer: NO_INFO_ANSWER, sources: [] };
  }

  const joinedAtSeconds = (asker.joinedAt.getTime() - params.meetingStartedAtMs) / 1000;
  const missedSegments = params.segments.filter((s) => s.endTime <= joinedAtSeconds);

  if (missedSegments.length === 0) {
    return { answer: "You haven't missed any discussion.", sources: [] };
  }

  return answerFromSegments(
    params,
    "Summarize what was discussed and decided before this participant joined, as a short bulleted list of what they missed.",
    missedSegments,
    "Summarize only what's in the transcript excerpt below into a few concise bullet points (decisions, who took what, deadlines). If genuinely nothing substantive happened, say so plainly."
  );
}

async function answerFromSegments(
  params: MeetingQAParams,
  question: string,
  segments: ITranscriptSegment[],
  instruction: string,
  maxContextChars: number = MAX_CONTEXT_CHARS,
  sourceSegments?: ITranscriptSegment[]
): Promise<MeetingQAResult> {
  if (segments.length === 0) {
    return { answer: NO_INFO_ANSWER, sources: [] };
  }

  const context = buildContext(segments, maxContextChars);
  const historyBlock =
    params.history.length > 0
      ? `Recent conversation with this user (for context only, do not treat as meeting evidence):\n${params.history
          .slice(-4)
          .map((h) => `Q: ${h.question}\nA: ${h.answer}`)
          .join("\n")}\n\n`
      : "";

  const prompt = `${historyBlock}${instruction}

The person asking is "${params.askerDisplayName}". When the question says "I", "me" or "my", it means ${params.askerDisplayName}.
Participants in this meeting: ${params.participants.map((p) => p.displayName).join(", ") || "unknown"}.

Transcript (chronological, "[mm:ss] Speaker: text"). The speaker name on each line is authoritative — it comes from that participant's own microphone:
${context}

Question: ${question}

Rules:
- Answer using ONLY the transcript above.
- If the transcript doesn't actually contain the answer, respond with exactly: "${NO_INFO_ANSWER}"
- If it's only partially clear, say so using wording like: "${UNCLEAR_ANSWER}"
- Never invent names, numbers, deadlines, or statements not present in the transcript.
- The transcript is raw speech-recognition output in its original spoken language(s) and a line may mix languages. A line marked "(low-confidence recognition)" may contain wrongly recognized words: don't state names, numbers or dates from such a line as certain; say it is unclear (using the wording above).
- Never attribute one speaker's words to another speaker.
- Where relevant, cite who said it and when, like "(Rahul — 10:04)".
- Keep the answer concise and direct.`;

  const answer = enforceRefusalWording(await askLLM(prompt, { maxTokens: 800 }));

  // A refusal has no supporting lines; showing "sources" under it would be misleading.
  if (answer === NO_INFO_ANSWER) return { answer, sources: [] };

  const basis = sourceSegments && sourceSegments.length > 0 ? sourceSegments : segments;
  const sources = basis.slice(-5).map((s) => ({
    text: s.text.slice(0, 300),
    startTime: s.startTime,
    endTime: s.endTime,
    speaker: s.speaker,
  }));

  return { answer, sources };
}

function totalChars(segments: ITranscriptSegment[]): number {
  let total = 0;
  for (const s of segments) total += s.text.length + s.speaker.length + 10;
  return total;
}

function buildContext(segments: ITranscriptSegment[], maxChars: number = MAX_CONTEXT_CHARS): string {
  // ORIGINAL recognized text only (never a translation); unsure lines are marked so they aren't treated as solid evidence.
  const lines = segments.map((s) => `[${formatTime(s.startTime)}] ${s.speaker}: ${s.text}${s.lowConfidence ? " (low-confidence recognition)" : ""}`);
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;

  // Bound cost on unusually long windows: keep the most recent portion,
  // which is what "what happened" / "what did X say" questions almost
  // always care about most, and note the truncation rather than silently
  // dropping context.
  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxChars) break;
    kept.unshift(lines[i]);
  }
  return `[earlier discussion truncated for length]\n${kept.join("\n")}`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.floor(Math.max(0, seconds) % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Best-effort normalization: if the model paraphrased a refusal instead of using our exact wording, leave it — but catch the common near-miss cases so tests relying on exact strings still pass. */
function enforceRefusalWording(answer: string): string {
  const trimmed = answer.trim();
  if (/^(i (don't|do not) know|no information|not (mentioned|found|available))/i.test(trimmed) && trimmed.length < 60) {
    return NO_INFO_ANSWER;
  }
  return trimmed;
}