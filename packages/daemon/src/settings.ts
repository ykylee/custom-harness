// 설정 계약 (WBS 5.0.1, workspace-model 설계 선행) — 우선순위 해석과 핫 리로드의 단일 지점.
//
// 규칙 3개:
//   1. 우선순위는 env > settings.json > 기본값. 예외 없다.
//   2. 키는 여기 레지스트리에만 선언한다. 선언 없는 키는 파일에 있어도 무시된다(오타 방어).
//   3. 키마다 재적용 범위(scope)를 명시한다 — 'live' 는 즉시 반영, 'restart' 는 데몬 재기동 필요.
//      'restart' 키가 런타임에 바뀌면 경고를 발행하되 값은 바꾸지 않는다(반쯤 적용된 상태 금지).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';

/** 값 원천 — 진단(doctor)·UI 가 "왜 이 값인가"를 설명할 수 있어야 한다 */
export type SettingSource = 'env' | 'file' | 'default';

export interface SettingDescriptor<T> {
  /** settings.json 의 키 (점 표기로 중첩 접근) */
  readonly key: string;
  /** 이 키를 덮는 환경 변수 이름 */
  readonly env?: string;
  readonly defaultValue: T;
  /** 재적용 범위 — 'restart' 는 런타임 변경을 반영하지 않는다 */
  readonly scope: 'live' | 'restart';
  /** 원시 값 → T. 부적합하면 undefined 를 반환한다 (throw 금지 — 잘못된 설정이 데몬을 죽이지 않는다) */
  parse(raw: unknown): T | undefined;
}

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
  /** env 가 이겨서 파일 값이 무시된 경우 true — UI 가 "환경 변수가 우선합니다"를 표시할 근거 */
  overriddenByEnv: boolean;
}

export interface SettingsChange {
  key: string;
  previous: unknown;
  next: unknown;
  /** scope='restart' 라 값을 반영하지 않은 변경 */
  requiresRestart: boolean;
}

function parsePositiveInt(max: number) {
  return (raw: unknown): number | undefined => {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) return undefined;
    return n;
  };
}

/** 0 을 허용하는 정수 파서 — 0 이 "아예 금지"라는 뜻을 갖는 상한에 쓴다 */
function parseNonNegativeInt(max: number) {
  return (raw: unknown): number | undefined => {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) return undefined;
    return n;
  };
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

/** 쉼표 구분 문자열 또는 문자열 배열 → 문자열 배열. 빈 값은 빈 배열(= 반입 없음) */
function parseStringList(raw: unknown): string[] | undefined {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : undefined;
  if (!items) return undefined;
  if (!items.every((item) => typeof item === 'string')) return undefined;
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 키 → 값 타입. 새 설정은 여기와 SETTINGS 양쪽에 추가한다 (한쪽만 빠지면 컴파일이 막는다) */
export interface SettingValues {
  maxSessions: number;
  autoApprove: boolean;
  workspaceSetupAutoRun: boolean;
  harnessHomeIsolation: boolean;
  harnessHomeLinks: string[];
  toolsReverseExposure: boolean;
  toolsMaxSessionDepth: number;
  toolsMaxFanout: number;
}
export type SettingKey = keyof SettingValues;

/** 선언된 설정 키 전부. 선언 없는 키는 파일에 있어도 무시된다 */
export const SETTINGS: { [K in SettingKey]: SettingDescriptor<SettingValues[K]> } = {
  maxSessions: {
    key: 'maxSessions',
    env: 'CUSTOM_HARNESS_MAX_SESSIONS',
    defaultValue: 8,
    scope: 'live',
    parse: parsePositiveInt(64),
  },
  autoApprove: {
    key: 'autoApprove',
    env: 'CUSTOM_HARNESS_AUTO_APPROVE',
    defaultValue: false,
    scope: 'live',
    parse: parseBoolean,
  },
  /** 프로젝트 설정 파일(harness.json)의 setup/teardown 자동 실행 — 기본 off (workspace-model §7 신뢰 경계) */
  workspaceSetupAutoRun: {
    key: 'workspace.setupAutoRun',
    env: 'CUSTOM_HARNESS_WORKSPACE_SETUP_AUTORUN',
    defaultValue: false,
    scope: 'live',
    parse: parseBoolean,
  },
  /**
   * 하네스 `HOME` 격리 (WBS 7.2.0a, NFR-1) — 기본 on. 끄면 하네스가 사용자 실제 홈의
   * 외부 MCP 설정을 읽어 게이트웨이 경계 밖 서버를 띄울 수 있다 (harness-mcp-support §3.1).
   */
  harnessHomeIsolation: {
    key: 'harness.homeIsolation',
    env: 'CUSTOM_HARNESS_HOME_ISOLATION',
    defaultValue: true,
    scope: 'live',
    parse: parseBoolean,
  },
  /** 격리 홈에 반입할 실제 홈 항목 allowlist — 거부 기본값. 홈 직속 이름만 (경로 금지) */
  harnessHomeLinks: {
    key: 'harness.homeLinks',
    env: 'CUSTOM_HARNESS_HOME_LINKS',
    defaultValue: ['.gitconfig', '.ssh'],
    scope: 'live',
    parse: parseStringList,
  },
  /**
   * 역방향 툴 노출 (M7 7.2.4, FR-9.2) — **기본 off**.
   *
   * 켜면 하네스가 데몬을 되부를 수 있다: 다른 세션의 타임라인을 읽고, 프롬프트를 보내고,
   * 터미널에 입력한다. 유용한 만큼 권한 상승 통로이기도 하므로 사용자가 명시적으로 켜야 한다
   * (홈 격리와 반대 방향의 기본값 — 그쪽은 끄는 것이 위험이고 이쪽은 켜는 것이 위험이다).
   *
   * `restart` 스코프인 이유: 등록은 기동 시 하네스 설정 파일에 기입하는 일이라, 값만 바꿔서는
   * 이미 떠 있는 하네스 프로세스의 툴 표면이 달라지지 않는다.
   */
  toolsReverseExposure: {
    key: 'tools.reverseExposure',
    env: 'CUSTOM_HARNESS_REVERSE_TOOLS',
    defaultValue: false,
    scope: 'restart',
    parse: parseBoolean,
  },
  /**
   * 역방향 툴이 만든 세션이 다시 세션을 만들 수 있는 깊이 상한 (M7 7.2.4).
   *
   * 기본 1 = 사용자가 만든 세션은 자식을 만들 수 있고, 그 자식은 더 못 만든다. 0 이면
   * `session_new` 자체가 막힌다. 상한이 없으면 한 번의 잘못된 프롬프트가 세션을 지수로
   * 늘리고, 그 각각이 게이트웨이 토큰을 쓴다.
   */
  toolsMaxSessionDepth: {
    key: 'tools.maxSessionDepth',
    env: 'CUSTOM_HARNESS_TOOLS_MAX_SESSION_DEPTH',
    defaultValue: 1,
    scope: 'live',
    parse: parseNonNegativeInt(8),
  },
  /**
   * 한 부모가 **동시에** 거느릴 수 있는 살아 있는 자식 세션 수 (M7 7.3.2, FR-9.3·NFR-7).
   *
   * 기본 1 — 위임은 되지만 병렬 팬아웃은 사용자가 명시적으로 열어야 한다. 깊이 상한
   * (`maxSessionDepth`)이 트리의 *높이*를 막는다면 이쪽은 *너비*를 막는다: 깊이 1 에서도
   * 자식 20개를 동시에 돌리면 토큰은 그대로 20배다.
   *
   * 세는 대상은 **닫히지 않은** 자식이다. 닫힌 세션은 더 이상 프롬프트를 받지 못하므로
   * 예산을 쓰지 않는다 — 그것까지 세면 상한이 "누적 생성 수"가 되어 재사용을 막는다.
   */
  toolsMaxFanout: {
    key: 'tools.maxFanout',
    env: 'CUSTOM_HARNESS_TOOLS_MAX_FANOUT',
    defaultValue: 1,
    scope: 'live',
    parse: parseNonNegativeInt(32),
  },
};

/** 점 표기 경로 읽기 — 중간 경로가 객체가 아니면 undefined */
function readPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** 점 표기 경로 쓰기 — 중간 객체를 만들어가며 대입 */
function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1) as string] = value;
}

/**
 * settings.json 의 읽기·쓰기·감시를 소유한다. 호출자는 read-modify-write 를 직접 하지 않는다
 * (PID 원장 경합 WBS 2.7.3 의 교훈 — 원자성은 스토어가 소유한다).
 */
export class SettingsStore {
  private raw: Record<string, unknown> = {};
  private loaded = false;
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(changes: SettingsChange[]) => void>();

  constructor(
    private readonly settingsFile: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async load(): Promise<void> {
    this.raw = await this.readFileSafe();
    this.loaded = true;
  }

  /** 우선순위 해석 결과 — 값과 함께 출처를 돌려준다 */
  resolve<K extends SettingKey>(key: K): ResolvedSetting<SettingValues[K]> {
    type V = SettingValues[K];
    const descriptor = SETTINGS[key] as SettingDescriptor<V>;
    const fileRaw = readPath(this.raw, descriptor.key);
    const fileValue = fileRaw === undefined ? undefined : descriptor.parse(fileRaw);

    if (descriptor.env) {
      const envRaw = this.env[descriptor.env];
      if (envRaw !== undefined && envRaw !== '') {
        const envValue = descriptor.parse(envRaw);
        if (envValue !== undefined) {
          return { value: envValue, source: 'env', overriddenByEnv: fileValue !== undefined };
        }
        // 부적합한 env 는 무시하고 아래로 떨어진다 — 잘못된 환경 변수가 데몬을 막지 않는다
      }
    }
    if (fileValue !== undefined)
      return { value: fileValue, source: 'file', overriddenByEnv: false };
    return { value: descriptor.defaultValue, source: 'default', overriddenByEnv: false };
  }

  get<K extends SettingKey>(key: K): SettingValues[K] {
    return this.resolve(key).value;
  }

  /** 전 키 해석 결과 — doctor·설정 UI 가 출처까지 보여줄 수 있게 */
  resolveAll(): Record<SettingKey, ResolvedSetting<unknown>> {
    const out = {} as Record<SettingKey, ResolvedSetting<unknown>>;
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      out[key] = this.resolve(key) as ResolvedSetting<unknown>;
    }
    return out;
  }

  /**
   * 파일에 값을 기입한다. env 가 그 키를 덮고 있으면 파일은 갱신하되 유효 값은 바뀌지 않으므로
   * `effective` 로 그 사실을 알린다 — 호출자가 "저장했는데 안 바뀐다"를 설명할 수 있어야 한다.
   */
  async set<K extends SettingKey>(
    key: K,
    value: SettingValues[K],
  ): Promise<{ effective: boolean }> {
    type V = SettingValues[K];
    const descriptor = SETTINGS[key] as SettingDescriptor<V>;
    const parsed = descriptor.parse(value);
    if (parsed === undefined)
      throw new Error(`설정 값이 유효하지 않음: ${descriptor.key}=${String(value)}`);

    await this.enqueueWrite(async () => {
      const current = await this.readFileSafe();
      writePath(current, descriptor.key, parsed);
      await this.writeFileAtomic(current);
      this.raw = current;
    });
    return { effective: this.resolve(key).source !== 'env' };
  }

  onChange(listener: (changes: SettingsChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 파일 변경 감시 시작 — 외부 편집(사용자가 직접 연 에디터)도 반영 대상이다 */
  watchFile(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(dirname(this.settingsFile), (_event, filename) => {
        if (filename && !String(filename).startsWith('settings.json')) return;
        clearTimeout(this.reloadTimer);
        // 에디터의 write→rename 는 이벤트를 여러 번 낸다 — 디바운스로 한 번만 재적용
        this.reloadTimer = setTimeout(() => void this.reload(), 50);
        this.reloadTimer.unref?.();
      });
    } catch {
      // 감시 불가(디렉토리 부재·플랫폼 제약)는 치명적이지 않다 — 다음 읽기에서 최신 값을 본다
    }
  }

  async reload(): Promise<SettingsChange[]> {
    const before = this.snapshot();
    this.raw = await this.readFileSafe();
    const changes: SettingsChange[] = [];
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      const descriptor = SETTINGS[key] as unknown as SettingDescriptor<unknown>;
      const next = this.resolve(key).value;
      if (Object.is(before[key], next)) continue;
      const requiresRestart = descriptor.scope === 'restart';
      changes.push({ key: descriptor.key, previous: before[key], next, requiresRestart });
    }
    if (changes.length > 0) {
      for (const listener of this.listeners) listener(changes);
    }
    return changes;
  }

  close(): void {
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  private snapshot(): Record<SettingKey, unknown> {
    const out = {} as Record<SettingKey, unknown>;
    for (const key of Object.keys(SETTINGS) as SettingKey[]) out[key] = this.resolve(key).value;
    return out;
  }

  private async readFileSafe(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.settingsFile, 'utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // 파일 부재·파손 모두 빈 설정으로 취급 — 기본값으로 기동한다 (관대 파싱, NFR-5)
      return {};
    }
  }

  private async writeFileAtomic(value: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.settingsFile), { recursive: true });
    const tmp = join(dirname(this.settingsFile), `settings.json.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, this.settingsFile);
  }

  /** 쓰기 직렬화 — 동시 set 이 read-modify-write 로 서로를 지우지 않게 */
  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
