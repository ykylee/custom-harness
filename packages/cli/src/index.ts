#!/usr/bin/env node
// @custom-harness/cli — bin 진입점. Electron 내장 Node(ELECTRON_RUN_AS_NODE)로 실행 (FR-5.1).
import { runCli } from './commands.js';

process.exitCode = await runCli(process.argv.slice(2));
