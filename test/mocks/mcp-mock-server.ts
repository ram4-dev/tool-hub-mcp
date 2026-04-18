import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Run a mock MCP server over stdio. Used as the subprocess target in integration tests.
 * It exposes two tools: "echo" and "slow".
 *
 * Usage:  node --import tsx/esm test/mocks/mcp-mock-server.ts --name=<name> [--crash-after=<n>]
 */
export async function startMock(opts: { name: string; crashAfter?: number } = { name: 'mock' }) {
  let calls = 0;
  const server = new Server(
    { name: opts.name, version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo back the given message',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
      {
        name: 'slow',
        description: 'Sleep then return',
        inputSchema: {
          type: 'object',
          properties: { ms: { type: 'number' } },
          required: ['ms'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls += 1;
    if (opts.crashAfter !== undefined && calls > opts.crashAfter) {
      process.exit(2);
    }
    const { name, arguments: args } = req.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    if (name === 'echo') {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ echoed: args?.message ?? null }) },
        ],
      };
    }
    if (name === 'slow') {
      const ms = (args?.ms as number) ?? 0;
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ slept: ms }) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'unknown' }) }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// When invoked directly via tsx, parse argv and run.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const args = process.argv.slice(2);
  const name = args.find((a) => a.startsWith('--name='))?.split('=')[1] ?? 'mock';
  const crashArg = args.find((a) => a.startsWith('--crash-after='))?.split('=')[1];
  const crashAfter = crashArg ? parseInt(crashArg, 10) : undefined;
  startMock({ name, crashAfter }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
