#!/usr/bin/env node
// 오프라인 프리셋 선주입 (WBS 2.5.2, FR-4.3.2·FR-2.2) — 설치기가 호출한다.
// 격리 홈에 오프라인 스위치만 미리 깐다 (게이트웨이 블록은 온보딩 시 데몬이 주입).
// create-if-absent 전용 — 기존 파일은 절대 건드리지 않는다 (FR-4.3.3 이전 상태 불변).
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.env.CUSTOM_HARNESS_HOME ?? join(homedir(), '.custom-harness');
const dataDir = join(root, 'data');

async function writeIfAbsent(path, content) {
  try {
    await writeFile(path, content, { flag: 'wx' }); // 존재 시 EEXIST — 손대지 않음
    console.log(`[presets] 생성: ${path}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`[presets] 유지: ${path} (기존 파일 보존)`);
  }
}

// pi — 오프라인은 env(PI_OFFLINE=1, 데몬 spawn 오버레이)라 파일 프리셋 불요.

// omp — config.yml 오프라인 프리셋 (17.3.8 실측 구문, gateway/omp-injection 과 동일 키)
await mkdir(join(dataDir, 'omp-home'), { recursive: true });
await writeIfAbsent(
  join(dataDir, 'omp-home', 'config.yml'),
  ['startup:', '  checkUpdate: false', 'marketplace:', '  autoUpdate: false', 'dev:', '  autoqa: false', '  autoqaConsent: denied', ''].join('\n'),
);

// grok — config.toml 오프라인 3스위치 (1.0.5 현행 구문, gateway/grok-injection 과 동일 키)
// Windows 번들은 grok 제외 확정(2026-08-25, windows-support.md) — 격리 홈 프리셋도 만들지 않는다
if (process.platform !== 'win32') {
  await mkdir(join(dataDir, 'grok-home'), { recursive: true });
  await writeIfAbsent(
    join(dataDir, 'grok-home', 'config.toml'),
    ['[cli]', 'auto_update = false', '', '[features]', 'telemetry = false', 'remote_fetch = false', 'managed_config = false', ''].join('\n'),
  );
}

console.log('[presets] 오프라인 프리셋 완료');
