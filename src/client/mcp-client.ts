import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpClientOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Timeout in ms for requests. Default 30_000. */
  timeoutMs?: number;
  /** Stderr sink (optional). Default: pipe to parent stderr, line-filtered. */
  onStderr?: (line: string) => void;
}

const DEFAULT_TIMEOUT = 30_000;

export class McpClientError extends Error {
  public readonly kind: 'timeout' | 'mcp_error' | 'not_found';
  constructor(kind: 'timeout' | 'mcp_error' | 'not_found', message: string) {
    super(message);
    this.kind = kind;
    this.name = 'McpClientError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => {
      reject(new McpClientError('timeout', `${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(to);
        resolve(v);
      },
      (e) => {
        clearTimeout(to);
        reject(e);
      },
    );
  });
}

/**
 * MCPClient wraps a single child MCP server over stdio.
 * connect() spawns the subprocess, initialize() is handled by the SDK Client internally.
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  public readonly opts: Required<Pick<McpClientOptions, 'name' | 'command'>> &
    McpClientOptions;

  constructor(opts: McpClientOptions) {
    this.opts = { ...opts, name: opts.name, command: opts.command };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args ?? [],
      env: this.opts.env,
      stderr: 'pipe',
    });

    const client = new Client(
      { name: 'toolhub', version: '0.1.0' },
      { capabilities: {} },
    );

    await withTimeout(client.connect(transport), this.opts.timeoutMs ?? DEFAULT_TIMEOUT, 'connect');

    // Pipe child stderr to optional sink
    const stderr = transport.stderr;
    if (stderr && this.opts.onStderr) {
      let buf = '';
      stderr.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          this.opts.onStderr!(line);
        }
      });
    }

    this.client = client;
    this.transport = transport;
    this.connected = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.client) throw new McpClientError('mcp_error', 'Not connected');
    try {
      const res = await withTimeout(
        this.client.listTools(),
        this.opts.timeoutMs ?? DEFAULT_TIMEOUT,
        'listTools',
      );
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch (err) {
      if (err instanceof McpClientError) throw err;
      throw new McpClientError('mcp_error', `listTools failed: ${(err as Error).message}`);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new McpClientError('mcp_error', 'Not connected');
    try {
      const res = await withTimeout(
        this.client.callTool({ name, arguments: args }),
        this.opts.timeoutMs ?? DEFAULT_TIMEOUT,
        `callTool(${name})`,
      );
      return res;
    } catch (err) {
      if (err instanceof McpClientError) throw err;
      throw new McpClientError('mcp_error', `callTool(${name}) failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    try {
      await this.transport?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
  }

  /** Registers a callback invoked when the subprocess exits (for supervisor). */
  onExit(cb: () => void): void {
    // The SDK's StdioClientTransport doesn't directly expose exit; rely on close callback.
    if (this.transport) {
      this.transport.onclose = cb;
    }
  }
}
