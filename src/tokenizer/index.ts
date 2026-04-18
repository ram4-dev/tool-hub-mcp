import { getEncoding } from 'js-tiktoken';

// DD-8: cl100k_base is reasonable for modern Claude/OpenAI models.
// Directional — documented in docs/token-estimation.md.
type Encoder = ReturnType<typeof getEncoding>;
let encoder: Encoder | null = null;

function getEncoder(): Encoder {
  if (!encoder) {
    encoder = getEncoding('cl100k_base');
  }
  return encoder;
}

/** Count tokens in a string using cl100k_base (singleton encoder). */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/** Approximate token count without loading the encoder — fallback. */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars per token is the common rule of thumb.
  return Math.ceil(text.length / 4);
}
