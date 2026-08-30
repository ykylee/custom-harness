// git 사실 관측 (workspace-model §4) — 정합화가 갱신할 수 있는 값만 읽는다.
//
// 여기서 읽은 값은 *가변 메타데이터*다. 식별자·경로·표시 이름에는 절대 반영되지 않는다.
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { normalizeRoot, type ProjectFacts } from './records.js';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    // 셸 미경유 + 타임아웃 — 응답 없는 저장소(네트워크 remote 등)가 데몬을 붙잡지 않게
    const { stdout } = await run('git', args, { cwd, timeout: 5_000, windowsHide: true });
    const value = stdout.trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * 체크아웃 루트 — git 이 아니면 undefined.
 *
 * `rev-parse --show-toplevel` 을 **쓰지 않는다**: git 은 심링크를 푼 경로를 돌려주는데
 * (macOS 의 /tmp → /private/tmp 가 대표적), 그러면 사용자가 고른 경로가 조용히 다른 경로로
 * 바뀐다. 대신 저장소 안에서의 상대 접두사만 받아 사용자의 경로에서 그만큼 걷어낸다
 * — 정규화는 끝까지 lexical 이다 (workspace-model 원칙 3).
 */
export async function checkoutRootFor(cwd: string): Promise<string | undefined> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return undefined;
  // 루트에서는 빈 문자열이라 git() 이 undefined 를 준다 — 그 경우 cwd 가 곧 루트다
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])) ?? '';
  let root = normalizeRoot(cwd);
  for (const segment of prefix.split('/').filter(Boolean)) {
    void segment;
    root = dirname(root);
  }
  return root;
}

/** 현재 브랜치 — detached HEAD 면 undefined */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  return git(cwd, ['branch', '--show-current']);
}

/** 프로젝트 수준 사실 — kind·기본 브랜치·remote */
export async function readProjectFacts(root: string): Promise<ProjectFacts> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { kind: 'plain' };

  const remoteUrl = await git(root, ['remote', 'get-url', 'origin']);
  // origin/HEAD 가 있으면 그것이 기본 브랜치. 폐쇄망 로컬 저장소는 없는 것이 정상이므로 현재 브랜치로 대체
  const originHead = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = originHead?.replace(/^origin\//, '') ?? (await currentBranch(root));

  return {
    kind: 'git',
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
  };
}

/**
 * 호스트 횡단 그룹핑 키 (workspace-model §2) — 정규화된 remote, 없으면 미기입.
 * 소비자는 이 값을 live git 에서 재유도하지 않는다. 생성 시 1회 고정한다.
 */
export function deriveProjectKey(remoteUrl: string | undefined): string | undefined {
  if (remoteUrl === undefined) return undefined;
  return remoteUrl
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
