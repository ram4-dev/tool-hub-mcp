# Feature Metadata

**Feature Name**: mcp-proxy-core
**Feature ID**: feat-20260418-mcp-proxy-core
**Mode**: greenfield
**Project Type**: mvp
**Platform**: backend
**User Profile**: non-technical
**Created**: 2026-04-18
**Last Updated**: 2026-04-18
**Current Stage**: 3-tasks

## Spec Approvals

- Functional: approved by ramiro.carnicer at 2026-04-18
- Technical: approved by ramiro.carnicer at 2026-04-18

---

## Framework Version

```yaml
framework:
  version_created: "non-fury-oss"
  version_current: null
  last_compatibility_check: null
  migration_notes: []
```

---

## Project Type Configuration

```yaml
project_type:
  type: mvp
  decision_date: 2026-04-18

  testing:
    unit_tests: critical_only
    ltp_enabled: false
    coverage_target: "varies"
```

---

## User Profile Configuration

```yaml
user_profile:
  type: non-technical
  source: global
  selected_at: 2026-04-18T00:00:00Z
```

---

## Feature Description

> Proxy MCP local para que los agentes de código consuman menos contexto y los usuarios puedan ver, medir y gestionar todas sus skills, plugins y MCPs desde un solo lugar.

Context saved from: README.md (full v0.1 MVP scope)

---

## Project Context

- **Stack**: TypeScript / Node 20+
- **Distribution**: `npx tool-proxy-mvp` / `npm install -g`
- **Persistence**: SQLite (better-sqlite3) + FTS5
- **Target client**: Claude Code (v0.1)
- **Scope**: MCPs only (no skills/plugins in v0.1)

---

## Resolved Decisions

| Decisión | Resolución |
|---|---|
| Nombre npm/github | `toolhub` |
| Telemetría | Solo metadata (tool, timestamp, latencia, éxito). Sin payloads. |
| Config del cliente | No invasivo — proxy solo lee `~/.claude.json` |
| Licencia | MIT |
| Alcance v0.1 | MVP completo (no experimento previo) |
| Formato tool IDs | `mcp_name.tool_name` (namespace por MCP) |
