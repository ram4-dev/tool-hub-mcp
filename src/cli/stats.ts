import { initDb, getToolhubDir } from '../telemetry/init.js';

const MIN_SAMPLES_FOR_PERCENTILE = 5;

function parseSince(since: string | undefined): string {
  // Support "7d", "24h", "30m". Defaults to 7d.
  const s = since ?? '7d';
  const m = /^(\d+)([dhm])$/.exec(s);
  const now = Date.now();
  if (!m) return new Date(now - 7 * 86400_000).toISOString();
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === 'd' ? n * 86400_000 : unit === 'h' ? n * 3600_000 : n * 60_000;
  return new Date(now - ms).toISOString();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface StatsOptions {
  since?: string;
  toolhubDir?: string;
}

export async function runStats(opts: StatsOptions = {}): Promise<void> {
  const db = initDb({ toolhubDir: getToolhubDir(opts.toolhubDir) });
  try {
    const since = parseSince(opts.since);
    const rows = db
      .prepare(
        `SELECT tool_id, mcp_name, latency_ms, success, tokens_saved_estimate
         FROM invocations WHERE ts >= ?`,
      )
      .all(since) as Array<{
      tool_id: string;
      mcp_name: string;
      latency_ms: number;
      success: number;
      tokens_saved_estimate: number | null;
    }>;

    console.log(`Stats since ${since} — ${rows.length} invocations`);
    if (rows.length === 0) return;

    const byTool = new Map<string, number>();
    const byMcp = new Map<string, number>();
    let tokensSaved = 0;
    const latencies: number[] = [];
    for (const r of rows) {
      byTool.set(r.tool_id, (byTool.get(r.tool_id) ?? 0) + 1);
      byMcp.set(r.mcp_name, (byMcp.get(r.mcp_name) ?? 0) + 1);
      tokensSaved += r.tokens_saved_estimate ?? 0;
      latencies.push(r.latency_ms);
    }
    latencies.sort((a, b) => a - b);

    const topTools = Array.from(byTool.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topMcps = Array.from(byMcp.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    console.log('\nTop tools:');
    for (const [n, c] of topTools) console.log(`  ${c.toString().padStart(4)}  ${n}`);
    console.log('\nTop MCPs:');
    for (const [n, c] of topMcps) console.log(`  ${c.toString().padStart(4)}  ${n}`);

    console.log('\nLatency (ms):');
    const count = latencies.length;
    const min = latencies[0];
    const max = latencies[count - 1];
    const avg = Math.round(latencies.reduce((s, v) => s + v, 0) / count);
    if (count < MIN_SAMPLES_FOR_PERCENTILE) {
      console.log('  (sample size too small — percentiles approximate)');
      console.log(`  count=${count}  min=${min}  max=${max}  avg=${avg}`);
    } else {
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const p99 = percentile(latencies, 99);
      console.log(`  count=${count}  min=${min}  max=${max}  avg=${avg}`);
      console.log(`  p50=${p50}  p95=${p95}  p99=${p99}`);
    }

    console.log(`\nTokens saved (estimated sum): ${tokensSaved}`);
  } finally {
    db.close();
  }
}
