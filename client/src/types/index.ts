export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

export type RecordingStatus =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "analyzing"
  | "ready"
  | "failed";

export interface Recording {
  _id: string;
  userId: string;
  title: string;
  type: "meeting" | "lecture" | "interview" | "other";
  fileUrl: string;
  originalFileName: string;
  mimeType: string;
  language: string;
  status: RecordingStatus;
  errorMessage?: string;
  createdAt: string;
}

export interface TranscriptSegment {
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
}

export interface Transcript {
  _id: string;
  recordingId: string;
  language: string;
  fullText: string;
  segments: TranscriptSegment[];
}

export interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  priority: string;
}

export interface Summary {
  _id: string;
  recordingId: string;
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  questions: string[];
  risks: string[];
  followUps: string[];
  importantDates: string[];
  topics: string[];
}

export interface LearningContent {
  _id: string;
  notes: string;
  importantConcepts: string[];
  definitions: { term: string; definition: string }[];
  flashcards: { question: string; answer: string }[];
  quiz: { question: string; options: string[]; correctIndex: number }[];
  examQuestions: {
    twoMark: string[];
    fiveMark: string[];
    longAnswer: string[];
    viva: string[];
  };
}

export interface InterviewTurn {
  question: string;
  answer: string;
  scores?: { technical: number; communication: number; grammar: number; clarity: number };
  fillerWordCount?: number;
  feedback?: string;
  improvedAnswer?: string;
}

export interface Interview {
  _id: string;
  role: string;
  difficulty: string;
  turns: InterviewTurn[];
  overallScore?: number;
  strongAreas?: string[];
  weakAreas?: string[];
  preparationPlan?: string;
  status: "in_progress" | "completed";
  createdAt: string;
}

export interface DashboardStats {
  totalRecordings: number;
  recordingsByType: { _id: string; count: number }[];
  totalInterviews: number;
  completedInterviews: number;
  avgInterviewScore: number | null;
  totalActionItems: number;
  topTopics: { topic: string; count: number }[];
  recentRecordings: Recording[];
}

export type LiveSessionMode = "business_meeting" | "general_meeting" | "live_class";

export interface LiveTranscriptSegment {
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
  translatedText?: string;
  detectedLanguage?: string;
}

export interface LiveInsightState {
  currentTopic: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  questions: string[];
  risks: string[];
  importantDates: string[];
  runningSummary: string;
}

export interface LiveChatEntry {
  question: string;
  answer: string;
}

// ---- Phase 2: shared multi-participant meetings ----

export const SUPPORTED_MEETING_LANGUAGES = ["English", "Tamil", "Hindi", "Arabic"] as const;
export type MeetingLanguage = (typeof SUPPORTED_MEETING_LANGUAGES)[number];

export interface MeetingParticipant {
  userId: string;
  displayName: string;
  // The language this participant wants the transcript translated into for
  // their own reading. Whatever language they actually speak is
  // auto-detected server-side — nobody needs to declare it.
  preferredLanguage: string;
  role: "host" | "participant";
}

export interface MeetingPreview {
  meetingId: string;
  title: string;
  host: string;
  status: "scheduled" | "active" | "ended";
  supportedLanguages: string[];
  defaultLanguage: string;
  participantCount: number;
  maxParticipants: number;
  videoConfigured: boolean;
  hasReport: boolean;
}

export type MeetingStatus = "scheduled" | "active" | "ended";

export interface MeetingChatMessage {
  id: string;
  userId: string;
  displayName: string;
  text: string;
  sentAt: string;
}

export interface MeetingListItem {
  meetingId: string;
  title: string;
  status: "scheduled" | "active" | "ended";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  participantCount: number;
  summaryStatus: string;
  recordingId?: string;
  isHost: boolean;
}

export interface MeetingTranscriptSegment {
  speaker: string;
  participantId?: string;
  // Stable id for this segment — see server/src/models/Transcript.ts. Used to
  // match up a later translation update with the right line, instead of a
  // positional array index (which can't be trusted once multiple
  // participants' streams are being merged into one chronological list).
  segmentId?: string;
  startTime: number;
  endTime: number;
  text: string;
  translatedText?: string;
  language?: string;
}

// ---- Phase 2: participant-aware live transcript ----
/** A finalized transcript line. participantId is the LiveKit identity (== NEXUS userId); never guessed. */
export interface MeetingTranscriptSegment2 {
  segmentId?: string;
  meetingId?: string;
  participantId?: string;
  speaker: string; // participant display name
  text: string; // ORIGINAL recognized text; never replaced by a translation
  language?: string; // dominant spoken language as reported by the recognizer (ISO code, e.g. "ta")
  languages?: string[]; // every language heard in this line (code-switching), dominant first
  languageConfidence?: number;
  confidence?: number; // mean recognizer confidence 0..1
  /** The recognizer was unsure of this line, so it may contain wrong words. */
  lowConfidence?: boolean;
  /** Reading-aid translations of `text`, keyed by language name ("English" | "Tamil" | "Hindi" | "Arabic"). */
  translations?: Record<string, string>;
  timestamp?: string; // ISO wall-clock start
  startTime: number;
  endTime: number;
}

/** Interim text for one participant currently speaking; replaced by the final segment. */
export interface MeetingTranscriptPartial {
  meetingId: string;
  participantId: string;
  participantName: string;
  text: string;
  timestamp: string;
}

export interface MyMeetingReport {
  whatISaid: MeetingTranscriptSegment[];
  myActionItems: ActionItem[];
  decisions: string[];
  importantPoints: string[];
}

export interface MeetingReport {
  meeting: {
    meetingId: string;
    title: string;
    status: string;
    startedAt?: string;
    endedAt?: string;
    participants: MeetingParticipant[];
    isHost: boolean;
  };
  recordingStatus?: string;
  transcript: { fullText: string; segments: MeetingTranscriptSegment[] } | null;
  summary: Summary | null;
  myReport: MyMeetingReport | null;
}

// ---- NEXUS AI inside a live meeting (Summary + Ask NEXUS) ----

/** On-demand summary of the meeting so far, built from the speaker-tagged transcript. */
export interface MeetingLiveSummary {
  meetingId: string;
  generatedAt: string; // ISO
  language: string;
  segmentCount: number; // transcript lines this summary is based on
  speakers: string[]; // who has actually spoken so far
  shortSummary: string;
  detailedSummary: string;
  keyPoints: string[];
  topics: string[];
  decisions: string[];
  actionItems: ActionItem[];
  questions: string[];
}

export interface MeetingAnswerSource {
  text: string;
  startTime: number;
  endTime: number;
  speaker: string;
}

/** Private reply to this user's Ask NEXUS question. */
export interface MeetingAnswer {
  requestId?: string;
  question: string;
  askedBy?: string;
  answer: string;
  sources: MeetingAnswerSource[];
  /** How many transcript lines the answer could draw on (0 = nothing transcribed yet). */
  segmentCount?: number;
  timings?: { contextMs: number; answerMs: number; translateMs: number; totalMs: number };
}

export interface MeetingAiErrorEvent {
  kind: "ask" | "summary";
  requestId?: string;
  message: string;
  code?: string;
}

/** One line in the Ask NEXUS conversation (a question that may still be waiting for its answer). */
export interface AskNexusEntry {
  id: string;
  question: string;
  pending: boolean;
  answer?: string;
  sources?: MeetingAnswerSource[];
  error?: string;
  /** Plain-language remark about the answer (e.g. nothing was transcribed yet). */
  note?: string;
  /** Server-side time to produce the answer, ms. */
  tookMs?: number;
}