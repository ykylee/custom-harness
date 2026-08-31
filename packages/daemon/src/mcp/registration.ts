// 역방향 MCP 서버 등록 (WBS 7.2.3, FR-9.2)
//
// 하네스마다 등록 창구가 다르다 (7.2.1 실측):
//   omp  — 격리 홈의 `mcp.json` 을 직접 쓴다. 여기에 `tools.xdev=false` 가 동반돼야 top-level 노출
//   grok — `grok mcp add` 가 정본이다. `$GROK_HOME/config.toml` 의 `[mcp_servers.*]` 스키마를
//          우리가 추측하지 않는다 — 하네스 자신의 CLI 가 쓰게 한다
//   pi   — MCP 를 설계상 배제. 확장(`pi.registerTool`)으로 따로 간다 (후속)
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 서버 이름. 짧게 유지한다 — 하네스가 다시 접두사를 붙이기 때문이다
 * (omp `mcp__ch_session_list`, grok `ch__session_list`). 길면 모델이 다루기 나빠진다 (7.2.2).
 *
 * 짧은 만큼 저장소가 프로젝트 스코프 `.mcp.json` 으로 **선점할 수 있다** (7.2.1 §3.5) —
 * 그 탐지는 7.2.4 의 몫이다.
 */
export const REVERSE_MCP_SERVER_NAME = 'ch';

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** MCP 서버 진입점 절대 경로 — 이 모듈과 같이 배포되므로 자기 위치에서 유도한다 */
export function resolveMcpEntryPath(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

/**
 * spawn 사양을 만든다.
 *
 * `command` 는 데몬 자신의 `process.execPath` 다 — 번들에서는 Electron 내장 Node 이고
 * (`ELECTRON_RUN_AS_NODE` 를 물려줘야 Node 로 뜬다), 개발에서는 그냥 node 다. pi 어댑터가
 * 같은 방식을 쓴다 (FR-4.1.3).
 *
 * `CUSTOM_HARNESS_HOME` 은 **항상** 넘긴다 — MCP 서버는 홈이 격리된 하네스의 자식이라
 * `homedir()` 로는 데이터 디렉토리를 못 찾는다 (WBS 7.2.0a).
 */
export function resolveMcpServerSpec(options: {
  root: string;
  name?: string;
  execPath?: string;
  entryPath?: string;
  runAsNode?: boolean;
}): McpServerSpec {
  const runAsNode = options.runAsNode ?? process.env.ELECTRON_RUN_AS_NODE !== undefined;
  return {
    name: options.name ?? REVERSE_MCP_SERVER_NAME,
    command: options.execPath ?? process.execPath,
    args: [options.entryPath ?? resolveMcpEntryPath()],
    env: {
      CUSTOM_HARNESS_HOME: options.root,
      ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}

export type McpRegistrationStatus = 'created' | 'unchanged' | 'updated';

export interface OmpMcpRegistrationResult {
  status: McpRegistrationStatus;
  configPath: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * omp 격리 홈의 `mcp.json` 에 우리 서버를 기입한다.
 *
 * 우리 이름의 항목만 관리하고 나머지는 보존한다 — 사용자가 추가한 서버를 지우지 않는다.
 * 드리프트 정책이 주입 모듈들과 다른 점: 여기서는 **우리 항목을 항상 최신으로 덮는다**.
 * 이 항목은 사용자 설정이 아니라 데몬의 실행 사양이고(포트가 아니라 경로·env 라 회전하지
 * 않지만 번들 경로는 업데이트마다 바뀐다), 낡은 채로 두면 서버가 아예 안 뜬다.
 */
export async function registerOmpMcpServer(
  ompHomeDir: string,
  spec: McpServerSpec,
): Promise<OmpMcpRegistrationResult> {
  const configPath = join(ompHomeDir, 'mcp.json');
  let existing: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    existing =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    existing = undefined; // 없음 또는 파싱 불가 — 새로 쓴다
  }

  const servers: Record<string, unknown> =
    existing !== undefined &&
    typeof existing.mcpServers === 'object' &&
    existing.mcpServers !== null
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  const desired = { command: spec.command, args: spec.args, env: spec.env };

  if (existing !== undefined && same(servers[spec.name], desired)) {
    return { status: 'unchanged', configPath };
  }
  const hadEntry = servers[spec.name] !== undefined;
  servers[spec.name] = desired;

  await mkdir(ompHomeDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ ...(existing ?? {}), mcpServers: servers }, null, 2)}\n`,
  );
  return {
    status: existing === undefined ? 'created' : hadEntry ? 'updated' : 'created',
    configPath,
  };
}

export interface GrokMcpRegistrationResult {
  status: 'registered';
  /** `grok mcp add` 표준 출력 — 진단용 */
  output: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * grok 에 우리 서버를 등록한다 — **하네스 CLI 에 위임**한다.
 *
 * `config.toml` 을 직접 쓰지 않는 이유: `[mcp_servers.*]` 스키마는 문서화가 얇고 버전 사이에
 * 바뀐 전례가 있다(1.0.5 → 1.0.13). `grok mcp add` 는 grok 자신이 읽을 형식으로 쓴다.
 *
 * 멱등성은 remove → add 로 만든다. `add` 만 반복하면 같은 이름이 이미 있을 때 실패하고,
 * `remove` 는 없는 이름에 대해 실패해도 무해하므로 결과를 무시한다.
 */
export async function registerGrokMcpServer(options: {
  execPath: string;
  grokHome: string;
  spec: McpServerSpec;
  /** 하네스 홈 격리 env — 데몬의 buildEnv 가 만든 것을 그대로 넘긴다 (WBS 7.2.0a) */
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  timeoutMs?: number;
}): Promise<GrokMcpRegistrationResult> {
  const run: CommandRunner =
    options.run ?? ((file, args, opts) => execFileAsync(file, args, { ...opts, encoding: 'utf8' }));
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? {}),
    GROK_HOME: options.grokHome,
  };
  const timeout = options.timeoutMs ?? 15_000;
  const { name, command, args, env: serverEnv } = options.spec;

  try {
    await run(options.execPath, ['mcp', 'remove', name, '--scope', 'user'], { env, timeout });
  } catch {
    // 없던 이름이면 실패가 정상이다
  }

  const addArgs = ['mcp', 'add', name, '--scope', 'user'];
  for (const [key, value] of Object.entries(serverEnv)) addArgs.push('-e', `${key}=${value}`);
  addArgs.push('--', command, ...args);

  const { stdout, stderr } = await run(options.execPath, addArgs, { env, timeout });
  return { status: 'registered', output: `${stdout}${stderr}`.trim() };
}
