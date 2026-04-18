-- toolhub state.db schema (v0.1)
-- See spec §5 Data Model

CREATE TABLE IF NOT EXISTS tools (
  tool_id           TEXT PRIMARY KEY,
  mcp_name          TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  short_description TEXT NOT NULL,
  full_schema_json  TEXT NOT NULL,
  schema_tokens     INTEGER NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tools_mcp ON tools(mcp_name);
CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);

CREATE TABLE IF NOT EXISTS invocations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id               TEXT NOT NULL,
  mcp_name              TEXT NOT NULL,
  ts                    TEXT NOT NULL,
  latency_ms            INTEGER NOT NULL,
  success               INTEGER NOT NULL,
  error_kind            TEXT,
  tokens_saved_estimate INTEGER
);

CREATE INDEX IF NOT EXISTS idx_inv_ts ON invocations(ts);
CREATE INDEX IF NOT EXISTS idx_inv_tool ON invocations(tool_id);
CREATE INDEX IF NOT EXISTS idx_inv_mcp ON invocations(mcp_name);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT PRIMARY KEY,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  total_tools          INTEGER NOT NULL,
  total_tokens_if_full INTEGER NOT NULL,
  total_tokens_exposed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_status (
  mcp_name        TEXT PRIMARY KEY,
  pid             INTEGER,
  state           TEXT NOT NULL,
  restart_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_restart_at TEXT
);
