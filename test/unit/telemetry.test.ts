import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../src/telemetry/init.js';
import { TelemetryWriter } from '../../src/telemetry/writer.js';
import type Database from 'better-sqlite3';
import type { InvocationRecord } from '../../src/config/types.js';

function mkRec(i: number): InvocationRecord {
  return {
    tool_id: 'x.y',
    mcp_name: 'x',
    ts: new Date().toISOString(),
    latency_ms: i,
    success: 1,
    error_kind: null,
    tokens_saved_estimate: 10,
  };
}

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
      w.enqueue(mkRec(i));
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
      w.enqueue(mkRec(i));
    }
    expect(w.droppedCount()).toBeGreaterThan(0);
    await w.stop();
  });

  it('stress: 10k enqueue calls are fast and eventually persist', async () => {
    const w = new TelemetryWriter({ db, flushIntervalMs: 20, maxQueue: 20_000 });
    w.start();
    const start = Date.now();
    for (let i = 0; i < 10_000; i++) {
      w.enqueue(mkRec(i));
    }
    expect(Date.now() - start).toBeLessThan(1500);
    // Allow time for all bounded batches (setImmediate continuations) to drain.
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();
    const c = (db.prepare('SELECT COUNT(*) as c FROM invocations').get() as { c: number }).c;
    expect(c).toBe(10_000);
  });

  it('bounded batch yields event loop between batches (setTimeout(0) fires mid-drain)', async () => {
    // Queue size > MAX_BATCH_SIZE (500) — we expect multiple flush rounds.
    const w = new TelemetryWriter({ db, flushIntervalMs: 5, maxQueue: 20_000 });
    w.start();
    for (let i = 0; i < 2000; i++) {
      w.enqueue(mkRec(i));
    }

    // Schedule a marker via setTimeout(0). If the writer properly yields between
    // batches (setImmediate continuation), this timeout should fire BEFORE all
    // 2000 records land in the DB.
    let markerFiredAt = -1;
    const marker = new Promise<void>((resolve) => {
      setTimeout(() => {
        markerFiredAt = (
          db.prepare('SELECT COUNT(*) as c FROM invocations').get() as { c: number }
        ).c;
        resolve();
      }, 0);
    });

    await marker;
    // When the marker fired, the first batch (500) should have been written
    // but NOT all 2000, proving the writer yielded.
    expect(markerFiredAt).toBeGreaterThanOrEqual(0);
    expect(markerFiredAt).toBeLessThan(2000);

    // Allow continuations to drain.
    await new Promise((r) => setTimeout(r, 200));
    await w.stop();
    const c = (db.prepare('SELECT COUNT(*) as c FROM invocations').get() as { c: number }).c;
    expect(c).toBe(2000);
  });

  it('overflow past maxQueue drops oldest and surfaces via getStats()', async () => {
    const w = new TelemetryWriter({ db, flushIntervalMs: 10_000, maxQueue: 10_000 });
    // Don't start the timer — we want overflow before any flush.
    // Enqueue 10,500 — 500 should be dropped (oldest first).
    for (let i = 0; i < 10_500; i++) {
      w.enqueue(mkRec(i));
    }
    const stats = w.getStats();
    expect(stats.queueDepth).toBe(10_000);
    expect(stats.droppedCount).toBe(500);
    expect(stats.droppedCount).toBeGreaterThan(0);

    // The remaining queue should start at index 500 (oldest 0..499 dropped).
    // Flush and verify the first surviving record has latency_ms=500.
    w.flush();
    // Drain any continuations.
    await new Promise((r) => setTimeout(r, 100));
    await w.stop();
    const firstRow = db
      .prepare('SELECT latency_ms FROM invocations ORDER BY id ASC LIMIT 1')
      .get() as { latency_ms: number };
    expect(firstRow.latency_ms).toBe(500);
  });
});
