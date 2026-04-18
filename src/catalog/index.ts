import type Database from 'better-sqlite3';
import type { ToolEntry } from '../config/types.js';

export interface AddToolInput {
  tool_id: string;
  mcp_name: string;
  tool_name: string;
  short_description: string;
  full_schema_json: string;
  schema_tokens: number;
}

/**
 * In-memory catalog backed by the `tools` table.
 * Synchronous (better-sqlite3) — safe to call from the event loop.
 */
export class Catalog {
  private readonly map = new Map<string, ToolEntry>();
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.loadFromDb();
  }

  private loadFromDb(): void {
    const rows = this.db
      .prepare(
        `SELECT tool_id, mcp_name, tool_name, short_description, full_schema_json,
                schema_tokens, enabled, first_seen_at, last_seen_at
         FROM tools`,
      )
      .all() as Array<{
      tool_id: string;
      mcp_name: string;
      tool_name: string;
      short_description: string;
      full_schema_json: string;
      schema_tokens: number;
      enabled: number;
      first_seen_at: string;
      last_seen_at: string;
    }>;
    for (const row of rows) {
      this.map.set(row.tool_id, { ...row, enabled: row.enabled === 1 });
    }
  }

  /** Upsert a tool. Preserves enabled flag and first_seen_at when already present. */
  add(input: AddToolInput): ToolEntry {
    const now = new Date().toISOString();
    const existing = this.map.get(input.tool_id);

    const entry: ToolEntry = {
      tool_id: input.tool_id,
      mcp_name: input.mcp_name,
      tool_name: input.tool_name,
      short_description: input.short_description,
      full_schema_json: input.full_schema_json,
      schema_tokens: input.schema_tokens,
      enabled: existing?.enabled ?? true,
      first_seen_at: existing?.first_seen_at ?? now,
      last_seen_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO tools (tool_id, mcp_name, tool_name, short_description, full_schema_json,
                            schema_tokens, enabled, first_seen_at, last_seen_at)
         VALUES (@tool_id, @mcp_name, @tool_name, @short_description, @full_schema_json,
                 @schema_tokens, @enabled, @first_seen_at, @last_seen_at)
         ON CONFLICT(tool_id) DO UPDATE SET
           short_description = excluded.short_description,
           full_schema_json  = excluded.full_schema_json,
           schema_tokens     = excluded.schema_tokens,
           last_seen_at      = excluded.last_seen_at`,
      )
      .run({
        ...entry,
        enabled: entry.enabled ? 1 : 0,
      });

    this.map.set(entry.tool_id, entry);
    return entry;
  }

  get(tool_id: string): ToolEntry | undefined {
    return this.map.get(tool_id);
  }

  /** List tools. By default returns only enabled ones. */
  list(opts: { enabledOnly?: boolean } = {}): ToolEntry[] {
    const { enabledOnly = true } = opts;
    const all = Array.from(this.map.values());
    return enabledOnly ? all.filter((e) => e.enabled) : all;
  }

  setEnabled(tool_id: string, enabled: boolean): boolean {
    const existing = this.map.get(tool_id);
    if (!existing) return false;
    existing.enabled = enabled;
    this.db
      .prepare('UPDATE tools SET enabled = ? WHERE tool_id = ?')
      .run(enabled ? 1 : 0, tool_id);
    return true;
  }

  removeByMcp(mcp_name: string): number {
    const toRemove: string[] = [];
    for (const [id, entry] of this.map) {
      if (entry.mcp_name === mcp_name) toRemove.push(id);
    }
    const stmt = this.db.prepare('DELETE FROM tools WHERE tool_id = ?');
    const txn = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id);
    });
    txn(toRemove);
    for (const id of toRemove) this.map.delete(id);
    return toRemove.length;
  }

  size(): number {
    return this.map.size;
  }

  totalSchemaTokens(enabledOnly = true): number {
    return this.list({ enabledOnly }).reduce((acc, e) => acc + (e.schema_tokens ?? 0), 0);
  }
}
