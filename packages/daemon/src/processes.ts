// 프로세스 관리 (daemon-design §3, FR-1.1)
// spawn 규약: 어댑터가 인자 조립, 데몬이 실행. 실행 파일은 절대 경로만 (PATH 탐색 금지).
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DaemonError } from './errors.js';

export interface SpawnSpec {
  /** 절대 경로 필수 — grok 바이너리명 충돌 대응 (FR-1.1.1) */
  command: string;
  args: string[];
  cwd?: string;
  /** env 오버레이 — 게이트웨이 키·오프라인 스위치·GROK_HOME 등 */
  env?: Record<string, string>;
  sessionId?: string;
  harness?: string;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** false = 비정상 종료 감지 대상 (terminate() 경유 아님, FR-1.1.3) */
  expected: boolean;
}

export interface ManagedProcess {
  pid: number;
  child: ChildProcess;
  exited: Promise<ProcessExit>;
  /** graceful(SIGTERM) → gracePeriod → SIGKILL 단계적 종료 (FR-1.1.2) */
  terminate(): Promise<ProcessExit>;
}

interface LedgerEntry {
  pid: number;
  sessionId?: string;
  harness?: string;
  spawnedAt: string;
  bundleVersion?: string;
  /** 소유 데몬 프로세스 구분 (FR-5.2, WBS 2.3.2) — 기동 시 이 값이 다른 항목만 회수 대상 */
  daemonPid?: number;
}

export interface ReapResult {
  /** 살아있어 단계적 종료(SIGTERM→SIGKILL) 후 정리한 pid */
  terminated: number[];
  /** 이미 죽어 있어 원장에서만 제거한 pid */
  removed: number[];
}

export interface SupervisorOptions {
  /** PID 원장 경로 — 미지정 시 원장 기록 생략 (테스트 편의) */
  ledgerPath?: string;
  gracePeriodMs?: number;
  bundleVersion?: string;
  /** 하네스 stderr 로그 디렉토리 (WBS 2.6.2, FR-5.3) — 미지정 시 stderr 는 어댑터 콜백만 */
  harnessLogDir?: string;
}

/** 시그널 0 프로브 — 살아있으면 true (EPERM 도 존재로 간주) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ProcessSupervisor {
  private readonly gracePeriodMs: number;
  private readonly ledgerPath: string | undefined;
  private readonly bundleVersion: string | undefined;
  private readonly harnessLogDir: string | undefined;
  private readonly live = new Set<ManagedProcess>();

  constructor(options: SupervisorOptions = {}) {
    this.gracePeriodMs = options.gracePeriodMs ?? 5000;
    this.ledgerPath = options.ledgerPath;
    this.bundleVersion = options.bundleVersion;
    this.harnessLogDir = options.harnessLogDir;
  }

  /** 하네스 stderr → logs/<harness>-<sessionId|pid>.log (append) — 어댑터 콜백과 병행 */
  private attachHarnessLog(spec: SpawnSpec, child: ChildProcess, pid: number): void {
    if (!this.harnessLogDir || !child.stderr) return;
    const name = `${spec.harness ?? 'proc'}-${spec.sessionId ?? pid}.log`;
    const path = join(this.harnessLogDir, name);
    const chunks: Buffer[] = [];
    let flushing = false;
    const flush = (): void => {
      if (flushing || chunks.length === 0) return;
      flushing = true;
      const payload = Buffer.concat(chunks.splice(0));
      void mkdir(this.harnessLogDir as string, { recursive: true })
        .then(() => appendFile(path, payload))
        .catch(() => {}) // 로그 실패는 세션을 죽이지 않는다
        .finally(() => {
          flushing = false;
          flush();
        });
    };
    child.stderr.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      flush();
    });
  }

  async spawn(spec: SpawnSpec): Promise<ManagedProcess> {
    if (!isAbsolute(spec.command)) {
      throw new DaemonError('bad_request', `spawn 은 절대 경로만 허용: ${spec.command}`);
    }
    const child = spawn(spec.command, spec.args, {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // spawn 실패(ENOENT 등)는 'error' 이벤트로 도착한다 — 'spawn' 이벤트와 경합
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) =>
        reject(new DaemonError('internal', `spawn 실패: ${error.message}`)),
      );
    });

    const pid = child.pid;
    if (pid === undefined) {
      throw new DaemonError('internal', 'spawn 후 pid 없음');
    }
    this.attachHarnessLog(spec, child, pid);

    let expected = false;
    let resolveExit!: (exit: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    child.once('exit', (code, signal) => {
      this.live.delete(managed);
      void this.ledgerRemove(pid);
      resolveExit({ code, signal, expected });
    });

    const gracePeriodMs = this.gracePeriodMs;
    const managed: ManagedProcess = {
      pid,
      child,
      exited,
      async terminate(): Promise<ProcessExit> {
        expected = true;
        if (child.exitCode !== null || child.signalCode !== null) return exited;
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, gracePeriodMs);
        const exit = await exited;
        clearTimeout(timer);
        return exit;
      },
    };

    this.live.add(managed);
    await this.ledgerAppend({
      pid,
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
      ...(spec.harness !== undefined ? { harness: spec.harness } : {}),
      spawnedAt: new Date().toISOString(),
      ...(this.bundleVersion !== undefined ? { bundleVersion: this.bundleVersion } : {}),
      daemonPid: process.pid,
    });
    return managed;
  }

  /**
   * 기동 시 이전 실행이 남긴 stale 프로세스 회수 (FR-1.1.4, daemon-design §3 1차 단순화).
   * 어댑터 재접속은 하지 않는다 — 살아있으면 graceful kill 후 세션은 재개 경로로.
   * pid 재사용 오살 리스크는 1차 수용 (원장 잔존 자체가 비정상 종료의 흔적).
   */
  async reapStale(): Promise<ReapResult> {
    const result: ReapResult = { terminated: [], removed: [] };
    const entries = await this.readLedger();
    if (entries.length === 0) return result;
    const survivors: LedgerEntry[] = [];
    for (const entry of entries) {
      // 현재 데몬 소유(이번 실행에서 spawn) 항목은 대상 아님 (FR-5.2 소유 구분)
      if (entry.daemonPid === process.pid || entry.pid === process.pid) {
        survivors.push(entry);
        continue;
      }
      if (!isAlive(entry.pid)) {
        result.removed.push(entry.pid);
        continue;
      }
      try {
        process.kill(entry.pid, 'SIGTERM');
        const deadline = Date.now() + this.gracePeriodMs;
        while (isAlive(entry.pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (isAlive(entry.pid)) process.kill(entry.pid, 'SIGKILL');
        result.terminated.push(entry.pid);
      } catch {
        // 종료 경합(이미 사라짐)·권한 문제 — 원장에서만 제거
        result.removed.push(entry.pid);
      }
    }
    await this.writeLedger(survivors);
    return result;
  }

  /**
   * pid → 세션 역인덱스 (M7 7.2.4).
   *
   * 역방향 툴을 부른 MCP 서버 프로세스는 **하네스의 자식**이라, 그 부모 pid 가 원장에 있다.
   * 노출 프로세스가 자기 세션을 스스로 주장하게 두지 않는 이유: 그 값은 하네스가 spawn 한
   * 프로세스의 자기 신고라 검증할 수 없다. 원장은 우리가 spawn 하며 직접 적은 기록이다.
   */
  async findByPid(pid: number): Promise<{ sessionId?: string; harness?: string } | undefined> {
    return (await this.readLedger()).find((entry) => entry.pid === pid);
  }

  /** 데몬 셧다운 경로 — 남은 프로세스 전부 단계적 종료 */
  async terminateAll(): Promise<void> {
    await Promise.all([...this.live].map((p) => p.terminate()));
  }

  private async readLedger(): Promise<LedgerEntry[]> {
    if (!this.ledgerPath) return [];
    try {
      return JSON.parse(await readFile(this.ledgerPath, 'utf8')) as LedgerEntry[];
    } catch {
      return [];
    }
  }

  private async writeLedger(entries: LedgerEntry[]): Promise<void> {
    if (!this.ledgerPath) return;
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const tmp = join(dirname(this.ledgerPath), 'processes.json.tmp');
    await writeFile(tmp, JSON.stringify(entries, null, 2));
    await rename(tmp, this.ledgerPath);
  }

  /**
   * 원장 조작 직렬화 (WBS 2.7.3 부하 스모크 검출) — 동시 spawn/exit 의
   * read-modify-write 가 겹치면 갱신 유실·tmp rename ENOENT 경합이 난다.
   */
  private ledgerChain: Promise<void> = Promise.resolve();

  private ledgerMutate(mutate: (entries: LedgerEntry[]) => LedgerEntry[]): Promise<void> {
    const run = this.ledgerChain.then(async () => {
      const entries = await this.readLedger();
      await this.writeLedger(mutate(entries));
    });
    this.ledgerChain = run.catch((error: unknown) => {
      console.error('[daemon] PID 원장 기록 실패:', error);
    });
    return run;
  }

  private ledgerAppend(entry: LedgerEntry): Promise<void> {
    return this.ledgerMutate((entries) => [...entries, entry]);
  }

  private ledgerRemove(pid: number): Promise<void> {
    return this.ledgerMutate((entries) => entries.filter((e) => e.pid !== pid));
  }
}
