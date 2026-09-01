// 관리 CLI (WBS 1.6.3·2.6, FR-5.1·FR-5.3) — daemon start/stop/status/version + doctor/logs.
//
// M7 7.5.1 부터 **세션 조작 명령이 여기 붙는다** (FR-9.6). FR-5.4 의 "에이전트 조작은
// UI 가 유일한 창구" 제한은 그 항목의 승인으로 풀렸다 — 자동화가 1급 경로라면 조작이
// UI 안에만 있어서는 안 된다. 세션 명령 본체는 `session-commands.ts`.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type SessionSummary } from '@custom-harness/protocol';
import {
  launchDetachedDaemon,
  readDaemonInfo,
  resolvePaths,
  stopDaemon,
  type DaemonPaths,
} from '@custom-harness/daemon';
import { readFile, readdir, stat } from 'node:fs/promises';
import { DaemonConnection, DaemonNotRunningError, RpcError } from './connection.js';
import { consoleIo, type CliIo } from './io.js';
import {
  cmdSessionApprove,
  cmdSessionClose,
  cmdSessionInterrupt,
  cmdSessionList,
  cmdSessionNew,
  cmdSessionPrompt,
  cmdSessionWatch,
} from './session-commands.js';
import { cmdWorkspaceArchive, cmdWorkspaceList, cmdWorkspaceNew } from './workspace-commands.js';
import { runDoctor } from './doctor.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

export type { CliIo } from './io.js';

/**
 * 실패 출력 규약 (M7 WBS 7.5.3, FR-9.6) — **오류는 언제나 stderr** 이다.
 *
 * `--json` 이어도 stdout 으로 보내지 않는다: stdout 을 payload 전용으로 비워 두어야
 * `cmd --json > out.json` 이 성공했을 때만 내용을 갖는다(7.5.1 의 "stdout 은 답" 규약의
 * 연장). 종료 코드가 여전히 1차 신호이고, JSON 은 그 **이유**를 기계가 읽게 해 준다.
 */
function fail(io: CliIo, json: boolean, code: string, message: string): void {
  io.err(json ? JSON.stringify({ error: { code, message } }) : message);
}

function resolveDaemonEntry(): string {
  // 테스트·번들에서 진입점 교체 가능 (번들 배선은 1.7)
  return process.env.CUSTOM_HARNESS_DAEMON_ENTRY ?? require.resolve('@custom-harness/daemon/main');
}

interface DaemonQuery {
  version: string;
  sessions: SessionSummary[];
}

/** 실행 중 데몬에 질의 — 연결·인증·상관관계는 DaemonConnection 이 소유한다 (7.5.1) */
async function queryDaemon(paths: DaemonPaths): Promise<DaemonQuery> {
  const connection = await DaemonConnection.open(paths, packageJson.version, 3000);
  try {
    const [version, sessions] = await Promise.all([
      connection.rpc<{ version: string }>('system.version', {}, 3000),
      connection.rpc<{ sessions: SessionSummary[] }>('session.list', {}, 3000),
    ]);
    return { version: version.version, sessions: sessions.sessions };
  } finally {
    connection.close();
  }
}

async function cmdStart(paths: DaemonPaths, io: CliIo, json: boolean): Promise<number> {
  const result = await launchDetachedDaemon({
    paths,
    entryPath: resolveDaemonEntry(),
    managedBy: 'cli',
  });
  if (json) {
    io.out(
      JSON.stringify({
        running: true,
        alreadyRunning: result.alreadyRunning,
        pid: result.info.pid,
        port: result.info.port,
      }),
    );
    return 0;
  }
  if (result.alreadyRunning) {
    io.out(`데몬이 이미 실행 중입니다 (pid=${result.info.pid}, port=${result.info.port})`);
  } else {
    io.out(`데몬 기동 완료 (pid=${result.info.pid}, port=${result.info.port})`);
  }
  return 0;
}

async function cmdStop(
  paths: DaemonPaths,
  io: CliIo,
  force: boolean,
  json: boolean,
): Promise<number> {
  const info = await readDaemonInfo(paths);
  if (!info) {
    if (json) io.out(JSON.stringify({ stopped: false, wasRunning: false }));
    else io.out('실행 중인 데몬이 없습니다');
    return 0;
  }
  // 실행 중 세션 존재 시 경고 + 확인 (FR-5.1) — 비대화형이므로 --force 로 확인을 갈음
  if (!force && info.port !== null) {
    try {
      const query = await queryDaemon(paths);
      const active = query.sessions.filter(
        (s) => s.status === 'running' || (s.pendingPermissions?.length ?? 0) > 0,
      );
      if (active.length > 0) {
        fail(
          io,
          json,
          'busy',
          `실행 중이거나 승인 대기 중인 세션 ${active.length}개가 있습니다 — 종료하려면 --force`,
        );
        return 1;
      }
    } catch {
      fail(io, json, 'unavailable', '세션 상태 확인 실패 — 그래도 종료하려면 --force');
      return 1;
    }
  }
  const result = await stopDaemon(paths);
  if (!result.stopped) {
    fail(io, json, 'timeout', `데몬(pid=${info.pid})이 시간 내 종료되지 않았습니다`);
    return 1;
  }
  if (json) io.out(JSON.stringify({ stopped: true, wasRunning: result.wasRunning }));
  else io.out(result.wasRunning ? '데몬 종료 완료' : '실행 중인 데몬이 없습니다');
  return 0;
}

async function cmdStatus(paths: DaemonPaths, io: CliIo, json: boolean): Promise<number> {
  const info = await readDaemonInfo(paths);
  if (!info) {
    // 정지됨은 오류가 아니라 **상태**다 — 종료 코드로 구분하되 error 로 싣지 않는다
    if (json) io.out(JSON.stringify({ running: false }));
    else io.out('데몬: 정지됨');
    return 1;
  }
  if (info.port === null) {
    if (json) io.out(JSON.stringify({ running: true, pid: info.pid, managedBy: info.managedBy }));
    else io.out(`데몬: 실행 중 (pid=${info.pid}, port=${info.port}, managedBy=${info.managedBy})`);
    return 0;
  }
  let query: DaemonQuery;
  try {
    query = await queryDaemon(paths);
  } catch (error) {
    if (!json) {
      io.out(`데몬: 실행 중 (pid=${info.pid}, port=${info.port}, managedBy=${info.managedBy})`);
    }
    fail(
      io,
      json,
      'unavailable',
      `상태 질의 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const active = query.sessions.filter((s) => s.status !== 'closed').length;
  if (json) {
    io.out(
      JSON.stringify({
        running: true,
        pid: info.pid,
        port: info.port,
        managedBy: info.managedBy,
        version: query.version,
        sessions: { active, total: query.sessions.length },
      }),
    );
    return 0;
  }
  io.out(`데몬: 실행 중 (pid=${info.pid}, port=${info.port}, managedBy=${info.managedBy})`);
  io.out(`버전: ${query.version} · 세션: 활성 ${active} / 전체 ${query.sessions.length}`);
  return 0;
}

function cmdVersion(io: CliIo, json: boolean): number {
  if (json) {
    io.out(JSON.stringify({ version: packageJson.version, protocolVersion: PROTOCOL_VERSION }));
    return 0;
  }
  io.out(`custom-harness ${packageJson.version} (protocol v${PROTOCOL_VERSION})`);
  io.out('번들 manifest 버전 표시는 WBS 1.7(번들) 배선 후 제공');
  return 0;
}

/** logs (WBS 2.6.2, FR-5.3) — 인자 없음: 로그 파일 목록·경로 안내 / 이름 지정: 마지막 N줄 */
async function cmdLogs(
  paths: DaemonPaths,
  io: CliIo,
  json: boolean,
  name?: string,
  lines = 50,
): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(paths.logsDir)).filter((f) => f.endsWith('.log')).sort();
  } catch {
    fail(io, json, 'not_found', `로그 디렉토리 없음: ${paths.logsDir} (데몬 최초 기동 시 생성)`);
    return 1;
  }
  if (name === undefined) {
    if (json) {
      const files = [];
      for (const entry of entries) {
        files.push({
          name: entry,
          path: join(paths.logsDir, entry),
          size: (await stat(join(paths.logsDir, entry))).size,
        });
      }
      io.out(JSON.stringify({ logsDir: paths.logsDir, files }));
      return 0;
    }
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
    fail(io, json, 'not_found', `로그 파일 없음: ${name} (custom-harness logs 로 목록 확인)`);
    return 1;
  }
  const path = join(paths.logsDir, fileName);
  const content = await readFile(path, 'utf8');
  const all = content.split('\n');
  const tail = all.slice(Math.max(0, all.length - (all.at(-1) === '' ? lines + 1 : lines)));
  if (json) {
    io.out(JSON.stringify({ path, lines: tail }));
    return 0;
  }
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
  custom-harness version               본체 버전

  --json  모든 명령에 붙는 **전역** 플래그 (FR-9.6). 성공은 stdout 에 JSON 한 줄
          (스트리밍은 이벤트 JSONL), 실패는 **stderr 에** {"error":{code,message}}.
          stdout 을 payload 전용으로 비워 둬야 "cmd --json > out.json" 이 성공했을
          때만 내용을 갖는다.

세션 (FR-9.6 — 모든 명령에 --json):
  custom-harness session list [--workspace ID] [--all]
  custom-harness session new --harness <pi|omp|grok|mock> [--cwd DIR] [--workspace ID] [--model M]
  custom-harness session prompt <세션> <텍스트...> [--wait]
  custom-harness session watch <세션> [--from-seq N]
  custom-harness session interrupt <세션>
  custom-harness session close <세션>
  custom-harness session approve <세션> [--request ID] [--option ID] [--reject]

워크스페이스 (FR-9.6):
  custom-harness workspace list [--project ID] [--all]
  custom-harness workspace new (--project ID | --root DIR) [--isolation directory|worktree]
                               [--branch B] [--base-branch B] [--name N] [--cwd DIR]
      --branch 단독 = 기존 브랜치 체크아웃 / --base-branch 를 함께 주면 새 브랜치 분기
  custom-harness workspace archive <워크스페이스> [--remove-checkout] [--force]

  스트리밍은 stdout 에 답만, 툴·승인·진단은 stderr 로 보낸다:
    custom-harness session prompt s-1 "테스트 고쳐줘" --wait > answer.txt`;

/** 아주 작은 플래그 파서 — 의존성을 늘리지 않는다(폐쇄망 번들에 얹을 것을 줄인다) */
interface ParsedArgs {
  flags: Record<string, string | true>;
  positional: string[];
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    // 다음 토큰이 값인지 불린 플래그인지 — `--wait --json` 에서 --json 을 값으로 먹지 않는다
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positional };
}

const flagString = (value: string | true | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** 워크스페이스 명령 (7.5.2) — 세션 명령과 같은 연결 수명·출력 규약 */
async function runWorkspaceCommand(
  paths: DaemonPaths,
  io: CliIo,
  sub: string | undefined,
  rest: readonly string[],
  json: boolean,
): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  const connection = await DaemonConnection.open(paths, packageJson.version);
  const context = { connection, io, json };
  try {
    switch (sub) {
      case 'list':
        return await cmdWorkspaceList(context, {
          projectId: flagString(flags.project),
          all: flags.all === true,
        });
      case 'new': {
        const isolation = flagString(flags.isolation) ?? 'directory';
        if (isolation !== 'directory' && isolation !== 'worktree') {
          io.err('--isolation 은 directory 또는 worktree');
          return 2;
        }
        return await cmdWorkspaceNew(context, {
          projectId: flagString(flags.project),
          root: flagString(flags.root),
          isolation,
          cwd: flagString(flags.cwd),
          branch: flagString(flags.branch),
          baseBranch: flagString(flags['base-branch']),
          displayName: flagString(flags.name),
        });
      }
      case 'archive': {
        const workspaceId = positional[0];
        if (workspaceId === undefined) {
          io.err('사용법: workspace archive <워크스페이스> [--remove-checkout] [--force]');
          return 2;
        }
        return await cmdWorkspaceArchive(context, {
          workspaceId,
          removeCheckout: flags['remove-checkout'] === true,
          force: flags.force === true,
        });
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } finally {
    connection.close();
  }
}

/**
 * 세션 명령 — 연결을 **하나만** 열고 명령이 끝나면 닫는다.
 *
 * 스트리밍 명령은 그 연결로 이벤트를 받으므로, 명령마다 연결을 새로 여는 구조였다면
 * 프롬프트를 보낸 연결과 이벤트를 듣는 연결이 달라져 구독 시점 갭이 생긴다.
 */
async function runSessionCommand(
  paths: DaemonPaths,
  io: CliIo,
  sub: string | undefined,
  rest: readonly string[],
  json: boolean,
): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  const connection = await DaemonConnection.open(paths, packageJson.version);
  const context = { connection, io, json };
  try {
    switch (sub) {
      case 'list':
        return await cmdSessionList(context, {
          workspaceId: flagString(flags.workspace),
          all: flags.all === true,
        });
      case 'new': {
        const harness = flagString(flags.harness);
        if (harness === undefined) {
          io.err('--harness 가 필요합니다 (pi|omp|grok|mock)');
          return 2;
        }
        return await cmdSessionNew(context, {
          harness,
          cwd: flagString(flags.cwd) ?? process.cwd(),
          workspaceId: flagString(flags.workspace),
          modelId: flagString(flags.model),
        });
      }
      case 'prompt': {
        const [sessionId, ...words] = positional;
        if (sessionId === undefined || words.length === 0) {
          io.err('사용법: session prompt <세션> <텍스트...> [--wait]');
          return 2;
        }
        return await cmdSessionPrompt(context, {
          sessionId,
          prompt: words.join(' '),
          wait: flags.wait === true,
        });
      }
      case 'watch': {
        const sessionId = positional[0];
        if (sessionId === undefined) {
          io.err('사용법: session watch <세션> [--from-seq N]');
          return 2;
        }
        const fromSeq = flagString(flags['from-seq']);
        return await cmdSessionWatch(context, {
          sessionId,
          ...(fromSeq !== undefined ? { fromSeq: Number(fromSeq) } : {}),
        });
      }
      case 'interrupt':
      case 'close': {
        const sessionId = positional[0];
        if (sessionId === undefined) {
          io.err(`사용법: session ${sub} <세션>`);
          return 2;
        }
        return sub === 'interrupt'
          ? await cmdSessionInterrupt(context, sessionId)
          : await cmdSessionClose(context, sessionId);
      }
      case 'approve': {
        const sessionId = positional[0];
        if (sessionId === undefined) {
          io.err('사용법: session approve <세션> [--request ID] [--option ID] [--reject]');
          return 2;
        }
        return await cmdSessionApprove(context, {
          sessionId,
          requestId: flagString(flags.request),
          optionId: flagString(flags.option),
          reject: flags.reject === true,
        });
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } finally {
    connection.close();
  }
}

export async function runCli(args: string[], io: CliIo = consoleIo): Promise<number> {
  const paths = resolvePaths();
  const [command, sub, ...rest] = args;
  // `--json` 은 **전역** 플래그다 (7.5.3) — 명령마다 따로 해석하면 어떤 명령은 되고
  // 어떤 명령은 안 되는 상태가 조용히 생긴다
  const json = args.includes('--json');
  try {
    if (command === 'version') return cmdVersion(io, json);
    if (command === 'doctor') return await runDoctor(paths, io, json);
    if (command === 'logs') {
      const tail = [sub, ...rest].filter((arg): arg is string => arg !== undefined);
      const { flags, positional } = parseArgs(tail);
      const lines = Number(typeof flags.lines === 'string' ? flags.lines : '50') || 50;
      return await cmdLogs(paths, io, json, positional[0], lines);
    }
    if (command === 'daemon') {
      if (sub === 'start') return await cmdStart(paths, io, json);
      if (sub === 'stop') return await cmdStop(paths, io, rest.includes('--force'), json);
      if (sub === 'status') return await cmdStatus(paths, io, json);
    }
    if (command === 'session') return await runSessionCommand(paths, io, sub, rest, json);
    if (command === 'workspace') return await runWorkspaceCommand(paths, io, sub, rest, json);
    // 도움말은 **성공**이다 → stdout. 알 수 없는 명령은 오류다 → stderr + 종료 코드 2
    if (command === undefined || command === 'help') {
      io.out(USAGE);
      return 0;
    }
    fail(io, json, 'unknown_command', USAGE);
    return 2;
  } catch (error) {
    // 스크립트는 "데몬이 안 떠 있다"와 "요청이 틀렸다"를 구분할 수 있어야 한다
    const code =
      error instanceof DaemonNotRunningError
        ? 'daemon_not_running'
        : error instanceof RpcError
          ? error.code
          : 'error';
    fail(io, json, code, error instanceof Error ? error.message : String(error));
    return 1;
  }
}
