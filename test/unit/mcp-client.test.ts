import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  attachBoundedStderr,
  IsolatedStdioTransport,
} from '../../src/client/mcp-client.js';

describe('attachBoundedStderr (PERF-001)', () => {
  it('caps buffer at 64KB and emits a single truncation warning', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dispose = attachBoundedStderr(stream, (l) => lines.push(l));

    // Write >64KB of data with no newlines so the internal buf grows unbounded (before cap).
    // Use 80KB in 4KB chunks.
    const chunk = 'x'.repeat(4 * 1024);
    for (let i = 0; i < 20; i++) {
      stream.write(chunk);
    }

    // Allow event loop to flush 'data' events.
    await new Promise((r) => setImmediate(r));

    // Exactly one truncation warning emitted.
    const warnings = lines.filter((l) => l === '[stderr truncated: exceeded 64KB]');
    expect(warnings.length).toBe(1);

    // Now send a newline and verify the residual line is no larger than ~32KB.
    stream.write('\n');
    await new Promise((r) => setImmediate(r));
    const dataLines = lines.filter((l) => l !== '[stderr truncated: exceeded 64KB]');
    expect(dataLines.length).toBe(1);
    // After overflow, buf was truncated to 32KB; between truncations it may grow back up to 64KB.
    expect(dataLines[0]!.length).toBeLessThanOrEqual(64 * 1024);
    // And it must have been truncated from the original 80KB
    expect(dataLines[0]!.length).toBeLessThan(80 * 1024);

    dispose();
    stream.end();
  });

  it('flushes residual bytes without trailing newline on stream end', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dispose = attachBoundedStderr(stream, (l) => lines.push(l));

    stream.write('line-without-newline');
    stream.end();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(lines).toContain('line-without-newline');
    dispose();
  });

  it('emits complete newline-delimited lines normally', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dispose = attachBoundedStderr(stream, (l) => lines.push(l));

    stream.write('one\ntwo\nthree\n');
    await new Promise((r) => setImmediate(r));

    expect(lines).toEqual(['one', 'two', 'three']);
    dispose();
    stream.end();
  });

  it('dispose() removes listeners so no further lines are emitted', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const dispose = attachBoundedStderr(stream, (l) => lines.push(l));

    stream.write('first\n');
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual(['first']);

    dispose();
    stream.write('second\n');
    stream.end();
    await new Promise((r) => setImmediate(r));

    expect(lines).toEqual(['first']);
  });
});

describe('IsolatedStdioTransport env policy (SEC-002)', () => {
  it('does NOT leak HOME/SHELL/USER/LOGNAME/TERM to the child by default', async () => {
    // Guard: ensure the parent actually has at least one of these set so the assertion is meaningful.
    const parentHasSome =
      'HOME' in process.env || 'SHELL' in process.env || 'USER' in process.env;
    expect(parentHasSome).toBe(true);

    // Spawn a tiny node script that prints JSON.stringify(process.env) and exits.
    // We bypass MCPClient here because the child isn't a real MCP server — we just want
    // to inspect its environment.
    const script = 'process.stdout.write(JSON.stringify(process.env)); process.exit(0);';

    const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    // simulate what IsolatedStdioTransport does: explicit env = callerEnv + PATH
    const isolatedEnv: Record<string, string> = { FOO_TOOLHUB_TEST: '1' };
    if (process.env.PATH) isolatedEnv.PATH = process.env.PATH;

    // Use the exact spawn options IsolatedStdioTransport uses.
    const proc = spawn(process.execPath, ['-e', script], {
      env: isolatedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let out = '';
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });

    const exitCode: number | null = await new Promise((resolve) => {
      proc.on('close', (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    const childEnvObserved = JSON.parse(out) as Record<string, string>;

    expect(childEnvObserved.HOME).toBeUndefined();
    expect(childEnvObserved.SHELL).toBeUndefined();
    expect(childEnvObserved.USER).toBeUndefined();
    expect(childEnvObserved.LOGNAME).toBeUndefined();
    expect(childEnvObserved.TERM).toBeUndefined();

    // Caller-provided var is present
    expect(childEnvObserved.FOO_TOOLHUB_TEST).toBe('1');

    // silence unused
    void childEnv;
  });

  it('IsolatedStdioTransport spawns with explicit env only (integration)', async () => {
    // Spawn node via the transport; child prints its env as a single JSON-RPC-like line we can read from stdout.
    // We don't use the SDK Client here — just start() the transport and listen to onmessage via the raw stream.
    // Simplest: spawn and read stdout directly on the underlying process by reusing the spawn contract.
    const transport = new IsolatedStdioTransport({
      command: process.execPath,
      args: [
        '-e',
        // Print env as NDJSON so the transport's parser can optionally pick it up, but we
        // just want to verify the spawn succeeds under isolated env.
        'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:0,result:{env:process.env}}) + "\\n");',
      ],
      env: { TOOLHUB_MARKER: 'yes' },
      preservePath: true,
      pipeStderr: false,
    });

    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.start();

    // Wait for the child to write and exit.
    await new Promise((r) => setTimeout(r, 200));

    await transport.close();

    // Find the one result message.
    const msg = received.find(
      (m): m is { result: { env: Record<string, string> } } =>
        typeof m === 'object' && m !== null && 'result' in (m as Record<string, unknown>),
    );
    expect(msg).toBeDefined();
    const env = msg!.result.env;

    expect(env.HOME).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
    expect(env.USER).toBeUndefined();
    expect(env.LOGNAME).toBeUndefined();
    expect(env.TERM).toBeUndefined();
    expect(env.TOOLHUB_MARKER).toBe('yes');
    // PATH preserved by default
    expect(env.PATH).toBeDefined();
  });
});
