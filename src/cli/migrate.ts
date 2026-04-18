import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
  renameSync,
  statSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';

const TOOLHUB_MCP_SNIPPET = {
  command: 'npx',
  args: ['-y', 'toolhub', '--mcp-server'],
};

function defaultPath(): string {
  return join(homedir(), '.claude.json');
}

function manifestPath(): string {
  return join(homedir(), '.toolhub', 'migrated-mcps.json');
}

function parseJson(text: string): Record<string, unknown> {
  const obj = JSON.parse(text);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('claude.json root must be an object');
  }
  return obj as Record<string, unknown>;
}

export interface BuildMigratedResult {
  migrated: Record<string, unknown>;
  originalMcps: Record<string, unknown> | null;
  unchanged: boolean;
}

function buildMigrated(original: Record<string, unknown>): BuildMigratedResult {
  const existing = original.mcpServers;
  const hasServers =
    typeof existing === 'object' &&
    existing !== null &&
    !Array.isArray(existing);
  const serversObj = hasServers ? (existing as Record<string, unknown>) : {};
  const keys = Object.keys(serversObj);

  // Case 1: already only toolhub — idempotent no-op.
  if (keys.length === 1 && keys[0] === 'toolhub') {
    return { migrated: original, originalMcps: null, unchanged: true };
  }

  // Case 2: no mcpServers or empty.
  if (keys.length === 0) {
    const next = { ...original };
    next.mcpServers = { toolhub: { ...TOOLHUB_MCP_SNIPPET } };
    return { migrated: next, originalMcps: null, unchanged: false };
  }

  // Case 3: has other MCPs — replace and report originals.
  const next = { ...original };
  next.mcpServers = { toolhub: { ...TOOLHUB_MCP_SNIPPET } };
  return { migrated: next, originalMcps: serversObj, unchanged: false };
}

function diffPretty(before: unknown, after: unknown): string {
  const b = JSON.stringify(before, null, 2).split('\n');
  const a = JSON.stringify(after, null, 2).split('\n');
  const out: string[] = [];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) {
    const left = b[i] ?? '';
    const right = a[i] ?? '';
    if (left === right) {
      out.push(`  ${left}`);
    } else {
      if (left) out.push(`- ${left}`);
      if (right) out.push(`+ ${right}`);
    }
  }
  return out.join('\n');
}

function backupName(path: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path}.toolhub-backup-${ts}`;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.toolhub-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { flag: 'wx' });
  renameSync(tmp, path);
}

export interface MigrateOptions {
  dryRun?: boolean;
  apply?: boolean;
  revert?: boolean;
  claudeJsonPath?: string;
}

export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const path = opts.claudeJsonPath ?? defaultPath();

  if (opts.revert) {
    return doRevert(path);
  }

  if (!existsSync(path)) {
    console.error(`Not found: ${path}. Nothing to migrate.`);
    process.exitCode = 1;
    return;
  }

  const originalText = readFileSync(path, 'utf8');
  const original = parseJson(originalText);
  const { migrated, originalMcps, unchanged } = buildMigrated(original);

  if (opts.dryRun || (!opts.apply && !opts.revert)) {
    console.log(`# dry-run diff for ${path}`);
    console.log(diffPretty(original, migrated));
    return;
  }

  // apply
  if (unchanged) {
    console.log(`No changes needed: ${path} is already toolhub-only.`);
    return;
  }

  const migratedText = JSON.stringify(migrated, null, 2);
  // Validate JSON roundtrip
  JSON.parse(migratedText);

  const backup = backupName(path);
  copyFileSync(path, backup);
  atomicWrite(path, migratedText);

  let manifestFile: string | null = null;
  if (originalMcps) {
    manifestFile = manifestPath();
    mkdirSync(dirname(manifestFile), { recursive: true });
    const manifest = {
      timestamp: new Date().toISOString(),
      original: originalMcps,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const n = Object.keys(originalMcps).length;
    console.log(
      `Replacing ${n} existing MCPs with toolhub proxy. Config backup: ${backup}. Manifest: ${manifestFile}.`,
    );
  }

  console.log(`Migrated ${path}`);
  console.log(`Backup:   ${backup}`);
  console.log('Run `toolhub migrate --revert` to restore.');
}

function latestBackup(path: string): string | null {
  const dir = dirname(path);
  const base = basename(path);
  const prefix = `${base}.toolhub-backup-`;
  let best: { file: string; mtime: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    const full = join(dir, f);
    const st = statSync(full);
    if (!best || st.mtimeMs > best.mtime) {
      best = { file: full, mtime: st.mtimeMs };
    }
  }
  return best?.file ?? null;
}

async function doRevert(path: string): Promise<void> {
  const backup = latestBackup(path);
  if (!backup) {
    console.error(`No backup found for ${path}`);
    process.exitCode = 1;
    return;
  }
  const content = readFileSync(backup, 'utf8');
  JSON.parse(content); // validate
  // atomicWrite uses tempfile + rename which overwrites atomically on POSIX.
  atomicWrite(path, content);

  // Best-effort cleanup of manifest.
  try {
    unlinkSync(manifestPath());
  } catch {
    // ignore (ENOENT or other); manifest cleanup is best-effort.
  }

  console.log(`Restored ${path} from ${backup}`);
}
