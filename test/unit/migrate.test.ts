import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrate } from '../../src/cli/migrate.js';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
beforeEach(() => {});
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeClaudeJson() {
  const dir = mkdtempSync(join(tmpdir(), 'toolhub-migrate-'));
  dirs.push(dir);
  const path = join(dir, 'claude.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: { github: { command: 'node', args: ['gh.js'] } },
      },
      null,
      2,
    ),
  );
  return path;
}

describe('migrate', () => {
  it('dry-run prints diff without writing', async () => {
    const path = makeClaudeJson();
    const original = readFileSync(path, 'utf8');
    await runMigrate({ dryRun: true, claudeJsonPath: path });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('apply creates backup and writes migrated json', async () => {
    const path = makeClaudeJson();
    const original = readFileSync(path, 'utf8');
    await runMigrate({ apply: true, claudeJsonPath: path });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers.toolhub).toBeDefined();
    const files = readdirSync(join(path, '..'));
    expect(files.some((f) => f.includes('.toolhub-backup-'))).toBe(true);
    expect(original.includes('github')).toBe(true);
  });

  it('revert restores last backup', async () => {
    const path = makeClaudeJson();
    const original = readFileSync(path, 'utf8');
    await runMigrate({ apply: true, claudeJsonPath: path });
    await runMigrate({ revert: true, claudeJsonPath: path });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
