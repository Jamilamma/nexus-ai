import { Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { Interview } from "../models/Interview";
import { askLLM, askLLMForJSON } from "../services/ai/llmClient";

export async function startInterview(req: AuthedRequest, res: Response) {
  const { role, jobDescription, difficulty } = req.body;
  if (!role) return res.status(400).json({ error: "role is required." });

  const firstQuestion = await askLLM(
    `You are a professional technical interviewer conducting a mock interview for a "${role}" position.
${jobDescription ? `Job description context: ${jobDescription}` : ""}
Difficulty level: ${difficulty || "intermediate"}.

Ask ONE opening interview question only (e.g. "Tell me about yourself" or a role-relevant opener). Output only the question, nothing else.`
  );

  const interview = await Interview.create({
    userId: req.userId,
    role,
    jobDescription,
    difficulty: difficulty || "intermediate",
    turns: [{ question: firstQuestion.trim(), answer: "" }],
    status: "in_progress",
  });

  res.status(201).json({ interview });
}

export async function submitAnswer(req: AuthedRequest, res: Response) {
  const { interviewId, answer } = req.body;
  if (!interviewId || answer === undefined) {
    return res.status(400).json({ error: "interviewId and answer are required." });
  }

  const interview = await Interview.findOne({ _id: interviewId, userId: req.userId });
  if (!interview) return res.status(404).json({ error: "Interview not found." });

  const currentTurn = interview.turns[interview.turns.length - 1];
  if (!currentTurn) return res.status(400).json({ error: "No active question to answer." });

  currentTurn.answer = answer;

  const evalPrompt = `You are evaluating one interview answer for a "${interview.role}" role.

Question: ${currentTurn.question}
Candidate's answer: ${answer}

Respond with JSON of this exact shape:
{
  "scores": { "technical": 0-10, "communication": 0-10, "grammar": 0-10, "clarity": 0-10 },
  "fillerWordCount": number,
  "feedback": "2-3 sentences of specific, constructive feedback",
  "improvedAnswer": "a stronger example answer to the same question",
  "nextQuestion": "one natural follow-up interview question based on this answer, or a new question if this topic is exhausted"
}

Do not claim to detect emotions or personality — describe communication indicators only (clarity, structure, filler words, pace).`;

  const evalResult = await askLLMForJSON<any>(evalPrompt);

  currentTurn.scores = evalResult.scores;
  currentTurn.fillerWordCount = evalResult.fillerWordCount;
  currentTurn.feedback = evalResult.feedback;
  currentTurn.improvedAnswer = evalResult.improvedAnswer;

  interview.turns.push({ question: evalResult.nextQuestion, answer: "" });

  await interview.save();

  res.json({ interview, feedback: evalResult });
}

export async function finishInterview(req: AuthedRequest, res: Response) {
  const { interviewId } = req.body;
  if (!interviewId) return res.status(400).json({ error: "interviewId is required." });

  const interview = await Interview.findOne({ _id: interviewId, userId: req.userId });
  if (!interview) return res.status(404).json({ error: "Interview not found." });

  const answeredTurns = interview.turns.filter((t) => t.answer && t.scores);

  if (answeredTurns.length === 0) {
    return res.status(400).json({ error: "Answer at least one question before finishing." });
  }

  const avg = (key: "technical" | "communication" | "grammar" | "clarity") =>
    answeredTurns.reduce((s, t) => s + (t.scores?.[key] || 0), 0) / answeredTurns.length;

  const overallScore = Math.round(
    ((avg("technical") + avg("communication") + avg("grammar") + avg("clarity")) / 4) * 10
  ) / 10;

  const summaryPrompt = `Based on this mock interview transcript (question/answer/feedback pairs for a "${interview.role}" role), identify strong areas, weak areas, and write a short personalized preparation plan.

${answeredTurns
  .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}\nFeedback: ${t.feedback}`)
  .join("\n\n")}

Respond with JSON: { "strongAreas": ["..."], "weakAreas": ["..."], "preparationPlan": "a short paragraph" }`;

  const summary = await askLLMForJSON<any>(summaryPrompt);

  interview.overallScore = overallScore;
  interview.strongAreas = summary.strongAreas;
  interview.weakAreas = summary.weakAreas;
  interview.preparationPlan = summary.preparationPlan;
  interview.status = "completed";

  await interview.save();

  res.json({ interview });
}

export async function getInterview(req: AuthedRequest, res: Response) {
  const interview = await Interview.findOne({ _id: req.params.id, userId: req.userId });
  if (!interview) return res.status(404).json({ error: "Interview not found." });
  res.json({ interview });
}

export async function listInterviews(req: AuthedRequest, res: Response) {
  const interviews = await Interview.find({ userId: req.userId }).sort({ createdAt: -1 });
  res.json({ interviews });
}
