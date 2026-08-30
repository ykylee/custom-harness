// 워크스페이스 변경사항 (WBS 6.5, workbench-tabs §3).
//
// working diff 는 "미커밋 변경 전부"다 — 스테이지 여부를 가르지 않고 HEAD 기준으로 본다.
// 미추적 파일은 git diff 가 보여주지 않으므로 별도로 목록에 얹는다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface DiffResult {
  scope: 'working' | 'commit';
  /** 통합 diff 원문 — 상한 초과 시 잘린다 */
  patch: string;
  truncated: boolean;
  /** 미추적 파일 경로 (working 한정) — diff 에는 안 나오지만 사용자에겐 변경이다 */
  untracked: string[];
  /** git 이 아니거나 조회 불가 */
  unavailable?: string;
}

const MAX_PATCH_BYTES = 1024 * 1024;

function cap(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= MAX_PATCH_BYTES) return { patch, truncated: false };
  return { patch: patch.slice(0, MAX_PATCH_BYTES), truncated: true };
}

/** 미커밋 변경 — HEAD 기준. 최초 커밋 전 저장소는 빈 트리를 기준으로 삼는다 */
export async function workingDiff(cwd: string): Promise<DiffResult> {
  try {
    let patch: string;
    try {
      patch = await git(cwd, ['diff', 'HEAD']);
    } catch {
      // unborn HEAD (커밋 0개) — 스테이지된 것만이라도 보여준다
      patch = await git(cwd, ['diff', '--cached']);
    }
    const untrackedOut = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
    const untracked = untrackedOut.split('\n').filter((line) => line.trim() !== '');
    return { scope: 'working', ...cap(patch), untracked };
  } catch (error) {
    return {
      scope: 'working',
      patch: '',
      truncated: false,
      untracked: [],
      unavailable: describe(error),
    };
  }
}

/** git 오류를 한 줄 사유로 — 스택은 클라이언트에 쓸모없다 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? 'git 조회 실패';
}

/** 커밋 하나의 변경 */
export async function commitDiff(cwd: string, sha: string): Promise<DiffResult> {
  // 사용자 입력이 git 인자로 들어가므로 옵션 주입을 막는다
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha) && !/^[\w.\-/]+$/.test(sha)) {
    return {
      scope: 'commit',
      patch: '',
      truncated: false,
      untracked: [],
      unavailable: `올바르지 않은 커밋 지정: ${sha}`,
    };
  }
  try {
    const patch = await git(cwd, ['show', '--patch', '--stat', sha, '--']);
    return { scope: 'commit', ...cap(patch), untracked: [] };
  } catch (error) {
    return {
      scope: 'commit',
      patch: '',
      truncated: false,
      untracked: [],
      unavailable: describe(error),
    };
  }
}

/**
 * 변경 감지 — 내용 해시가 아니라 **요약 지문**을 주기적으로 비교한다.
 * fs.watch 는 플랫폼별 편차가 크고(리눅스 recursive, 에디터의 원자적 저장 패턴 등)
 * 워크스페이스 하나당 감시자 하나를 유지하는 비용이 크다. 여기서는 정확도보다
 * "바뀌면 곧 알아챈다"가 목적이라 폴링이 더 예측 가능하다.
 */
export class DiffWatcher {
  private timer: NodeJS.Timeout | undefined;
  private last: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly onChange: () => void,
    private readonly intervalMs = 2000,
  ) {}

  async start(): Promise<void> {
    this.last = await this.fingerprint();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const next = await this.fingerprint();
    if (next === this.last) return;
    this.last = next;
    this.onChange();
  }

  /** `git status --porcelain` + HEAD — 파일 내용까지 읽지 않고 변경 여부만 본다 */
  private async fingerprint(): Promise<string> {
    try {
      const [status, head] = await Promise.all([
        git(this.cwd, ['status', '--porcelain=v1']),
        git(this.cwd, ['rev-parse', 'HEAD']).catch(() => ''),
      ]);
      return `${head.trim()}\n${status}`;
    } catch {
      return 'unavailable';
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
