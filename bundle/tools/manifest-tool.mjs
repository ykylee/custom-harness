#!/usr/bin/env node
// manifest 검증 도구 (WBS 2.5.1, FR-4.2.1) — 번들에 동봉되어 설치기·반입 절차가 사용한다.
// 실행: <번들 Electron RUN_AS_NODE 또는 node> tools/manifest-tool.mjs verify <번들 루트>
//       … hash <경로>   (파일/디렉토리 해시 단건 계산 — 반입 대조용)
import { stat } from 'node:fs/promises';
import { dirHash, fileHash, verifyBundle } from '../lib/manifest.mjs';

const [command, target] = process.argv.slice(2);

if (command === 'verify' && target) {
  const { ok, manifest, mismatches } = await verifyBundle(target);
  console.log(
    `[manifest] ${manifest.bundleVersion} (${manifest.os}/${manifest.arch}) — 하네스 ${manifest.harnesses.length}종`,
  );
  if (ok) {
    console.log('[manifest] 검증 통과 — 전 구성물 체크섬 일치');
    process.exit(0);
  }
  for (const m of mismatches) {
    console.error(`[manifest] 불일치: ${m.target}\n  기대 ${m.expected}\n  실제 ${m.actual}`);
  }
  process.exit(1);
} else if (command === 'hash' && target) {
  const info = await stat(target);
  console.log(info.isDirectory() ? await dirHash(target) : await fileHash(target));
} else {
  console.error('사용법: manifest-tool.mjs verify <번들 루트> | hash <경로>');
  process.exit(2);
}
