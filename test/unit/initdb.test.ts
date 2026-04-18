import { describe, it, expect, afterEach } from 'vitest';
import { initDb } from '../../src/telemetry/init.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('initDb', () => {
  it('creates ~/.toolhub/state.db idempotently with WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toolhub-test-'));
    tmpDirs.push(dir);
    const db1 = initDb({ toolhubDir: dir });
    const mode = db1.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe('wal');
    const tables = db1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((r) => r.name);
    expect(names).toContain('tools');
    expect(names).toContain('invocations');
    expect(names).toContain('sessions');
    expect(names).toContain('mcp_status');
    db1.close();

    // Idempotency: running again should not throw.
    const db2 = initDb({ toolhubDir: dir });
    db2.exec('INSERT INTO tools (tool_id, mcp_name, tool_name, short_description, full_schema_json, schema_tokens, enabled, first_seen_at, last_seen_at) VALUES (\'x.y\',\'x\',\'y\',\'d\',\'{}\',1,1,\'t\',\'t\')');
    db2.close();
  });
});
