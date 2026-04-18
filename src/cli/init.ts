import { readClaudeCodeConfig } from '../config/claude-code.js';
import { countTokens } from '../tokenizer/index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface InitOptions {
  claudeJsonPath?: string;
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const mcps = readClaudeCodeConfig({
    claudeJsonPath: opts.claudeJsonPath,
    onWarn: (m) => console.error(`[config] ${m}`),
  });

  console.log('toolhub init');
  console.log('==============');
  console.log(`Detected ${mcps.length} MCP server(s):`);
  for (const m of mcps) {
    console.log(`  - ${m.name}  (command: ${m.command} ${m.args.join(' ')})`);
  }

  // Rough estimation: each MCP ~250 tokens of metadata (names + descriptions + schemas).
  // Real number comes from running once and measuring schema_tokens in SQLite.
  const roughTokens = mcps.length * 250;
  console.log('');
  console.log(`Estimated current context cost: ~${roughTokens} tokens (rough).`);
  console.log('Run toolhub once and then `toolhub stats` to see the measured saving.');

  console.log('');
  console.log('Suggested ~/.claude.json snippet (replace your mcpServers with this):');
  const snippet = {
    mcpServers: {
      toolhub: {
        command: 'npx',
        args: ['-y', 'toolhub', '--mcp-server'],
      },
    },
  };
  console.log(JSON.stringify(snippet, null, 2));

  // Write a token check-summary into stdout for the user.
  const totalChars = JSON.stringify(snippet).length;
  const snippetTokens = countTokens(JSON.stringify(snippet));
  console.log(
    `\nSnippet itself: ${totalChars} chars / ${snippetTokens} tokens. Backup path will be ${join(homedir(), '.claude.json.toolhub-backup-<ts>')}.`,
  );
}
