/**
 * Backoff schedule per DD-6: 1s, 5s, 30s. After 3 failed restarts => excluded.
 */
export const BACKOFF_STEPS_MS: readonly number[] = [1000, 5000, 30000];

export function nextBackoffMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= BACKOFF_STEPS_MS.length) return null;
  return BACKOFF_STEPS_MS[attempt];
}
