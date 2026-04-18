import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initDb } from '../../src/telemetry/init.js';
import { runStats } from '../../src/cli/stats.js';

const tmpDirs: string[] = [];

function seedInvocations(dir: string, latencies: number[]): void {
  const db: Database.Database = initDb({ toolhubDir: dir });
  const stmt = db.prepare(
    `INSERT INTO invocations
       (tool_id, mcp_name, ts, latency_ms, success, error_kind, tokens_saved_estimate)
     VALUES (?, ?, ?, ?, 1, NULL, 5)`,
  );
  const ts = new Date().toISOString();
  for (const l of latencies) stmt.run('demo.tool', 'demo', ts, l);
  db.close();
}

describe('runStats percentile sample guard', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logged: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toolhub-stats-test-'));
    tmpDirs.push(dir);
    logged = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged += args.map((a) => String(a)).join(' ') + '\n';
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('skips p50/p95/p99 and shows "approximate" note when N < 5', async () => {
    seedInvocations(dir, [10, 20, 30]); // 3 samples
    await runStats({ toolhubDir: dir, since: '7d' });
    expect(logged).toContain('approximate');
    expect(logged).not.toMatch(/p95=/);
    expect(logged).not.toMatch(/p50=/);
    expect(logged).not.toMatch(/p99=/);
    expect(logged).toMatch(/count=3/);
    expect(logged).toMatch(/min=10/);
    expect(logged).toMatch(/max=30/);
  });

  it('shows percentiles when N >= 5', async () => {
    seedInvocations(dir, [10, 20, 30, 40, 50, 60, 70]); // 7 samples
    await runStats({ toolhubDir: dir, since: '7d' });
    expect(logged).not.toContain('approximate');
    expect(logged).toMatch(/p50=/);
    expect(logged).toMatch(/p95=/);
    expect(logged).toMatch(/p99=/);
  });
});
