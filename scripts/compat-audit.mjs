#!/usr/bin/env node
// NFR-5 COMPAT 태그 검수 — 호환 shim 이 기한 없이 남지 않게 한다.
//
// 사용: node scripts/compat-audit.mjs
// 허용 형식: // COMPAT(name): 이유, remove after YYYY-MM-DD
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const today = new Date().toISOString().slice(0, 10);
const tagPattern = /COMPAT\(/;
const validPattern =
  /\/\/\s*COMPAT\(([A-Za-z][A-Za-z0-9_-]*)\):\s*.+,\s*remove after\s+(\d{4}-\d{2}-\d{2})\s*$/;
const files = execFileSync('git', ['ls-files', 'packages', 'scripts', 'bundle'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter((path) => /\.(?:ts|tsx|mjs|js|sh|ps1)$/.test(path));

const malformed = [];
const expired = [];
let count = 0;

for (const path of files) {
  const lines = readFileSync(join(repoRoot, path), 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!tagPattern.test(line)) return;
    const match = line.match(validPattern);
    if (!match) {
      malformed.push(`${path}:${index + 1}`);
      return;
    }
    count += 1;
    if (match[2] < today) expired.push(`${path}:${index + 1} (${match[1]}, ${match[2]})`);
  });
}

console.log(`COMPAT 태그 ${count}건 검사 (기준일 ${today})`);
if (malformed.length > 0) console.error(`FAIL 형식 오류: ${malformed.join(', ')}`);
if (expired.length > 0) console.error(`FAIL 만료: ${expired.join(', ')}`);
if (malformed.length === 0 && expired.length === 0) console.log('PASS COMPAT 태그 형식 및 만료일');

process.exit(malformed.length === 0 && expired.length === 0 ? 0 : 1);
