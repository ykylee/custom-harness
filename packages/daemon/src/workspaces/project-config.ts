// 프로젝트 설정 파일 `harness.json` (WBS 5.5.3, workspace-model §7).
//
// 이 파일의 내용은 곧 실행될 명령이다. 그래서 두 가지를 강제한다:
//   ① **베이스 브랜치의 커밋된 내용만** 읽는다 — 작업 중 브랜치의 미커밋 변경이 실행 경로에 새 나가지 않게.
//   ② 실행 전 **신뢰 확인**을 받는다. 신뢰는 (프로젝트, 파일 내용 해시)에 묶이므로 내용이 바뀌면 다시 묻는다.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RegistryStore } from './registry-store.js';

const run = promisify(execFile);

export const PROJECT_CONFIG_FILE = 'harness.json';

/** 멀티라인 셸 또는 명령 배열 — 어느 쪽이든 순차 실행 */
const CommandsSchema = z.union([z.string(), z.array(z.string())]);

export const ProjectConfigSchema = z.looseObject({
  workspace: z
    .looseObject({
      setup: CommandsSchema.optional(),
      teardown: CommandsSchema.optional(),
    })
    .optional(),
  scripts: z.record(z.string(), z.looseObject({ command: z.string() })).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** 신뢰 판정 대상 — 원문 바이트의 sha256 */
  contentHash: string;
  raw: string;
}

function toCommands(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter((command) => command.trim() !== '');
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * 베이스 브랜치의 커밋본에서 설정을 읽는다. 파일이 없으면 undefined — 설정 파일은 선택이다.
 * 파손된 JSON 도 undefined 로 취급하되 사유를 남긴다(관대 파싱, NFR-5).
 */
export async function loadProjectConfig(
  repoRoot: string,
  ref: string,
): Promise<LoadedProjectConfig | undefined> {
  let raw: string;
  try {
    const { stdout } = await run('git', ['show', `${ref}:${PROJECT_CONFIG_FILE}`], {
      cwd: repoRoot,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    raw = stdout;
  } catch {
    return undefined; // 파일 없음 또는 ref 없음
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[daemon] ${PROJECT_CONFIG_FILE} 파싱 실패 (${repoRoot}@${ref}) — 무시`);
    return undefined;
  }
  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[daemon] ${PROJECT_CONFIG_FILE} 스키마 불일치 (${repoRoot}@${ref}) — 무시`);
    return undefined;
  }
  return {
    config: result.data,
    contentHash: createHash('sha256').update(raw).digest('hex'),
    raw,
  };
}

export function setupCommands(config: ProjectConfig): string[] {
  return toCommands(config.workspace?.setup);
}
export function teardownCommands(config: ProjectConfig): string[] {
  return toCommands(config.workspace?.teardown);
}

// ── 신뢰 원장 ───────────────────────────────────────────────────────────────

export const TrustEntrySchema = z.looseObject({
  /** `${projectId}:${contentHash}` */
  id: z.string(),
  projectId: z.string(),
  contentHash: z.string(),
  grantedAt: z.string(),
});
export type TrustEntry = z.infer<typeof TrustEntrySchema>;

export function trustId(projectId: string, contentHash: string): string {
  return `${projectId}:${contentHash}`;
}

export class TrustStore {
  private readonly store: RegistryStore<TrustEntry>;

  constructor(projectsDir: string) {
    this.store = new RegistryStore(join(projectsDir, 'config-trust.json'), TrustEntrySchema);
  }

  async isTrusted(projectId: string, contentHash: string): Promise<boolean> {
    const id = trustId(projectId, contentHash);
    return (await this.store.readAll()).some((entry) => entry.id === id);
  }

  /** 내용이 바뀌면 새 항목이 되므로, 이전 승인이 새 내용을 덮지 않는다 */
  async grant(projectId: string, contentHash: string): Promise<void> {
    const id = trustId(projectId, contentHash);
    await this.store.mutate((records) => {
      if (records.some((entry) => entry.id === id)) return { records, result: undefined };
      return {
        records: [...records, { id, projectId, contentHash, grantedAt: new Date().toISOString() }],
        result: undefined,
      };
    });
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────

export interface RunCommandsResult {
  ok: boolean;
  /** 실패한 명령과 종료 코드 — UI 가 어디서 멈췄는지 보여줄 수 있게 */
  failed?: { command: string; exitCode: number | null; stderr: string };
}

/**
 * 명령을 순차 실행한다. 하나라도 실패하면 거기서 멈춘다 —
 * setup 이 반쯤 적용된 워크스페이스를 성공으로 표시하지 않는다.
 */
export async function runCommands(
  commands: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<RunCommandsResult> {
  for (const command of commands) {
    const outcome = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      // 셸 경유가 의도적이다 — 설정 파일은 파이프·리다이렉트를 포함한 스크립트를 담는다.
      // 그래서 실행 전 신뢰 확인이 필수다 (workspace-model §7).
      const child = spawn(command, {
        cwd: options.cwd,
        env: options.env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4096);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 600_000);
      timer.unref?.();
      child.on('error', () => resolve({ code: -1, stderr }));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
    if (outcome.code !== 0) {
      return { ok: false, failed: { command, exitCode: outcome.code, stderr: outcome.stderr } };
    }
  }
  return { ok: true };
}
