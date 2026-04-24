import { describe, it, expect } from 'vitest';
import { readClaudeCodeConfig, expandEnvVars } from '../../src/config/claude-code.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'claude.json');

describe('ConfigReader', () => {
  it('parses fixture and expands env vars, skipping invalid entries', () => {
    const warnings: string[] = [];
    const mcps = readClaudeCodeConfig({
      claudeJsonPath: fixture,
      pluginsDir: '/nonexistent-toolhub-plugins',
      manifestPath: '/nonexistent-toolhub-manifest.json',
      onWarn: (m) => warnings.push(m),
    });
    // Expect: github + fs (disabled-one filtered, "bad" invalid => warning)
    const names = mcps.map((m) => m.name).sort();
    expect(names).toEqual(['fs', 'github']);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const github = mcps.find((m) => m.name === 'github')!;
    const expectedToken = process.env.GITHUB_TOKEN ?? '';
    expect(github.env.GITHUB_TOKEN).toBe(expectedToken);
  });

  it('expandEnvVars replaces ${VAR}', () => {
    const env = { FOO: 'bar' };
    expect(expandEnvVars('a-${FOO}-b', env as NodeJS.ProcessEnv)).toBe('a-bar-b');
    expect(expandEnvVars('${MISSING}', {} as NodeJS.ProcessEnv)).toBe('');
  });

  it('findPluginMcpJsonFiles: symlink escape is not followed (SEC-004)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'toolhub-sec004-'));
    try {
      // Structure:
      //   <tmpRoot>/outside/.mcp.json        <-- should NOT be read (outside plugins root)
      //   <tmpRoot>/plugins/                 <-- plugins root passed to reader
      //   <tmpRoot>/plugins/escape -> ../outside  <-- symlink; must be skipped
      const outside = join(tmpRoot, 'outside');
      const pluginsDir = join(tmpRoot, 'plugins');
      mkdirSync(outside, { recursive: true });
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(outside, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            escaped: { command: 'echo', args: ['pwned'] },
          },
        }),
      );

      // Symlink creation may fail on restrictive sandboxes — skip gracefully.
      try {
        symlinkSync(outside, join(pluginsDir, 'escape'));
      } catch (err) {
        console.warn(`skipping symlink-escape test: ${(err as Error).message}`);
        return;
      }

      const warnings: string[] = [];
      const mcps = readClaudeCodeConfig({
        claudeJsonPath: '/nonexistent-toolhub.json',
        pluginsDir,
        manifestPath: '/nonexistent-toolhub-manifest.json',
        onWarn: (m) => warnings.push(m),
      });
      // The symlink-escaped .mcp.json must NOT have been followed.
      expect(mcps.find((m) => m.name === 'escaped')).toBeUndefined();
      expect(mcps).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
