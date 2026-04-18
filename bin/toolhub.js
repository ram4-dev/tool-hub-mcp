#!/usr/bin/env node
import { buildCli } from '../dist/cli/main.js';

const program = buildCli();
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
