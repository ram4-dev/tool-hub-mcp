import type Database from 'better-sqlite3';
import { initDb, getToolhubDir } from './telemetry/init.js';
import { Catalog } from './catalog/index.js';
import { Supervisor } from './supervisor/index.js';
import { Router } from './router/index.js';
import { TelemetryWriter } from './telemetry/writer.js';
import { ServerFacade } from './server/facade.js';
import { readClaudeCodeConfig } from './config/claude-code.js';
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
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<ToolhubRuntime> {
  const db = initDb({ toolhubDir: opts.toolhubDir, inMemory: opts.inMemoryDb });
  const catalog = new Catalog(db);
  const telemetry = new TelemetryWriter({ db });
  telemetry.start();

  const mcps = opts.mcps ?? readClaudeCodeConfig({
    onWarn: (m) => console.error(`[config] ${m}`),
  });

  const supervisor = new Supervisor({
    db,
    catalog,
    mcps,
  });
  await supervisor.startAll();

  const router = new Router({ catalog, supervisor, telemetry });
  const facade = new ServerFacade(router);

  const startedAt = new Date();
  const shutdown = async () => {
    await facade.close();
    await supervisor.shutdown();
    await telemetry.stop();
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
