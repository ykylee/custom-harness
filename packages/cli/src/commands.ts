// 관리 CLI (WBS 1.6.3·2.6, FR-5.1·FR-5.3) — daemon start/stop/status/version + doctor/logs.
// 에이전트 조작 명령은 범위 외 (FR-5.4 — UI 가 유일한 조작면).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type SessionSummary } from '@custom-harness/protocol';
import {
  launchDetachedDaemon,
  readDaemonInfo,
  resolvePaths,
  stopDaemon,
  type DaemonPaths,
} from '@custom-harness/daemon';
import { readFile, readdir, stat } from 'node:fs/promises';
import { runDoctor } from './doctor.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

function resolveDaemonEntry(): string {
  // 테스트·번들에서 진입점 교체 가능 (번들 배선은 1.7)
  return process.env.CUSTOM_HARNESS_DAEMON_ENTRY ?? require.resolve('@custom-harness/daemon/main');
}

interface DaemonQuery {
  version: string;
  sessions: SessionSummary[];
}

/** 실행 중 데몬에 WS 로 질의 — Bearer 헤더 인증 (protocol-design §4) */
async function queryDaemon(port: number, token: string, timeoutMs = 3000): Promise<DaemonQuery> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, [], {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames: Record<string, unknown>[] = [];
  let notify: (() => void) | undefined;
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    notify?.();
  });

  const waitFor = async <T>(predicate: () => T | undefined): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = predicate();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error('데몬 응답 타임아웃');
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 50);
      });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'custom-harness-cli', version: packageJson.version },
        capabilities: {},
      }),
    );
    await waitFor(() => frames.find((f) => f.type === 'hello.response'));

    ws.send(JSON.stringify({ type: 'system.version.request', requestId: 'v', params: {} }));
    ws.send(JSON.stringify({ type: 'session.list.request', requestId: 's', params: {} }));
    const version = await waitFor(() => frames.find((f) => f.requestId === 'v' && f.ok === true));
    const sessions = await waitFor(() => frames.find((f) => f.requestId === 's' && f.ok === true));
    return {
      version: (version.result as { version: string }).version,
      sessions: (sessions.result as { sessions: SessionSummary[] }).sessions,
    };
  } finally {
    ws.close();
  }
}

async function readToken(paths: DaemonPaths): Promise<string> {
  return (await readFile(paths.tokenFile, 'utf8')).trim();
}

async function cmdStart(paths: DaemonPaths, io: CliIo): Promise<number> {
  const result = await launchDetachedDaemon({
    paths,
    entryPath: resolveDaemonEntry(),
    managedBy: 'cli',
  });
  if (result.alreadyRunning) {
    io.out(`데몬이 이미 실행 중입니다 (pid=${result.info.pid}, port=${result.info.port})`);
  } else {
    io.out(`데몬 기동 완료 (pid=${result.info.pid}, port=${result.info.port})`);
  }
  return 0;
}

async function cmdStop(paths: DaemonPaths, io: CliIo, force: boolean): Promise<number> {
  const info = await readDaemonInfo(paths);
  if (!info) {
    io.out('실행 중인 데몬이 없습니다');
    return 0;
  }
  // 실행 중 세션 존재 시 경고 + 확인 (FR-5.1) — 비대화형이므로 --force 로 확인을 갈음
  if (!force && info.port !== null) {
    try {
      const query = await queryDaemon(info.port, await readToken(paths));
      const active = query.sessions.filter(
        (s) => s.status === 'running' || (s.pendingPermissions?.length ?? 0) > 0,
      );
      if (active.length > 0) {
        io.err(
          `실행 중이거나 승인 대기 중인 세션 ${active.length}개가 있습니다 — 종료하려면 --force`,
        );
        return 1;
      }
    } catch {
      io.err('세션 상태 확인 실패 — 그래도 종료하려면 --force');
      return 1;
    }
  }
  const result = await stopDaemon(paths);
  if (!result.stopped) {
    io.err(`데몬(pid=${info.pid})이 시간 내 종료되지 않았습니다`);
    return 1;
  }
  io.out(result.wasRunning ? '데몬 종료 완료' : '실행 중인 데몬이 없습니다');
  return 0;
}

async function cmdStatus(paths: DaemonPaths, io: CliIo): Promise<number> {
  const info = await readDaemonInfo(paths);
  if (!info) {
    io.out('데몬: 정지됨');
    return 1;
  }
  io.out(`데몬: 실행 중 (pid=${info.pid}, port=${info.port}, managedBy=${info.managedBy})`);
  if (info.port !== null) {
    try {
      const query = await queryDaemon(info.port, await readToken(paths));
      const active = query.sessions.filter((s) => s.status !== 'closed').length;
      io.out(`버전: ${query.version} · 세션: 활성 ${active} / 전체 ${query.sessions.length}`);
    } catch (error) {
      io.err(`상태 질의 실패: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  return 0;
}

function cmdVersion(io: CliIo): number {
  io.out(`custom-harness ${packageJson.version} (protocol v${PROTOCOL_VERSION})`);
  io.out('번들 manifest 버전 표시는 WBS 1.7(번들) 배선 후 제공');
  return 0;
}

/** logs (WBS 2.6.2, FR-5.3) — 인자 없음: 로그 파일 목록·경로 안내 / 이름 지정: 마지막 N줄 */
async function cmdLogs(paths: DaemonPaths, io: CliIo, name?: string, lines = 50): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(paths.logsDir)).filter((f) => f.endsWith('.log')).sort();
  } catch {
    io.out(`로그 디렉토리 없음: ${paths.logsDir} (데몬 최초 기동 시 생성)`);
    return 1;
  }
  if (name === undefined) {
    io.out(`로그 디렉토리: ${paths.logsDir}`);
    if (entries.length === 0) {
      io.out('로그 파일 없음');
      return 0;
    }
    for (const entry of entries) {
      const size = (await stat(join(paths.logsDir, entry))).size;
      io.out(`  ${entry}  (${(size / 1024).toFixed(1)}KB)`);
    }
    io.out('tail: custom-harness logs <이름|daemon> [--lines N]');
    return 0;
  }
  // 이름 매칭 — 정확 일치 → 접두 일치 (daemon → daemon.log, 세션ID 접두 등)
  const fileName =
    entries.find((f) => f === name || f === `${name}.log`) ??
    entries.find((f) => f.startsWith(name));
  if (fileName === undefined) {
    io.err(`로그 파일 없음: ${name} (custom-harness logs 로 목록 확인)`);
    return 1;
  }
  const path = join(paths.logsDir, fileName);
  const content = await readFile(path, 'utf8');
  const all = content.split('\n');
  const tail = all.slice(Math.max(0, all.length - (all.at(-1) === '' ? lines + 1 : lines)));
  io.out(`── ${path} (마지막 ${lines}줄) ──`);
  for (const line of tail) io.out(line);
  return 0;
}

const USAGE = `사용법:
  custom-harness daemon start          데몬 기동 (실행 중이면 no-op)
  custom-harness daemon stop [--force] 데몬 정상 종료 (활성 세션 있으면 --force 필요)
  custom-harness daemon status         실행 여부·PID·포트·세션 수·버전
  custom-harness doctor                설치 자가 진단 (manifest·하네스·게이트웨이·프리셋·경계)
  custom-harness logs [이름] [--lines N]  로그 목록/경로 안내 · 지정 시 마지막 N줄 (기본 50)
  custom-harness version               본체 버전`;

export async function runCli(
  args: string[],
  io: CliIo = { out: console.log, err: console.error },
): Promise<number> {
  const paths = resolvePaths();
  const [command, sub, ...rest] = args;
  try {
    if (command === 'version') return cmdVersion(io);
    if (command === 'doctor') return await runDoctor(paths, io);
    if (command === 'logs') {
      const linesFlag = [sub, ...rest].indexOf('--lines');
      const lines =
        linesFlag >= 0 ? Number([sub, ...rest][linesFlag + 1] ?? '50') || 50 : undefined;
      const name = sub !== undefined && sub !== '--lines' ? sub : undefined;
      return await cmdLogs(paths, io, name, lines ?? 50);
    }
    if (command === 'daemon') {
      if (sub === 'start') return await cmdStart(paths, io);
      if (sub === 'stop') return await cmdStop(paths, io, rest.includes('--force'));
      if (sub === 'status') return await cmdStatus(paths, io);
    }
    io.err(USAGE);
    return command === undefined || command === 'help' ? 0 : 2;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
