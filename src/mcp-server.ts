import { bootstrap } from './index.js';

/**
 * Entry logic for the MCP server mode. Invoked by Claude Code (or any MCP client).
 * Reads config, spawns child MCPs, and exposes the 3 facade tools over stdio.
 */
export async function runMcpServer(): Promise<void> {
  // Build runtime WITHOUT awaiting child MCP spawns — Claude Code's initialize handshake
  // must be answered within a few seconds, but 40+ children with per-client 30s timeouts
  // can easily push bootstrap past that. Connect stdio first, then kick off children.
  const runtime = await bootstrap({ deferChildStart: true });
  await runtime.facade.connectStdio();

  // Fire-and-forget: children come online in the background and register in the catalog
  // as they finish their listTools handshake. `list_capabilities` will reflect whatever
  // has registered so far.
  void runtime.supervisor.startAll();

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
