#!/usr/bin/env node
import { runMcpServer } from '../dist/mcp-server.js';

runMcpServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
