import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrap, type ToolhubRuntime } from '../../src/index.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mockPath = join(here, '..', 'mocks', 'mcp-mock-server.ts');

// We execute the mock via `tsx`.
function mcpDescriptor(name: string, crashAfter?: number) {
  const args = ['tsx', mockPath, `--name=${name}`];
  if (crashAfter !== undefined) args.push(`--crash-after=${crashAfter}`);
  return {
    name,
    command: 'npx',
    args,
    env: {},
    source: 'test',
  };
}

let runtime: ToolhubRuntime;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'toolhub-e2e-'));
  runtime = await bootstrap({
    toolhubDir: tmpDir,
    mcps: [mcpDescriptor('alpha'), mcpDescriptor('beta')],
  });
}, 60_000);

afterAll(async () => {
  await runtime?.shutdown();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('end-to-end', () => {
  it('discovers tools from both mock MCPs', () => {
    const list = runtime.catalog.list();
    const ids = list.map((e) => e.tool_id).sort();
    expect(ids).toContain('alpha.echo');
    expect(ids).toContain('beta.echo');
  });

  it('invokes a tool via the router and records telemetry', async () => {
    const result = await runtime.router.invoke('alpha.echo', { message: 'hello' });
    expect(result).toBeDefined();
    runtime.telemetry.flush();
    const row = runtime.db
      .prepare('SELECT * FROM invocations WHERE tool_id=?')
      .get('alpha.echo') as any;
    expect(row).toBeDefined();
    expect(row.success).toBe(1);
  });

  it('get_schema returns schema for a known tool', () => {
    const entry = runtime.catalog.get('alpha.echo');
    expect(entry).toBeDefined();
    const schema = JSON.parse(entry!.full_schema_json);
    expect(schema.type).toBe('object');
  });
});
