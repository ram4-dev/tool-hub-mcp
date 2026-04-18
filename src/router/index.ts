import type { Catalog } from '../catalog/index.js';
import type { Supervisor } from '../supervisor/index.js';
import type { TelemetryWriter } from '../telemetry/writer.js';
import type { InvocationRecord, ErrorKind } from '../config/types.js';
import { McpClientError } from '../client/mcp-client.js';

export const TOOL_ID_RE = /^[a-z0-9_-]+\.[a-z0-9_-]+$/;
export const MAX_ARGS_BYTES = 1024 * 1024; // 1MB per §8 Security

export class RouterError extends Error {
  public readonly kind: 'TOOL_NOT_FOUND' | 'MCP_UNAVAILABLE' | 'TIMEOUT' | 'VALIDATION' | 'MCP_ERROR';
  constructor(
    kind: 'TOOL_NOT_FOUND' | 'MCP_UNAVAILABLE' | 'TIMEOUT' | 'VALIDATION' | 'MCP_ERROR',
    message: string,
  ) {
    super(message);
    this.kind = kind;
    this.name = 'RouterError';
  }
}

export interface RouterOptions {
  catalog: Catalog;
  supervisor: Supervisor;
  telemetry: TelemetryWriter;
}

function errorKindFromClientError(err: unknown): ErrorKind {
  if (err instanceof McpClientError) {
    if (err.kind === 'timeout') return 'timeout';
    if (err.kind === 'not_found') return 'not_found';
    return 'mcp_error';
  }
  return 'mcp_error';
}

export class Router {
  private readonly catalog: Catalog;
  private readonly supervisor: Supervisor;
  private readonly telemetry: TelemetryWriter;

  constructor(opts: RouterOptions) {
    this.catalog = opts.catalog;
    this.supervisor = opts.supervisor;
    this.telemetry = opts.telemetry;
  }

  getCatalog(): Catalog {
    return this.catalog;
  }

  validateId(tool_id: string): void {
    if (!TOOL_ID_RE.test(tool_id)) {
      throw new RouterError('VALIDATION', `Invalid tool_id: ${tool_id}`);
    }
  }

  async invoke(tool_id: string, args: Record<string, unknown>): Promise<unknown> {
    this.validateId(tool_id);

    const argsSize = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
    if (argsSize > MAX_ARGS_BYTES) {
      throw new RouterError('VALIDATION', `arguments size ${argsSize} exceeds 1MB limit`);
    }

    const entry = this.catalog.get(tool_id);
    if (!entry || !entry.enabled) {
      this.recordInvocation({
        tool_id,
        mcp_name: entry?.mcp_name ?? 'unknown',
        ts: new Date().toISOString(),
        latency_ms: 0,
        success: 0,
        error_kind: 'not_found',
        tokens_saved_estimate: null,
      });
      throw new RouterError('TOOL_NOT_FOUND', `tool ${tool_id} not found or disabled`);
    }

    const client = this.supervisor.getClient(entry.mcp_name);
    if (!client || !client.isConnected()) {
      this.recordInvocation({
        tool_id,
        mcp_name: entry.mcp_name,
        ts: new Date().toISOString(),
        latency_ms: 0,
        success: 0,
        error_kind: 'mcp_error',
        tokens_saved_estimate: entry.schema_tokens,
      });
      throw new RouterError('MCP_UNAVAILABLE', `MCP "${entry.mcp_name}" is not available`);
    }

    const start = Date.now();
    try {
      const result = await client.callTool(entry.tool_name, args);
      const latency = Date.now() - start;
      this.recordInvocation({
        tool_id,
        mcp_name: entry.mcp_name,
        ts: new Date().toISOString(),
        latency_ms: latency,
        success: 1,
        error_kind: null,
        tokens_saved_estimate: entry.schema_tokens,
      });
      return result;
    } catch (err) {
      const latency = Date.now() - start;
      const kind = errorKindFromClientError(err);
      this.recordInvocation({
        tool_id,
        mcp_name: entry.mcp_name,
        ts: new Date().toISOString(),
        latency_ms: latency,
        success: 0,
        error_kind: kind,
        tokens_saved_estimate: entry.schema_tokens,
      });
      if (err instanceof McpClientError && err.kind === 'timeout') {
        throw new RouterError('TIMEOUT', err.message);
      }
      throw new RouterError('MCP_ERROR', (err as Error).message);
    }
  }

  private recordInvocation(rec: InvocationRecord): void {
    this.telemetry.enqueue(rec);
  }
}
