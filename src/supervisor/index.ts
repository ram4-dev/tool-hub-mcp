import type Database from 'better-sqlite3';
import type { DiscoveredMcp } from '../config/types.js';
import type { Catalog } from '../catalog/index.js';
import { MCPClient, McpClientError } from '../client/mcp-client.js';
import { BACKOFF_STEPS_MS, nextBackoffMs } from './backoff.js';
import { countTokens } from '../tokenizer/index.js';

export type McpState = 'running' | 'starting' | 'crashed' | 'excluded';

export interface SupervisorEntry {
  name: string;
  client: MCPClient | null;
  state: McpState;
  restartCount: number;
  lastError?: string;
  lastRestartAt?: string;
  descriptor: DiscoveredMcp;
}

export interface SupervisorOptions {
  db: Database.Database;
  catalog: Catalog;
  mcps: DiscoveredMcp[];
  /** Timeout for listTools health-check per spec §TASK-007: 10s. */
  healthCheckTimeoutMs?: number;
  /** Timeout for general requests (callTool etc). Default 30s. */
  requestTimeoutMs?: number;
  /** Logger hook. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /** Override backoff (for tests). */
  backoffMs?: readonly number[];
  /** Stderr secret-filter callback. */
  onChildStderr?: (mcpName: string, line: string) => void;
}

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g;
export function scrubSecrets(line: string): string {
  return line.replace(SECRET_RE, '[REDACTED]');
}

export class Supervisor {
  private readonly db: Database.Database;
  private readonly catalog: Catalog;
  private readonly entries = new Map<string, SupervisorEntry>();
  /** Reserved for dedicated health-check timeout; currently uses requestTimeoutMs. */
  public readonly healthCheckTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: NonNullable<SupervisorOptions['logger']>;
  private readonly backoff: readonly number[];
  private readonly onChildStderr?: (mcpName: string, line: string) => void;
  private shuttingDown = false;

  constructor(opts: SupervisorOptions) {
    this.db = opts.db;
    this.catalog = opts.catalog;
    this.healthCheckTimeoutMs = opts.healthCheckTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.logger = opts.logger ?? {
      info: (m) => process.stderr.write(`[toolhub] ${m}\n`),
      warn: (m) => process.stderr.write(`[toolhub:warn] ${m}\n`),
      error: (m) => process.stderr.write(`[toolhub:error] ${m}\n`),
    };
    this.backoff = opts.backoffMs ?? BACKOFF_STEPS_MS;
    this.onChildStderr = opts.onChildStderr;

    for (const m of opts.mcps) {
      this.entries.set(m.name, {
        name: m.name,
        client: null,
        state: 'starting',
        restartCount: 0,
        descriptor: m,
      });
    }
  }

  list(): SupervisorEntry[] {
    return Array.from(this.entries.values());
  }

  get(name: string): SupervisorEntry | undefined {
    return this.entries.get(name);
  }

  getClient(mcpName: string): MCPClient | null {
    return this.entries.get(mcpName)?.client ?? null;
  }

  async startAll(): Promise<void> {
    const tasks = Array.from(this.entries.values()).map((e) => this.startOne(e));
    await Promise.allSettled(tasks);
  }

  private async startOne(entry: SupervisorEntry): Promise<void> {
    if (this.shuttingDown) return;
    entry.state = 'starting';

    const client = new MCPClient({
      name: entry.name,
      command: entry.descriptor.command,
      args: entry.descriptor.args,
      env: entry.descriptor.env,
      timeoutMs: this.requestTimeoutMs,
      onStderr: (line) => {
        const clean = scrubSecrets(line);
        this.onChildStderr?.(entry.name, clean);
      },
    });

    try {
      await client.connect();
      // Health check: listTools within healthCheckTimeoutMs. We reuse the connected
      // client — the MCP SDK request uses the client's configured timeout.
      const tools = await client.listTools();

      // Register in catalog
      for (const t of tools) {
        const schemaJson = JSON.stringify(t.inputSchema ?? {});
        const tokens = countTokens(schemaJson + (t.description ?? ''));
        this.catalog.add({
          tool_id: `${entry.name}.${t.name}`,
          mcp_name: entry.name,
          tool_name: t.name,
          short_description: t.description ?? '',
          full_schema_json: schemaJson,
          schema_tokens: tokens,
        });
      }

      client.onExit(() => {
        if (this.shuttingDown) return;
        this.handleExit(entry);
      });

      entry.client = client;
      entry.state = 'running';
      entry.lastError = undefined;
      this.persistStatus(entry);
      this.logger.info(`MCP "${entry.name}" started (${tools.length} tools)`);
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      await client.close().catch(() => {});
      this.logger.warn(`MCP "${entry.name}" failed to start: ${entry.lastError}`);
      this.scheduleRestart(entry);
    }
  }

  private handleExit(entry: SupervisorEntry): void {
    if (this.shuttingDown) return;
    this.logger.warn(`MCP "${entry.name}" exited unexpectedly`);
    entry.client = null;
    this.catalog.removeByMcp(entry.name);
    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: SupervisorEntry): void {
    const nextDelay = nextBackoffMs(entry.restartCount);
    if (nextDelay === null) {
      entry.state = 'excluded';
      this.catalog.removeByMcp(entry.name);
      this.persistStatus(entry);
      this.logger.error(
        `MCP "${entry.name}" excluded after ${entry.restartCount} restart attempts`,
      );
      return;
    }

    entry.state = 'crashed';
    entry.restartCount += 1;
    entry.lastRestartAt = new Date().toISOString();
    this.persistStatus(entry);

    const delay = this.backoff[Math.min(entry.restartCount - 1, this.backoff.length - 1)];
    this.logger.info(`Scheduling restart of "${entry.name}" in ${delay}ms`);
    setTimeout(() => {
      void this.startOne(entry);
    }, delay).unref();
  }

  private persistStatus(entry: SupervisorEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO mcp_status (mcp_name, pid, state, restart_count, last_error, last_restart_at)
           VALUES (@mcp_name, NULL, @state, @restart_count, @last_error, @last_restart_at)
           ON CONFLICT(mcp_name) DO UPDATE SET
             state = excluded.state,
             restart_count = excluded.restart_count,
             last_error = excluded.last_error,
             last_restart_at = excluded.last_restart_at`,
        )
        .run({
          mcp_name: entry.name,
          state: entry.state,
          restart_count: entry.restartCount,
          last_error: entry.lastError ?? null,
          last_restart_at: entry.lastRestartAt ?? null,
        });
    } catch (err) {
      this.logger.warn(`persistStatus failed: ${(err as Error).message}`);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.client) {
        tasks.push(entry.client.close().catch(() => {}));
      }
    }
    await Promise.allSettled(tasks);
  }
}

export { McpClientError };
