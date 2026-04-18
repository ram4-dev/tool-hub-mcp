import { describe, it, expect } from 'vitest';
import { nextBackoffMs, BACKOFF_STEPS_MS } from '../../src/supervisor/backoff.js';

describe('backoff', () => {
  it('matches spec DD-6: 1s/5s/30s', () => {
    expect(BACKOFF_STEPS_MS).toEqual([1000, 5000, 30000]);
    expect(BACKOFF_STEPS_MS.length).toBe(3);
  });

  it('returns null past the last attempt (single source of truth for termination)', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(5000);
    expect(nextBackoffMs(2)).toBe(30000);
    expect(nextBackoffMs(3)).toBe(null);
    expect(nextBackoffMs(4)).toBe(null);
  });

  it('returns null for negative attempts', () => {
    expect(nextBackoffMs(-1)).toBe(null);
  });
});
