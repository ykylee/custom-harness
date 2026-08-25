// 프로세스 관리 (daemon-design §3, FR-1.1)
// spawn 규약: 어댑터가 인자 조립, 데몬이 실행. 실행 파일은 절대 경로만 (PATH 탐색 금지).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
}

export interface SupervisorOptions {
  /** PID 원장 경로 — 미지정 시 원장 기록 생략 (테스트 편의) */
  ledgerPath?: string;
  gracePeriodMs?: number;
  bundleVersion?: string;
}

export class ProcessSupervisor {
  private readonly gracePeriodMs: number;
  private readonly ledgerPath: string | undefined;
  private readonly bundleVersion: string | undefined;
  private readonly live = new Set<ManagedProcess>();

  constructor(options: SupervisorOptions = {}) {
    this.gracePeriodMs = options.gracePeriodMs ?? 5000;
    this.ledgerPath = options.ledgerPath;
    this.bundleVersion = options.bundleVersion;
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
    });
    return managed;
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

  private async ledgerAppend(entry: LedgerEntry): Promise<void> {
    const entries = await this.readLedger();
    entries.push(entry);
    await this.writeLedger(entries);
  }

  private async ledgerRemove(pid: number): Promise<void> {
    const entries = await this.readLedger();
    await this.writeLedger(entries.filter((e) => e.pid !== pid));
  }
}
