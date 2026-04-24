import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getToolhubDir } from './telemetry/init.js';
import { Catalog } from './catalog/index.js';
import { Supervisor } from './supervisor/index.js';
import { Router } from './router/index.js';
import { TelemetryWriter } from './telemetry/writer.js';
import { ServerFacade } from './server/facade.js';
import { readClaudeCodeConfig } from './config/claude-code.js';
import { disposeTokenizer } from './tokenizer/index.js';
import type { DiscoveredMcp } from './config/types.js';

export interface ToolhubRuntime {
  db: Database.Database;
  catalog: Catalog;
  supervisor: Supervisor;
  telemetry: TelemetryWriter;
  router: Router;
  facade: ServerFacade;
  startedAt: Date;
  shutdown: () => Promise<void>;
}

export interface BootstrapOptions {
  toolhubDir?: string;
  mcps?: DiscoveredMcp[]; // override for tests
  inMemoryDb?: boolean;
  /** Override log directory (primarily for tests). */
  logDir?: string;
  /**
   * If true, do NOT await supervisor.startAll() inside bootstrap — caller is responsible
   * for invoking it after connecting stdio. This matters in MCP-server mode where the
   * client (Claude Code) will time out the initialize handshake if bootstrap blocks on
   * 40+ child spawns for up to 30s each. Default false (test/CLI paths are unchanged).
   */
  deferChildStart?: boolean;
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

interface ChildLogStream {
  path: string;
  stream: fs.WriteStream;
  bytes: number;
}

function openLogStream(logPath: string): ChildLogStream {
  let bytes = 0;
  try {
    bytes = fs.statSync(logPath).size;
  } catch {
    bytes = 0;
  }
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  return { path: logPath, stream, bytes };
}

function rotateIfNeeded(entry: ChildLogStream, incoming: number): ChildLogStream {
  if (entry.bytes + incoming < LOG_ROTATE_BYTES) return entry;
  try {
    entry.stream.end();
  } catch {
    // ignore
  }
  const rotated = `${entry.path}.1`;
  try {
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
  } catch {
    // ignore
  }
  try {
    fs.renameSync(entry.path, rotated);
  } catch {
    // ignore — if rename fails we just reopen the same file
  }
  return openLogStream(entry.path);
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<ToolhubRuntime> {
  const db = initDb({ toolhubDir: opts.toolhubDir, inMemory: opts.inMemoryDb });
  const catalog = new Catalog(db);
  const telemetry = new TelemetryWriter({ db });
  telemetry.start();

  const mcps = opts.mcps ?? readClaudeCodeConfig({
    onWarn: (m) => console.error(`[config] ${m}`),
  });

  const logDir = opts.logDir ?? path.join(os.homedir(), '.toolhub', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const streams = new Map<string, ChildLogStream>();
  for (const m of mcps) {
    const logPath = path.join(logDir, `${m.name}.log`);
    streams.set(m.name, openLogStream(logPath));
  }

  const supervisor = new Supervisor({
    db,
    catalog,
    mcps,
    onChildStderr: (name, line) => {
      const existing = streams.get(name);
      if (!existing) return;
      const payload = line + '\n';
      const rotated = rotateIfNeeded(existing, Buffer.byteLength(payload));
      if (rotated !== existing) streams.set(name, rotated);
      rotated.stream.write(payload);
      rotated.bytes += Buffer.byteLength(payload);
    },
  });
  if (!opts.deferChildStart) {
    await supervisor.startAll();
  }

  const router = new Router({ catalog, supervisor, telemetry });
  const facade = new ServerFacade(router);

  const startedAt = new Date();
  const shutdown = async () => {
    await facade.close();
    await supervisor.shutdown();
    await telemetry.stop();
    for (const entry of streams.values()) {
      try {
        entry.stream.end();
      } catch {
        // ignore
      }
    }
    streams.clear();
    disposeTokenizer();
    try {
      db.close();
    } catch {
      // ignore
    }
  };

  return { db, catalog, supervisor, telemetry, router, facade, startedAt, shutdown };
}

export { getToolhubDir };
export * from './config/types.js';
