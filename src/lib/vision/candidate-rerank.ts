import { generateEmbeddingFromBuffer } from "@/lib/vision/embeddings";

export interface RerankCandidateBaseline {
  id: string;
  imageUrl: string;
  verificationImageUrl?: string | null;
  embedding?: number[] | null;
  serverEmbeddingSimilarity?: number;
}

interface RerankCandidateOptions {
  allowPlaceholder?: boolean;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return Number.NEGATIVE_INFINITY;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : Number.NEGATIVE_INFINITY;
}

export async function rerankCandidateBaselinesByServerEmbedding(
  currentImageBuffer: Buffer,
  candidateBaselines: RerankCandidateBaseline[],
  options: RerankCandidateOptions = {},
): Promise<RerankCandidateBaseline[]> {
  if (
    candidateBaselines.length === 0 ||
    !candidateBaselines.some(
      (candidate) =>
        Array.isArray(candidate.embedding) && candidate.embedding.length > 0,
    )
  ) {
    return candidateBaselines;
  }

  const currentEmbedding = await generateEmbeddingFromBuffer(currentImageBuffer, {
    allowPlaceholder: options.allowPlaceholder,
  });

  return [...candidateBaselines]
    .map((candidate) => {
      const similarity =
        Array.isArray(candidate.embedding) &&
        candidate.embedding.length === currentEmbedding.length
          ? cosineSimilarity(currentEmbedding, candidate.embedding)
          : Number.NEGATIVE_INFINITY;

      return {
        ...candidate,
        serverEmbeddingSimilarity: similarity,
      };
    })
    .sort(
      (a, b) =>
        (b.serverEmbeddingSimilarity ?? Number.NEGATIVE_INFINITY) -
        (a.serverEmbeddingSimilarity ?? Number.NEGATIVE_INFINITY),
    );
}
