// CLI 세션 명령 (M7 WBS 7.5.1, FR-9.6) — 스크립트가 에이전트를 부리는 표면.
//
// FR-5.4 는 "에이전트 조작은 UI 가 유일한 창구"였다. FR-9.6 이 그 제한을 푼다: 자동화가
// 1급 경로라면 조작이 UI 안에만 있어서는 안 된다.
//
// 출력 규약 둘 — 이 규약이 명령들의 모양을 정한다:
//
//   ① **stdout 은 답, stderr 은 과정.** 어시스턴트 텍스트만 stdout 으로 가고 툴 실행·승인
//      요청·상태는 stderr 로 간다. 그래야 `session prompt … --wait > answer.txt` 가
//      기대대로 동작한다.
//   ② **`--json` 은 원시 이벤트 JSONL.** 모양을 다시 빚지 않는다 — 프로토콜이 이미 계약이고,
//      CLI 가 자기 스키마를 하나 더 만들면 그것도 유지 대상이 된다.
import type { PermissionRequest, SessionEvent, SessionSummary } from '@custom-harness/protocol';
import type { CliIo } from './io.js';
import type { DaemonConnection } from './connection.js';

/** 스트리밍이 한 턴을 기다리는 최대 시간 — 무한 대기는 CI 를 멈춰 세운다 */
const WATCH_TIMEOUT_MS = 30 * 60_000;

export interface SessionCommandContext {
  connection: DaemonConnection;
  io: CliIo;
  json: boolean;
}

// ── list ───────────────────────────────────────────────────────────────────

export async function cmdSessionList(
  context: SessionCommandContext,
  options: { workspaceId?: string | undefined; all: boolean },
): Promise<number> {
  const { sessions } = await context.connection.rpc<{ sessions: SessionSummary[] }>(
    'session.list',
    {
      ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
    },
  );
  // 닫힌 세션은 기본적으로 숨긴다 — 이력은 지워지지 않으므로(FR-1.3) 목록이 계속 자란다
  const visible = options.all ? sessions : sessions.filter((s) => s.status !== 'closed');
  if (context.json) {
    context.io.out(JSON.stringify({ sessions: visible }));
    return 0;
  }
  if (visible.length === 0) {
    context.io.out(options.all ? '세션 없음' : '활성 세션 없음 (--all 로 전체 보기)');
    return 0;
  }
  for (const session of visible) {
    const pending = session.pendingPermissions?.length ?? 0;
    const attention =
      session.requiresAttention === true ? ` !${session.attentionReason ?? ''}` : '';
    context.io.out(
      `${session.sessionId}  ${session.harness}  ${session.status}${attention}` +
        `${pending > 0 ? `  승인대기 ${pending}` : ''}  ${session.title ?? session.cwd}`,
    );
  }
  return 0;
}

// ── new ────────────────────────────────────────────────────────────────────

export async function cmdSessionNew(
  context: SessionCommandContext,
  options: {
    harness: string;
    cwd: string;
    workspaceId?: string | undefined;
    modelId?: string | undefined;
  },
): Promise<number> {
  // workspaceId 를 안 주면 데몬이 cwd 로 프로젝트를 열어 기본 워크스페이스에 귀속시킨다.
  // 폴백이 아니라 CLI 를 위해 마련된 경로다 — "이 디렉토리에서 한 번 돌려라"가
  // 워크스페이스 선행 생성 없이 표현돼야 한다 (session.create 주석, FR-9.6).
  const { session } = await context.connection.rpc<{ session: SessionSummary }>('session.create', {
    harness: options.harness,
    cwd: options.cwd,
    ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
  });
  if (context.json) context.io.out(JSON.stringify({ session }));
  else context.io.out(session.sessionId); // 파이프로 바로 넘길 수 있게 id 만
  return 0;
}

// ── prompt ─────────────────────────────────────────────────────────────────

export async function cmdSessionPrompt(
  context: SessionCommandContext,
  options: { sessionId: string; prompt: string; wait: boolean },
): Promise<number> {
  // 구독을 **보내기 전에** 건다 — 사이에 온 이벤트는 다시 받을 길이 없다.
  // (백필은 turnId 를 모르는 시점이라 갭 판정의 기준이 없다)
  const stream = options.wait ? startStream(context, options.sessionId) : undefined;
  const { turnId } = await context.connection.rpc<{ turnId: string }>('session.prompt', {
    sessionId: options.sessionId,
    prompt: options.prompt,
  });
  if (stream === undefined) {
    if (context.json) context.io.out(JSON.stringify({ turnId }));
    else context.io.out(turnId);
    return 0;
  }
  return await stream.untilTurnEnds(turnId);
}

// ── watch ──────────────────────────────────────────────────────────────────

export async function cmdSessionWatch(
  context: SessionCommandContext,
  options: { sessionId: string; fromSeq?: number | undefined },
): Promise<number> {
  const stream = startStream(context, options.sessionId);
  if (options.fromSeq !== undefined) await stream.backfill(options.fromSeq);
  return await stream.untilTurnEnds(undefined);
}

// ── interrupt · close ──────────────────────────────────────────────────────

export async function cmdSessionInterrupt(
  context: SessionCommandContext,
  sessionId: string,
): Promise<number> {
  // 멱등 — 이미 멈췄어도 성공이다 (FR-1.6). 스크립트가 상태를 먼저 확인할 필요가 없다
  await context.connection.rpc('session.interrupt', { sessionId });
  if (context.json) context.io.out(JSON.stringify({ sessionId, interrupted: true }));
  else context.io.out(`중단 요청: ${sessionId}`);
  return 0;
}

export async function cmdSessionClose(
  context: SessionCommandContext,
  sessionId: string,
): Promise<number> {
  await context.connection.rpc('session.close', { sessionId });
  if (context.json) context.io.out(JSON.stringify({ sessionId, closed: true }));
  else context.io.out(`세션 종료: ${sessionId} (이력은 유지 — 재개 가능)`);
  return 0;
}

// ── approve ────────────────────────────────────────────────────────────────

export async function cmdSessionApprove(
  context: SessionCommandContext,
  options: {
    sessionId: string;
    requestId?: string | undefined;
    optionId?: string | undefined;
    reject: boolean;
  },
): Promise<number> {
  const { sessions } = await context.connection.rpc<{ sessions: SessionSummary[] }>('session.list');
  const session = sessions.find((s) => s.sessionId === options.sessionId);
  if (session === undefined) {
    context.io.err(`세션 없음: ${options.sessionId}`);
    return 1;
  }
  const pending = session.pendingPermissions ?? [];
  const request =
    options.requestId !== undefined
      ? pending.find((r) => r.requestId === options.requestId)
      : pending.length === 1
        ? pending[0]
        : undefined;
  if (request === undefined) {
    // 여러 건일 때 **고르지 않는다** — 잘못 고른 승인은 되돌릴 수 없다
    context.io.err(
      pending.length === 0
        ? '승인 대기 중인 요청이 없습니다'
        : `승인 대기 ${pending.length}건 — --request 로 지정하세요:\n` +
            pending.map((r) => `  ${r.requestId}  ${r.kind}  ${r.summary}`).join('\n'),
    );
    return 1;
  }
  const optionId = options.optionId ?? defaultOptionId(request, options.reject);
  if (optionId === undefined) {
    context.io.err(
      `${options.reject ? '거절' : '허용'} 선택지가 없습니다 — --option 으로 지정하세요:\n` +
        request.options.map((o) => `  ${o.optionId}  ${o.kind}  ${o.label}`).join('\n'),
    );
    return 1;
  }
  await context.connection.rpc('session.permission.respond', {
    sessionId: options.sessionId,
    requestId: request.requestId,
    outcome: { optionId },
  });
  if (context.json) {
    context.io.out(JSON.stringify({ requestId: request.requestId, optionId }));
  } else {
    context.io.out(`응답 완료: ${request.requestId} → ${optionId}`);
  }
  return 0;
}

/**
 * 선택지 id 는 하네스마다 다르지만 **종류(kind)는 중립 모델**이다 (FR-1.5).
 * 그래서 CLI 가 "허용/거절"만 받고 id 는 대신 찾아 준다 — 스크립트가 하네스별 문자열을
 * 알아야 한다면 자동화 표면이라 부를 수 없다. `once` 를 고르는 이유: `always` 는 이후
 * 요청까지 조용히 통과시키므로 명시 지정을 요구한다.
 */
function defaultOptionId(request: PermissionRequest, reject: boolean): string | undefined {
  const wanted = reject ? 'reject_once' : 'allow_once';
  return request.options.find((option) => option.kind === wanted)?.optionId;
}

// ── 스트리밍 ───────────────────────────────────────────────────────────────

interface Stream {
  /** 놓친 구간을 타임라인에서 메운다 — 구독 전에 일어난 일은 이벤트로 오지 않는다 */
  backfill(fromSeq: number): Promise<void>;
  /** turnId 지정 시 **그 턴**이 끝날 때까지, 미지정이면 어떤 턴이든 끝날 때까지 */
  untilTurnEnds(turnId: string | undefined): Promise<number>;
}

function startStream(context: SessionCommandContext, sessionId: string): Stream {
  const { io, json } = context;
  /** 이미 낸 seq — 백필과 라이브가 겹치는 구간을 한 번만 낸다 */
  let lastSeq = -1;
  /**
   * 끝난 턴의 결말. 단일 값이 아니라 turnId 별 기록인 이유: 구독은 프롬프트를 **보내기
   * 전에** 걸리므로 어느 턴을 기다릴지 아직 모르는 채로 종료 이벤트가 올 수 있다.
   * 단일 값이면 그때 남의 턴 결말이 자리를 차지한다.
   */
  const ended = new Map<string, 'completed' | 'failed' | 'canceled'>();
  /** 기다리는 턴. undefined = 아무 턴이나 */
  let awaitedTurn: string | undefined;
  let awaiting = false;
  let resolveEnd: (() => void) | undefined;

  const settledOutcome = (): 'completed' | 'failed' | 'canceled' | undefined =>
    awaitedTurn !== undefined ? ended.get(awaitedTurn) : [...ended.values()][0];
  /**
   * 백필이 도는 동안 라이브 이벤트를 잡아 둔다. 구독을 끊었다 다시 걸지 않는 이유는
   * 그 사이에 온 이벤트가 사라지기 때문 — 백필이 메우려던 갭을 백필이 다시 만든다.
   */
  let buffering = false;
  const buffered: SessionEvent[] = [];

  const emit = (event: SessionEvent): void => {
    if (event.sessionId !== sessionId) return;
    if (event.seq <= lastSeq) return; // 백필·라이브 중복
    lastSeq = event.seq;
    if (json) io.out(JSON.stringify(event));
    else renderHuman(event, io);

    if (
      event.type !== 'turn_completed' &&
      event.type !== 'turn_failed' &&
      event.type !== 'turn_canceled'
    ) {
      return;
    }
    ended.set(
      event.turnId,
      event.type === 'turn_completed'
        ? 'completed'
        : event.type === 'turn_failed'
          ? 'failed'
          : 'canceled',
    );
    // 특정 턴을 기다리는 중이면 다른 턴의 종료로 끝내지 않는다 — 위임·자동 후속 턴이
    // 도는 세션에서 남의 턴을 내 결과로 착각하게 된다
    if (awaiting && settledOutcome() !== undefined) resolveEnd?.();
  };

  context.connection.onEvent((event) => {
    if (buffering) buffered.push(event);
    else emit(event);
  });

  return {
    async backfill(fromSeq) {
      buffering = true;
      try {
        const { events } = await context.connection.rpc<{ events: SessionEvent[] }>(
          'session.timeline',
          { sessionId, fromSeq },
        );
        for (const event of events) emit(event);
      } finally {
        buffering = false;
        // 잡아 둔 것을 순서대로 흘린다 — seq 중복은 emit 이 거른다
        for (const event of buffered.splice(0)) emit(event);
      }
    },
    async untilTurnEnds(turnId) {
      awaitedTurn = turnId;
      awaiting = true;
      // 프롬프트 응답을 기다리는 사이 그 턴이 이미 끝났을 수 있다 — 바로 반환한다
      const already = settledOutcome();
      if (already !== undefined) return already === 'failed' ? 1 : 0;
      const finished = new Promise<'done'>((resolve) => {
        resolveEnd = () => resolve('done');
      });
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), WATCH_TIMEOUT_MS).unref?.();
      });
      const disconnected = new Promise<'closed'>((resolve) => {
        context.connection.onClose(() => resolve('closed'));
      });
      const result = await Promise.race([finished, timeout, disconnected]);
      if (result === 'timeout') {
        io.err('스트리밍 시간 초과');
        return 1;
      }
      if (result === 'closed') {
        io.err('데몬 연결이 끊겼습니다');
        return 1;
      }
      // 실패한 턴은 실패로 끝난다 — 스크립트가 종료 코드로 판단할 수 있어야 한다
      return settledOutcome() === 'failed' ? 1 : 0;
    },
  };
}

/** 사람이 읽는 출력 — stdout 은 답만, 나머지는 stderr (§출력 규약 ①) */
function renderHuman(event: SessionEvent, io: CliIo): void {
  switch (event.type) {
    case 'message_delta':
      io.write(event.delta);
      return;
    case 'tool_execution_started':
      io.err(`[툴] ${event.toolName ?? event.kind}${event.summary ? ` — ${event.summary}` : ''}`);
      return;
    case 'permission_requested':
      io.err(
        `[승인 대기] ${event.request.requestId}  ${event.request.kind}  ${event.request.summary}`,
      );
      io.err('  응답: custom-harness session approve <세션> --request ' + event.request.requestId);
      return;
    case 'turn_failed':
      io.err(`[턴 실패] ${event.error.message}`);
      return;
    case 'turn_canceled':
      io.err('[턴 중단됨]');
      return;
    case 'turn_completed':
      io.write('\n');
      if (event.usage?.totalTokens !== undefined) io.err(`[토큰] ${event.usage.totalTokens}`);
      return;
    default:
      return; // reasoning·usage·상태 변화는 기본 출력에서 뺀다 (--json 으로는 전부 나온다)
  }
}
