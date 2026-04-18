import { initDb, getToolhubDir } from '../telemetry/init.js';

function parseSince(since: string | undefined): string {
  const s = since ?? '7d';
  const m = /^(\d+)([dhm])$/.exec(s);
  const now = Date.now();
  if (!m) return new Date(now - 7 * 86400_000).toISOString();
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === 'd' ? n * 86400_000 : unit === 'h' ? n * 3600_000 : n * 60_000;
  return new Date(now - ms).toISOString();
}

export interface UnusedOptions {
  since?: string;
  toolhubDir?: string;
}

export async function runUnused(opts: UnusedOptions = {}): Promise<void> {
  const db = initDb({ toolhubDir: getToolhubDir(opts.toolhubDir) });
  try {
    const since = parseSince(opts.since);
    const rows = db
      .prepare(
        `SELECT t.tool_id, t.mcp_name
         FROM tools t
         WHERE t.enabled = 1
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             WHERE i.tool_id = t.tool_id AND i.ts >= ?
           )
         ORDER BY t.mcp_name, t.tool_id`,
      )
      .all(since) as Array<{ tool_id: string; mcp_name: string }>;

    console.log(`Unused tools since ${since} — ${rows.length} found`);
    for (const r of rows) {
      console.log(`  ${r.tool_id}`);
    }
  } finally {
    db.close();
  }
}
