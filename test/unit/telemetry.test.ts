import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../src/telemetry/init.js';
import { TelemetryWriter } from '../../src/telemetry/writer.js';
import type Database from 'better-sqlite3';

describe('TelemetryWriter', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb({ inMemory: true });
  });
  afterEach(() => {
    db.close();
  });

  it('enqueue is non-blocking; flush persists rows', async () => {
    const w = new TelemetryWriter({ db, flushIntervalMs: 10 });
    w.start();
    for (let i = 0; i < 100; i++) {
      w.enqueue({
        tool_id: 'x.y',
        mcp_name: 'x',
        ts: new Date().toISOString(),
        latency_ms: i,
        success: 1,
        error_kind: null,
        tokens_saved_estimate: 10,
      });
    }
    await new Promise((r) => setTimeout(r, 50));
    await w.stop();
    const c = (db.prepare('SELECT COUNT(*) as c FROM invocations').get() as { c: number }).c;
    expect(c).toBe(100);
  });

  it('drops when queue is full', async () => {
    const w = new TelemetryWriter({ db, flushIntervalMs: 1000, maxQueue: 5 });
    w.start();
    for (let i = 0; i < 100; i++) {
      w.enqueue({
        tool_id: 'x.y',
        mcp_name: 'x',
        ts: new Date().toISOString(),
        latency_ms: i,
        success: 1,
        error_kind: null,
        tokens_saved_estimate: 10,
      });
    }
    expect(w.droppedCount()).toBeGreaterThan(0);
    await w.stop();
  });

  it('stress: 10k enqueue calls are fast and eventually persist', async () => {
    const w = new TelemetryWriter({ db, flushIntervalMs: 20, maxQueue: 20_000 });
    w.start();
    const start = Date.now();
    for (let i = 0; i < 10_000; i++) {
      w.enqueue({
        tool_id: 'x.y',
        mcp_name: 'x',
        ts: new Date().toISOString(),
        latency_ms: i,
        success: 1,
        error_kind: null,
        tokens_saved_estimate: 10,
      });
    }
    expect(Date.now() - start).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 150));
    await w.stop();
    const c = (db.prepare('SELECT COUNT(*) as c FROM invocations').get() as { c: number }).c;
    expect(c).toBe(10_000);
  });
});
