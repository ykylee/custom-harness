// omp 게이트웨이 설정 주입 (WBS 2.1.3, FR-2.1.2/FR-2.2, credential-injection-design §2)
// 대상: 격리 홈(PI_CODING_AGENT_DIR)의 models.yml + config.yml.
// - models.yml: 관리 프로바이더 블록 (oh-my-pi 17.3.8 ProviderConfigSchema 실측 —
//   apiKey 는 bare env 변수명으로 기록, omp resolveConfigValue 가 env 우선 해석)
// - config.yml: modelRoles.default + 오프라인 프리셋 (omp 는 PI_OFFLINE 미지원 실측 —
//   startup.checkUpdate / marketplace.autoUpdate / dev.autoqa 설정으로 차단)
// 관리 항목만 생성·갱신하고 그 외 항목은 보존. 변경 전 원본 백업, 드리프트는
// 자동 덮어쓰기 금지(경고 후 명시 갱신) — pi-injection 과 동일 정책.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GatewayModel } from './pi-injection.js';

export interface OmpInjectionConfig {
  /** 게이트웨이 base URL (OpenAI 호환 /v1) */
  baseUrl: string;
  /** models.yml providers.<name> — 자사 관리 블록 이름 */
  providerName: string;
  /** apiKey 는 env 변수명으로만 기록 — 평문 금지 (FR-2.1.1) */
  apiKeyEnvVar: string;
  models: GatewayModel[];
  /** modelRoles.default 대상 — 미지정 시 models[0] */
  defaultModel?: string | undefined;
  /** 게이트웨이 비표준 응답 대응 (C-1 실측 후 확정) */
  compat?: Record<string, unknown> | undefined;
}

export type OmpInjectionStatus = 'created' | 'unchanged' | 'updated' | 'drift';

export interface OmpInjectionResult {
  status: OmpInjectionStatus;
  modelsPath: string;
  configPath: string;
  backupPaths: string[];
}

function managedProviderBlock(config: OmpInjectionConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    api: 'openai-completions',
    // omp model-config-values.ts 실측: 값을 env 변수명으로 우선 해석 (pi 의 "$VAR" 와 다름)
    apiKey: config.apiKeyEnvVar,
    authHeader: true,
    ...(config.compat ? { compat: config.compat } : {}),
    models: config.models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) })),
  };
}

/** config.yml 관리 경로 → 원하는 값 (중첩 병합) */
function managedConfigEntries(config: OmpInjectionConfig): [string[], unknown][] {
  const defaultModel = config.defaultModel ?? config.models[0]?.id;
  return [
    ...(defaultModel !== undefined
      ? ([[['modelRoles', 'default'], `${config.providerName}/${defaultModel}`]] as [
          string[],
          unknown,
        ][])
      : []),
    [['startup', 'checkUpdate'], false],
    [['marketplace', 'autoUpdate'], false],
    [['dev', 'autoqa'], false],
    [['dev', 'autoqaConsent'], 'denied'],
  ];
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

async function readYamlFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = parseYaml(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return undefined; // 없음 또는 파싱 불가 — 파싱 불가는 undefined 로 보고 새로 쓰지 않는다
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * models.yml + config.yml 에 관리 항목을 주입한다.
 * - 두 파일 모두 없음/관리 항목 없음 → 생성 (created)
 * - 관리 항목 전부 동일 → 무변경 (unchanged)
 * - 관리 항목 상이 + force → 백업 후 갱신 (updated)
 * - 관리 항목 상이 + !force → 어느 파일도 손대지 않고 드리프트 보고 (drift)
 */
export async function injectOmpGateway(
  ompHomeDir: string,
  config: OmpInjectionConfig,
  options: { force?: boolean } = {},
): Promise<OmpInjectionResult> {
  const modelsPath = join(ompHomeDir, 'models.yml');
  const configPath = join(ompHomeDir, 'config.yml');
  const desiredProvider = managedProviderBlock(config);
  const desiredEntries = managedConfigEntries(config);

  const existingModels = await readYamlFile(modelsPath);
  const existingConfig = await readYamlFile(configPath);

  const currentProvider = existingModels
    ? getPath(existingModels, ['providers', config.providerName])
    : undefined;
  const modelsDrift = currentProvider !== undefined && !same(currentProvider, desiredProvider);
  const configDrift =
    existingConfig !== undefined &&
    desiredEntries.some(([path, desired]) => {
      const current = getPath(existingConfig, path);
      return current !== undefined && !same(current, desired);
    });

  const modelsChanged = currentProvider === undefined || modelsDrift;
  const configChanged =
    existingConfig === undefined ||
    desiredEntries.some(([path, desired]) => !same(getPath(existingConfig, path), desired));

  if (!modelsChanged && !configChanged) {
    return { status: 'unchanged', modelsPath, configPath, backupPaths: [] };
  }
  if ((modelsDrift || configDrift) && !options.force) {
    // 드리프트 자동 덮어쓰기 금지 — 부분 적용도 하지 않는다 (일관성)
    return { status: 'drift', modelsPath, configPath, backupPaths: [] };
  }

  await mkdir(ompHomeDir, { recursive: true });
  const backupPaths: string[] = [];
  const created = existingModels === undefined && existingConfig === undefined;

  if (modelsChanged) {
    const nextModels: Record<string, unknown> = { ...(existingModels ?? {}) };
    setPath(nextModels, ['providers', config.providerName], desiredProvider);
    if (existingModels !== undefined) {
      const backup = `${modelsPath}.bak`;
      await writeFile(backup, stringifyYaml(existingModels));
      backupPaths.push(backup);
    }
    await writeFile(modelsPath, stringifyYaml(nextModels));
  }
  if (configChanged) {
    const nextConfig: Record<string, unknown> = { ...(existingConfig ?? {}) };
    for (const [path, desired] of desiredEntries) setPath(nextConfig, path, desired);
    if (existingConfig !== undefined) {
      const backup = `${configPath}.bak`;
      await writeFile(backup, stringifyYaml(existingConfig));
      backupPaths.push(backup);
    }
    await writeFile(configPath, stringifyYaml(nextConfig));
  }

  return { status: created ? 'created' : 'updated', modelsPath, configPath, backupPaths };
}
