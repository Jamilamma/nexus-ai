import { Response } from "express";
import { Types } from "mongoose";
import { AuthedRequest } from "../middleware/auth";
import { Recording } from "../models/Recording";
import { answerFromRecording } from "../services/rag/retrieve";

export async function queryRecording(req: AuthedRequest, res: Response) {
  const { recordingId, question } = req.body;

  if (!recordingId || !question) {
    return res.status(400).json({ error: "recordingId and question are required." });
  }

  // Ownership check happens here at the API boundary, AND again inside
  // answerFromRecording's DB query — defense in depth against cross-user access.
  const recording = await Recording.findOne({ _id: recordingId, userId: req.userId });
  if (!recording) {
    return res.status(404).json({ error: "Recording not found." });
  }

  const result = await answerFromRecording(
    question,
    req.userId as Types.ObjectId,
    new Types.ObjectId(recordingId)
  );

  res.json(result);
}
