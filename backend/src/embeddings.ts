/**
 * Local embeddings — no API key, fully offline after the first model download.
 * all-MiniLM-L6-v2 (384-dim) via transformers.js, mean-pooled and L2-normalized,
 * so cosine similarity reduces to a dot product. Groq has no embeddings API and
 * the project must run keyless, which is why embeddings are local.
 */
import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";

// Cache model weights inside the repo (gitignored) so runs are reproducible.
env.cacheDir = new URL("../data/models", import.meta.url).pathname;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  return extractor;
}

/** Embed one text → unit-length Float32Array(384). */
export async function embed(text: string): Promise<Float32Array> {
  const ex = await getExtractor();
  const out = await ex(text, { pooling: "mean", normalize: true });
  return new Float32Array(out.data as Float32Array);
}

/** Cosine similarity of two unit vectors = dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
