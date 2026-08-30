// git worktree 조작 (WBS 5.5.1·5.5.2) — 생성·제거·복구.
//
// 경로 규약: 백킹 체크아웃은 항상 데이터 디렉토리 안(`data/worktrees/<workspaceId>`)에 만든다
// (workspace-model D-1). 사용자 저장소 옆에 흩뿌리지 않는 대신, 제거·정리가 한 곳에서 끝난다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 60_000, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    throw new GitCommandError(`git ${args[0]} 실패: ${stderr.split('\n')[0] ?? ''}`, stderr);
  }
}

/** 브랜치 존재 여부 — 로컬 참조만 본다(폐쇄망에서 remote 조회는 매달릴 수 있다) */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** 슬러그화 — git 브랜치 이름으로 쓸 수 없는 문자를 걷어낸다 */
function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'work' : slug;
}

/**
 * 브랜치 자동 이름 (WBS 5.5.1) — 충돌하면 접미 번호를 올린다.
 * 이름을 못 만들고 실패하느니, 사용자가 나중에 바꿀 수 있는 이름을 주는 편이 낫다.
 */
export async function generateBranchName(
  repoRoot: string,
  hint: string,
  prefix = 'harness',
): Promise<string> {
  const base = `${prefix}/${slugify(hint)}`;
  if (!(await branchExists(repoRoot, base))) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!(await branchExists(repoRoot, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export interface AddWorktreeInput {
  repoRoot: string;
  /** 백킹 체크아웃을 만들 경로 — 존재하지 않아야 한다 */
  path: string;
  branch: string;
  /** 새 브랜치를 만들 기준. 미지정이면 기존 브랜치를 체크아웃한다 */
  baseBranch?: string;
}

/** worktree 생성. `baseBranch` 가 있으면 새 브랜치를 분기한다 */
export async function addWorktree(input: AddWorktreeInput): Promise<void> {
  const args =
    input.baseBranch === undefined
      ? ['worktree', 'add', input.path, input.branch]
      : ['worktree', 'add', '-b', input.branch, input.path, input.baseBranch];
  await git(input.repoRoot, args);
}

/** worktree 제거 — 디렉토리가 이미 사라졌어도 원장(prune)은 정리한다 */
export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  try {
    await git(repoRoot, ['worktree', 'remove', '--force', path]);
  } catch {
    // 디렉토리가 이미 없거나 잠긴 경우 — 원장 정리로 대체한다
  }
  await git(repoRoot, ['worktree', 'prune']);
}

/**
 * worktree 복구 (WBS 5.5.2) — 백킹 디렉토리가 외부에서 사라진 경우 메인 저장소에서 재생성한다.
 * 브랜치는 이미 존재하므로 새로 분기하지 않고 체크아웃만 한다.
 */
export async function restoreWorktree(input: {
  repoRoot: string;
  path: string;
  branch: string;
}): Promise<void> {
  // 죽은 원장 항목이 남아 있으면 add 가 "이미 등록됨"으로 거절한다
  await git(input.repoRoot, ['worktree', 'prune']);
  const exists = await branchExists(input.repoRoot, input.branch);
  await addWorktree({
    repoRoot: input.repoRoot,
    path: input.path,
    branch: input.branch,
    // 브랜치까지 사라졌다면 현재 HEAD 에서 다시 만든다 — 복구가 실패로 끝나지 않게
    ...(exists ? {} : { baseBranch: 'HEAD' }),
  });
}
