import { initDb, getToolhubDir } from '../telemetry/init.js';

export interface ToggleOptions {
  toolhubDir?: string;
}

function setEnabled(toolId: string, enabled: boolean, opts: ToggleOptions): void {
  const db = initDb({ toolhubDir: getToolhubDir(opts.toolhubDir) });
  try {
    const res = db
      .prepare('UPDATE tools SET enabled = ? WHERE tool_id = ?')
      .run(enabled ? 1 : 0, toolId);
    if (res.changes === 0) {
      console.error(`tool_id not found: ${toolId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${enabled ? 'Enabled' : 'Disabled'} ${toolId}`);
  } finally {
    db.close();
  }
}

export function runEnable(toolId: string, opts: ToggleOptions = {}): void {
  setEnabled(toolId, true, opts);
}

export function runDisable(toolId: string, opts: ToggleOptions = {}): void {
  setEnabled(toolId, false, opts);
}
