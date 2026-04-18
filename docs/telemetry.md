# Telemetry Policy — toolhub (v0.1)

toolhub stores **metadata only**. It never persists arguments or results from tool
invocations.

## What is stored

Per invocation, in `~/.toolhub/state.db` (table `invocations`):

- `tool_id` — fully-qualified tool name (`mcp.tool`).
- `mcp_name` — originating MCP server.
- `ts` — ISO-8601 timestamp.
- `latency_ms` — round-trip time measured by the router.
- `success` — 0 or 1.
- `error_kind` — `timeout` | `mcp_error` | `not_found` | `validation` | `null`.
- `tokens_saved_estimate` — the token cost of the schema the agent did *not* need to
  carry in its context (directional, see `docs/token-estimation.md`).

Static catalog metadata is persisted in the `tools` table: tool id, description,
schema JSON, estimated token cost, enabled flag, first/last seen timestamps.

## What is NOT stored

- Tool call **arguments**.
- Tool call **results**.
- Environment variable values or secrets of any kind.
- stderr of child MCPs beyond in-memory line scrubbing (see §8 Security in the tech spec).

## Retention

v0.1 does not delete. A retention policy (default 30 days) is planned for v0.2.
To wipe everything today:

```bash
rm -rf ~/.toolhub
```

## Why metadata only

- Eliminates the risk of accidentally logging secrets passed through args (API keys, PII, etc.).
- Simplifies the legal surface — no sensitive data ever touches disk.
- Keeps `state.db` tiny even after heavy usage.
