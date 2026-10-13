import axios from "axios";

/**
 * Embedding provider abstraction for RAG.
 *
 * Anthropic does not host an embeddings endpoint directly, so this uses
 * Voyage AI (Anthropic's recommended embeddings partner) when an API key
 * is configured. If no embeddings key is present, it falls back to a
 * lightweight local TF-IDF-style vector so "Ask Your Recording" still
 * works end-to-end in development without extra API keys — swap in a
 * real embeddings provider for production quality.
 *
 * To use real embeddings: set VOYAGE_API_KEY in server/.env.
 */

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (VOYAGE_API_KEY) {
    const response = await axios.post(
      "https://api.voyageai.com/v1/embeddings",
      { input: texts, model: "voyage-3-lite" },
      { headers: { Authorization: `Bearer ${VOYAGE_API_KEY}` }, timeout: 30_000 }
    );
    return response.data.data.map((d: any) => d.embedding);
  }

  // Fallback: deterministic bag-of-words hashed vector (dev-only).
  return texts.map((t) => hashEmbedding(t));
}

const FALLBACK_DIM = 256;

function hashEmbedding(text: string): number[] {
  const vec = new Array(FALLBACK_DIM).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    }
    vec[hash % FALLBACK_DIM] += 1;
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
