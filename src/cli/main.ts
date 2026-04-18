import { Command } from 'commander';
import { runInit } from './init.js';
import { runStatus } from './status.js';
import { runMigrate } from './migrate.js';
import { runStats } from './stats.js';
import { runUnused } from './unused.js';
import { runEnable, runDisable } from './toggle.js';

export function buildCli(): Command {
  const program = new Command();

  program
    .name('toolhub')
    .description('Local MCP proxy for coding agents.')
    .version('0.1.0');

  program
    .command('init')
    .description('Scan ~/.claude.json and print a suggested toolhub MCP snippet.')
    .action(async () => {
      await runInit();
    });

  program
    .command('status')
    .description('Show proxy status (MCPs, catalog size, warnings).')
    .option('--json', 'emit JSON')
    .action(async (opts) => {
      await runStatus({ json: !!opts.json });
    });

  program
    .command('migrate')
    .description('Migrate ~/.claude.json to use toolhub. Use one of --dry-run, --apply, --revert.')
    .option('--dry-run', 'show diff without writing')
    .option('--apply', 'apply the migration (creates backup)')
    .option('--revert', 'restore last backup')
    .action(async (opts) => {
      await runMigrate({ dryRun: opts.dryRun, apply: opts.apply, revert: opts.revert });
    });

  program
    .command('stats')
    .description('Show aggregated usage stats.')
    .option('--since <range>', 'time range, e.g. 7d, 24h, 30m', '7d')
    .action(async (opts) => {
      await runStats({ since: opts.since });
    });

  program
    .command('unused')
    .description('List tools not invoked in the given period.')
    .option('--since <range>', 'time range, e.g. 7d', '7d')
    .action(async (opts) => {
      await runUnused({ since: opts.since });
    });

  program
    .command('enable <tool_id>')
    .description('Re-enable a tool previously disabled.')
    .action((toolId: string) => {
      runEnable(toolId);
    });

  program
    .command('disable <tool_id>')
    .description('Hide a tool from the catalog without touching the MCP.')
    .action((toolId: string) => {
      runDisable(toolId);
    });

  program
    .option('--mcp-server', 'run as MCP server (used by Claude Code). Equivalent to toolhub-mcp-server.')
    .hook('preAction', async (thisCommand) => {
      if (thisCommand.opts().mcpServer) {
        const { runMcpServer } = await import('../mcp-server.js');
        await runMcpServer();
        process.exit(0);
      }
    });

  return program;
}
