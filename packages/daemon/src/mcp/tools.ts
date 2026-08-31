// 역방향 툴 → 데몬 RPC 바인딩 (WBS 7.2.3, FR-9.2)
//
// 카탈로그(`@custom-harness/protocol` tools.ts)는 무엇을 노출할지를 정하고, 여기서는 그것을
// 데몬 RPC 에 잇는다. 노출 경로가 둘(MCP 서버 / pi 확장)이므로 이 바인딩도 경로와 무관해야
// 한다 — 그래서 전송이 아니라 `DaemonRpc` 인터페이스에만 의존한다.
import {
  TOOL_CATALOG,
  findTool,
  toolDescriptors,
  type ToolDescriptor,
  type ToolSpec,
} from '@custom-harness/protocol';
import type { ToolCallResult, ToolInvoker } from './server.js';

/** 데몬 RPC 한 번 — 전송(WS)은 호출자가 소유한다 */
export interface DaemonRpc {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolInvokerOptions {
  rpc: DaemonRpc;
  /**
   * 승인 대상(write) 툴을 실행할 수 있는가.
   *
   * 7.2.3 은 **노출**까지가 범위이고 승인 채널(데몬이 스스로 사용자에게 묻는 경로)은 7.2.4 다.
   * 그때까지 write 툴은 카탈로그에 보이되 실행되지 않는다 — 승인 없이 실행하면 카탈로그가
   * 테스트로 고정한 "write 는 전부 승인 대상" 규칙이 표면에서만 참인 상태가 된다.
   */
  allowApprovalRequired?: boolean;
}

/** 승인 채널이 없어 거부할 때의 문구 — 모델이 읽고 다른 수단을 찾을 수 있어야 한다 */
function approvalRequiredText(spec: ToolSpec): string {
  return (
    `${spec.name} 은(는) 사용자 승인이 필요한 툴이라 현재 실행할 수 없다. ` +
    `승인 채널은 아직 구현 전이다(WBS 7.2.4). 조회 툴(session_list · session_read · ` +
    `ws_list · term_list · term_read)은 그대로 쓸 수 있으니, 상태를 확인한 뒤 ` +
    `변경이 필요한 일은 사용자에게 요청하라.`
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
  const { rpc, allowApprovalRequired = false } = options;

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

      if (spec.approval && !allowApprovalRequired) {
        return fail(approvalRequiredText(spec));
      }

      try {
        return await dispatch(rpc, spec, args);
      } catch (error) {
        return fail(`${name} 실행 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

async function dispatch(
  rpc: DaemonRpc,
  spec: ToolSpec,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (spec.name) {
    case 'session_list': {
      const params =
        args.workspaceId !== undefined ? { workspaceId: args.workspaceId as string } : {};
      const result = await rpc.call('session.list', params);
      let sessions = asArray(result.sessions);
      // 주의 상태는 7.1 이 계산한 값을 **거르기만** 한다 — 여기서 다시 판단하지 않는다
      if (args.requiresAttention === true) {
        sessions = sessions.filter((s) => s.requiresAttention === true);
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

    // write 툴은 승인 채널(7.2.4)이 붙기 전에는 여기까지 오지 않는다.
    // 온다면 `allowApprovalRequired` 가 켜진 것이고, 그 배선은 7.2.4 의 몫이다.
    default:
      return fail(`${spec.name} 의 데몬 바인딩이 아직 없다 (WBS 7.2.4)`);
  }
}
