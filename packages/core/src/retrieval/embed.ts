import { createHash } from 'node:crypto'

export const EMBEDDING_DIMENSIONS = 384

export interface EmbeddingProvider {
  readonly name: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

const STOPWORDS = new Set(
  'a an the and or but if then than that this these those of to in on at for with from by is are was were be been being it its as we our you your they their he she them us not no do does did have has had will would can could should may might must about into over under after before during'.split(
    ' ',
  ),
)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s._-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function bucket(token: string, salt: string): number {
  const h = createHash('sha1').update(salt).update(token).digest()
  return ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % EMBEDDING_DIMENSIONS
}

/**
 * Deterministic hashed-feature embedder — the `mock` implementation of EmbeddingProvider.
 *
 * It is not a semantic model, but it is a real vector space: shared vocabulary and
 * shared bigrams produce genuine cosine similarity, sub-word shingles give partial
 * credit for morphological variants, and identical input always produces an identical
 * vector. That determinism is what lets the eval harness distinguish "the plumbing
 * broke" from "the model was wrong" (§5.12).
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-hashing'
  readonly dimensions = EMBEDDING_DIMENSIONS

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text))
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
    const tokens = tokenize(text)
    if (tokens.length === 0) return vector

    const counts = new Map<string, number>()
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
      for (let n = 3; n <= 5 && n < token.length; n++) {
        for (let i = 0; i + n <= token.length; i++) {
          const gram = `#${token.slice(i, i + n)}`
          counts.set(gram, (counts.get(gram) ?? 0) + 0.35)
        }
      }
    }
    for (let i = 0; i + 1 < tokens.length; i++) {
      const bigram = `${tokens[i]}_${tokens[i + 1]}`
      counts.set(bigram, (counts.get(bigram) ?? 0) + 0.8)
    }

    for (const [term, count] of counts) {
      // Sublinear term weighting keeps a repeated word from dominating the vector.
      const weight = 1 + Math.log(count)
      const idx = bucket(term, 'v1')
      const sign = bucket(term, 'sign') % 2 === 0 ? 1 : -1
      vector[idx] = vector[idx]! + sign * weight
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
    return norm === 0 ? vector : vector.map((v) => v / norm)
  }
}

/** pgvector's text input format. Bound as a parameter and cast, never interpolated. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b[i] ?? 0)
  return dot
}

let provider: EmbeddingProvider = new HashingEmbeddingProvider()

export function embeddingProvider(): EmbeddingProvider {
  return provider
}

export function setEmbeddingProvider(next: EmbeddingProvider): void {
  if (next.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding provider "${next.name}" produces ${next.dimensions} dimensions; the chunk column is vector(${EMBEDDING_DIMENSIONS}). Changing this requires a migration and a full reindex.`,
    )
  }
  provider = next
}
