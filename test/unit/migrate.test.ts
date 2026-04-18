import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrate } from '../../src/cli/migrate.js';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
const savedHome: { value: string | undefined } = { value: undefined };

beforeEach(() => {
  savedHome.value = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), 'toolhub-home-'));
  dirs.push(homeDir);
  process.env.HOME = homeDir;
});

afterEach(() => {
  if (savedHome.value === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome.value;
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeClaudeJson(
  servers: Record<string, unknown> = {
    github: { command: 'node', args: ['gh.js'] },
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'toolhub-migrate-'));
  dirs.push(dir);
  const path = join(dir, 'claude.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: servers,
      },
      null,
      2,
    ),
  );
  return path;
}

function manifestFilePath(): string {
  return join(process.env.HOME as string, '.toolhub', 'migrated-mcps.json');
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

  it('apply twice is idempotent (no second backup when already toolhub-only)', async () => {
    const path = makeClaudeJson();
    await runMigrate({ apply: true, claudeJsonPath: path });
    const backupsAfterFirst = readdirSync(join(path, '..')).filter((f) =>
      f.includes('.toolhub-backup-'),
    );
    expect(backupsAfterFirst.length).toBe(1);

    const configAfterFirst = readFileSync(path, 'utf8');

    // Sleep a ms to ensure any new backup would have a different timestamp.
    await new Promise((r) => setTimeout(r, 5));

    await runMigrate({ apply: true, claudeJsonPath: path });

    const backupsAfterSecond = readdirSync(join(path, '..')).filter((f) =>
      f.includes('.toolhub-backup-'),
    );
    expect(backupsAfterSecond.length).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(configAfterFirst);
  });

  it('creates manifest file when replacing multiple MCPs', async () => {
    const path = makeClaudeJson({
      github: { command: 'node', args: ['gh.js'] },
      linear: { command: 'node', args: ['linear.js'] },
    });
    await runMigrate({ apply: true, claudeJsonPath: path });

    const mp = manifestFilePath();
    expect(existsSync(mp)).toBe(true);
    const manifest = JSON.parse(readFileSync(mp, 'utf8'));
    expect(typeof manifest.timestamp).toBe('string');
    expect(manifest.original.github).toEqual({
      command: 'node',
      args: ['gh.js'],
    });
    expect(manifest.original.linear).toEqual({
      command: 'node',
      args: ['linear.js'],
    });
  });

  it('revert removes manifest file', async () => {
    const path = makeClaudeJson({
      github: { command: 'node', args: ['gh.js'] },
    });
    await runMigrate({ apply: true, claudeJsonPath: path });
    const mp = manifestFilePath();
    expect(existsSync(mp)).toBe(true);

    await runMigrate({ revert: true, claudeJsonPath: path });
    expect(existsSync(mp)).toBe(false);
  });
});
