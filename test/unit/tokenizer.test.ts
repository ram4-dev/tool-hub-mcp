import { describe, it, expect } from 'vitest';
import { countTokens, approximateTokens } from '../../src/tokenizer/index.js';

describe('tokenizer', () => {
  it('counts tokens for hello world', () => {
    expect(countTokens('hola mundo')).toBeGreaterThan(0);
  });
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
  it('approximateTokens is order-of-magnitude close', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const real = countTokens(text);
    const approx = approximateTokens(text);
    expect(approx).toBeGreaterThan(real / 4);
    expect(approx).toBeLessThan(real * 4);
  });
  it('is stable across multiple calls (singleton encoder)', () => {
    const a = countTokens('same string');
    const b = countTokens('same string');
    expect(a).toBe(b);
  });
});
