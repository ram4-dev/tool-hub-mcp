import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';

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
  /**
   * If true (default), the full parent env is inherited by the child (matching the behavior
   * of Claude Code / SDK's StdioClientTransport). Real-world MCPs (mcp-remote-proxy, uvx,
   * Zero-Trust-authed services) depend on this to find auth cookies, proxy configs, etc.
   *
   * If false, only a small non-secret allowlist (PATH/HOME/USER/…/LANG) is forwarded.
   * Opt-in for stricter deployments; in either mode, `env` overrides take precedence.
   */
  preservePath?: boolean;
}

const DEFAULT_TIMEOUT = 30_000;
const STDERR_MAX_BYTES = 64 * 1024;
const STDERR_TRUNCATE_TO_BYTES = 32 * 1024;
const STDERR_TRUNCATED_WARN = '[stderr truncated: exceeded 64KB]';

/**
 * Non-secret environment variables standard shell programs expect.
 * Forwarded to children by default so MCPs can find ~/.cache, ~/.config, tmp dirs, etc.
 * Secrets (API keys, tokens) are NEVER forwarded unless explicitly in opts.env.
 */
const SAFE_DEFAULT_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  ...(process.platform === 'win32'
    ? ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SYSTEMROOT', 'PROGRAMFILES', 'PROGRAMDATA', 'TEMP', 'TMP']
    : []),
] as const;

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
 * IsolatedStdioTransport — a minimal MCP stdio transport built on explicit spawn so toolhub
 * can pipe stderr into its own log sink and control lifecycle precisely. See McpClientOptions
 * for env-inheritance policy (preservePath default=true → full parent env; false → safe allowlist).
 *
 * Framing: newline-delimited JSON per MCP stdio spec.
 */
export class IsolatedStdioTransport implements Transport {
  private _process?: ChildProcessWithoutNullStreams;
  private _stderrStream: PassThrough | null = null;
  private _readBuffer: Buffer = Buffer.alloc(0);

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly params: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      preservePath?: boolean;
      pipeStderr?: boolean;
    },
  ) {
    if (params.pipeStderr) {
      this._stderrStream = new PassThrough();
    }
  }

  get stderr(): PassThrough | null {
    return this._stderrStream;
  }

  async start(): Promise<void> {
    if (this._process) {
      throw new Error('IsolatedStdioTransport already started');
    }
    // Env policy:
    //   preservePath=true  (default) → inherit full parent env + caller overrides.
    //     This matches how Claude Code launches MCPs today; real-world MCPs (mcp-remote-proxy,
    //     uvx, Zero-Trust-gated services) depend on HOME/SHELL/proxy vars/auth cookies found in
    //     files referenced by arbitrary env. Narrower defaults broke most children in practice.
    //   preservePath=false → strict: only SAFE_DEFAULT_ENV_KEYS + caller overrides.
    //     Opt-in for stricter deployments that audit exactly what secrets each child sees.
    //
    // In both modes, caller-provided `env` takes precedence over parent env for the same key.
    const preservePath = this.params.preservePath ?? true;
    const env: Record<string, string> = {};
    if (preservePath) {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
    } else {
      for (const key of SAFE_DEFAULT_ENV_KEYS) {
        const v = process.env[key];
        if (v !== undefined) env[key] = v;
      }
    }
    for (const [k, v] of Object.entries(this.params.env ?? {})) {
      env[k] = v;
    }

    return new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.params.command, this.params.args ?? [], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: process.platform === 'win32',
        });
      } catch (err) {
        reject(err as Error);
        return;
      }
      this._process = proc;

      proc.on('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });
      proc.on('spawn', () => {
        resolve();
      });
      proc.on('close', () => {
        this._process = undefined;
        this.onclose?.();
      });
      proc.stdin.on('error', (error) => {
        this.onerror?.(error);
      });
      proc.stdout.on('data', (chunk: Buffer) => {
        this._readBuffer = this._readBuffer.length
          ? Buffer.concat([this._readBuffer, chunk])
          : chunk;
        this.processReadBuffer();
      });
      proc.stdout.on('error', (error) => {
        this.onerror?.(error);
      });
      if (this._stderrStream) {
        proc.stderr.pipe(this._stderrStream);
      }
    });
  }

  private processReadBuffer(): void {
    while (true) {
      const idx = this._readBuffer.indexOf(0x0a /* \n */);
      if (idx === -1) break;
      const line = this._readBuffer.subarray(0, idx).toString('utf8').replace(/\r$/, '');
      this._readBuffer = this._readBuffer.subarray(idx + 1);
      if (line.length === 0) continue;
      try {
        const parsed = JSONRPCMessageSchema.parse(JSON.parse(line));
        this.onmessage?.(parsed);
      } catch (err) {
        this.onerror?.(err as Error);
      }
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._process || !this._process.stdin.writable) {
        reject(new Error('Not connected'));
        return;
      }
      const payload = JSON.stringify(message) + '\n';
      if (this._process.stdin.write(payload)) {
        resolve();
      } else {
        this._process.stdin.once('drain', () => resolve());
      }
    });
  }

  async close(): Promise<void> {
    const proc = this._process;
    if (!proc) {
      this._readBuffer = Buffer.alloc(0);
      return;
    }
    this._process = undefined;
    const closePromise = new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
    });
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
    ]);
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
      ]);
    }
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this._readBuffer = Buffer.alloc(0);
  }
}

/**
 * Attaches a bounded line-oriented stderr reader to the given stream.
 *
 * - Caps internal buffer at 64 KB; on overflow, truncates to the latest 32 KB and emits a
 *   single warning line (`[stderr truncated: exceeded 64KB]`) via onLine.
 * - On stream close/end, flushes any residual bytes without a trailing newline as a final line.
 * - Returns a disposer that removes the listeners (call on transport close).
 */
export function attachBoundedStderr(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  let buf = '';
  let truncatedWarned = false;

  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
    }
    if (Buffer.byteLength(buf, 'utf8') > STDERR_MAX_BYTES) {
      // Truncate to latest 32 KB (by character slice — adequate since UTF-8 sizes are bounded by 4x chars).
      const keepChars = STDERR_TRUNCATE_TO_BYTES;
      buf = buf.length > keepChars ? buf.slice(buf.length - keepChars) : buf;
      if (!truncatedWarned) {
        truncatedWarned = true;
        onLine(STDERR_TRUNCATED_WARN);
      }
    }
  };

  const flushRemainder = (): void => {
    if (buf.length > 0) {
      onLine(buf);
      buf = '';
    }
  };

  const onEnd = (): void => {
    flushRemainder();
  };
  const onClose = (): void => {
    flushRemainder();
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onClose);

  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
    stream.off('close', onClose);
  };
}

/**
 * MCPClient wraps a single child MCP server over stdio.
 * connect() spawns the subprocess, initialize() is handled by the SDK Client internally.
 */
export class MCPClient {
  private client: Client | null = null;
  private transport: IsolatedStdioTransport | null = null;
  private connected = false;
  private stderrDisposer: (() => void) | null = null;
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
    const transport = new IsolatedStdioTransport({
      command: this.opts.command,
      args: this.opts.args ?? [],
      env: this.opts.env,
      preservePath: this.opts.preservePath ?? true,
      pipeStderr: Boolean(this.opts.onStderr),
    });

    const client = new Client(
      { name: 'toolhub', version: '0.1.0' },
      { capabilities: {} },
    );

    await withTimeout(client.connect(transport), this.opts.timeoutMs ?? DEFAULT_TIMEOUT, 'connect');

    // Bounded, line-oriented stderr pump
    const stderr = transport.stderr;
    if (stderr && this.opts.onStderr) {
      this.stderrDisposer = attachBoundedStderr(stderr, this.opts.onStderr);
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
    if (this.stderrDisposer) {
      try {
        this.stderrDisposer();
      } catch {
        // ignore
      }
      this.stderrDisposer = null;
    }
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
    if (this.transport) {
      this.transport.onclose = cb;
    }
  }
}
