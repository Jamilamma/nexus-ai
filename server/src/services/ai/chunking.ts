import { ITranscriptSegment } from "../../models/Transcript";

export interface TextChunk {
  text: string;
  startTime: number;
  endTime: number;
  speaker: string;
}

/**
 * Groups transcript segments into ~targetChars-sized chunks so we never
 * send an entire multi-hour transcript to the LLM in one call. Used both
 * for summarization (map-reduce over chunks) and for RAG indexing.
 */
export function chunkSegments(segments: ITranscriptSegment[], targetChars = 2000): TextChunk[] {
  const chunks: TextChunk[] = [];
  let buffer: ITranscriptSegment[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({
      text: buffer.map((s) => `[${s.speaker}] ${s.text}`).join("\n"),
      startTime: buffer[0].startTime,
      endTime: buffer[buffer.length - 1].endTime,
      speaker: buffer[0].speaker,
    });
    buffer = [];
    bufferLen = 0;
  };

  for (const seg of segments) {
    buffer.push(seg);
    bufferLen += seg.text.length;
    if (bufferLen >= targetChars) flush();
  }
  flush();

  return chunks;
}

/** Simple char-budget truncation fallback for plain (non-segmented) text. */
export function chunkPlainText(text: string, targetChars = 2000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += targetChars) {
    chunks.push(text.slice(i, i + targetChars));
  }
  return chunks;
}

/**
 * Splits a "[Speaker]: text" style transcript (one line per turn — this is
 * exactly the format meetingManager/sessionManager write into
 * Transcript.fullText) into ~targetChars-sized chunks WITHOUT ever cutting
 * a line in half.
 *
 * chunkPlainText's blind character slicing will happily split
 * "[Priya]: I think we should..." mid-line, so half of Priya's sentence
 * lands in one chunk and half in the next with no speaker tag at all —
 * the per-chunk summarizer then has no idea who said the second half. With
 * more participants in a meeting there are more, shorter speaker turns, so
 * this kind of mid-line cut happens more often and does more damage to
 * "who said what" accuracy — which is exactly the failure mode reported
 * for multi-participant meetings. Chunking on line boundaries instead
 * guarantees every line (and its speaker tag) stays intact in exactly one
 * chunk.
 */
export function chunkTranscriptText(text: string, targetChars = 8000): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  for (const line of lines) {
    // A single line longer than the whole budget (rare) still can't be
    // split safely mid-sentence, so it gets its own chunk rather than
    // being sliced.
    if (bufferLen > 0 && bufferLen + line.length + 1 > targetChars) {
      chunks.push(buffer.join("\n"));
      buffer = [];
      bufferLen = 0;
    }
    buffer.push(line);
    bufferLen += line.length + 1;
  }
  if (buffer.length > 0) chunks.push(buffer.join("\n"));

  return chunks;
}
