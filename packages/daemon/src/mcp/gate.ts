// 역방향 툴 안전장치 (WBS 7.2.4, FR-9.2 · FR-1.5)
//
// 카탈로그(무엇을 노출할지)와 바인딩(어떻게 실행할지) 사이에 서는 관문이다. 넷을 본다:
//
//   ① opt-in   — 노출 자체가 꺼져 있으면 어떤 툴도 실행하지 않는다 (기본 off)
//   ② 호출자   — 누가 불렀는가. PID 원장으로 판정하며 **자기 신고를 믿지 않는다**
//   ③ 승인     — write 5종은 사용자에게 묻는다. 물을 곳이 없으면 거부한다
//   ④ 재귀     — 세션을 만드는 툴은 깊이 상한을 넘으면 거부한다
//
// 그리고 통과·거부·실패를 모두 감사 로그에 남긴다. 거부가 기록되지 않으면 "하네스가 무엇을
// 하려 했는가"가 사라진다 — 사후 조사에서는 성공보다 그쪽이 중요할 때가 많다.
import {
  TOOL_LABEL_DEPTH,
  TOOL_LABEL_PARENT_SESSION,
  findTool,
  type ToolSpec,
} from '@custom-harness/protocol';
import { summarizeArgs, type AuditLogger } from './audit.js';
import type { ToolCallResult } from './server.js';
import { createToolInvoker, type DaemonRpc, type ToolGateDecision } from './tools.js';

/** 호출자 판정 결과 — 세션을 못 찾으면 `sessionId` 가 없다 */
export interface CallerInfo {
  sessionId?: string;
  harness?: string;
  /** 호출자 세션의 재귀 깊이. 사용자가 만든 세션은 0 */
  depth: number;
}

export interface ReverseToolRuntime {
  rpc: DaemonRpc;
  audit: AuditLogger;
  /** `tools.reverseExposure` — 호출 시점에 읽는다(핫 리로드) */
  isEnabled(): boolean;
  /** `tools.maxSessionDepth` */
  maxSessionDepth(): number;
  /** `tools.maxFanout` — 한 부모가 동시에 거느릴 수 있는 살아 있는 자식 수 */
  maxFanout(): number;
  /**
   * 이 세션의 **닫히지 않은** 직계 자식 수. 판정 기준은 `session_usage` 가 모델에게 보여
   * 주는 값과 같아야 한다 — 다르면 모델은 여유가 있다고 보는데 게이트가 막는 상태가 된다.
   */
  activeChildCount(sessionId: string): Promise<number>;
  /** pid → 세션 (PID 원장). 노출 프로세스의 부모가 하네스 프로세스다 */
  resolveCaller(callerPid: number | undefined): Promise<CallerInfo>;
  /**
   * 사용자에게 묻는다. `true` = 승인. 호출자 세션이 없으면 물을 화면이 없다는 뜻이라
   * 이 함수는 불리지 않는다.
   */
  requestApproval(input: {
    sessionId: string;
    spec: ToolSpec;
    args: Record<string, unknown>;
  }): Promise<boolean>;
}

function fail(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 승인 카드 한 줄 — 사용자가 이것만 보고 판단한다. 대상과 내용이 다 보여야 한다 */
export function approvalSummary(spec: ToolSpec, args: Record<string, unknown>): string {
  switch (spec.name) {
    case 'session_new':
      return `다른 에이전트가 새 세션을 만들려 한다 — ${String(args.harness)} @ ${String(args.cwd)}`;
    case 'session_say':
      return `다른 에이전트가 세션 ${String(args.sessionId)} 에 프롬프트를 보내려 한다: ${preview(args.prompt)}`;
    case 'session_stop':
      return `다른 에이전트가 세션 ${String(args.sessionId)} 의 턴을 중단하려 한다`;
    case 'term_new':
      return `다른 에이전트가 워크스페이스 ${String(args.workspaceId)} 에 터미널을 열려 한다`;
    case 'term_send':
      // 가장 위험한 툴이라 내용을 그대로 보여준다 — 요약하면 무엇을 실행하는지가 사라진다
      return `다른 에이전트가 터미널 ${String(args.terminalId)} 에 입력하려 한다: ${preview(args.data)}`;
    default:
      return `다른 에이전트가 ${spec.name} 을(를) 실행하려 한다`;
  }
}

function preview(value: unknown): string {
  const text = String(value ?? '');
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * 툴 호출 1회 — 관문 전체를 통과시킨다.
 *
 * 반환값은 MCP `tools/call` 결과 그대로다. 거부도 **결과**로 돌려준다(프로토콜 오류가 아니라):
 * 모델이 읽고 다른 수단을 찾아야 하는데, 오류로 올리면 하네스가 대화 밖에서 삼킨다 (7.2.3 결정).
 */
export async function invokeReverseTool(
  runtime: ReverseToolRuntime,
  input: { name: string; args: Record<string, unknown>; callerPid?: number },
): Promise<ToolCallResult> {
  const spec = findTool(input.name);
  const effect = spec?.effect ?? 'read';

  if (!runtime.isEnabled()) {
    const reason = '역방향 툴이 꺼져 있다 (설정 tools.reverseExposure). 사용자가 켜야 쓸 수 있다.';
    await runtime.audit.record({
      at: new Date().toISOString(),
      tool: input.name,
      effect,
      outcome: 'blocked',
      reason: 'opt-in off',
    });
    return fail(reason);
  }

  const caller = await runtime.resolveCaller(input.callerPid);
  let approval: 'granted' | 'denied' | undefined;
  let blockedReason: string | undefined;

  const invoker = createToolInvoker({
    rpc: runtime.rpc,
    gate: async (toolSpec, args): Promise<ToolGateDecision> => {
      // ── 재귀 상한 ─────────────────────────────────────────────────────────
      if (toolSpec.spawnsSession === true) {
        if (caller.sessionId === undefined) {
          blockedReason = '호출자 세션 미상 — 재귀 깊이를 셀 수 없다';
          return {
            allow: false,
            reason:
              `${toolSpec.name} 은(는) 호출자 세션을 판정할 수 없어 거부됐다. ` +
              `세션을 만드는 툴은 재귀 깊이를 세야 하는데, 그 기준이 없으면 상한이 성립하지 않는다.`,
          };
        }
        const limit = runtime.maxSessionDepth();
        const childDepth = caller.depth + 1;
        if (childDepth > limit) {
          blockedReason = `재귀 깊이 상한 초과 (${childDepth} > ${limit})`;
          return {
            allow: false,
            reason:
              `${toolSpec.name} 이(가) 재귀 깊이 상한에 걸렸다 (깊이 ${childDepth}, 상한 ${limit}). ` +
              `직접 처리하거나 사용자에게 요청하라.`,
          };
        }

        // 팬아웃 상한 (M7 7.3.2, NFR-7) — 깊이가 트리의 높이를 막는다면 이쪽은 너비를 막는다.
        // 깊이 1 에서도 자식 20개를 동시에 돌리면 토큰은 그대로 20배다.
        const fanoutLimit = runtime.maxFanout();
        const active = await runtime.activeChildCount(caller.sessionId);
        if (active >= fanoutLimit) {
          blockedReason = `팬아웃 상한 초과 (활성 자식 ${active} ≥ 상한 ${fanoutLimit})`;
          return {
            allow: false,
            reason:
              `${toolSpec.name} 이(가) 팬아웃 상한에 걸렸다 (살아 있는 자식 ${active}개, 상한 ${fanoutLimit}개). ` +
              `session_usage 로 자식들의 진행과 비용을 확인하고, 끝난 자식을 session_stop 후 정리하거나 ` +
              `기존 자식에게 session_say 로 이어서 시켜라.`,
          };
        }
      }

      // ── 승인 ─────────────────────────────────────────────────────────────
      if (!toolSpec.approval) return { allow: true };
      if (caller.sessionId === undefined) {
        blockedReason = '호출자 세션 미상 — 승인을 물을 화면이 없다';
        return {
          allow: false,
          reason:
            `${toolSpec.name} 은(는) 사용자 승인이 필요한데 호출자 세션을 판정할 수 없어 물을 곳이 ` +
            `없다. 조회 툴은 그대로 쓸 수 있다.`,
        };
      }
      const granted = await runtime.requestApproval({
        sessionId: caller.sessionId,
        spec: toolSpec,
        args,
      });
      approval = granted ? 'granted' : 'denied';
      if (!granted) {
        return { allow: false, reason: `${toolSpec.name} 을(를) 사용자가 거부했다.` };
      }

      // 승인된 세션 생성에는 부모·깊이 라벨을 얹는다 (상한을 센 주체가 근거를 남긴다)
      if (toolSpec.spawnsSession === true && caller.sessionId !== undefined) {
        return {
          allow: true,
          labels: {
            [TOOL_LABEL_PARENT_SESSION]: caller.sessionId,
            [TOOL_LABEL_DEPTH]: String(caller.depth + 1),
          },
        };
      }
      return { allow: true };
    },
  });

  const result = await invoker.call(input.name, input.args);

  await runtime.audit.record({
    at: new Date().toISOString(),
    tool: input.name,
    effect,
    ...(caller.sessionId !== undefined ? { callerSessionId: caller.sessionId } : {}),
    ...(caller.harness !== undefined ? { callerHarness: caller.harness } : {}),
    ...(approval !== undefined ? { approval } : {}),
    outcome: !result.isError ? 'ok' : blockedReason !== undefined ? 'blocked' : 'error',
    ...reasonField(blockedReason, result),
    args: summarizeArgs(input.args),
  });

  return result;
}

/** 감사 항목의 사유 — 차단 사유가 있으면 그것, 없으면 실패 결과의 앞부분 */
function reasonField(
  blockedReason: string | undefined,
  result: ToolCallResult,
): { reason?: string } {
  if (blockedReason !== undefined) return { reason: blockedReason };
  if (!result.isError) return {};
  const text = result.content[0]?.text;
  return text === undefined ? {} : { reason: text.slice(0, 200) };
}

/** 세션 라벨에서 재귀 깊이를 읽는다 — 없거나 망가졌으면 0 (사용자가 만든 세션과 같게 본다) */
export function depthFromLabels(labels: Record<string, string> | undefined): number {
  const raw = labels?.[TOOL_LABEL_DEPTH];
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
