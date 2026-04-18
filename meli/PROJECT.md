# PROJECT.md — toolhub

## Project Overview

Local MCP proxy for coding agents. Sits between a coding agent (Claude Code, Cursor, Codex) and its MCP servers, exposing a compact normalized catalog and routing invocations on demand — reducing context consumption and providing usage telemetry.

## Tech Stack

- **Language**: TypeScript / Node 20+
- **Distribution**: npm package (`npx tool-proxy-mvp`)
- **Persistence**: SQLite (better-sqlite3) + FTS5/BM25
- **Testing**: Vitest
- **CI/CD**: GitHub Actions

## Spec Language

```yaml
language:
  specs: es
```

## Project Type

MVP — tests for critical paths only.

## Architecture Principles

- Single local process acting as MCP server proxy
- Non-invasive: reads client config, never writes
- Zero-config: `npx tool-proxy-mvp` just works
- Latency budget: ≤50ms overhead per invocation
- Crash isolation: child MCP crash NEVER brings down proxy

## Out of Scope (v0.1)

- Skills, plugins, hooks
- Multi-client (Cursor, Codex)
- UI web
- Semantic embeddings
- Per-project profiles
- MCP security auditing
- Federated registry
