import { Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { Recording } from "../models/Recording";
import { Transcript } from "../models/Transcript";
import { Summary } from "../models/Summary";
import { deleteStoredFile } from "../services/storage/localStorage";
import { transcribeAudioFile, wrapPlainTextAsSegments } from "../services/speech/transcribe";
import { finalizeRecordingAnalysis } from "../services/pipeline/finalizeRecording";
import { KnowledgeChunk } from "../models/KnowledgeChunk";
import { LearningContent } from "../models/LearningContent";
import { LiveSession } from "../models/LiveSession";

export async function createRecording(req: AuthedRequest, res: Response) {
  const { title, type, pastedTranscript, language } = req.body;
  const file = req.file;

  if (!file && !pastedTranscript) {
    return res.status(400).json({ error: "Provide either an audio/video file or a pasted transcript." });
  }

  const recording = await Recording.create({
    userId: req.userId,
    title: title || file?.originalname || "Untitled recording",
    type: type || "meeting",
    source: "upload",
    fileUrl: file ? file.filename : "text-only",
    originalFileName: file ? file.originalname : "pasted-transcript.txt",
    mimeType: file ? file.mimetype : "text/plain",
    language: language || "auto",
    status: "uploaded",
  });

  // Process asynchronously so the upload request returns immediately.
  processUploadedRecording(recording._id, file?.path, pastedTranscript).catch(async (err) => {
    console.error("[recording pipeline]", err.message);
    await Recording.findByIdAndUpdate(recording._id, { status: "failed", errorMessage: err.message });
  });

  res.status(201).json({ recording });
}

/**
 * Handles the "we have a file or pasted text, but no transcript yet" case
 * for uploaded recordings: transcribe, save the Transcript, then hand off
 * to the shared finalizeRecordingAnalysis() pipeline (also used by live
 * sessions once they end).
 */
async function processUploadedRecording(recordingId: any, filePath?: string, pastedTranscript?: string) {
  const recording = await Recording.findById(recordingId);
  if (!recording) return;

  await Recording.findByIdAndUpdate(recordingId, { status: "transcribing" });

  let fullText: string;
  let segments;
  let detectedLanguage = "en";

  if (pastedTranscript) {
    fullText = pastedTranscript;
    segments = wrapPlainTextAsSegments(pastedTranscript);
  } else if (filePath) {
    const result = await transcribeAudioFile(filePath);
    fullText = result.fullText;
    segments = result.segments;
    detectedLanguage = result.detectedLanguage;
  } else {
    throw new Error("No transcript source provided.");
  }

  if (!fullText || fullText.trim().length === 0) {
    throw new Error("No speech was detected in this recording.");
  }

  await Transcript.create({
    recordingId,
    userId: recording.userId,
    language: detectedLanguage,
    fullText,
    segments,
  });

  await Recording.findByIdAndUpdate(recordingId, { language: detectedLanguage });

  await finalizeRecordingAnalysis(recordingId);
}

export async function listRecordings(req: AuthedRequest, res: Response) {
  const recordings = await Recording.find({ userId: req.userId }).sort({ createdAt: -1 });
  res.json({ recordings });
}

export async function getRecording(req: AuthedRequest, res: Response) {
  const recording = await Recording.findOne({ _id: req.params.id, userId: req.userId });
  if (!recording) return res.status(404).json({ error: "Recording not found." });

  const [transcript, summary, learningContent] = await Promise.all([
    Transcript.findOne({ recordingId: recording._id, userId: req.userId }),
    Summary.findOne({ recordingId: recording._id, userId: req.userId }),
    LearningContent.findOne({ recordingId: recording._id, userId: req.userId }),
  ]);

  res.json({ recording, transcript, summary, learningContent });
}

export async function deleteRecording(req: AuthedRequest, res: Response) {
  const recording = await Recording.findOne({ _id: req.params.id, userId: req.userId });
  if (!recording) return res.status(404).json({ error: "Recording not found." });

  if (recording.fileUrl !== "text-only") {
    try {
      deleteStoredFile(recording.fileUrl);
    } catch {
      /* file may already be gone; not fatal */
    }
  }

  await Promise.all([
    Recording.deleteOne({ _id: recording._id }),
    Transcript.deleteOne({ recordingId: recording._id }),
    Summary.deleteOne({ recordingId: recording._id }),
    KnowledgeChunk.deleteMany({ recordingId: recording._id }),
    LearningContent.deleteOne({ recordingId: recording._id }),
    LiveSession.deleteOne({ recordingId: recording._id }),
  ]);

  res.json({ success: true });
}
