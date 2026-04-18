import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Router } from '../router/index.js';
import { RouterError } from '../router/index.js';

/**
 * ServerFacade exposes exactly 3 tools to the agent:
 *   list_capabilities, get_schema, invoke.
 * Child tools are NOT exposed directly — they are reachable via `invoke`.
 * Tool ids follow the `mcp_name.tool_name` namespacing scheme.
 */
export class ServerFacade {
  private readonly server: Server;
  private readonly router: Router;
  private transport: StdioServerTransport | null = null;

  constructor(router: Router) {
    this.router = router;
    this.server = new Server(
      { name: 'toolhub', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_capabilities',
          description:
            'Returns the compact list of tools available through toolhub. Each entry has {name, short_description}.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'get_schema',
          description:
            'Returns the full JSON schema for a single tool. Use this right before calling invoke.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Fully-qualified tool id, e.g. "github.create_pr"' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        {
          name: 'invoke',
          description:
            'Invokes a child-MCP tool by fully-qualified name and forwards the result.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              arguments: { type: 'object' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params as {
        name: string;
        arguments?: Record<string, unknown>;
      };

      try {
        switch (name) {
          case 'list_capabilities':
            return this.handleListCapabilities();
          case 'get_schema':
            return this.handleGetSchema((args?.name as string) ?? '');
          case 'invoke':
            return await this.handleInvoke(
              (args?.name as string) ?? '',
              (args?.arguments as Record<string, unknown>) ?? {},
            );
          default:
            return errorContent('TOOL_NOT_FOUND', `Unknown facade tool: ${name}`);
        }
      } catch (err) {
        if (err instanceof RouterError) {
          return errorContent(err.kind, err.message);
        }
        return errorContent('MCP_ERROR', (err as Error).message);
      }
    });
  }

  private handleListCapabilities() {
    const tools = this.router.getCatalog().list({ enabledOnly: true }).map((e) => ({
      name: e.tool_id,
      short_description: e.short_description,
    }));
    return jsonContent(tools);
  }

  private handleGetSchema(toolId: string) {
    const entry = this.router.getCatalog().get(toolId);
    if (!entry || !entry.enabled) {
      return errorContent('TOOL_NOT_FOUND', `tool ${toolId} not found`);
    }
    let schema: unknown;
    try {
      schema = JSON.parse(entry.full_schema_json);
    } catch {
      schema = {};
    }
    return jsonContent({ name: entry.tool_id, schema });
  }

  private async handleInvoke(toolId: string, args: Record<string, unknown>) {
    const result = await this.router.invoke(toolId, args);
    return jsonContent(result);
  }

  async connectStdio(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
  }

  async close(): Promise<void> {
    try {
      await this.server.close();
    } catch {
      // ignore
    }
  }

  /** Exposed for tests (in-process wiring via a custom transport). */
  getServer(): Server {
    return this.server;
  }
}

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function errorContent(kind: string, message: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: { kind, message } }),
      },
    ],
    isError: true,
  };
}
