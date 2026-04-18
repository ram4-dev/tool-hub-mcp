# Token Estimation Methodology — toolhub (v0.1)

## Encoder

toolhub estimates tokens using [`js-tiktoken`](https://www.npmjs.com/package/js-tiktoken)
with the `cl100k_base` encoding. This encoder is the one used by current-generation
OpenAI and Claude models. The number produced is **directional**: it approximates what
an LLM would see, but individual provider tokenizers may differ by a few percent.

## What gets counted

For each discovered tool we store `schema_tokens`, computed as:

```
countTokens(JSON.stringify(inputSchema) + (description ?? ''))
```

That is: the JSON schema payload plus the short description the agent would otherwise
see in its initial context.

## "Tokens saved" estimate

Each invocation writes `tokens_saved_estimate = schema_tokens` of the tool being
invoked. The idea: in a direct setup, that tool would have been in context from the
start; with toolhub, it only cost tokens when actually invoked (via `get_schema`).

`toolhub stats` sums these values across a time window. It is a **lower bound on
savings**: it ignores the compounding effect of not carrying schemas across many turns
of the agent, which is where most of the real savings come from.

## Why this is good enough for v0.1

- Tokenization is consistent across runs (singleton encoder).
- The order of magnitude is correct for optimization decisions.
- Exact provider parity is not a v0.1 goal and would add dependency weight for
  little decision value.

v0.2 may expose a calibration CLI that measures the true agent context size before
and after toolhub to validate the directional number.
