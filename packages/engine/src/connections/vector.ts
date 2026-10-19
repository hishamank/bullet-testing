/**
 * Plain-TypeScript vector maths for connections: unit-normalise, centre, cosine, top-k and the
 * byte encoding stored in SQLite. At journal scale (thousands of thoughts) a full scan is a few
 * milliseconds; no vector index is needed.
 */

export type Vector = Float32Array

/** A unit-length copy (a zero vector stays zero). */
export function normalize(v: ArrayLike<number>): Vector {
  let n = 0
  for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) * (v[i] ?? 0)
  const out = new Float32Array(v.length)
  if (n === 0) return out
  const inv = 1 / Math.sqrt(n)
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) * inv
  return out
}

/** Dot product (the cosine, for unit vectors). Vectors of different length score 0. */
export function dot(a: Vector, b: Vector): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/** Cosine similarity of any two vectors. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return dot(normalize(a), normalize(b))
}

/** The mean of unit vectors, as a running sum and a count (so it can be combined). */
export interface VectorMean {
  sum: Float32Array
  count: number
}

export function meanOf(vectors: readonly Vector[], dim?: number): VectorMean | null {
  const d = dim ?? vectors[0]?.length
  if (d === undefined) return null
  const sum = new Float32Array(d)
  let count = 0
  for (const v of vectors) {
    if (v.length !== d) continue
    for (let i = 0; i < d; i++) sum[i] = (sum[i] as number) + (v[i] as number)
    count += 1
  }
  return count === 0 ? null : { sum, count }
}

/** Two means as one. */
export function combineMeans(a: VectorMean | null, b: VectorMean | null): VectorMean | null {
  if (!a) return b
  if (!b || b.sum.length !== a.sum.length) return a
  const sum = new Float32Array(a.sum.length)
  for (let i = 0; i < sum.length; i++) sum[i] = (a.sum[i] as number) + (b.sum[i] as number)
  return { sum, count: a.count + b.count }
}

/**
 * Subtract the mean and re-normalise. A general LLM's embeddings all point roughly the same way
 * (unrelated notes score 0.7–0.9); removing the common direction leaves what tells them apart.
 */
export function centre(v: Vector, mean: VectorMean | null): Vector {
  if (!mean || mean.count === 0 || mean.sum.length !== v.length) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++)
    out[i] = (v[i] as number) - (mean.sum[i] as number) / mean.count
  return normalize(out)
}

export interface Scored<T> {
  item: T
  score: number
}

/** The `k` items most similar to `query` (unit vectors), best first. */
export function topK<T>(
  query: Vector,
  items: readonly T[],
  vectorOf: (item: T) => Vector,
  k: number,
): Scored<T>[] {
  const scored: Scored<T>[] = []
  for (const item of items) scored.push({ item, score: dot(query, vectorOf(item)) })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/** Float32 little-endian bytes, for a SQLite blob. */
export function encodeVector(v: ArrayLike<number>): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v as ArrayLike<number>)
  return new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength))
}

/** The inverse of {@link encodeVector} (copies, so an unaligned blob is fine). */
export function decodeVector(bytes: Uint8Array): Vector {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}
