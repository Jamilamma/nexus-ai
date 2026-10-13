import { Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { Recording } from "../models/Recording";
import { Transcript } from "../models/Transcript";
import { LearningContent } from "../models/LearningContent";
import { askLLMForJSON } from "../services/ai/llmClient";

export async function generateLearningContent(req: AuthedRequest, res: Response) {
  const { recordingId } = req.body;
  if (!recordingId) return res.status(400).json({ error: "recordingId is required." });

  const recording = await Recording.findOne({ _id: recordingId, userId: req.userId });
  if (!recording) return res.status(404).json({ error: "Recording not found." });

  const transcript = await Transcript.findOne({ recordingId, userId: req.userId });
  if (!transcript) return res.status(400).json({ error: "This recording has no transcript yet." });

  const prompt = `You are generating study material from a lecture transcript. Respond with JSON of this exact shape:
{
  "notes": "well-organized study notes in markdown",
  "importantConcepts": ["array of key concepts"],
  "definitions": [{ "term": "string", "definition": "string" }],
  "flashcards": [{ "question": "string", "answer": "string" }],
  "quiz": [{ "question": "string", "options": ["A","B","C","D"], "correctIndex": 0 }],
  "examQuestions": {
    "twoMark": ["short factual questions"],
    "fiveMark": ["medium explanatory questions"],
    "longAnswer": ["long-form essay questions"],
    "viva": ["oral exam style questions"]
  }
}

Base everything strictly on the lecture content below. Generate 5-10 items per array where reasonable.

Lecture transcript:
${transcript.fullText}`;

  const result = await askLLMForJSON<any>(prompt, { maxTokens: 3000 });

  const learningContent = await LearningContent.findOneAndUpdate(
    { recordingId },
    { recordingId, userId: req.userId, ...result },
    { upsert: true, new: true }
  );

  res.json({ learningContent });
}

export async function getLearningContent(req: AuthedRequest, res: Response) {
  const learningContent = await LearningContent.findOne({
    recordingId: req.params.recordingId,
    userId: req.userId,
  });
  if (!learningContent) return res.status(404).json({ error: "No learning content generated yet." });
  res.json({ learningContent });
}
