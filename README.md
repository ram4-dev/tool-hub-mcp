# toolhub

Local MCP proxy for coding agents. Sits between your coding agent (Claude Code, etc.)
and all the MCP servers it depends on, exposing a **compact catalog** of tool names
and lazy-loading full schemas only when needed. Reduces initial context consumption
and adds usage telemetry.

> **Status**: v0.1 MVP. Target client: Claude Code.

## Quick start

```bash
# 1. Inspect what toolhub would do — does NOT touch your config.
npx toolhub init

# 2. Preview and then apply the migration to ~/.claude.json (with automatic backup).
npx toolhub migrate --dry-run
npx toolhub migrate --apply

# 3. Run Claude Code normally. Use the CLI to inspect usage.
npx toolhub status
npx toolhub stats --since 7d
npx toolhub unused --since 7d

# Undo at any time:
npx toolhub migrate --revert
```

## What toolhub exposes to the agent

Exactly **3 tools**:

- `list_capabilities()` — compact `{name, short_description}` list of every child tool.
- `get_schema(name)` — full JSON schema for a single tool.
- `invoke(name, arguments)` — forwards to the right child MCP and returns the result.

Child tools are namespaced as `mcp_name.tool_name` (e.g. `github.create_pr`).

## Architecture (v0.1)

```
Claude Code --- MCP/stdio ---> toolhub ---+--stdio--> github MCP
                                          +--stdio--> filesystem MCP
                                          +--stdio--> ...
```

- Single Node process.
- One subprocess per child MCP; communication via MCP over stdio.
- SQLite in `~/.toolhub/state.db` (WAL mode) for catalog + telemetry.
- Supervisor auto-restarts crashed child MCPs with 1s/5s/30s backoff, excludes after
  3 failures.
- Telemetry is **metadata only** — never args, never results.

See `meli/wip/20260418-mcp-proxy-core/2-technical/spec.md` for full design.

## CLI

| Command | Purpose |
|---|---|
| `toolhub init` | Scan `~/.claude.json`, print suggested snippet. Does not write. |
| `toolhub migrate --dry-run` | Preview the change to `~/.claude.json`. |
| `toolhub migrate --apply` | Apply the change with a timestamped backup. |
| `toolhub migrate --revert` | Restore the latest backup. |
| `toolhub status [--json]` | Process + child MCPs + catalog state. |
| `toolhub stats [--since 7d]` | Top tools/MCPs, tokens saved, p50/p95/p99 latency. |
| `toolhub unused [--since 7d]` | Tools with zero invocations in the window. |
| `toolhub enable <tool_id>` | Un-hide a tool from the catalog. |
| `toolhub disable <tool_id>` | Hide a tool without touching the child MCP. |
| `toolhub --mcp-server` | Run as MCP server (this is what Claude Code spawns). |

## Troubleshooting

- **Catalog exceeds 5k tokens warning**: you have too many MCPs. v0.1 still works but
  won't optimize well for your case; v0.2 adds search mode (BM25).
- **A child MCP is marked `excluded`**: it failed 3 restarts. Check `~/.toolhub/logs/<mcp>.log`
  and fix its config, then restart toolhub.
- **`toolhub migrate --apply` refuses**: the target JSON failed validation. Review with
  `--dry-run` and fix your `~/.claude.json` before retrying.
- **Want to wipe everything**: `rm -rf ~/.toolhub`.

## Docs

- [`docs/telemetry.md`](./docs/telemetry.md) — what we record, what we do NOT record.
- [`docs/token-estimation.md`](./docs/token-estimation.md) — how "tokens saved" is computed.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT. See [`LICENSE`](./LICENSE).
