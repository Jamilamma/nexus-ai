import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import { env } from "../../config/env";
import { ITranscriptSegment } from "../../models/Transcript";

export interface TranscriptionResult {
  fullText: string;
  segments: ITranscriptSegment[];
  detectedLanguage: string;
}
export async function transcribeAudioFile(filePath: string): Promise<TranscriptionResult> {
  // Self-hosted: the same faster-whisper service the live meetings use. No API key, audio stays on your servers.
  if (env.sttProvider === "whisper") {
    return transcribeWithWhisper(filePath);
  }
  if (env.sttProvider === "assemblyai" && env.sttApiKey) {
    return transcribeWithAssemblyAI(filePath);
  }

  throw new Error(
    "No speech-to-text provider is configured. Set STT_PROVIDER=whisper (self-hosted, free; see stt-service/README.md) " +
      "or STT_PROVIDER=assemblyai with STT_API_KEY in server/.env, or use the 'paste transcript' option " +
      "instead of audio upload."
  );
}

/**
 * Recorded files through the self-hosted Whisper service. Differences from AssemblyAI, stated plainly:
 *  - NO speaker diarization: every line is "Speaker 1" (Whisper does not identify speakers; live meetings
 *    get real speaker names from LiveKit participant IDs, but a mixed recording has no such information).
 *  - ONE language is detected per file (restricted to WHISPER_LANGUAGES); a file that switches language
 *    for long stretches will be partly mis-transcribed.
 */
async function transcribeWithWhisper(filePath: string): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  if (env.whisperLanguages.length === 1) form.append("language", env.whisperLanguages[0]);
  else if (env.whisperLanguages.length > 1) form.append("candidates", env.whisperLanguages.join(","));

  const headers: Record<string, string> = { ...form.getHeaders() };
  if (env.whisperApiToken) headers.Authorization = `Bearer ${env.whisperApiToken}`;

  let data: any;
  try {
    const res = await axios.post(`${env.whisperUrl}/transcribe-file`, form, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: env.whisperFileTimeoutMs,
    });
    data = res.data;
  } catch (err: any) {
    const detail = err?.response?.data?.detail;
    if (err?.code === "ECONNREFUSED") {
      throw new Error(`Whisper STT service is not reachable at ${env.whisperUrl}. Start it (see stt-service/README.md).`);
    }
    throw new Error(`Whisper transcription failed: ${detail ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : err?.message || err}`);
  }

  const language: string = data.language || "en";
  const segments: ITranscriptSegment[] = (data.segments || [])
    .filter((s: any) => typeof s.text === "string" && s.text.trim())
    .map((s: any) => ({
      speaker: "Speaker 1",
      startTime: s.start,
      endTime: s.end,
      text: s.text.trim(),
      language,
      confidence: typeof s.avg_logprob === "number" ? Math.min(1, Math.max(0, Math.exp(s.avg_logprob))) : undefined,
    }));
  const fullText = segments.map((s) => s.text).join(" ");
  return {
    fullText,
    segments: segments.length > 0 ? segments : [{ speaker: "Speaker 1", startTime: 0, endTime: 0, text: "" }],
    detectedLanguage: language,
  };
}

async function transcribeWithAssemblyAI(filePath: string): Promise<TranscriptionResult> {
  const headers = { authorization: env.sttApiKey };

  // 1. Upload the file
  const fileStream = fs.createReadStream(filePath);
  const uploadRes = await axios.post("https://api.assemblyai.com/v2/upload", fileStream, {
    headers: { ...headers, "content-type": "application/octet-stream" },
    maxBodyLength: Infinity,
  });
  const audioUrl = uploadRes.data.upload_url;

  // 2. Request transcription with diarization + language detection
  const transcriptRes = await axios.post(
    "https://api.assemblyai.com/v2/transcript",
    { audio_url: audioUrl, speaker_labels: true, language_detection: true },
    { headers }
  );
  const transcriptId = transcriptRes.data.id;

  // 3. Poll until complete
  let status = "queued";
  let data: any = null;
  while (status !== "completed" && status !== "error") {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers });
    data = poll.data;
    status = data.status;
  }

  if (status === "error") {
    throw new Error(`Transcription failed: ${data.error}`);
  }

  const segments: ITranscriptSegment[] = (data.utterances || []).map((u: any) => ({
    speaker: `Speaker ${u.speaker}`,
    startTime: u.start / 1000,
    endTime: u.end / 1000,
    text: u.text,
  }));

  return {
    fullText: data.text || "",
    segments: segments.length > 0 ? segments : [{ speaker: "Speaker 1", startTime: 0, endTime: 0, text: data.text || "" }],
    detectedLanguage: data.language_code || "en",
  };
}

/**
 * Splits a manually-pasted transcript (no timestamps) into a single
 * segment so the rest of the pipeline (chunking, RAG, summarization)
 * works identically whether the transcript came from an STT API or was
 * typed/pasted by the user.
 */
export function wrapPlainTextAsSegments(text: string): ITranscriptSegment[] {
  return [{ speaker: "Speaker 1", startTime: 0, endTime: 0, text }];
}
