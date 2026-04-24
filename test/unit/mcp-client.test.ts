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

describe('IsolatedStdioTransport env policy', () => {
  it('preservePath=true (default) inherits parent env and layers caller overrides on top', async () => {
    const LEAK_KEY = 'TOOLHUB_ENV_PROBE';
    process.env[LEAK_KEY] = 'from-parent';
    try {
      const transport = new IsolatedStdioTransport({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:0,result:{env:process.env}}) + "\\n");',
        ],
        env: { TOOLHUB_MARKER: 'yes' },
        preservePath: true,
        pipeStderr: false,
      });

      const received: unknown[] = [];
      transport.onmessage = (m) => received.push(m);

      await transport.start();
      await new Promise((r) => setTimeout(r, 200));
      await transport.close();

      const msg = received.find(
        (m): m is { result: { env: Record<string, string> } } =>
          typeof m === 'object' && m !== null && 'result' in (m as Record<string, unknown>),
      );
      expect(msg).toBeDefined();
      const env = msg!.result.env;

      expect(env.TOOLHUB_MARKER).toBe('yes');
      expect(env.PATH).toBeDefined();
      // Full parent env is inherited by default (real-world MCPs need proxy/auth vars from parent).
      expect(env[LEAK_KEY]).toBe('from-parent');
    } finally {
      delete process.env[LEAK_KEY];
    }
  });

  it('caller-provided env overrides same-key parent env', async () => {
    const KEY = 'TOOLHUB_OVERRIDE_PROBE';
    process.env[KEY] = 'parent-value';
    try {
      const transport = new IsolatedStdioTransport({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:0,result:{env:process.env}}) + "\\n");',
        ],
        env: { [KEY]: 'caller-value' },
        preservePath: true,
        pipeStderr: false,
      });

      const received: unknown[] = [];
      transport.onmessage = (m) => received.push(m);

      await transport.start();
      await new Promise((r) => setTimeout(r, 200));
      await transport.close();

      const msg = received.find(
        (m): m is { result: { env: Record<string, string> } } =>
          typeof m === 'object' && m !== null && 'result' in (m as Record<string, unknown>),
      );
      expect(msg!.result.env[KEY]).toBe('caller-value');
    } finally {
      delete process.env[KEY];
    }
  });

  it('preservePath=false yields strict env (only safe allowlist + caller vars)', async () => {
    const LEAK_KEY = 'TOOLHUB_STRICT_PROBE';
    process.env[LEAK_KEY] = 'must-not-leak';
    try {
      const transport = new IsolatedStdioTransport({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:0,result:{env:process.env}}) + "\\n");',
        ],
        env: { ONLY_THIS: '1' },
        preservePath: false,
        pipeStderr: false,
      });

      const received: unknown[] = [];
      transport.onmessage = (m) => received.push(m);

      await transport.start();
      await new Promise((r) => setTimeout(r, 200));
      await transport.close();

      const msg = received.find(
        (m): m is { result: { env: Record<string, string> } } =>
          typeof m === 'object' && m !== null && 'result' in (m as Record<string, unknown>),
      );
      expect(msg).toBeDefined();
      const env = msg!.result.env;
      expect(env.ONLY_THIS).toBe('1');
      // Non-allowlisted parent var must not leak in strict mode
      expect(env[LEAK_KEY]).toBeUndefined();
      // But safe allowlist IS present when parent has them
      if (process.env.PATH) expect(env.PATH).toBeDefined();
    } finally {
      delete process.env[LEAK_KEY];
    }
  });
});
