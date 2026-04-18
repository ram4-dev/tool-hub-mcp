import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Router } from '../router/index.js';
import { RouterError, TOOL_ID_RE } from '../router/index.js';

const CallEnvelopeSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).optional(),
});
const ListCapabilitiesParamsSchema = z.object({}).passthrough();
const GetSchemaParamsSchema = z.object({ name: z.string() });
const InvokeParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).optional(),
});

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
      const envelopeParsed = CallEnvelopeSchema.safeParse(req.params);
      if (!envelopeParsed.success) {
        return errorContent('INVALID_PARAMS', envelopeParsed.error.message);
      }
      const { name, arguments: rawArgs = {} } = envelopeParsed.data;

      try {
        switch (name) {
          case 'list_capabilities': {
            const parsed = ListCapabilitiesParamsSchema.safeParse(rawArgs);
            if (!parsed.success) {
              return errorContent('INVALID_PARAMS', parsed.error.message);
            }
            return this.handleListCapabilities();
          }
          case 'get_schema': {
            const parsed = GetSchemaParamsSchema.safeParse(rawArgs);
            if (!parsed.success) {
              return errorContent('INVALID_PARAMS', parsed.error.message);
            }
            return this.handleGetSchema(parsed.data.name);
          }
          case 'invoke': {
            const parsed = InvokeParamsSchema.safeParse(rawArgs);
            if (!parsed.success) {
              return errorContent('INVALID_PARAMS', parsed.error.message);
            }
            return await this.handleInvoke(parsed.data.name, parsed.data.arguments ?? {});
          }
          default:
            return errorContent('TOOL_NOT_FOUND', `Unknown facade tool: ${String(name)}`);
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
    if (!TOOL_ID_RE.test(toolId)) {
      return errorContent('TOOL_NOT_FOUND', `tool ${toolId} not found`);
    }
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
