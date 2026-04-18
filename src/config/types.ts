import { z } from 'zod';

/**
 * Shape of an MCP server entry inside ~/.claude.json.
 * stdio transport only in v0.1 (command + args + env).
 */
export const McpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({}),
  // Optional transport field; some configs use "stdio" explicitly. Others omit it.
  type: z.string().optional(),
  disabled: z.boolean().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const ClaudeConfigSchema = z
  .object({
    mcpServers: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

export interface DiscoveredMcp {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  source: string; // file path where it came from
}

/** InvocationRecord is written to SQLite by the telemetry writer. */
export interface InvocationRecord {
  tool_id: string;
  mcp_name: string;
  ts: string; // ISO-8601
  latency_ms: number;
  success: 0 | 1;
  error_kind: 'timeout' | 'mcp_error' | 'not_found' | 'validation' | null;
  tokens_saved_estimate: number | null;
}

/** Entry kept in the in-memory catalog. */
export interface ToolEntry {
  tool_id: string; // "github.create_pr"
  mcp_name: string;
  tool_name: string;
  short_description: string;
  full_schema_json: string;
  schema_tokens: number;
  enabled: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

export type ErrorKind = NonNullable<InvocationRecord['error_kind']>;
