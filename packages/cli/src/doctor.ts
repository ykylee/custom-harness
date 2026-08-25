// doctor 자가 진단 (WBS 2.6.1, FR-5.3) — 항목별 pass/warn/fail.
// 데몬 없이도 동작한다 (파일·서비스 직접 검사) — 설치 직후·장애 상황의 1차 진단 도구.
// 검사: 데몬 상태 / manifest 체크섬 재검증(FR-4.2.1) / 하네스 실행 파일·버전(FR-1.8) /
// 게이트웨이 설정·키·연결(FR-2.3) / 오프라인 프리셋(FR-2.2) / 트래픽 경계(FR-2.5).
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  GatewayService,
  KeyStore,
  readDaemonInfo,
  verifyBundleTree,
  type DaemonPaths,
} from '@custom-harness/daemon';
import type { CliIo } from './commands.js';

const execFileAsync = promisify(execFile);

type Verdict = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  verdict: Verdict;
  detail: string;
}

const MARK: Record<Verdict, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

/** 번들 manifest 위치 — 래퍼 env 우선, 설치 규약(current/manifest.json) 폴백 */
function manifestPath(paths: DaemonPaths): string {
  return process.env.CUSTOM_HARNESS_MANIFEST ?? join(paths.root, 'current', 'manifest.json');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 하네스 실행 파일 --version 실측 — pi(JS 엔트리)는 현재 런타임(RUN_AS_NODE 겸용)으로 실행 */
async function probeVersion(
  bundleRoot: string,
  harness: { name?: string; kind?: string; path?: string; entry?: string },
): Promise<string> {
  const target = join(bundleRoot, harness.entry ?? harness.path ?? '');
  const isJsEntry = harness.entry !== undefined;
  const command = isJsEntry ? process.execPath : target;
  const cmdArgs = isJsEntry ? [target, '--version'] : ['--version'];
  const { stdout } = await execFileAsync(command, cmdArgs, {
    timeout: 15_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const raw = stdout.trim();
  // "omp/17.3.8" · "grok 1.0.5 (hash) [stable]" · "0.84.1" 전부 수용 (관대)
  const match = /(\d+\.\d+\.\S*)/.exec(raw);
  return match?.[1] ?? raw.slice(0, 40);
}

export async function runDoctor(paths: DaemonPaths, io: CliIo): Promise<number> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, verdict: Verdict, detail: string): void => {
    checks.push({ name, verdict, detail });
  };

  // 1. 데몬 상태
  const info = await readDaemonInfo(paths);
  if (info) add('데몬', 'pass', `실행 중 (pid=${info.pid}, port=${info.port})`);
  else add('데몬', 'warn', '정지됨 — daemon start 로 기동');

  // 2. manifest 체크섬 재검증 (FR-4.2.1)
  const manifest = manifestPath(paths);
  let raw:
    | {
        harnesses?: {
          name?: string;
          version?: string;
          kind?: string;
          path?: string;
          entry?: string;
        }[];
        bundleVersion?: string;
      }
    | undefined;
  if (!(await exists(manifest))) {
    add('manifest', 'warn', `번들 미설치 (${manifest} 없음) — 개발 환경이면 정상`);
  } else {
    try {
      const result = await verifyBundleTree(dirname(manifest));
      raw = result.raw;
      if (result.ok) {
        add('manifest', 'pass', `${result.raw.bundleVersion ?? '?'} — 전 구성물 체크섬 일치`);
      } else {
        add(
          'manifest',
          'fail',
          `체크섬 불일치 ${result.mismatches.length}건: ${result.mismatches.map((m) => m.target).join(', ')}`,
        );
      }
    } catch (error) {
      add(
        'manifest',
        'fail',
        `검증 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 3. 하네스 실행 파일·버전 (FR-1.8)
  if (raw?.harnesses) {
    const bundleRoot = dirname(manifest);
    for (const h of raw.harnesses) {
      const name = h.name ?? '?';
      const target = join(bundleRoot, h.entry ?? h.path ?? '');
      if (!(await exists(target))) {
        add(`하네스:${name}`, 'fail', `실행 파일 없음: ${target}`);
        continue;
      }
      try {
        const actual = await probeVersion(bundleRoot, h);
        if (h.version !== undefined && actual !== h.version) {
          add(
            `하네스:${name}`,
            'warn',
            `버전 불일치: 실측 ${actual} ≠ manifest ${h.version} (FR-1.8 — 동작은 계속)`,
          );
        } else {
          add(`하네스:${name}`, 'pass', `${actual} — 실행·버전 확인`);
        }
      } catch (error) {
        add(
          `하네스:${name}`,
          'fail',
          `--version 실행 실패: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // 4~6. 게이트웨이·프리셋·경계 — 데몬과 동일 서비스 로직을 직접 사용 (파일 기반)
  const keyStore = new KeyStore(paths.credentialsFile);
  const gateway = new GatewayService(paths, keyStore);
  const config = await gateway.getConfig();
  if (!config) {
    add('게이트웨이', 'warn', '미설정 — 앱 온보딩에서 게이트웨이 주소·키 입력 필요');
  } else {
    const key = await keyStore.get();
    if (key === undefined) {
      add('게이트웨이', 'warn', `설정됨 (${config.baseUrl}) — 키 미등록`);
    } else {
      const test = await gateway.testKey();
      if (test.valid) add('게이트웨이', 'pass', `${config.baseUrl} — 연결·인증 확인`);
      else add('게이트웨이', 'fail', `연결 확인 실패: ${test.detail ?? '원인 미상'}`);
    }
  }

  // 5. 오프라인 프리셋 (FR-2.2) — pi 는 spawn env(PI_OFFLINE) 방식이라 파일 검사 없음
  // 번들 환경은 manifest 동봉 하네스만 검사 — Windows 번들은 grok 미동봉 (windows-support.md)
  const bundledNames = raw?.harnesses
    ? new Set(raw.harnesses.map((h) => h.name).filter((n): n is string => n !== undefined))
    : undefined;
  const presetChecks: [string, string, (content: string) => boolean][] = [
    [
      'omp',
      join(paths.ompHomeDir, 'config.yml'),
      (c) => /checkUpdate:\s*false/.test(c) && /autoUpdate:\s*false/.test(c),
    ],
    [
      'grok',
      join(paths.grokHomeDir, 'config.toml'),
      (c) => /auto_update\s*=\s*false/.test(c) && /telemetry\s*=\s*false/.test(c),
    ],
  ];
  for (const [name, path, valid] of presetChecks) {
    if (bundledNames !== undefined && !bundledNames.has(name)) continue; // 미동봉 하네스 — 검사 제외
    if (!(await exists(path))) {
      add(`프리셋:${name}`, 'warn', `${path} 없음 — 설치기/온보딩 전이면 정상 (pi 는 env 방식)`);
    } else if (valid(await readFile(path, 'utf8'))) {
      add(`프리셋:${name}`, 'pass', '오프라인 스위치 적용됨');
    } else {
      add(`프리셋:${name}`, 'fail', `오프라인 스위치가 꺼져 있음: ${path}`);
    }
  }

  // 6. 트래픽 경계 (FR-2.5)
  const violations = await gateway.checkTrafficBoundaries();
  if (!config) {
    add('트래픽 경계', 'warn', '게이트웨이 미설정 — 검사 생략');
  } else if (violations.length === 0) {
    add('트래픽 경계', 'pass', '게이트웨이 외 목적지 없음');
  } else {
    for (const v of violations) {
      add('트래픽 경계', 'fail', `${v.harness} → ${v.url} (${v.location})`);
    }
  }

  // 출력 + 종료 코드
  for (const check of checks) {
    io.out(`[${MARK[check.verdict]}] ${check.name} — ${check.detail}`);
  }
  const fails = checks.filter((c) => c.verdict === 'fail').length;
  const warns = checks.filter((c) => c.verdict === 'warn').length;
  io.out(`doctor: pass ${checks.length - fails - warns} · warn ${warns} · fail ${fails}`);
  return fails > 0 ? 1 : 0;
}
