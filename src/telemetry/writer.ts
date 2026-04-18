import type Database from 'better-sqlite3';
import type { InvocationRecord } from '../config/types.js';

/** Max records processed per synchronous flush batch. Larger batches starve the event loop. */
const MAX_BATCH_SIZE = 500;
/** Max items held in the in-memory queue before oldest are dropped. */
const DEFAULT_MAX_QUEUE = 10_000;

export interface TelemetryWriterOptions {
  db: Database.Database;
  /** Bounded queue size. Default 10,000. */
  maxQueue?: number;
  /** Flush interval ms. Default 100. */
  flushIntervalMs?: number;
  /** Callback when items are dropped due to backpressure. */
  onDropped?: (count: number) => void;
}

export interface TelemetryWriterStats {
  queueDepth: number;
  droppedCount: number;
}

/**
 * Async batching writer for invocation telemetry.
 * enqueue() is sync and non-blocking. When the bounded queue is full, the OLDEST
 * record is dropped (FIFO) and droppedCount is incremented.
 *
 * flush() processes up to MAX_BATCH_SIZE records per call inside a single
 * transaction (one fsync per batch). If more records remain, continuation is
 * scheduled via setImmediate so the event loop can service other work.
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
  private flushScheduled = false;
  private readonly insertStmt: Database.Statement;
  private readonly insertMany: (items: InvocationRecord[]) => void;

  constructor(opts: TelemetryWriterOptions) {
    this.db = opts.db;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.flushIntervalMs = opts.flushIntervalMs ?? 100;
    this.onDropped = opts.onDropped;
    // Prepared statement reused across all flushes.
    this.insertStmt = this.db.prepare(
      `INSERT INTO invocations
        (tool_id, mcp_name, ts, latency_ms, success, error_kind, tokens_saved_estimate)
       VALUES (@tool_id, @mcp_name, @ts, @latency_ms, @success, @error_kind, @tokens_saved_estimate)`,
    );
    // Single transaction wrapper — one fsync per batch instead of per row.
    this.insertMany = this.db.transaction((items: InvocationRecord[]) => {
      for (const item of items) this.insertStmt.run(item);
    });
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

  getStats(): TelemetryWriterStats {
    return { queueDepth: this.queue.length, droppedCount: this.dropped };
  }

  enqueue(rec: InvocationRecord): void {
    if (this.queue.length >= this.maxQueue) {
      // Bounded queue: drop OLDEST (FIFO) and count.
      this.queue.shift();
      this.dropped += 1;
      this.onDropped?.(1);
    }
    this.queue.push(rec);
  }

  /**
   * Write up to MAX_BATCH_SIZE queued items synchronously. If more records
   * remain, schedule a continuation via setImmediate so we yield the event loop
   * between batches (keeps invoke p95 under the 50ms spec target during bursts).
   */
  flush(): void {
    if (this.queue.length === 0) return;
    const take = Math.min(this.queue.length, MAX_BATCH_SIZE);
    const batch = this.queue.splice(0, take);
    try {
      this.insertMany(batch);
    } catch {
      // On error, best-effort: drop the batch (avoid infinite retries blocking Router).
    }
    if (this.queue.length > 0 && !this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }

  /** Drain the queue fully (used on shutdown). Synchronously processes all remaining batches. */
  private drain(): void {
    while (this.queue.length > 0) {
      const take = Math.min(this.queue.length, MAX_BATCH_SIZE);
      const batch = this.queue.splice(0, take);
      try {
        this.insertMany(batch);
      } catch {
        // best-effort drop
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.drain();
    this.started = false;
  }
}
