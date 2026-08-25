#!/usr/bin/env node
// 테스트용 fake 데몬 — 런처·CLI 테스트 전용. pid/token 파일 계약만 흉내낸다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

if (process.env.FAKE_DAEMON_FAIL === '1') process.exit(7);

const root = process.env.CUSTOM_HARNESS_HOME;
if (!root) process.exit(2);
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const pidFile = path.join(dataDir, 'daemon.pid');
const tokenFile = path.join(dataDir, 'daemon.token');

fs.writeFileSync(tokenFile, 'fixture-token', { mode: 0o600 });
fs.writeFileSync(
  pidFile,
  JSON.stringify({
    pid: process.pid,
    port: 43210,
    managedBy: process.env.CUSTOM_HARNESS_MANAGED_BY ?? 'cli',
    bundleVersion: null,
  }),
);

process.on('SIGTERM', () => {
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(tokenFile, { force: true });
  process.exit(0);
});
setInterval(() => {}, 1000);
