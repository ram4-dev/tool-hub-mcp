import type Database from 'better-sqlite3';
import type { InvocationRecord } from '../config/types.js';

export interface TelemetryWriterOptions {
  db: Database.Database;
  /** Bounded queue size. Default 1000. */
  maxQueue?: number;
  /** Flush interval ms. Default 100. */
  flushIntervalMs?: number;
  /** Callback when items are dropped due to backpressure. */
  onDropped?: (count: number) => void;
}

/**
 * Async batching writer for invocation telemetry.
 * enqueue() is sync and non-blocking — drops with warning when the queue is full.
 */
export class TelemetryWriter {
  private readonly db: Database.Database;
  private readonly maxQueue: number;
  private readonly flushIntervalMs: number;
  private readonly onDropped?: (count: number) => void;
  private queue: InvocationRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private dropped = 0;
  private started = false;
  private insertStmt: Database.Statement;

  constructor(opts: TelemetryWriterOptions) {
    this.db = opts.db;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 100;
    this.onDropped = opts.onDropped;
    this.insertStmt = this.db.prepare(
      `INSERT INTO invocations
        (tool_id, mcp_name, ts, latency_ms, success, error_kind, tokens_saved_estimate)
       VALUES (@tool_id, @mcp_name, @ts, @latency_ms, @success, @error_kind, @tokens_saved_estimate)`,
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  depth(): number {
    return this.queue.length;
  }

  droppedCount(): number {
    return this.dropped;
  }

  enqueue(rec: InvocationRecord): void {
    if (this.queue.length >= this.maxQueue) {
      this.dropped += 1;
      this.onDropped?.(1);
      return;
    }
    this.queue.push(rec);
  }

  /** Write all queued items synchronously (called by timer or on shutdown). */
  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const insertMany = this.db.transaction((items: InvocationRecord[]) => {
      for (const item of items) this.insertStmt.run(item);
    });
    try {
      insertMany(batch);
    } catch {
      // On error, best-effort: drop the batch (avoid infinite retries blocking Router).
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    this.started = false;
  }
}
