import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default directory for toolhub state
export const DEFAULT_TOOLHUB_DIR = join(homedir(), '.toolhub');

export function getToolhubDir(override?: string): string {
  return override ?? process.env.TOOLHUB_HOME ?? DEFAULT_TOOLHUB_DIR;
}

export function getDbPath(toolhubDir?: string): string {
  return join(getToolhubDir(toolhubDir), 'state.db');
}

function loadSchemaSql(): string {
  // Resolve schema.sql relative to this module. Works in both dist/ and src/ layouts.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'schema.sql'),
    join(here, '..', '..', 'src', 'telemetry', 'schema.sql'),
    join(here, '..', '..', '..', 'src', 'telemetry', 'schema.sql'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8');
  }
  throw new Error('schema.sql not found (looked in: ' + candidates.join(', ') + ')');
}

export interface InitDbOptions {
  /** Override the directory where state.db lives. Defaults to ~/.toolhub. */
  toolhubDir?: string;
  /** If true, opens :memory: instead of a file (for tests). */
  inMemory?: boolean;
}

export function initDb(options: InitDbOptions = {}): Database.Database {
  let dbPath: string;
  if (options.inMemory) {
    dbPath = ':memory:';
  } else {
    const dir = getToolhubDir(options.toolhubDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    dbPath = join(dir, 'state.db');
  }

  const db = new Database(dbPath);

  if (!options.inMemory) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const schema = loadSchemaSql();
  db.exec(schema);

  return db;
}
