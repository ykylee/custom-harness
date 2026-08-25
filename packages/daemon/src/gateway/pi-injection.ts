// pi 게이트웨이 설정 주입 (WBS 1.4.1, FR-2.1.1/2.1.4, credential-injection-design §2)
// 대상: 격리 홈(PI_CODING_AGENT_DIR)의 models.json. 관리 프로바이더 블록만 생성·갱신하고
// 그 외 항목은 보존한다. 변경 전 원본 백업, 드리프트는 자동 덮어쓰기 금지(경고 후 명시 갱신).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GatewayModel {
  id: string;
  name?: string;
}

export interface PiInjectionConfig {
  /** 게이트웨이 base URL (OpenAI 호환 /v1) */
  baseUrl: string;
  /** models.json providers.<name> — 자사 관리 블록 이름 */
  providerName: string;
  /** apiKey 는 env 보간(`$VAR`)으로만 기록 — 평문 금지 (FR-2.1.1) */
  apiKeyEnvVar: string;
  models: GatewayModel[];
  /** 게이트웨이 비표준 응답 대응 (FR-2.1.1 compat — C-1 실측 후 확정) */
  compat?: Record<string, unknown>;
}

export type PiInjectionStatus = 'created' | 'unchanged' | 'updated' | 'drift';

export interface PiInjectionResult {
  status: PiInjectionStatus;
  modelsPath: string;
  backupPath?: string;
}

function managedBlock(config: PiInjectionConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    api: 'openai-completions',
    apiKey: `$${config.apiKeyEnvVar}`,
    authHeader: true,
    ...(config.compat ? { compat: config.compat } : {}),
    models: config.models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) })),
  };
}

/**
 * models.json 에 관리 블록을 주입한다.
 * - 파일 없음 → 생성 (created)
 * - 관리 블록 동일 → 무변경 (unchanged)
 * - 관리 블록 상이 + force → 백업 후 갱신 (updated)
 * - 관리 블록 상이 + !force → 손대지 않고 드리프트 보고 (drift — 자동 덮어쓰기 금지)
 */
export async function injectPiGateway(
  piHomeDir: string,
  config: PiInjectionConfig,
  options: { force?: boolean } = {},
): Promise<PiInjectionResult> {
  const modelsPath = join(piHomeDir, 'models.json');
  const desired = managedBlock(config);

  let existing: { providers?: Record<string, unknown> } | undefined;
  try {
    existing = JSON.parse(await readFile(modelsPath, 'utf8')) as typeof existing;
  } catch {
    existing = undefined;
  }

  if (existing?.providers && config.providerName in existing.providers) {
    const current = existing.providers[config.providerName];
    if (JSON.stringify(current) === JSON.stringify(desired)) {
      return { status: 'unchanged', modelsPath };
    }
    if (!options.force) return { status: 'drift', modelsPath };
  }

  const next = {
    ...existing,
    providers: { ...existing?.providers, [config.providerName]: desired },
  };
  await mkdir(piHomeDir, { recursive: true });
  let backupPath: string | undefined;
  if (existing !== undefined) {
    backupPath = `${modelsPath}.bak`;
    await writeFile(backupPath, JSON.stringify(existing, null, 2));
  }
  await writeFile(modelsPath, JSON.stringify(next, null, 2));
  return {
    status: existing === undefined ? 'created' : 'updated',
    modelsPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}
