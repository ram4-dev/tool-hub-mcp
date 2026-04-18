import { describe, it, expect } from 'vitest';
import { readClaudeCodeConfig, expandEnvVars } from '../../src/config/claude-code.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'claude.json');

describe('ConfigReader', () => {
  it('parses fixture and expands env vars, skipping invalid entries', () => {
    const warnings: string[] = [];
    const mcps = readClaudeCodeConfig({
      claudeJsonPath: fixture,
      pluginsDir: '/nonexistent-toolhub-plugins',
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
});
