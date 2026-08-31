// 역방향 툴 카탈로그 정본 (M7 WBS 7.2.2, FR-9.2).
//
// 데몬이 **자신의 기능을 하네스에게 되돌려 노출**하는 툴 목록이다. 카탈로그는 여기 하나뿐이고,
// 노출 경로는 둘이다 (7.2.3): ① omp·grok — 데몬 소유 MCP stdio 서버 ② pi — `pi.registerTool`
// 확장. 두 경로가 각자 툴을 정의하면 하네스마다 다른 표면이 생긴다 — 그래서 프로토콜 층에 둔다.
//
// **이름 규칙**: 짧게. 하네스가 다시 접두사를 붙이기 때문이다 (7.2.1 실측) —
// omp `mcp__<server>_<tool>`, grok `<server>__<tool>`. 원본이 길면 모델이 다루기 나빠진다.
import { z } from 'zod';

// 파라미터는 와이어 스키마의 `looseObject` 관례를 따르지 않고 `z.strictObject` 를 쓴다.
// (`z.object` 는 미지 키를 **조용히 제거**할 뿐 거부하지 않는다 — 7.2.3 e2e 에서 검출.)
// 그 관례는 "번들 버전이 다른 양쪽이 서로의 추가 필드를 견딘다"를 위한 것인데, 카탈로그와
// 그 핸들러는 **같이 배포된다**. 반면 여기 입력을 만드는 쪽은 모델이라 오타·환각 파라미터가
// 조용히 무시되면 안 된다 — 명시적인 검증 실패가 낫다.

/** 툴이 데몬 상태를 바꾸는가 — 7.2.4 안전장치·감사 로그의 1차 분류 */
export type ToolEffect = 'read' | 'write';

export interface ToolSpec<P extends z.ZodType = z.ZodType> {
  /** 하네스에 노출되는 이름. 소문자·숫자·`_` 만, 24자 이하 (재접두사 여유) */
  name: string;
  /** 한 줄 요약 — 모델이 툴을 고르는 유일한 근거다 */
  description: string;
  params: P;
  effect: ToolEffect;
  /**
   * 사용자 승인을 반드시 거쳐야 하는가 (FR-1.5).
   * 하네스 자신의 승인 게이트와 **별개** — 그쪽은 우리 서버 전체를 한 덩어리로 볼 뿐이라
   * "세션 목록 조회"와 "임의 셸 실행"을 구분하지 못한다. 그 구분을 여기서 소유한다.
   */
  approval: boolean;
  /**
   * 이 툴이 새 세션을 만들 수 있는가 — 자기 자신을 재귀 생성하는 경로.
   * 7.2.4 가 깊이·개수 상한을 이 플래그로 건다.
   */
  spawnsSession?: boolean;
}

const sessionId = z.string().describe('세션 ID');

/**
 * 카탈로그 정본. FR-9.2 가 열거한 범위(세션 생성·프롬프트 전송·상태 조회·중단·
 * 워크스페이스 조회·터미널 조작)를 모두 덮는다.
 */
export const TOOL_CATALOG = [
  // ── 세션 ─────────────────────────────────────────────────────────────────
  {
    name: 'session_list',
    // 주의 상태는 7.1 이 계산한 값을 그대로 싣는다 — 여기서 다시 판단하지 않는다
    description:
      '세션 목록과 상태를 조회한다. 각 세션의 주의 필요 여부(requiresAttention)와 사유를 함께 준다.',
    params: z.strictObject({
      workspaceId: z.string().optional().describe('이 워크스페이스의 세션만'),
      requiresAttention: z.boolean().optional().describe('주의가 필요한 세션만'),
    }),
    effect: 'read',
    approval: false,
  },
  {
    name: 'session_read',
    description: '한 세션의 타임라인(대화·툴 실행 기록)을 seq 이후부터 읽는다.',
    params: z.strictObject({
      sessionId,
      fromSeq: z.number().int().nonnegative().optional().describe('이 seq 다음부터'),
      limit: z.number().int().positive().max(500).optional().describe('최대 이벤트 수 (기본 100)'),
    }),
    effect: 'read',
    approval: false,
  },
  {
    name: 'session_new',
    description: '새 세션을 만든다. 하네스와 작업 디렉토리를 지정한다.',
    params: z.strictObject({
      harness: z.string().describe('pi | omp | grok'),
      cwd: z.string().describe('작업 디렉토리 절대 경로'),
      workspaceId: z.string().optional(),
      modelId: z.string().optional(),
    }),
    effect: 'write',
    approval: true,
    spawnsSession: true,
  },
  {
    name: 'session_say',
    description: '세션에 프롬프트를 보낸다. 턴이 시작되며 완료를 기다리지 않는다.',
    params: z.strictObject({ sessionId, prompt: z.string().describe('보낼 프롬프트') }),
    effect: 'write',
    approval: true,
  },
  {
    // 멱등 — 활성 턴이 없어도 성공이다 (FR-1.6 과 같은 의미론)
    name: 'session_stop',
    description: '세션의 진행 중인 턴을 중단한다. 이미 멈춰 있어도 성공한다.',
    params: z.strictObject({ sessionId }),
    effect: 'write',
    approval: true,
  },

  // ── 워크스페이스 ─────────────────────────────────────────────────────────
  {
    name: 'ws_list',
    description: '워크스페이스 목록을 조회한다(프로젝트·격리 방식·경로 포함).',
    params: z.strictObject({ projectId: z.string().optional() }),
    effect: 'read',
    approval: false,
  },

  // ── 터미널 ───────────────────────────────────────────────────────────────
  {
    name: 'term_list',
    description: '워크스페이스의 터미널 목록을 조회한다.',
    params: z.strictObject({ workspaceId: z.string().optional() }),
    effect: 'read',
    approval: false,
  },
  {
    name: 'term_new',
    description: '워크스페이스에 터미널을 연다.',
    params: z.strictObject({ workspaceId: z.string(), cwd: z.string().optional() }),
    effect: 'write',
    approval: true,
  },
  {
    // 임의 셸 입력이다 — 카탈로그에서 가장 위험한 툴. 승인 없이 열리면 안 된다.
    name: 'term_send',
    description: '터미널에 입력을 보낸다(줄바꿈을 포함해야 실행된다).',
    params: z.strictObject({ terminalId: z.string(), data: z.string().describe('보낼 입력') }),
    effect: 'write',
    approval: true,
  },
  {
    name: 'term_read',
    description: '터미널의 최근 출력(스크롤백)을 읽는다.',
    params: z.strictObject({
      terminalId: z.string(),
      bytes: z.number().int().positive().max(65536).optional().describe('최대 바이트 (기본 8192)'),
    }),
    effect: 'read',
    approval: false,
  },
] as const satisfies readonly ToolSpec[];

export type ToolName = (typeof TOOL_CATALOG)[number]['name'];

/** 이름 규칙 — 두 접두사 방식(`mcp__<s>_<t>` / `<s>__<t>`) 어디에 넣어도 깨지지 않는 형태 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,23}$/;

export function findTool(name: string): ToolSpec | undefined {
  return (TOOL_CATALOG as readonly ToolSpec[]).find((tool) => tool.name === name);
}

/** MCP `tools/list` 항목 — pi 확장도 같은 스키마를 쓴다 (7.2.3 노출 2경로 공용) */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toolDescriptor(spec: ToolSpec): ToolDescriptor {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.params, { io: 'input' }) as Record<string, unknown>,
  };
}

export function toolDescriptors(): ToolDescriptor[] {
  return (TOOL_CATALOG as readonly ToolSpec[]).map(toolDescriptor);
}
