// 게이트웨이 서비스 (WBS 1.4) — 설정 영속화, pi 주입, spawn env 오버레이, 연결 확인.
// 모든 LLM 트래픽은 게이트웨이만 경유 (G3) — 연결 확인 호출도 게이트웨이가 유일한 목적지.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HarnessId } from '@custom-harness/protocol';
import type { DaemonPaths } from '../paths.js';
import type { KeyStore } from './key-store.js';
import { injectPiGateway, type GatewayModel, type PiInjectionResult } from './pi-injection.js';

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
  [key: string]: unknown;
}

export interface KeyTestResult {
  valid: boolean;
  detail?: string;
}

export class GatewayService {
  constructor(
    private readonly paths: DaemonPaths,
    private readonly keyStore: KeyStore,
  ) {}

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
    const config = await this.getConfig();
    if (!config) throw new Error('gateway.baseUrl 이 설정되지 않음');
    await this.ensurePiInjection({ force: true });
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
    if (harness === 'grok') {
      return { GROK_HOME: this.paths.grokHomeDir }; // M2 2.2 에서 config.toml 주입과 함께 확장
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
