// Embedding model — gte-small, 384 dims, runs in the Edge Runtime.

// @ts-ignore Supabase Edge Runtime global
const embeddingModel = new Supabase.ai.Session('gte-small')

export async function embed(text: string): Promise<number[]> {
  const result = await embeddingModel.run(text, {
    mean_pool: true,
    normalize: true,
  })
  return Array.from(result as Float32Array | number[])
}
