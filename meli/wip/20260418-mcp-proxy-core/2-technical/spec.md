# Technical Specification — toolhub (MVP v0.1)

**Feature ID**: feat-20260418-mcp-proxy-core
**Status**: draft
**Created**: 2026-04-18
**Language**: es

---

## 1. Executive Summary

toolhub es un proceso Node.js local que actúa simultáneamente como **servidor MCP** (frente a Claude Code) y como **cliente MCP multi-hijo** (frente a los MCPs que el usuario tiene instalados). Lee la config de Claude Code, levanta cada MCP como subproceso, indexa sus tools, expone 3 tools propias (`list_capabilities`, `get_schema`, `invoke`) y rutea cada invocación al hijo correcto mientras persiste telemetría en SQLite.

---

## 2. Architecture

```
┌────────────────┐   MCP/stdio    ┌────────────────────────────────────┐
│  Claude Code   │ ◀────────────▶ │           toolhub (Node)           │
└────────────────┘                │                                    │
                                  │  ┌──────────────────────────────┐  │
                                  │  │ ConfigReader (ClaudeCode)    │  │
                                  │  │ ServerFacade (MCP server)    │  │
                                  │  │ Catalog (in-mem + SQLite)    │  │
                                  │  │ Router                       │  │
                                  │  │ Supervisor                   │  │
                                  │  │ Telemetry (SQLite writer)    │  │
                                  │  │ CLI (commander)              │  │
                                  │  └──────────────────────────────┘  │
                                  └─────┬────────────┬──────────┬──────┘
                                        │ stdio      │ stdio    │ stdio
                                  ┌─────▼────┐  ┌────▼─────┐ ┌──▼───────┐
                                  │ MCP #1   │  │ MCP #2   │ │ MCP #N   │
                                  │ (github) │  │ (fs)     │ │ (...)    │
                                  └──────────┘  └──────────┘ └──────────┘
```

### ASCII Diagram

```
           Claude Code
                │  (MCP over stdio)
                ▼
        ┌─────────────────┐
        │    toolhub      │───────────▶ __________
        │   (Node 20+)    │            / ~/.toolhub\
        └──┬──┬──┬─────┬──┘            |   state.db |
           │  │  │     │               \____________/
     stdio │  │  │     │ stdio
           ▼  ▼  ▼     ▼
        ┌──┐┌──┐┌──┐ ┌──┐
        │M1││M2││M3│ │Mn│   MCP children (subprocessed)
        └──┘└──┘└──┘ └──┘
```

---

## 3. Components

| Component | Responsibility | Key Files |
|---|---|---|
| **ConfigReader** | Parsea `~/.claude.json` + plugins, extrae MCPs declarados con env vars expandidas | `src/config/claude-code.ts` |
| **ServerFacade** | Expone los 3 MCP tools al agente usando `@modelcontextprotocol/sdk` | `src/server/facade.ts` |
| **Supervisor** | Spawn/kill/restart de cada MCP hijo. Health checks. Backoff. | `src/supervisor/index.ts` |
| **MCPClient** | Adapter para hablar MCP con cada hijo (lista tools, invoca) | `src/client/mcp-client.ts` |
| **Catalog** | In-memory map `tool_id → { mcp, schema, enabled }`. Sincroniza con SQLite. | `src/catalog/index.ts` |
| **Router** | Recibe `invoke(name, args)`, busca en catalog, llama al MCPClient, mide latencia | `src/router/index.ts` |
| **Telemetry** | Writer async a SQLite (WAL mode). Cola bounded para no bloquear invocaciones | `src/telemetry/writer.ts` |
| **CLI** | Subcomandos: `init`, `migrate`, `status`, `stats`, `unused`, `enable`, `disable` | `src/cli/*.ts` |
| **Tokenizer** | Estima tokens del schema (para estimar ahorro) usando `js-tiktoken` | `src/tokenizer/index.ts` |

---

## 4. Process Model

- **1 proceso principal** (toolhub). Event-loop Node, no threads.
- **N subprocesses** (uno por MCP), comunicación por stdio JSON-RPC (MCP protocol).
- **1 worker de telemetría** dentro del proceso principal (microtask + bounded queue hacia SQLite).

Ciclo de vida:
1. CLI o Claude Code arranca toolhub.
2. `ConfigReader` lee la config del cliente.
3. `Supervisor` lanza cada MCP hijo y ejecuta `tools/list` en cada uno.
4. `Catalog` se popula en memoria + persiste en SQLite.
5. `ServerFacade` empieza a escuchar en stdio (MCP server).
6. Invocaciones entrantes → `Router` → `MCPClient` → hijo correspondiente → respuesta → telemetría async.
7. Si hijo muere: supervisor detecta `exit`, backoff, reintenta.

---

## 5. Data Model (SQLite)

Archivo: `~/.toolhub/state.db` (WAL mode, `PRAGMA journal_mode=WAL`).

```sql
-- Tools descubiertas de los MCPs hijos
CREATE TABLE tools (
  tool_id         TEXT PRIMARY KEY,           -- "github.create_pr"
  mcp_name        TEXT NOT NULL,              -- "github"
  tool_name       TEXT NOT NULL,              -- "create_pr"
  short_description TEXT NOT NULL,
  full_schema_json TEXT NOT NULL,             -- JSON serializado
  schema_tokens   INTEGER NOT NULL,           -- estimado con js-tiktoken
  enabled         INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE INDEX idx_tools_mcp ON tools(mcp_name);
CREATE INDEX idx_tools_enabled ON tools(enabled);

-- Una fila por invocación (metadata ONLY — nunca payloads)
CREATE TABLE invocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id         TEXT NOT NULL,
  mcp_name        TEXT NOT NULL,
  ts              TEXT NOT NULL,              -- ISO-8601
  latency_ms      INTEGER NOT NULL,
  success         INTEGER NOT NULL,           -- 0/1
  error_kind      TEXT,                       -- "timeout" | "mcp_error" | "not_found" | null
  tokens_saved_estimate INTEGER               -- schema_tokens de esa tool
);

CREATE INDEX idx_inv_ts ON invocations(ts);
CREATE INDEX idx_inv_tool ON invocations(tool_id);
CREATE INDEX idx_inv_mcp ON invocations(mcp_name);

-- Resumen por sesión del agente (para "tokens ahorrados")
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  total_tools     INTEGER NOT NULL,
  total_tokens_if_full INTEGER NOT NULL,      -- suma de schema_tokens de tools activas
  total_tokens_exposed INTEGER NOT NULL       -- solo los compact descriptions
);

-- Estado del supervisor
CREATE TABLE mcp_status (
  mcp_name        TEXT PRIMARY KEY,
  pid             INTEGER,
  state           TEXT NOT NULL,              -- "running" | "crashed" | "excluded"
  restart_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_restart_at TEXT
);
```

**Retention**: v0.1 no borra. v0.2 agregará policy (default 30 días).

---

## 6. Tools Exposed to Agent

### `list_capabilities`
Sin argumentos. Devuelve todas las tools enabled:
```json
[
  { "name": "github.create_pr", "short_description": "Create a pull request on GitHub" },
  { "name": "fs.read_file",     "short_description": "Read a local file" },
  ...
]
```

### `get_schema(name: string)`
Devuelve el JSON schema completo de una tool:
```json
{ "name": "github.create_pr", "schema": { /* full JSON schema */ } }
```
Error `TOOL_NOT_FOUND` si no existe o está disabled.

### `invoke(name: string, arguments: object)`
Rutea al MCP hijo. Respuesta = respuesta del hijo (pasa-through). Errores conocidos: `TOOL_NOT_FOUND`, `MCP_UNAVAILABLE`, `TIMEOUT`.

---

## 7. Key Design Decisions

### DD-1: TypeScript + Node 20+
**Alternativas**: Go, Rust. **Elegido TS**: el SDK oficial (`@modelcontextprotocol/sdk`) es TS, Claude Code es Node, iteración rápida. Reescritura en Go queda para si el proyecto pega.

### DD-2: SQLite (better-sqlite3) sin FTS5 en v0.1
No hay búsqueda en v0.1, así que FTS5 no es necesario todavía. `better-sqlite3` es sync pero muy rápido — las escrituras de telemetría van por una cola que batchea cada 100ms para no bloquear.

### DD-3: Namespace `mcp_name.tool_name`
Previene colisiones entre MCPs. El MCP hijo solo ve su nombre original; el namespacing es responsabilidad del router.

### DD-4: Config no invasiva
toolhub NUNCA escribe `~/.claude.json`. El CLI `migrate --apply` genera un diff y lo aplica tras confirmación explícita, siempre con backup timestamped.

### DD-5: Telemetría metadata-only
Nada de args ni results. Solo `{tool, mcp, ts, latency, success, error_kind, tokens_saved_estimate}`. Esto elimina la posibilidad de loguear secrets accidentalmente y simplifica policy de retención.

### DD-6: Backoff de supervisor: 1s / 5s / 30s
3 reintentos. Si los 3 fallan → MCP excluido del catálogo con state `crashed`. El usuario lo ve en `toolhub status`.

### DD-7: Modo catálogo directo único (sin BM25 en v0.1)
Si `total_schema_tokens > 5k`, warning al usuario pero funciona igual. BM25/FTS5 llega en v0.2.

### DD-8: Estimación de tokens
Usar `js-tiktoken` con encoding `cl100k_base` (compatible con modelos Claude/OpenAI). La estimación es directional, no exacta; se documenta la metodología.

---

## 8. Security

### 8.1 Input Validation
- Nombre de tool en `get_schema`/`invoke`: regex `^[a-z0-9_-]+\.[a-z0-9_-]+$`. Rechazar si no matchea.
- `arguments` de `invoke`: validar contra el JSON schema del hijo antes de enviarlo. Si falla, error sin invocar.
- Límite de tamaño de `arguments`: 1 MB (defensivo; no hay caso legítimo para más).

### 8.2 Subprocess Isolation
- MCPs hijos arrancan con **env vars solo de lo necesario** (no heredan todo el env del padre). El usuario configura explícitamente qué vars expone.
- stdin/stdout aislados; stderr capturado a `~/.toolhub/logs/<mcp>.log` con rotación (10MB × 5).

### 8.3 Secrets
- toolhub **no maneja secrets propios** en v0.1.
- Los secrets de MCPs hijos (tokens API, etc.) vienen del env del usuario; toolhub los pasa tal cual al spawn.
- SQLite no persiste ningún valor que venga de `arguments` o `result`.

### 8.4 Config File Safety
- `~/.claude.json` solo se lee. `migrate --apply` escribe con:
  - Validación de JSON antes de reemplazar
  - Backup atómico (`.claude.json.toolhub-backup-<ts>`)
  - Write via `fs.writeFileSync` con `flag: 'wx'` a un temp, luego `rename`.

### 8.5 OWASP Considerations
| Risk | Mitigación |
|---|---|
| Injection (command) | No se interpola nada a shell; spawn usa `args[]` |
| Path traversal | CLI expande paths con `path.resolve`; nunca concatena strings |
| SSRF | No se hacen requests HTTP en v0.1 |
| Secrets in logs | Metadata-only + filtrar stderr para patrones `sk-*`, `ghp_*`, etc. |

---

## 9. Performance

| Target | Valor |
|---|---|
| Overhead de proxy en `invoke` | ≤ 50ms p95 |
| Arranque cold (5 MCPs) | ≤ 3s |
| Memoria en idle | ≤ 150 MB (principal + hijos) |
| Write de telemetría | no bloqueante (cola async) |

**Medición**: métricas exportadas en `toolhub status --json` + incluidas en `toolhub stats`.

---

## 10. Testing Strategy

| Capa | Herramienta | Qué testea |
|---|---|---|
| Unit | Vitest | Catalog, Router, ConfigReader (parsing), Tokenizer |
| Integration | Vitest + MCP mock | Flujo completo con 2-3 MCPs mock en-proceso |
| Snapshot | Vitest | Parsing de `~/.claude.json` contra fixtures reales |
| Smoke | script bash en CI | `toolhub init` + invocación end-to-end |

**Coverage target (MVP)**: rutas críticas (router, supervisor restart, migrate --revert) con tests; no target numérico.

---

## 11. Deployment & Distribution

- **npm registry**: `toolhub` (paquete global + `npx` soportado).
- **Entry point**: `bin/toolhub.js` (CLI) + `bin/toolhub-mcp-server.js` (el proceso que Claude Code invoca).
- **Postinstall**: crea `~/.toolhub/` si no existe, inicializa `state.db` con el esquema.
- **Matriz CI**: macOS, Linux, Windows × Node 20, 22.
- **Release**: GitHub Actions → semantic-release → npm.

---

## 12. CLI Surface (v0.1)

```
toolhub init                    # detecta MCPs en ~/.claude.json, muestra resumen
toolhub migrate --dry-run       # genera diff del ~/.claude.json
toolhub migrate --apply         # aplica con backup
toolhub migrate --revert        # restaura último backup
toolhub status [--json]         # estado del proceso + MCPs hijos
toolhub stats [--since 7d]      # uso agregado
toolhub unused [--since 7d]     # tools no invocadas
toolhub enable <tool_id>
toolhub disable <tool_id>
toolhub --mcp-server            # modo servidor (invocado por Claude Code)
```

---

## 13. Repository Layout

```
toolhub/
├── bin/
│   ├── toolhub.js                 # CLI entry
│   └── toolhub-mcp-server.js      # MCP server entry (invoked by client)
├── src/
│   ├── config/
│   │   ├── claude-code.ts
│   │   └── types.ts
│   ├── server/facade.ts
│   ├── client/mcp-client.ts
│   ├── supervisor/
│   │   ├── index.ts
│   │   └── backoff.ts
│   ├── catalog/index.ts
│   ├── router/index.ts
│   ├── telemetry/
│   │   ├── writer.ts
│   │   └── schema.sql
│   ├── tokenizer/index.ts
│   ├── cli/
│   │   ├── init.ts
│   │   ├── migrate.ts
│   │   ├── status.ts
│   │   ├── stats.ts
│   │   ├── unused.ts
│   │   └── toggle.ts
│   └── index.ts
├── test/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   │   └── claude.json
│   └── mocks/mcp-mock-server.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .github/workflows/ci.yml
├── LICENSE (MIT)
└── README.md
```

---

## 14. Observability

- Logs estructurados JSON a `~/.toolhub/logs/toolhub.log`.
- Niveles: `error | warn | info | debug`. Default `info`. Override via `TOOLHUB_LOG_LEVEL`.
- `toolhub status --json` expone: uptime, children state, last errors, queue depth del writer de telemetría.

---

## 15. Risks & Open Questions

### Risks técnicos (ver §7 del README)
Cubiertos en §2 Architecture y §7 Design Decisions.

### Open for v0.2+
- Modo búsqueda (BM25/FTS5).
- Retention policy configurable.
- Per-project profiles.
- Cursor adapter.
