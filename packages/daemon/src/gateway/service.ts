// 게이트웨이 서비스 (WBS 1.4·2.3.4·2.3.5) — 설정 영속화, 하네스 주입, spawn env 오버레이,
// 연결 확인, 모델 카탈로그, 트래픽 경계 검사.
// 모든 LLM 트래픽은 게이트웨이만 경유 (G3) — 연결 확인 호출도 게이트웨이가 유일한 목적지.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import type { HarnessId, ModelInfo } from '@custom-harness/protocol';
import type { DaemonPaths } from '../paths.js';
import { SettingsStore } from '../settings.js';
import type { KeyStore } from './key-store.js';
import { injectPiGateway, type GatewayModel, type PiInjectionResult } from './pi-injection.js';
import { injectOmpGateway, type OmpInjectionResult } from './omp-injection.js';
import { injectGrokGateway, type GrokInjectionResult } from './grok-injection.js';

export interface GatewayConfig {
  baseUrl: string;
  providerName: string;
  apiKeyEnvVar: string;
  defaultModel?: string;
  models: GatewayModel[];
  compat?: Record<string, unknown>;
}

export const GATEWAY_DEFAULTS = {
  providerName: 'gateway',
  apiKeyEnvVar: 'CUSTOM_HARNESS_GATEWAY_KEY',
} as const;

interface SettingsFileShape {
  gateway?: Partial<GatewayConfig>;
  /** 동시 세션 상한 (FR-1.7, WBS 2.3.1) — 기본 8 */
  maxSessions?: number;
  [key: string]: unknown;
}

export interface BoundaryViolation {
  harness: HarnessId;
  /** 게이트웨이 외 목적지를 가리키는 URL */
  url: string;
  /** 위반이 발견된 설정 위치 (파일·항목) */
  location: string;
}

export interface KeyTestResult {
  valid: boolean;
  detail?: string;
}

export class GatewayService {
  private modelsCache: { at: number; models: ModelInfo[] } | undefined;
  /** 설정 우선순위(env > 파일 > 기본값)의 단일 지점 — WBS 5.0.1 */
  private readonly settings: SettingsStore;

  constructor(
    private readonly paths: DaemonPaths,
    private readonly keyStore: KeyStore,
    settings?: SettingsStore,
  ) {
    this.settings = settings ?? new SettingsStore(paths.settingsFile);
  }

  async getConfig(): Promise<GatewayConfig | undefined> {
    const settings = await this.readSettings();
    const gateway = settings.gateway;
    if (!gateway?.baseUrl) return undefined; // 미온보딩 상태
    return {
      baseUrl: gateway.baseUrl,
      providerName: gateway.providerName ?? GATEWAY_DEFAULTS.providerName,
      apiKeyEnvVar: gateway.apiKeyEnvVar ?? GATEWAY_DEFAULTS.apiKeyEnvVar,
      ...(gateway.defaultModel !== undefined ? { defaultModel: gateway.defaultModel } : {}),
      models: gateway.models ?? [],
      ...(gateway.compat !== undefined ? { compat: gateway.compat } : {}),
    };
  }

  /** 설정 갱신 후 pi 주입 동기화 — 명시 조작이므로 드리프트가 있어도 갱신(force) */
  async setConfig(partial: Partial<GatewayConfig>): Promise<GatewayConfig> {
    const settings = await this.readSettings();
    settings.gateway = { ...settings.gateway, ...partial };
    await this.writeSettings(settings);
    this.modelsCache = undefined; // 카탈로그 캐시 무효화 (WBS 2.3.4)
    const config = await this.getConfig();
    if (!config) throw new Error('gateway.baseUrl 이 설정되지 않음');
    await this.ensurePiInjection({ force: true });
    await this.ensureOmpInjection({ force: true });
    await this.ensureGrokInjection({ force: true });
    return config;
  }

  /**
   * 데몬 기동 시 검증·복구 (credential-injection-design §2).
   * 드리프트는 자동 덮어쓰기 금지 — 결과만 보고하고 명시 갱신(setConfig)에서만 force.
   */
  async ensurePiInjection(
    options: { force?: boolean } = {},
  ): Promise<PiInjectionResult | undefined> {
    const config = await this.getConfig();
    if (!config) return undefined;
    return injectPiGateway(this.paths.piHomeDir, config, options);
  }

  /** omp 주입 검증·복구 (WBS 2.1.3) — 드리프트 정책은 pi 와 동일 */
  async ensureOmpInjection(
    options: { force?: boolean } = {},
  ): Promise<OmpInjectionResult | undefined> {
    const config = await this.getConfig();
    if (!config) return undefined;
    return injectOmpGateway(this.paths.ompHomeDir, config, options);
  }

  /** grok 주입 검증·복구 (WBS 2.2.2) — GROK_HOME/config.toml, 드리프트 정책 동일 */
  async ensureGrokInjection(
    options: { force?: boolean } = {},
  ): Promise<GrokInjectionResult | undefined> {
    const config = await this.getConfig();
    if (!config) return undefined;
    return injectGrokGateway(this.paths.grokHomeDir, config, options);
  }

  /** spawn env 오버레이 (FR-2.1.4 2단 구조 + FR-2.2 오프라인 프리셋) */
  async buildEnv(harness: HarnessId): Promise<Record<string, string>> {
    const config = await this.getConfig();
    const key = await this.keyStore.get();
    if (harness === 'pi') {
      return {
        // 격리 홈 — 사용자 ~/.pi 불간섭 (credential-injection-design §2 실측 확정)
        PI_CODING_AGENT_DIR: this.paths.piHomeDir,
        // 오프라인 프리셋 — 버전 체크·설치 핑 차단 (FR-2.2, WBS 1.4.2)
        PI_OFFLINE: '1',
        ...(config && key !== undefined ? { [config.apiKeyEnvVar]: key } : {}),
      };
    }
    if (harness === 'omp') {
      return {
        // 격리 홈 — omp 도 PI_CODING_AGENT_DIR 을 지원한다 (oh-my-pi 17.3.8 dirs.ts 실측).
        // 사용자 ~/.omp 불간섭 + models.yml·config.yml 주입 대상과 일치 (WBS 2.1.3)
        PI_CODING_AGENT_DIR: this.paths.ompHomeDir,
        // omp 는 PI_OFFLINE 미지원(실측) — 오프라인 차단은 config.yml 프리셋이 담당.
        ...(config && key !== undefined ? { [config.apiKeyEnvVar]: key } : {}),
      };
    }
    if (harness === 'grok') {
      return {
        // 홈 전체 격리 — 사용자 ~/.grok 불간섭, config.toml 주입 대상과 일치 (실측 확정)
        GROK_HOME: this.paths.grokHomeDir,
        // config.toml [model.*].env_key 가 이 변수를 읽는다 (FR-2.1.1 — 평문 금지)
        ...(config && key !== undefined ? { [config.apiKeyEnvVar]: key } : {}),
      };
    }
    return {};
  }

  /** 온보딩 연결 확인 — 게이트웨이 Chat Completions 1회 호출 (설계 §3, FR-2.3.1) */
  async testKey(): Promise<KeyTestResult> {
    const config = await this.getConfig();
    if (!config) return { valid: false, detail: 'gateway 미설정 (config.set 선행 필요)' };
    const key = await this.keyStore.get();
    if (key === undefined) return { valid: false, detail: '저장된 키 없음 (config.key.set 선행)' };

    const model = config.defaultModel ?? config.models[0]?.id;
    if (!model) return { valid: false, detail: '테스트에 사용할 모델 미설정' };

    try {
      const response = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (response.ok) return { valid: true };
      if (response.status === 401 || response.status === 403) {
        return { valid: false, detail: `인증 실패 (${response.status}) — 키 확인 필요` };
      }
      return { valid: false, detail: `게이트웨이 응답 ${response.status}` };
    } catch (error) {
      return {
        valid: false,
        detail: `네트워크 오류: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 동시 세션 상한 (WBS 2.3.1) — 우선순위는 SettingsStore 가 소유한다 (env > 파일 > 기본 8) */
  async getMaxSessions(): Promise<number> {
    await this.settings.load();
    return this.settings.get('maxSessions');
  }

  async setMaxSessions(value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 1 || value > 64) {
      throw new Error(`maxSessions 는 1~64 정수여야 함: ${value}`);
    }
    await this.settings.set('maxSessions', value);
  }

  /**
   * 모델 카탈로그 (WBS 2.3.4, FR-2.4) — 게이트웨이 /models 조회, 실패·빈 목록이면
   * 설정의 정적 카탈로그(gateway.models — manifest/온보딩 유래) 폴백. 60초 캐시.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 60_000) {
      return this.modelsCache.models;
    }
    const config = await this.getConfig();
    if (!config) return [];
    const fallback: ModelInfo[] = config.models.map((m) => ({
      id: m.id,
      ...(m.name !== undefined ? { displayName: m.name } : {}),
    }));
    let models = fallback;
    try {
      const key = await this.keyStore.get();
      const response = await fetch(joinUrl(config.baseUrl, '/models'), {
        headers: key !== undefined ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: unknown };
        if (Array.isArray(body.data)) {
          const fetched = body.data
            .map((m) => m as { id?: unknown })
            .filter((m): m is { id: string } => typeof m.id === 'string')
            .map((m) => ({ id: m.id }));
          if (fetched.length > 0) models = fetched;
        }
      }
    } catch {
      // 게이트웨이 /models 미지원·네트워크 실패 — 정적 카탈로그 폴백 (FR-2.4)
    }
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /**
   * 트래픽 경계 검사 (WBS 2.3.5, FR-2.5) — 격리 홈의 유효 설정에서 LLM 엔드포인트를
   * 수집해 게이트웨이(+화이트리스트) 외 목적지를 경고한다. 검사 실패는 조용히 통과
   * (파일 없음 = 주입 전 상태 — 위반 아님).
   */
  async checkTrafficBoundaries(allowedUrls: string[] = []): Promise<BoundaryViolation[]> {
    const config = await this.getConfig();
    if (!config) return [];
    const allowedOrigins = new Set(
      [config.baseUrl, ...allowedUrls].map((u) => originOf(u)).filter((o) => o !== undefined),
    );
    const violations: BoundaryViolation[] = [];
    const record = (harness: HarnessId, url: unknown, location: string): void => {
      if (typeof url !== 'string' || !url) return;
      const origin = originOf(url);
      if (origin === undefined || !allowedOrigins.has(origin)) {
        violations.push({ harness, url: String(url), location });
      }
    };

    // pi — models.json providers.*.baseUrl
    try {
      const models = JSON.parse(
        await readFile(join(this.paths.piHomeDir, 'models.json'), 'utf8'),
      ) as { providers?: Record<string, { baseUrl?: unknown }> };
      for (const [name, provider] of Object.entries(models.providers ?? {})) {
        record('pi', provider.baseUrl, `pi-home/models.json providers.${name}`);
      }
    } catch {
      /* 파일 없음·파싱 불가 — 주입 전 상태 */
    }

    // omp — models.yml providers.*.baseUrl
    try {
      const models = parseYaml(
        await readFile(join(this.paths.ompHomeDir, 'models.yml'), 'utf8'),
      ) as { providers?: Record<string, { baseUrl?: unknown }> };
      for (const [name, provider] of Object.entries(models?.providers ?? {})) {
        record('omp', provider.baseUrl, `omp-home/models.yml providers.${name}`);
      }
    } catch {
      /* 동일 */
    }

    // grok — config.toml model.*.base_url
    try {
      const toml = parseToml(
        await readFile(join(this.paths.grokHomeDir, 'config.toml'), 'utf8'),
      ) as { model?: Record<string, { base_url?: unknown }> };
      for (const [name, model] of Object.entries(toml.model ?? {})) {
        record('grok', model.base_url, `grok-home/config.toml model.${name}`);
      }
    } catch {
      /* 동일 */
    }

    return violations;
  }

  private async readSettings(): Promise<SettingsFileShape> {
    try {
      return JSON.parse(await readFile(this.paths.settingsFile, 'utf8')) as SettingsFileShape;
    } catch {
      return {};
    }
  }

  private async writeSettings(settings: SettingsFileShape): Promise<void> {
    await mkdir(dirname(this.paths.settingsFile), { recursive: true });
    const tmp = join(dirname(this.paths.settingsFile), 'settings.json.tmp');
    await writeFile(tmp, JSON.stringify(settings, null, 2));
    await rename(tmp, this.paths.settingsFile);
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** URL origin (스킴+호스트+포트) — 파싱 불가면 undefined (위반으로 기록) */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
