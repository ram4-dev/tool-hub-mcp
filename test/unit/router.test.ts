import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../src/telemetry/init.js';
import { Catalog } from '../../src/catalog/index.js';
import { TelemetryWriter } from '../../src/telemetry/writer.js';
import { Router, RouterError, TOOL_ID_RE } from '../../src/router/index.js';
import type Database from 'better-sqlite3';

class FakeClient {
  connected = true;
  isConnected() {
    return this.connected;
  }
  async callTool(_name: string, args: Record<string, unknown>) {
    return { ok: true, args };
  }
}

class FakeSupervisor {
  private client = new FakeClient();
  getClient(_mcp: string) {
    return this.client as any;
  }
}

describe('Router', () => {
  let db: Database.Database;
  let telemetry: TelemetryWriter;

  beforeEach(() => {
    db = initDb({ inMemory: true });
    telemetry = new TelemetryWriter({ db, flushIntervalMs: 10 });
    telemetry.start();
  });
  afterEach(async () => {
    await telemetry.stop();
    db.close();
  });

  it('validates tool_id regex', () => {
    expect(TOOL_ID_RE.test('valid.tool')).toBe(true);
    expect(TOOL_ID_RE.test('no-namespace')).toBe(false);
    expect(TOOL_ID_RE.test('UPPER.case')).toBe(false);
    expect(TOOL_ID_RE.test('a.b.c')).toBe(false);
  });

  it('invokes enabled tool and records invocation', async () => {
    const catalog = new Catalog(db);
    catalog.add({
      tool_id: 'mock.echo',
      mcp_name: 'mock',
      tool_name: 'echo',
      short_description: 'echo',
      full_schema_json: '{}',
      schema_tokens: 3,
    });
    const router = new Router({
      catalog,
      supervisor: new FakeSupervisor() as any,
      telemetry,
    });
    const result = await router.invoke('mock.echo', { message: 'hi' });
    expect(result).toMatchObject({ ok: true });

    telemetry.flush();
    const row = db.prepare('SELECT * FROM invocations ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.success).toBe(1);
    expect(row.tool_id).toBe('mock.echo');
  });

  it('returns TOOL_NOT_FOUND for disabled tool', async () => {
    const catalog = new Catalog(db);
    catalog.add({
      tool_id: 'mock.echo',
      mcp_name: 'mock',
      tool_name: 'echo',
      short_description: 'echo',
      full_schema_json: '{}',
      schema_tokens: 3,
    });
    catalog.setEnabled('mock.echo', false);
    const router = new Router({
      catalog,
      supervisor: new FakeSupervisor() as any,
      telemetry,
    });
    await expect(router.invoke('mock.echo', {})).rejects.toBeInstanceOf(RouterError);
  });

  it('rejects oversized arguments', async () => {
    const catalog = new Catalog(db);
    const router = new Router({
      catalog,
      supervisor: new FakeSupervisor() as any,
      telemetry,
    });
    const big = 'x'.repeat(1024 * 1024 + 100);
    await expect(router.invoke('mock.echo', { big })).rejects.toThrow(/exceeds 1MB/);
  });
});
