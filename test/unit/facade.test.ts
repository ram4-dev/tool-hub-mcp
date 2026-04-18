import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/telemetry/init.js';
import { Catalog } from '../../src/catalog/index.js';
import { TelemetryWriter } from '../../src/telemetry/writer.js';
import { Router } from '../../src/router/index.js';
import { ServerFacade } from '../../src/server/facade.js';

class FakeSupervisor {
  getClient(_mcp: string) {
    return {
      isConnected: () => true,
      callTool: async (_n: string, args: Record<string, unknown>) => ({ ok: true, args }),
    } as any;
  }
}

async function makeWired() {
  const db = initDb({ inMemory: true });
  const telemetry = new TelemetryWriter({ db, flushIntervalMs: 10 });
  telemetry.start();
  const catalog = new Catalog(db);
  const router = new Router({
    catalog,
    supervisor: new FakeSupervisor() as any,
    telemetry,
  });
  const facade = new ServerFacade(router);

  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([
    facade.getServer().connect(serverTx),
    client.connect(clientTx),
  ]);

  return { db, telemetry, catalog, facade, client };
}

describe('ServerFacade', () => {
  let wired: Awaited<ReturnType<typeof makeWired>>;

  beforeEach(async () => {
    wired = await makeWired();
  });
  afterEach(async () => {
    await wired.client.close();
    await wired.facade.close();
    await wired.telemetry.stop();
    wired.db.close();
  });

  it('get_schema with invalid-regex tool_id returns TOOL_NOT_FOUND (SEC-001)', async () => {
    const res: any = await wired.client.callTool({
      name: 'get_schema',
      arguments: { name: 'NotAValidId!!' },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error.kind).toBe('TOOL_NOT_FOUND');
  });

  it('get_schema for unknown (but regex-valid) tool still returns TOOL_NOT_FOUND', async () => {
    const res: any = await wired.client.callTool({
      name: 'get_schema',
      arguments: { name: 'nope.missing' },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error.kind).toBe('TOOL_NOT_FOUND');
  });

  it('invoke with missing name returns INVALID_PARAMS (QUAL-002)', async () => {
    const res: any = await wired.client.callTool({
      name: 'invoke',
      arguments: {},
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error.kind).toBe('INVALID_PARAMS');
  });

  it('get_schema with non-string name returns INVALID_PARAMS', async () => {
    const res: any = await wired.client.callTool({
      name: 'get_schema',
      arguments: { name: 123 as unknown as string },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error.kind).toBe('INVALID_PARAMS');
  });
});
