import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_PLUGIN_WALK_DEPTH = 8;
import {
  ClaudeConfigSchema,
  McpServerConfigSchema,
  type DiscoveredMcp,
  type McpServerConfig,
} from './types.js';

const ENV_VAR_RE = /\$\{([A-Z0-9_]+)\}/gi;

/** Expand ${ENV_VAR} references against the given env map (defaults to process.env). */
export function expandEnvVars(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(ENV_VAR_RE, (_match, name) => env[name] ?? '');
}

function expandMcp(name: string, raw: McpServerConfig, source: string): DiscoveredMcp {
  const args = raw.args.map((a) => expandEnvVars(a));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.env ?? {})) {
    env[k] = expandEnvVars(v);
  }
  return {
    name,
    command: expandEnvVars(raw.command),
    args,
    env,
    source,
  };
}

export interface ReadConfigOptions {
  /** Path to ~/.claude.json override (for tests). */
  claudeJsonPath?: string;
  /** Override plugins dir (for tests). */
  pluginsDir?: string;
  /** Optional logger for validation warnings. */
  onWarn?: (msg: string) => void;
}

function defaultClaudeJsonPath(): string {
  return join(homedir(), '.claude.json');
}

function defaultPluginsDir(): string {
  return join(homedir(), '.claude', 'plugins');
}

function readJsonSafe(path: string, onWarn?: (m: string) => void): unknown | null {
  try {
    const txt = readFileSync(path, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    onWarn?.(`Could not read/parse ${path}: ${(err as Error).message}`);
    return null;
  }
}

function extractMcps(
  raw: unknown,
  source: string,
  onWarn: (m: string) => void,
): DiscoveredMcp[] {
  const parsed = ClaudeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    onWarn(`Invalid config shape at ${source}: ${parsed.error.message}`);
    return [];
  }
  const servers = parsed.data.mcpServers ?? {};
  const out: DiscoveredMcp[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const mcp = McpServerConfigSchema.safeParse(entry);
    if (!mcp.success) {
      onWarn(`Skipping invalid MCP "${name}" in ${source}: ${mcp.error.message}`);
      continue;
    }
    if (mcp.data.disabled) continue;
    out.push(expandMcp(name, mcp.data, source));
  }
  return out;
}

function findPluginMcpJsonFiles(dir: string): string[] {
  const results: string[] = [];
  const root = resolve(dir);
  const walk = (current: string, depth: number) => {
    if (depth > MAX_PLUGIN_WALK_DEPTH) return;
    if (!existsSync(current)) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      // Skip symlinks entirely to prevent path-traversal / loop escapes.
      if (st.isSymbolicLink()) {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile() && entry === '.mcp.json') {
        results.push(full);
      }
    }
  };
  walk(root, 0);
  return results;
}

/**
 * Reads ~/.claude.json and any ~/.claude/plugins/ ** /.mcp.json files,
 * returns a de-duplicated list of MCP servers with env vars expanded.
 * Reads only — never writes. Invalid entries are dropped with a warning.
 */
export function readClaudeCodeConfig(opts: ReadConfigOptions = {}): DiscoveredMcp[] {
  const onWarn = opts.onWarn ?? (() => {});
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const pluginsDir = opts.pluginsDir ?? defaultPluginsDir();

  const seen = new Map<string, DiscoveredMcp>();

  if (existsSync(claudeJsonPath)) {
    const raw = readJsonSafe(claudeJsonPath, onWarn);
    if (raw) {
      for (const mcp of extractMcps(raw, claudeJsonPath, onWarn)) {
        seen.set(mcp.name, mcp);
      }
    }
  }

  for (const pluginFile of findPluginMcpJsonFiles(pluginsDir)) {
    const raw = readJsonSafe(pluginFile, onWarn);
    if (raw) {
      for (const mcp of extractMcps(raw, pluginFile, onWarn)) {
        if (!seen.has(mcp.name)) seen.set(mcp.name, mcp);
      }
    }
  }

  return Array.from(seen.values());
}
