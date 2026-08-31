// 하네스 홈 격리 (WBS 7.2.0a, NFR-1) — 하네스가 사용자 실제 `$HOME` 을 읽지 못하게 막는다.
//
// 배경(7.2.1 실측, docs/reference/harness-mcp-support.md §3.1): `PI_CODING_AGENT_DIR` /
// `GROK_HOME` 로 *설정 홈* 을 격리해도 omp·grok 은 `$HOME` 뿌리의 외부 도구 MCP 설정
// (`~/.claude.json`, Claude Code 플러그인 `.mcp.json`, `~/.cursor/mcp.json` …)을 그대로 읽어
// 서버를 띄운다. 그 서버가 원격(http/sse)이면 게이트웨이 경계 밖 접속이 생긴다 = NFR-1 우회.
// omp 에는 이 탐색을 끄는 설정 키가 없어(실측) **HOME 을 덮는 것이 유일한 봉쇄 수단**이다.
//
// 정책은 "거부 기본값" 이다: 격리 홈은 빈 디렉토리에서 시작하고, 반입할 항목만 allowlist 로
// 심볼릭 링크한다(기본 `.gitconfig`·`.ssh` — 하네스 안에서 git 을 쓰기 위한 최소 표면).
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessId } from '@custom-harness/protocol';

export interface HarnessHomeResult {
  /** 격리 홈 절대 경로 */
  dir: string;
  /** 실제 홈에서 반입(링크)에 성공한 항목 */
  linked: string[];
  /** 링크 실패·원본 부재 등 — 기동을 막지 않고 보고만 한다 */
  warnings: string[];
}

/** 하네스별 격리 홈 — 한 하네스의 잔여 쓰기가 다른 하네스에 보이지 않도록 분리한다 */
export function harnessHomeDir(harnessHomesDir: string, harness: HarnessId): string {
  return join(harnessHomesDir, harness);
}

/**
 * 격리 홈을 준비한다. mkdir 실패는 **throw** — 홈을 만들지 못한 채 HOME 만 덮으면
 * 하네스가 존재하지 않는 홈을 보게 되므로, 격리는 성립하거나 실패하거나 둘 중 하나여야 한다.
 * 반입 링크 실패는 경고로만 남긴다(편의 기능이지 보안 속성이 아니다).
 */
export async function ensureHarnessHome(
  dir: string,
  links: readonly string[] = [],
  realHome: string = homedir(),
): Promise<HarnessHomeResult> {
  await mkdir(dir, { recursive: true });
  // XDG 계열도 격리 홈 안으로 접어둔다 (아래 env 오버레이와 짝)
  for (const sub of ['.config', '.local/share', '.local/state', '.cache']) {
    await mkdir(join(dir, sub), { recursive: true });
  }

  const linked: string[] = [];
  const warnings: string[] = [];
  for (const entry of links) {
    // 상위 탈출·절대 경로는 반입 대상이 아니다 — allowlist 는 홈 바로 아래 항목만 지칭한다
    if (entry.includes('/') || entry.includes('\\') || entry === '..' || entry === '.') {
      warnings.push(`반입 항목명이 올바르지 않음(홈 직속 항목만 허용): ${entry}`);
      continue;
    }
    const source = join(realHome, entry);
    const target = join(dir, entry);
    try {
      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink()) {
        if ((await readlink(target)) === source) {
          linked.push(entry);
          continue;
        }
        warnings.push(`반입 건너뜀 — 다른 대상을 가리키는 링크가 이미 있음: ${target}`);
        continue;
      }
      if (existing) {
        warnings.push(`반입 건너뜀 — 격리 홈에 같은 이름의 실체가 이미 있음: ${target}`);
        continue;
      }
      if (!(await lstat(source).catch(() => undefined))) continue; // 원본 없음 — 정상
      await symlink(source, target);
      linked.push(entry);
    } catch (error) {
      // Windows 는 심볼릭 링크에 권한이 필요할 수 있다 — 격리는 유지하고 편의만 포기한다
      warnings.push(
        `반입 실패 ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { dir, linked, warnings };
}

/**
 * spawn env 오버레이. HOME 만 덮으면 `XDG_CONFIG_HOME` 이 명시된 환경에서 새어 나가므로
 * XDG 4종도 함께 격리 홈 안으로 고정한다.
 */
export function harnessHomeEnv(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    HOME: dir,
    ...(platform === 'win32' ? { USERPROFILE: dir } : {}),
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local', 'share'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    XDG_CACHE_HOME: join(dir, '.cache'),
  };
}
