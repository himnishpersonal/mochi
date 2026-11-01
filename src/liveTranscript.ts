export type LiveSegment = { startMs: number; endMs: number; text: string; noSpeechProbability?: number; language?: string };

// Keep failed writes queued. A later chunk retries the same evidence before adding newer text.
export async function persistLiveChunk<T>(pending: LiveSegment[], incoming: LiveSegment[], save: (batch: LiveSegment[]) => Promise<T>): Promise<T> {
  pending.push(...incoming);
  const batch = [...pending];
  const result = await save(batch);
  pending.splice(0, batch.length);
  return result;
}
