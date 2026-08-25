// grok 게이트웨이 설정 주입 (WBS 2.2.2, FR-2.1.3/FR-2.2, credential-injection-design §2)
// 대상: 격리 홈(GROK_HOME)의 config.toml. 스키마 근거: grok 1.0.5 실기 파싱 통과 +
// 공식 config 문서(user-guide 05/26) — [cli] auto_update, [features] telemetry/remote_fetch/
// managed_config, [models] default·web_search, [model.<id>] base_url·api_backend·env_key.
// api key 는 env_key(환경변수명)로만 기록 — 평문 금지 (FR-2.1.1).
// grok 는 런타임에 config.toml 을 재작성한다(M0 실측: [marketplace] 자동 추가) —
// 관리 항목만 병합하고 그 외는 보존. 드리프트는 자동 덮어쓰기 금지 (pi/omp 와 동일 정책).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { GatewayModel } from './pi-injection.js';

export interface GrokInjectionConfig {
  /** 게이트웨이 base URL (OpenAI 호환 /v1) */
  baseUrl: string;
  /** env_key 로 기록할 환경변수명 — 평문 금지 (FR-2.1.1) */
  apiKeyEnvVar: string;
  models: GatewayModel[];
  /** [models] default·web_search 대상 — 미지정 시 models[0] (보조 호출 유출 방지, M0 실측) */
  defaultModel?: string | undefined;
}

export type GrokInjectionStatus = 'created' | 'unchanged' | 'updated' | 'drift';

export interface GrokInjectionResult {
  status: GrokInjectionStatus;
  configPath: string;
  backupPath?: string;
}

/** 관리 경로 → 원하는 값. [model.<id>] 는 게이트웨이 모델별 1섹션 */
function managedEntries(config: GrokInjectionConfig): [string[], unknown][] {
  const defaultModel = config.defaultModel ?? config.models[0]?.id;
  const entries: [string[], unknown][] = [
    [['cli', 'auto_update'], false],
    // 오프라인 스위치 3종 현행 구문 (v1.0.5 — 구 top-level telemetry 는 파싱 에러, M0 실측)
    [['features', 'telemetry'], false],
    [['features', 'remote_fetch'], false],
    [['features', 'managed_config'], false],
  ];
  if (defaultModel !== undefined) {
    // 세션 제목 생성 등 보조 호출도 게이트웨이 모델로 고정 (M0 실측 발견 반영)
    entries.push([['models', 'default'], defaultModel]);
    entries.push([['models', 'web_search'], defaultModel]);
  }
  for (const m of config.models) {
    entries.push([
      ['model', m.id],
      {
        model: m.id,
        ...(m.name !== undefined ? { name: m.name } : {}),
        base_url: config.baseUrl,
        api_backend: 'chat_completions',
        env_key: config.apiKeyEnvVar,
      },
    ]);
  }
  return entries;
}

function getPath(root: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function setPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1] as string] = value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * config.toml 에 관리 항목을 주입한다.
 * - 파일/관리 항목 없음 → 생성 (created)
 * - 관리 항목 전부 동일 → 무변경 (unchanged)
 * - 관리 항목 상이 + force → 백업 후 갱신 (updated)
 * - 관리 항목 상이 + !force → 손대지 않고 드리프트 보고 (drift)
 */
export async function injectGrokGateway(
  grokHomeDir: string,
  config: GrokInjectionConfig,
  options: { force?: boolean } = {},
): Promise<GrokInjectionResult> {
  const configPath = join(grokHomeDir, 'config.toml');
  const desired = managedEntries(config);

  let existing: Record<string, unknown> | undefined;
  try {
    existing = parseToml(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = undefined; // 없음 또는 파싱 불가
  }

  const drift =
    existing !== undefined &&
    desired.some(([path, value]) => {
      const current = getPath(existing, path);
      return current !== undefined && !same(current, value);
    });
  const changed =
    existing === undefined ||
    desired.some(([path, value]) => !same(getPath(existing, path), value));

  if (!changed) return { status: 'unchanged', configPath };
  if (drift && !options.force) return { status: 'drift', configPath };

  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [path, value] of desired) setPath(next, path, value);
  await mkdir(grokHomeDir, { recursive: true });
  let backupPath: string | undefined;
  if (existing !== undefined) {
    backupPath = `${configPath}.bak`;
    await writeFile(backupPath, stringifyToml(existing));
  }
  await writeFile(configPath, stringifyToml(next));
  return {
    status: existing === undefined ? 'created' : 'updated',
    configPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}
