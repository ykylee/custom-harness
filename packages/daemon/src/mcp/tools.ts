// 역방향 툴 → 데몬 RPC 바인딩 (WBS 7.2.3·7.2.4, FR-9.2)
//
// 카탈로그(`@custom-harness/protocol` tools.ts)는 무엇을 노출할지를 정하고, 여기서는 그것을
// 데몬 RPC 에 잇는다. 노출 경로가 둘(MCP 서버 / pi 확장)이므로 이 바인딩도 경로와 무관해야
// 한다 — 그래서 전송이 아니라 `DaemonRpc` 인터페이스에만 의존한다.
//
// 7.2.4 부터 이 invoker 는 **데몬 안에서** 돈다(`tool.invoke` RPC). 노출 프로세스는 전송만
// 한다 — 승인·감사·재귀 상한이 전부 게이트를 통과해야 하는데, 그 셋의 근거(사용자 연결·단일
// 기록자·세션 그래프)가 데몬에만 있기 때문이다.
import {
  TOOL_CATALOG,
  TOOL_LABEL_PARENT_SESSION,
  findTool,
  toolDescriptors,
  type ToolDescriptor,
  type ToolSpec,
} from '@custom-harness/protocol';
import type { ToolCallResult, ToolInvoker } from './server.js';

/** 데몬 RPC 한 번 — 전송(WS 또는 데몬 내부 호출)은 호출자가 소유한다 */
export interface DaemonRpc {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 게이트 판정 — 통과 여부와, 통과 시 실행에 얹을 부가 정보 */
export interface ToolGateDecision {
  allow: boolean;
  /** 거부 사유. **모델이 읽는다** — 다른 수단을 찾을 수 있는 문장이어야 한다 */
  reason?: string;
  /** 세션 생성 툴에 붙일 라벨 (부모·깊이) — 게이트가 깊이를 세므로 게이트가 만든다 */
  labels?: Record<string, string>;
}

/**
 * 실행 직전 관문. 파라미터 검증을 통과한 뒤에 불린다 — 무엇을 하려는지 확정된 뒤라야
 * 사용자에게 물을 문장을 만들 수 있고, 감사 로그도 같은 것을 적을 수 있다.
 */
export type ToolGate = (spec: ToolSpec, args: Record<string, unknown>) => Promise<ToolGateDecision>;

export interface ToolInvokerOptions {
  rpc: DaemonRpc;
  /**
   * 없으면 승인 대상(write) 툴은 전부 거부된다.
   *
   * 게이트를 옵션으로 둔 이유는 테스트 편의가 아니라 **기본값의 방향** 때문이다: 게이트를
   * 붙이는 것을 잊은 호출 경로가 생기면 write 툴이 승인 없이 열리는 것이 아니라 막힌다.
   */
  gate?: ToolGate;
}

/** 게이트가 없어 거부할 때의 문구 — 모델이 읽고 다른 수단을 찾을 수 있어야 한다 */
function noGateText(spec: ToolSpec): string {
  return (
    `${spec.name} 은(는) 사용자 승인이 필요한 툴인데 이 경로에는 승인 채널이 없다. ` +
    `조회 툴(session_list · session_read · ws_list · term_list · term_read)은 그대로 쓸 수 ` +
    `있으니, 상태를 확인한 뒤 변경이 필요한 일은 사용자에게 요청하라.`
  );
}

function ok(payload: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function fail(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 세션 요약에서 모델에게 쓸모 있는 것만 — 타임라인·승인 원문까지 실으면 컨텍스트만 먹는다 */
function summarizeSession(session: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    'sessionId',
    'harness',
    'cwd',
    'status',
    'modelId',
    'seq',
    'workspaceId',
    'title',
    'requiresAttention',
    'attentionReason',
    'attentionTimestamp',
    'updatedAt',
    // 부모-자식 관계는 라벨로만 표현된다 (FR-9.3) — 빼면 모델이 위임 구조를 못 본다
    'labels',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    if (session[key] !== undefined) out[key] = session[key];
  }
  // 개수만 준다 — 무엇을 묻는지는 session_read 로 본다
  const pending = session.pendingPermissions;
  if (Array.isArray(pending) && pending.length > 0) out.pendingPermissionCount = pending.length;
  return out;
}

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

/**
 * 카탈로그를 데몬 RPC 에 잇는 invoker.
 *
 * 파라미터는 카탈로그의 zod 스키마로 **엄격 검증**한다. 입력을 만드는 쪽이 모델이라
 * 환각 파라미터가 조용히 무시되면 잘못된 대상에 작업이 나갈 수 있다 (7.2.2 결정).
 */
export function createToolInvoker(options: ToolInvokerOptions): ToolInvoker {
  const { rpc, gate } = options;

  return {
    list(): ToolDescriptor[] {
      return toolDescriptors();
    },

    async call(name: string, rawArgs: unknown): Promise<ToolCallResult> {
      const spec = findTool(name);
      if (!spec) {
        return fail(
          `알 수 없는 툴: ${name}. 사용 가능: ${TOOL_CATALOG.map((t) => t.name).join(', ')}`,
        );
      }

      const parsed = spec.params.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return fail(`${name} 파라미터가 스키마와 맞지 않는다 — ${detail}`);
      }
      const args = parsed.data as Record<string, unknown>;

      if (!gate) {
        // 게이트 없는 경로는 조회만 흘려보낸다
        if (spec.approval) return fail(noGateText(spec));
        return dispatch(rpc, spec, args, { allow: true });
      }

      const decision = await gate(spec, args);
      if (!decision.allow) return fail(decision.reason ?? `${name} 이(가) 거부됐다.`);
      return dispatch(rpc, spec, args, decision);
    },
  };
}

async function dispatch(
  rpc: DaemonRpc,
  spec: ToolSpec,
  args: Record<string, unknown>,
  decision: ToolGateDecision,
): Promise<ToolCallResult> {
  try {
    return await run(rpc, spec, args, decision);
  } catch (error) {
    return fail(
      `${spec.name} 실행 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function run(
  rpc: DaemonRpc,
  spec: ToolSpec,
  args: Record<string, unknown>,
  decision: ToolGateDecision,
): Promise<ToolCallResult> {
  switch (spec.name) {
    // ── 조회 (승인 불요) ─────────────────────────────────────────────────────
    case 'session_list': {
      const params =
        args.workspaceId !== undefined ? { workspaceId: args.workspaceId as string } : {};
      const result = await rpc.call('session.list', params);
      let sessions = asArray(result.sessions);
      // 주의 상태는 7.1 이 계산한 값을 **거르기만** 한다 — 여기서 다시 판단하지 않는다
      if (args.requiresAttention === true) {
        sessions = sessions.filter((s) => s.requiresAttention === true);
      }
      // 부모 필터도 거르기만 한다 — 관계의 정본은 세션 레코드의 라벨이고,
      // 데몬에 별도 인덱스를 두면 그것과 라벨이 어긋날 자리가 생긴다 (M7 7.3.1)
      if (typeof args.parentSessionId === 'string') {
        const parent = args.parentSessionId;
        sessions = sessions.filter(
          (s) =>
            (s.labels as Record<string, string> | undefined)?.[TOOL_LABEL_PARENT_SESSION] ===
            parent,
        );
      }
      return ok({ sessions: sessions.map(summarizeSession) });
    }

    case 'session_read': {
      const params: Record<string, unknown> = { sessionId: args.sessionId };
      if (args.fromSeq !== undefined) params.fromSeq = args.fromSeq;
      const result = await rpc.call('session.timeline', params);
      const events = asArray(result.events);
      // limit 은 툴 층에서 자른다 — session.timeline 에는 limit 이 없고,
      // 프로토콜을 넓히는 것보다 여기서 끝에서 자르는 편이 싸다 (최근 것이 궁금하다)
      const limit = typeof args.limit === 'number' ? args.limit : 100;
      const sliced = events.length > limit ? events.slice(events.length - limit) : events;
      return ok({ events: sliced, totalReturned: sliced.length, truncated: events.length > limit });
    }

    case 'ws_list': {
      const params = args.projectId !== undefined ? { projectId: args.projectId as string } : {};
      const result = await rpc.call('workspace.list', params);
      return ok({ workspaces: asArray(result.workspaces) });
    }

    case 'term_list': {
      const params =
        args.workspaceId !== undefined ? { workspaceId: args.workspaceId as string } : {};
      const result = await rpc.call('terminal.list', params);
      return ok({ terminals: asArray(result.terminals) });
    }

    case 'term_read': {
      const params: Record<string, unknown> = { terminalId: args.terminalId };
      if (args.bytes !== undefined) params.bytes = args.bytes;
      const result = await rpc.call('terminal.read', params);
      // 모델에게는 base64 가 아니라 텍스트를 준다 — 그대로 읽을 수 있어야 쓸모가 있다
      const text = Buffer.from(String(result.scrollback ?? ''), 'base64').toString('utf8');
      return ok({ output: text, truncated: result.truncated === true });
    }

    case 'session_wait': {
      const params: Record<string, unknown> = { sessionId: args.sessionId };
      if (args.timeoutMs !== undefined) params.timeoutMs = args.timeoutMs;
      const result = await rpc.call('session.wait', params);
      const timedOut = result.timedOut === true;
      return ok({
        done: !timedOut && result.activeTurn !== true,
        status: result.status,
        ...(result.lastTurnOutcome !== undefined ? { outcome: result.lastTurnOutcome } : {}),
        timedOut,
        // 다시 부르라고 명시한다 — 모델이 timedOut 을 실패로 읽고 포기하면 위임이 끊긴다
        ...(timedOut ? { note: '아직 진행 중이다. 다시 호출하면 이어서 기다린다.' } : {}),
      });
    }

    case 'session_usage': {
      const result = await rpc.call('session.usage', { sessionId: args.sessionId });
      return ok(result);
    }

    case 'session_result': {
      const result = await rpc.call('session.result', { sessionId: args.sessionId });
      return ok(result);
    }

    // ── 변경 (승인 대상) ─────────────────────────────────────────────────────
    case 'session_new': {
      const params: Record<string, unknown> = { harness: args.harness, cwd: args.cwd };
      if (args.workspaceId !== undefined) params.workspaceId = args.workspaceId;
      if (args.modelId !== undefined) params.modelId = args.modelId;
      // 부모·깊이 라벨은 게이트가 만든다 — 상한을 센 주체가 그 근거도 남긴다
      if (decision.labels !== undefined) params.labels = decision.labels;
      const result = await rpc.call('session.create', params);
      const session = (result.session ?? {}) as Record<string, unknown>;
      return ok({ session: summarizeSession(session) });
    }

    case 'session_say': {
      const result = await rpc.call('session.prompt', {
        sessionId: args.sessionId,
        prompt: args.prompt,
      });
      // 턴 완료를 기다리지 않는다(카탈로그 계약) — 진행 확인은 session_read 로
      return ok({ turnId: result.turnId, note: '턴이 시작됐다. 진행은 session_read 로 확인한다.' });
    }

    case 'session_stop': {
      await rpc.call('session.interrupt', { sessionId: args.sessionId });
      return ok({ stopped: true }); // 멱등 — 활성 턴이 없어도 성공이다
    }

    case 'term_new': {
      // 크기는 화면 없는 소비자의 기본값이다. 사람이 붙으면 attach 가 자기 크기로 다시 잡는다
      const result = await rpc.call('terminal.create', {
        workspaceId: args.workspaceId,
        cols: 80,
        rows: 24,
      });
      return ok({ terminal: result.terminal });
    }

    case 'term_send': {
      await rpc.call('terminal.write', { terminalId: args.terminalId, data: args.data });
      const data = String(args.data ?? '');
      return ok({
        sent: data.length,
        // 개행 없이 보낸 입력은 셸에 남아만 있다 — 모델이 "실행됐다"고 오해하기 쉬운 지점
        executed: data.includes('\n'),
        ...(data.includes('\n') ? {} : { note: '줄바꿈이 없어 아직 실행되지 않았다.' }),
      });
    }

    default:
      return fail(`${spec.name} 의 데몬 바인딩이 없다`);
  }
}
