import { bootstrap } from './index.js';

/**
 * Entry logic for the MCP server mode. Invoked by Claude Code (or any MCP client).
 * Reads config, spawns child MCPs, and exposes the 3 facade tools over stdio.
 */
export async function runMcpServer(): Promise<void> {
  const runtime = await bootstrap();
  await runtime.facade.connectStdio();

  const shutdown = async () => {
    try {
      await runtime.shutdown();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
