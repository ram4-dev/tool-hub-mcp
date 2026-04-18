import { initDb, getToolhubDir } from '../telemetry/init.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface McpStatusRow {
  mcp_name: string;
  state: string;
  restart_count: number;
  last_error: string | null;
  last_restart_at: string | null;
}

export interface StatusOptions {
  json?: boolean;
  toolhubDir?: string;
}

export async function runStatus(opts: StatusOptions = {}): Promise<void> {
  const dir = getToolhubDir(opts.toolhubDir);
  const dbExists = existsSync(join(dir, 'state.db'));
  if (!dbExists) {
    const msg = 'toolhub has not been initialized yet. Run `toolhub init` first.';
    if (opts.json) {
      console.log(JSON.stringify({ initialized: false, message: msg }));
    } else {
      console.log(msg);
    }
    return;
  }

  const db = initDb({ toolhubDir: dir });
  try {
    const mcps = db
      .prepare(
        `SELECT mcp_name, state, restart_count, last_error, last_restart_at FROM mcp_status`,
      )
      .all() as McpStatusRow[];

    const totalTools = (db.prepare('SELECT COUNT(*) as c FROM tools').get() as { c: number }).c;
    const enabledTools = (
      db.prepare('SELECT COUNT(*) as c FROM tools WHERE enabled = 1').get() as { c: number }
    ).c;
    const totalTokens = (
      db
        .prepare('SELECT COALESCE(SUM(schema_tokens),0) as t FROM tools WHERE enabled = 1')
        .get() as { t: number }
    ).t;

    // Simple "logs dir listing" — v0.1 keeps it lightweight.
    const logsDir = join(dir, 'logs');
    const logFiles = existsSync(logsDir)
      ? readdirSync(logsDir).map((f) => ({
          name: f,
          bytes: statSync(join(logsDir, f)).size,
        }))
      : [];

    const warning =
      totalTokens > 5000
        ? `Catalog exceeds 5k tokens (${totalTokens}). v0.1 works but will not optimize well — consider waiting for v0.2 search mode or disabling heavy MCPs.`
        : null;

    const payload = {
      initialized: true,
      toolhub_dir: dir,
      pid: process.pid,
      uptime_s: process.uptime(),
      children: mcps,
      catalog: { total: totalTools, enabled: enabledTools, total_tokens: totalTokens },
      logs: logFiles,
      warning,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`toolhub dir: ${dir}`);
      console.log(`catalog:     ${enabledTools}/${totalTools} tools enabled (${totalTokens} tokens)`);
      console.log(`children:    ${mcps.length}`);
      for (const m of mcps) {
        console.log(`  - ${m.mcp_name}: ${m.state} (restarts=${m.restart_count})`);
      }
      if (warning) {
        console.log(`\nwarning: ${warning}`);
      }
    }
  } finally {
    db.close();
  }
}
