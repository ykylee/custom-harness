// 세션 레벨 RPC — `domain.verb.request` / `.response`, requestId 상관 (protocol-design §2)
// 도메인: session.* / config.* / harness.* / project.* / workspace.* / terminal.* /
//        file.* / diff.* / system.*
import { z } from 'zod';
import { HarnessIdSchema, PROTOCOL_VERSION } from './base.js';
import { CapabilityFlagsSchema } from './capabilities.js';
import {
  PermissionOutcomeSchema,
  PermissionRequestSchema,
  SessionEventSchema,
  SessionStatusSchema,
  UsageSchema,
} from './events.js';
import {
  ProjectSchema,
  WorkspaceIsolationSchema,
  WorkspaceSchema,
  WorkspaceSetupStateSchema,
} from './workspaces.js';
import { TerminalSchema } from './terminal.js';

export const RpcErrorSchema = z.looseObject({
  /** 어댑터 에러 kind('spawn'|'protocol'|…) 또는 데몬 에러 코드 */
  code: z.string(),
  message: z.string(),
  retriable: z.boolean().optional(),
  detail: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/** method 당 request/response 스키마 쌍 — 응답은 ok 판별 유니온 (성공 result / 실패 error) */
function rpcPair<M extends string, P extends z.ZodType, R extends z.ZodType>(
  method: M,
  params: P,
  result: R,
) {
  const request = z.looseObject({
    type: z.literal(`${method}.request` as const),
    requestId: z.string(),
    params,
  });
  const response = z.discriminatedUnion('ok', [
    z.looseObject({
      type: z.literal(`${method}.response` as const),
      requestId: z.string(),
      ok: z.literal(true),
      result,
    }),
    z.looseObject({
      type: z.literal(`${method}.response` as const),
      requestId: z.string(),
      ok: z.literal(false),
      error: RpcErrorSchema,
    }),
  ]);
  return { method, request, response };
}

// ── 공용 데이터 형 ─────────────────────────────────────────────────────────

export const SessionSummarySchema = z.looseObject({
  sessionId: z.string(),
  harness: HarnessIdSchema,
  cwd: z.string(),
  status: SessionStatusSchema,
  modelId: z.string().optional(),
  /** 마지막 이벤트 seq — 재연결 갭 감지 (protocol-design §5) */
  seq: z.number().int().nonnegative(),
  /** 미응답 승인 요청 — 데몬 재시작·재연결 후 조회 보장 (FR-1.5) */
  pendingPermissions: z.array(PermissionRequestSchema).optional(),
  /** 세션 누적 토큰 요약 (FR-3.7, M2 2.4.5 — additive) */
  usage: UsageSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // ── 워크스페이스 모델 선반영 (WBS 5.0.2, workspace-model §3.3) ──
  // 전부 optional additive — 이전 번들의 클라이언트가 이 필드를 모른 채로도 파싱된다.
  /** 소유 워크스페이스. 5.4.1 이후 소유권 판정의 유일한 근거가 된다 (cwd 추론 금지) */
  workspaceId: z.string().optional(),
  /** 사용자·시스템 라벨 (부모-자식 관계 등) */
  labels: z.record(z.string(), z.string()).optional(),
  /** 소프트 삭제 시각 */
  archivedAt: z.string().optional(),
  /** 사용자 주의 필요 여부 — 데몬이 정본으로 계산한다 (M7 7.1) */
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(['permission', 'error', 'finished']).optional(),
  /** 주의 상태로 전이한 시각 — "얼마나 기다렸나" 정렬 기준 (M7 7.1.1) */
  attentionTimestamp: z.string().optional(),
  /** 사용자 표시 제목 (M7 7.6 이 채운다) */
  title: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** 검색 세그먼트 종류 (M7 7.4.1) — 결과를 대화/사고/툴로 좁히는 필터 축 */
export const SearchSegmentKindSchema = z.enum(['user', 'assistant', 'reasoning', 'tool']);
export type SearchSegmentKind = z.infer<typeof SearchSegmentKindSchema>;

/** 검색 결과 한 건. 세션 메타를 함께 실어 팔레트가 추가 조회 없이 한 줄을 그린다 */
export const SearchHitSchema = z.looseObject({
  sessionId: z.string(),
  /** 세그먼트를 여는 이벤트의 seq — 결과를 눌렀을 때 타임라인에서 찾아갈 위치 */
  seq: z.number().int().nonnegative(),
  kind: SearchSegmentKindSchema,
  /** tool 세그먼트의 하네스 네이티브 툴명 */
  toolName: z.string().optional(),
  /** 매치 주변만 잘라낸 본문 */
  snippet: z.string(),
  harness: HarnessIdSchema,
  workspaceId: z.string().optional(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * 위임 비용 트리 (M7 7.3.2) — 자기 사용량과 자손 합을 나눠 준다.
 * 자식 트랙 UI(7.3.3)가 그대로 소비한다.
 */
export const SessionUsageTreeSchema = z.looseObject({
  /** 이 세션 자신의 누적 사용량 */
  own: UsageSchema,
  /** 자신 + 자손 전체 */
  subtree: UsageSchema,
  /** 직계 자식 수 (닫힌 것 포함) */
  childCount: z.number().int().nonnegative(),
  /** 그중 아직 살아 있는 수 — 팬아웃 상한이 세는 대상 */
  activeChildCount: z.number().int().nonnegative(),
  /** 직계 자식 요약 — 어느 자식이 비싼지 */
  children: z.array(
    z.looseObject({
      sessionId: z.string(),
      status: SessionStatusSchema,
      harness: HarnessIdSchema,
      usage: UsageSchema.optional(),
      /** 이 자식이 거느린 자손까지 포함한 합 */
      subtree: UsageSchema,
    }),
  ),
});
export type SessionUsageTree = z.infer<typeof SessionUsageTreeSchema>;

export const ModelInfoSchema = z.looseObject({
  id: z.string(),
  displayName: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** probe 결과 (adapter-contract §1 ProbeResult — FR-1.8 버전 검증) */
export const ProbeResultSchema = z.looseObject({
  available: z.boolean(),
  version: z.string().optional(),
  verified: z.boolean().optional(),
  warnings: z.array(z.string()),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const HarnessInfoSchema = z.looseObject({
  id: HarnessIdSchema,
  capabilities: CapabilityFlagsSchema,
  models: z.array(ModelInfoSchema).optional(),
  /** 트래픽 경계·버전 검증 경고 (FR-2.5/FR-1.8, M2 2.3 — additive) */
  warnings: z.array(z.string()).optional(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

export const McpServerConfigSchema = z.looseObject({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ── method 정의 ────────────────────────────────────────────────────────────
//
// 네임스페이스 규약 (WBS 5.0.3): `<domain>.<verb>` 또는 `<domain>.<namespace>.<verb>`.
// 예약 도메인 — 구현 전이라도 다른 용도로 쓰지 않는다:
//   project.*    프로젝트 레지스트리 (M5 5.2)
//   workspace.*  워크스페이스 레지스트리·worktree·setup (M5 5.3·5.5)
//   terminal.*   데몬 소유 터미널 (M6 6.3)
//   file.*       워크스페이스 파일 탐색·열람 (M6 6.4)
//   diff.*       working/커밋 변경사항 (M6 6.5)
//   tool.*       역방향 툴 카탈로그 (M7 7.2)
// 신규 필드는 optional 로만 추가하고 제거·축소하지 않는다 (protocol-design §3).

export const rpc = {
  session: {
    create: rpcPair(
      'session.create',
      z.looseObject({
        harness: HarnessIdSchema,
        /**
         * 소유 워크스페이스 (WBS 5.4.1). 소유권 판정의 근거는 이 값뿐이다.
         *
         * 미지정 시 데몬이 `cwd` 로 프로젝트를 열어 **기본 워크스페이스에 귀속**시킨다.
         * 이는 호환 폴백이 아니라 의도된 편의 경로다 — 스크립트·CLI 가 "이 디렉토리에서
         * 한 번 돌려라"를 워크스페이스 선행 생성 없이 표현할 수 있어야 한다(FR-9.6).
         * UI 는 5.6 이후 항상 workspaceId 를 보낸다.
         */
        workspaceId: z.string().optional(),
        cwd: z.string(),
        modelId: z.string().optional(),
        approvalPolicy: z.enum(['mediate', 'auto']).optional(),
        mcpServers: z.array(McpServerConfigSchema).optional(),
        /**
         * 생성 시 붙일 라벨 (WBS 7.2.4). 지금은 역방향 툴이 부모 세션과 재귀 깊이를 적는
         * 용도로만 쓴다 — 그 값이 세션 레코드에 남아야 데몬을 재시작해도 깊이 상한이 성립한다.
         * 부모-자식 관계의 온전한 모델은 7.3.1 이 이 위에 세운다.
         */
        labels: z.record(z.string(), z.string()).optional(),
      }),
      z.looseObject({ session: SessionSummarySchema }),
    ),
    resume: rpcPair(
      'session.resume',
      z.looseObject({ sessionId: z.string() }),
      z.looseObject({ session: SessionSummarySchema }),
    ),
    list: rpcPair(
      'session.list',
      z.looseObject({ workspaceId: z.string().optional() }),
      z.looseObject({ sessions: z.array(SessionSummarySchema) }),
    ),
    close: rpcPair('session.close', z.looseObject({ sessionId: z.string() }), z.looseObject({})),
    prompt: rpcPair(
      'session.prompt',
      z.looseObject({ sessionId: z.string(), prompt: z.string() }),
      z.looseObject({ turnId: z.string() }),
    ),
    /**
     * 활성 턴 완료 대기 (M7 7.3.1, FR-9.3) — 서브에이전트 위임의 "기다린다"에 해당한다.
     *
     * **상한 있는 대기**다. 무한 대기를 두지 않는 이유는 전송에 있다: 이 호출은 하네스가
     * spawn 한 MCP 서버의 RPC 를 통해 오고 그쪽 대기도 유한하다. 시간 안에 안 끝나면
     * `timedOut: true` 로 돌려주고 호출자가 다시 건다 — 끊긴 대기보다 다시 거는 편이 낫다.
     */
    wait: rpcPair(
      'session.wait',
      z.looseObject({
        sessionId: z.string(),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
      }),
      z.looseObject({
        status: SessionStatusSchema,
        /** 아직 턴이 돌고 있는가 — `timedOut` 이 true 면 이 값도 true 다 */
        activeTurn: z.boolean(),
        /** 마지막으로 끝난 턴의 결말. 한 번도 돈 적이 없으면 생략 */
        lastTurnOutcome: z.enum(['completed', 'failed', 'canceled']).optional(),
        timedOut: z.boolean(),
      }),
    ),
    /** 멱등 — 이미 중단됐거나 실행 중이 아니어도 성공 응답 (FR-1.6) */
    interrupt: rpcPair(
      'session.interrupt',
      z.looseObject({ sessionId: z.string() }),
      z.looseObject({}),
    ),
    permissionRespond: rpcPair(
      'session.permission.respond',
      z.looseObject({
        sessionId: z.string(),
        requestId: z.string(),
        outcome: PermissionOutcomeSchema,
      }),
      z.looseObject({}),
    ),
    modelSet: rpcPair(
      'session.model.set',
      z.looseObject({ sessionId: z.string(), modelId: z.string() }),
      z.looseObject({}),
    ),
    /**
     * 주의 상태 확인 처리 (M7 7.1.2, FR-9.1) — 사용자가 세션을 열어 봤다는 신호.
     * 멱등. 승인 대기는 이 호출로 사라지지 않는다 — 화면을 본 것이 응답은 아니다.
     */
    attentionAck: rpcPair(
      'session.attention.ack',
      z.looseObject({ sessionId: z.string() }),
      z.looseObject({}),
    ),
    /**
     * 위임 비용 합산 (M7 7.3.2, FR-9.3 · NFR-7).
     *
     * 자기 사용량과 **자손 전체**의 합을 함께 준다. 둘을 나눠 주는 이유: 부모의 대화가
     * 싸도 위임이 비쌀 수 있고, 그 구분이 없으면 "왜 예산이 줄었나"를 판단할 수 없다.
     * 트리는 세션 레코드의 부모 라벨을 따라 걷는다 — 별도 인덱스를 두지 않는다(7.3.1 §8.1).
     */
    usage: rpcPair(
      'session.usage',
      z.looseObject({ sessionId: z.string() }),
      SessionUsageTreeSchema,
    ),
    /**
     * 마지막 턴의 결과만 (M7 7.3.1, FR-9.3) — 위임한 작업의 "회수"에 해당한다.
     *
     * `timeline` 과 나눈 이유는 양이다. 부모가 자식의 답만 필요할 때 타임라인 전체를 받으면
     * 자식의 툴 실행 기록까지 부모 컨텍스트에 실린다 — 위임으로 아끼려던 것을 되돌려 놓는다.
     */
    result: rpcPair(
      'session.result',
      z.looseObject({ sessionId: z.string() }),
      z.looseObject({
        status: SessionStatusSchema,
        outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
        /** assistant 응답 본문 — 진행 중이면 지금까지 온 부분 */
        text: z.string(),
        error: z.string().optional(),
        usage: UsageSchema.optional(),
        /** 턴이 아직 안 끝났다 */
        pending: z.boolean(),
      }),
    ),
    /** 재연결 갭 발생 시 타임라인 재동기화 (protocol-design §5) */
    timeline: rpcPair(
      'session.timeline',
      z.looseObject({ sessionId: z.string(), fromSeq: z.number().int().nonnegative().optional() }),
      z.looseObject({ events: z.array(SessionEventSchema) }),
    ),
    /**
     * 타임라인 전문 검색 (M7 7.4.1, FR-9.4).
     *
     * 검색 대상은 원본 이벤트가 아니라 **턴 단위로 합친 텍스트**다 — 델타 조각을 그대로
     * 뒤지면 두 조각에 걸친 문자열이 영영 안 잡힌다. 그래서 결과 단위도 이벤트가 아니라
     * 세그먼트이고, `seq` 는 그 세그먼트를 **여는** 이벤트를 가리킨다(타임라인 점프 앵커).
     */
    search: rpcPair(
      'session.search',
      z.looseObject({
        /** 공백으로 끊어 AND — 각 항이 어딘가에 부분 문자열로 나타나야 한다 */
        query: z.string(),
        workspaceId: z.string().optional(),
        harness: HarnessIdSchema.optional(),
        sessionId: z.string().optional(),
        kinds: z.array(SearchSegmentKindSchema).optional(),
        /**
         * 기간 필터 (ISO). **세션 시각 기준**이다 — 이벤트 봉투에는 시각이 없고
         * (sessionId + seq 뿐) 이벤트별 시각을 넣는 것은 프로토콜 변경인 데다 이미 쌓인
         * 타임라인에는 소급되지 않는다. 세션 타임라인은 그 세션의 수명 안에 있으므로
         * 겹침 판정으로 거른다.
         */
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      z.looseObject({ hits: z.array(SearchHitSchema) }),
    ),
  },
  config: {
    /** 게이트웨이 API 키 저장 (FR-2) — 키 값은 응답·이벤트에 되돌려 보내지 않는다 */
    keySet: rpcPair('config.key.set', z.looseObject({ apiKey: z.string() }), z.looseObject({})),
    keyTest: rpcPair(
      'config.key.test',
      z.looseObject({}),
      z.looseObject({ valid: z.boolean(), detail: z.string().optional() }),
    ),
    get: rpcPair(
      'config.get',
      z.looseObject({ keys: z.array(z.string()).optional() }),
      z.looseObject({ values: z.record(z.string(), z.unknown()) }),
    ),
    set: rpcPair(
      'config.set',
      z.looseObject({ values: z.record(z.string(), z.unknown()) }),
      z.looseObject({}),
    ),
  },
  harness: {
    list: rpcPair(
      'harness.list',
      z.looseObject({}),
      z.looseObject({ harnesses: z.array(HarnessInfoSchema) }),
    ),
    probe: rpcPair(
      'harness.probe',
      z.looseObject({ harness: HarnessIdSchema }),
      z.looseObject({ probe: ProbeResultSchema }),
    ),
  },
  // 프로젝트 레지스트리 (WBS 5.2.3) — 목록은 기본적으로 활성만 준다
  project: {
    open: rpcPair(
      'project.open',
      z.looseObject({ root: z.string() }),
      // 프로젝트를 열면 기본 워크스페이스도 함께 보장된다 (workspace-model D-2)
      z.looseObject({ project: ProjectSchema, workspace: WorkspaceSchema }),
    ),
    list: rpcPair(
      'project.list',
      z.looseObject({ includeArchived: z.boolean().optional() }),
      z.looseObject({ projects: z.array(ProjectSchema) }),
    ),
    update: rpcPair(
      'project.update',
      z.looseObject({ projectId: z.string(), displayName: z.string() }),
      z.looseObject({ project: ProjectSchema }),
    ),
    archive: rpcPair(
      'project.archive',
      z.looseObject({ projectId: z.string() }),
      z.looseObject({}),
    ),
  },
  // 워크스페이스 레지스트리 (WBS 5.3.5)
  workspace: {
    create: rpcPair(
      'workspace.create',
      z.looseObject({
        projectId: z.string(),
        isolation: WorkspaceIsolationSchema,
        cwd: z.string().optional(),
        baseBranch: z.string().optional(),
        branch: z.string().optional(),
        displayName: z.string().optional(),
      }),
      z.looseObject({ workspace: WorkspaceSchema }),
    ),
    list: rpcPair(
      'workspace.list',
      z.looseObject({ projectId: z.string().optional(), includeArchived: z.boolean().optional() }),
      z.looseObject({ workspaces: z.array(WorkspaceSchema) }),
    ),
    update: rpcPair(
      'workspace.update',
      z.looseObject({
        workspaceId: z.string(),
        displayName: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
      z.looseObject({ workspace: WorkspaceSchema }),
    ),
    archive: rpcPair(
      'workspace.archive',
      // removeCheckout 는 worktree 백킹 디렉토리까지 지운다 — 기본은 보존 (workspace-model §6)
      z.looseObject({ workspaceId: z.string(), removeCheckout: z.boolean().optional() }),
      z.looseObject({ workspace: WorkspaceSchema }),
    ),
    labelsList: rpcPair(
      'workspace.labels.list',
      z.looseObject({}),
      z.looseObject({
        labels: z.array(
          z.looseObject({
            id: z.string(),
            key: z.string(),
            value: z.string(),
            createdAt: z.string(),
            lastUsedAt: z.string(),
          }),
        ),
      }),
    ),
    scriptsList: rpcPair(
      'workspace.scripts.list',
      z.looseObject({ workspaceId: z.string() }),
      z.looseObject({
        scripts: z.array(z.looseObject({ name: z.string(), command: z.string() })),
        /** 설정 파일 실행 동의가 아직 없는 상태 */
        trusted: z.boolean(),
      }),
    ),
    scriptRun: rpcPair(
      'workspace.scripts.run',
      z.looseObject({
        workspaceId: z.string(),
        name: z.string(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      }),
      // 감독 터미널로 실행한다 — 출력은 터미널 탭에서 그대로 보인다
      z.looseObject({ terminal: TerminalSchema }),
    ),
    setupRun: rpcPair(
      'workspace.setup.run',
      z.looseObject({ workspaceId: z.string(), trust: z.boolean().optional() }),
      z.looseObject({
        setupState: WorkspaceSetupStateSchema,
        /** pending 사유·실패 지점 — UI 가 무엇을 물어야 하는지 알 수 있게 */
        detail: z.string().optional(),
      }),
    ),
  },
  // 데몬 소유 터미널 (WBS 6.3, workbench-tabs §2.4)
  terminal: {
    create: rpcPair(
      'terminal.create',
      z.looseObject({
        workspaceId: z.string(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
        shell: z.string().optional(),
      }),
      z.looseObject({ terminal: TerminalSchema }),
    ),
    list: rpcPair(
      'terminal.list',
      z.looseObject({ workspaceId: z.string().optional() }),
      z.looseObject({ terminals: z.array(TerminalSchema) }),
    ),
    attach: rpcPair(
      'terminal.attach',
      z.looseObject({
        terminalId: z.string(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      }),
      z.looseObject({
        /** 이 연결에서 쓸 1바이트 핸들 — 바이너리 프레임의 slot */
        slot: z.number().int().nonnegative(),
        /** 링 버퍼 스냅샷 (base64) — 이후 출력은 바이너리 프레임으로 이어진다 */
        scrollback: z.string(),
        /** 링 버퍼가 넘쳐 앞이 잘렸는지 — 클라이언트가 상단에 알린다 */
        truncated: z.boolean(),
      }),
    ),
    detach: rpcPair(
      'terminal.detach',
      z.looseObject({ terminalId: z.string() }),
      z.looseObject({}),
    ),
    resize: rpcPair(
      'terminal.resize',
      z.looseObject({
        terminalId: z.string(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      }),
      z.looseObject({}),
    ),
    /**
     * 스크롤백 1회 읽기 (WBS 7.2.3) — `attach` 와 달리 **슬롯을 잡지 않고 구독도 만들지 않는다**.
     * 화면 없이 상태만 보는 소비자(역방향 툴 `term_read`)를 위한 경로다. attach 로 대신하면
     * 연결마다 1바이트 핸들을 소모하고 detach 를 잊으면 슬롯이 샌다.
     */
    read: rpcPair(
      'terminal.read',
      z.looseObject({
        terminalId: z.string(),
        /** 스크롤백 끝에서부터 최대 바이트 (기본 8192, 상한은 링 버퍼 크기) */
        bytes: z.number().int().positive().max(65536).optional(),
      }),
      z.looseObject({
        /** base64 — attach 의 scrollback 과 같은 인코딩 */
        scrollback: z.string(),
        /** 링 버퍼가 넘쳐 앞이 잘렸거나 bytes 로 잘렸는지 */
        truncated: z.boolean(),
      }),
    ),
    /**
     * 입력 1회 쓰기 (WBS 7.2.4) — 대화형 UI 의 바이너리 프레임 경로와 **병행**한다.
     *
     * 프레임 경로는 attach 로 잡은 슬롯 위에서만 성립하는데(6.3), 역방향 툴 `term_send` 는
     * 화면 없이 한 줄을 보내는 소비자라 슬롯을 잡을 이유가 없다. 반대로 이 RPC 로 대화형
     * 입력을 흘리면 키 입력마다 JSON 왕복이 생긴다 — 그래서 둘 다 남긴다.
     */
    write: rpcPair(
      'terminal.write',
      z.looseObject({ terminalId: z.string(), data: z.string() }),
      z.looseObject({}),
    ),
    kill: rpcPair('terminal.kill', z.looseObject({ terminalId: z.string() }), z.looseObject({})),
  },
  // 워크스페이스 파일 (WBS 6.4) — 경로는 워크스페이스 상대만 받는다 (workbench-tabs §3)
  file: {
    list: rpcPair(
      'file.list',
      z.looseObject({ workspaceId: z.string(), path: z.string() }),
      z.looseObject({
        entries: z.array(
          z.looseObject({
            name: z.string(),
            path: z.string(),
            kind: z.enum(['file', 'directory']),
            size: z.number().int().nonnegative().optional(),
          }),
        ),
        /** 항목 수 상한을 넘어 잘렸는지 */
        truncated: z.boolean(),
      }),
    ),
    read: rpcPair(
      'file.read',
      z.looseObject({ workspaceId: z.string(), path: z.string() }),
      z.looseObject({
        path: z.string(),
        size: z.number().int().nonnegative(),
        /** 상한 초과·바이너리면 없다 */
        text: z.string().optional(),
        binary: z.boolean(),
        tooLarge: z.boolean(),
      }),
    ),
  },
  // 변경사항 (WBS 6.5) — 구독은 클라이언트가 다시 건다(데몬이 구독 상태를 영속하지 않는다)
  diff: {
    get: rpcPair(
      'diff.get',
      z.looseObject({
        workspaceId: z.string(),
        scope: z.enum(['working', 'commit']),
        sha: z.string().optional(),
      }),
      z.looseObject({
        scope: z.enum(['working', 'commit']),
        patch: z.string(),
        truncated: z.boolean(),
        untracked: z.array(z.string()),
        unavailable: z.string().optional(),
      }),
    ),
    subscribe: rpcPair(
      'diff.subscribe',
      z.looseObject({ workspaceId: z.string() }),
      z.looseObject({}),
    ),
    unsubscribe: rpcPair(
      'diff.unsubscribe',
      z.looseObject({ workspaceId: z.string() }),
      z.looseObject({}),
    ),
  },
  /**
   * 역방향 툴 (M7 7.2.4, FR-9.2) — 하네스가 spawn 한 MCP 서버 / pi 확장이 부른다.
   *
   * 툴 실행을 **데몬 안으로** 끌어온 이유가 셋 있다: ① 승인 채널이 여기에만 있다(사용자와
   * 이어진 연결은 데몬이 소유한다) ② 감사 로그의 단일 기록자여야 한다(하네스마다 MCP 서버
   * 프로세스가 따로 뜨므로 JSONL 을 각자 append 하면 섞인다) ③ 재귀 상한이 보는 세션 그래프가
   * 데몬에 있다. 노출 프로세스는 전송만 하고 판단하지 않는다.
   */
  tool: {
    invoke: rpcPair(
      'tool.invoke',
      z.looseObject({
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        /**
         * 호출한 프로세스의 부모 pid = 하네스 프로세스. 데몬이 PID 원장으로 세션을 역인덱싱해
         * 승인 요청을 그 세션에 붙이고 재귀 깊이를 센다. 모르면 생략 — 그때는 세션 귀속 없이
         * 처리되고, 세션을 만드는 툴은 깊이를 셀 수 없으므로 거부된다.
         */
        callerPid: z.number().int().positive().optional(),
      }),
      // MCP `tools/call` 결과 그대로 — 노출 프로세스가 변환 없이 흘려보낸다
      z.looseObject({
        content: z.array(z.looseObject({ type: z.literal('text'), text: z.string() })),
        isError: z.boolean(),
      }),
    ),
  },
  system: {
    version: rpcPair(
      'system.version',
      z.looseObject({}),
      z.looseObject({ version: z.string(), protocolVersion: z.literal(PROTOCOL_VERSION) }),
    ),
    shutdown: rpcPair('system.shutdown', z.looseObject({}), z.looseObject({})),
  },
} as const;

// ── 수신 프레임 파싱용 집계 유니온 ─────────────────────────────────────────

export const RpcRequestSchema = z.discriminatedUnion('type', [
  rpc.session.create.request,
  rpc.session.resume.request,
  rpc.session.list.request,
  rpc.session.close.request,
  rpc.session.prompt.request,
  rpc.session.wait.request,
  rpc.session.interrupt.request,
  rpc.session.permissionRespond.request,
  rpc.session.modelSet.request,
  rpc.session.attentionAck.request,
  rpc.session.usage.request,
  rpc.session.result.request,
  rpc.session.timeline.request,
  rpc.session.search.request,
  rpc.config.keySet.request,
  rpc.config.keyTest.request,
  rpc.config.get.request,
  rpc.config.set.request,
  rpc.harness.list.request,
  rpc.harness.probe.request,
  rpc.project.open.request,
  rpc.project.list.request,
  rpc.project.update.request,
  rpc.project.archive.request,
  rpc.workspace.create.request,
  rpc.workspace.list.request,
  rpc.workspace.update.request,
  rpc.workspace.archive.request,
  rpc.workspace.labelsList.request,
  rpc.workspace.scriptsList.request,
  rpc.workspace.scriptRun.request,
  rpc.terminal.create.request,
  rpc.terminal.list.request,
  rpc.terminal.attach.request,
  rpc.terminal.detach.request,
  rpc.terminal.resize.request,
  rpc.terminal.read.request,
  rpc.terminal.write.request,
  rpc.terminal.kill.request,
  rpc.file.list.request,
  rpc.file.read.request,
  rpc.diff.get.request,
  rpc.diff.subscribe.request,
  rpc.diff.unsubscribe.request,
  rpc.workspace.setupRun.request,
  rpc.tool.invoke.request,
  rpc.system.version.request,
  rpc.system.shutdown.request,
]);
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

// 응답은 method 별로 ok 유니온이라 type 단일 판별이 불가 — z.union 으로 집계
export const RpcResponseSchema = z.union([
  rpc.session.create.response,
  rpc.session.resume.response,
  rpc.session.list.response,
  rpc.session.close.response,
  rpc.session.prompt.response,
  rpc.session.wait.response,
  rpc.session.interrupt.response,
  rpc.session.permissionRespond.response,
  rpc.session.modelSet.response,
  rpc.session.attentionAck.response,
  rpc.session.usage.response,
  rpc.session.result.response,
  rpc.session.timeline.response,
  rpc.session.search.response,
  rpc.config.keySet.response,
  rpc.config.keyTest.response,
  rpc.config.get.response,
  rpc.config.set.response,
  rpc.harness.list.response,
  rpc.harness.probe.response,
  rpc.project.open.response,
  rpc.project.list.response,
  rpc.project.update.response,
  rpc.project.archive.response,
  rpc.workspace.create.response,
  rpc.workspace.list.response,
  rpc.workspace.update.response,
  rpc.workspace.archive.response,
  rpc.workspace.labelsList.response,
  rpc.workspace.scriptsList.response,
  rpc.workspace.scriptRun.response,
  rpc.terminal.create.response,
  rpc.terminal.list.response,
  rpc.terminal.attach.response,
  rpc.terminal.detach.response,
  rpc.terminal.resize.response,
  rpc.terminal.read.response,
  rpc.terminal.write.response,
  rpc.terminal.kill.response,
  rpc.file.list.response,
  rpc.file.read.response,
  rpc.diff.get.response,
  rpc.diff.subscribe.response,
  rpc.diff.unsubscribe.response,
  rpc.workspace.setupRun.response,
  rpc.tool.invoke.response,
  rpc.system.version.response,
  rpc.system.shutdown.response,
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
