#!/usr/bin/env node
// M7 수용 검증 (오케스트레이션 · 자동화) — 마일스톤 **완료 기준** 3개를 실제로 돌려서 확인한다.
//
//   기준 1. 주의 상태가 데몬 정본으로 동작한다        (WP 7.1, FR-9.1)
//   기준 2. 세션이 세션을 위임·회수한다                (WP 7.3, FR-9.3)
//   기준 3. CLI 로 세션 조작을 자동화할 수 있다        (WP 7.5, FR-9.6)
//
// 부가로 같은 마일스톤의 WP 7.4(검색)·7.6(제목)도 함께 본다.
//
// **범위**: 여기서는 데몬 계약과 CLI 표면을 mock 하네스로 검증한다. 하네스별 실물 왕복
// (역방향 툴 MCP 노출·3하네스 위임 루프)은 그 항목들에서 실물로 검증됐고, 이 스크립트가
// 그것을 대신하지 않는다 — 이건 **회귀용 재실행 가능 수용 경로**다.
//
// 사용: node scripts/m7-acceptance.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAdapter, startDaemon } from '../packages/daemon/dist/index.js';
import { runCli } from '../packages/cli/dist/commands.js';
import { TOOL_LABEL_PARENT_SESSION } from '../packages/protocol/dist/index.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const captureIo = () => {
  const io = {
    lines: [],
    errors: [],
    chunks: [],
    out: (l) => io.lines.push(l),
    write: (c) => io.chunks.push(c),
    err: (l) => io.errors.push(l),
  };
  return io;
};

const root = await mkdtemp(join(tmpdir(), 'ch-m7-'));
const cwd = await mkdtemp(join(tmpdir(), 'ch-m7-cwd-'));
process.env.CUSTOM_HARNESS_HOME = root;
// `pendingOnResume` 은 어댑터가 재개 시 미응답 승인을 되살리는 경로(FR-1.5)를 태우는
// 주입 지점이다 — 실물 하네스는 자기 세션 파일에서 복원한다.
const boot = (pendingOnResume = []) =>
  startDaemon({
    root,
    version: '0.1.0-m7',
    managedBy: 'acceptance',
    adapters: [new MockAdapter({ pendingOnResume })],
  });
let daemon = await boot();

// ── 기준 1. 주의 상태가 데몬 정본으로 동작한다 (FR-9.1) ────────────────────
console.log('\n── 기준 1: 주의 상태 (WP 7.1, FR-9.1) ──');
{
  const session = await daemon.manager.createSession({ harness: 'mock', cwd });
  const id = session.sessionId;
  const summary = async () => (await daemon.manager.listSessions()).find((s) => s.sessionId === id);

  await daemon.manager.prompt(id, '[approval] 위험한 명령 실행');
  check(
    '승인 대기가 주의 상태로 올라온다',
    await waitFor(async () => {
      const s = await summary();
      return s?.requiresAttention === true && s.attentionReason === 'permission';
    }),
  );

  // 화면을 본 것이 응답은 아니다 — ack 로 승인 대기가 사라지면 안 된다
  daemon.manager.acknowledgeAttention(id);
  const afterAck = await summary();
  check('확인(ack)이 승인 대기를 지우지 않는다', afterAck?.requiresAttention === true);

  // 데몬이 재시작해도 클라이언트가 없던 동안의 상태를 그대로 되찾는다
  const carried = afterAck?.pendingPermissions ?? [];
  await daemon.stop();
  daemon = await boot(carried);
  const restored = (await daemon.manager.listSessions()).find((s) => s.sessionId === id);
  check(
    '재기동 후에도 주의 상태가 남는다',
    restored?.requiresAttention === true && restored.attentionReason === 'permission',
    `reason=${restored?.attentionReason}`,
  );

  // 미응답 승인은 **재개**에서 복원된다 (FR-1.3) — 닫힌 세션에는 응답할 런타임이 없다
  await daemon.manager.resumeSession(id);
  const resumed = await summary();
  check(
    '재개하면 미응답 승인이 되살아난다',
    (resumed?.pendingPermissions?.length ?? 0) > 0,
    `pending=${resumed?.pendingPermissions?.length}`,
  );

  const pending = resumed?.pendingPermissions?.[0];
  if (pending !== undefined) {
    await daemon.manager.respondPermission(id, pending.requestId, { optionId: 'allow' });
    check(
      '응답하면 주의 상태가 풀린다',
      await waitFor(async () => (await summary())?.requiresAttention === false),
    );
  } else {
    check('응답하면 주의 상태가 풀린다', false, '복원된 승인 요청 없음');
  }
}

// ── 기준 2. 세션이 세션을 위임·회수한다 (FR-9.3) ───────────────────────────
console.log('\n── 기준 2: 위임·회수 (WP 7.3, FR-9.3) ──');
{
  const parent = await daemon.manager.createSession({ harness: 'mock', cwd });
  const child = await daemon.manager.createSession({
    harness: 'mock',
    cwd,
    labels: { [TOOL_LABEL_PARENT_SESSION]: parent.sessionId, 'ch.toolDepth': '1' },
  });

  // 위임: 자식에게 일을 시키고 → 기다리고 → 결과를 회수한다
  await daemon.manager.prompt(child.sessionId, '자식이 할 일');
  const waited = await daemon.manager.waitForTurn(child.sessionId, { timeoutMs: 5000 });
  check('자식 턴 완료를 기다린다', waited.timedOut === false && waited.activeTurn === false);

  const result = await daemon.manager.lastTurnResult(child.sessionId);
  check(
    '마지막 턴 결과만 회수한다',
    result.pending === false && result.text.includes('작업을 시작합니다'),
    JSON.stringify(result.text.slice(0, 30)),
  );

  const usage = await daemon.manager.usageTree(parent.sessionId);
  check('부모가 자손을 자식으로 인식한다', usage.childCount === 1);
  check(
    '비용이 자기 것과 가지 전체로 나뉘어 합산된다',
    (usage.subtree.totalTokens ?? 0) >= (usage.own.totalTokens ?? 0),
    `own=${usage.own.totalTokens} subtree=${usage.subtree.totalTokens}`,
  );
}

// ── 기준 3. CLI 로 세션 조작을 자동화할 수 있다 (FR-9.6) ───────────────────
console.log('\n── 기준 3: CLI 자동화 (WP 7.5, FR-9.6) ──');
{
  const io = captureIo();
  let code = await runCli(['session', 'new', '--harness', 'mock', '--cwd', cwd], io);
  const id = io.lines[0];
  check('session new', code === 0 && !!id, id);

  const prompted = captureIo();
  code = await runCli(['session', 'prompt', id, '자동화', '확인', '--wait'], prompted);
  check(
    'prompt --wait 가 답을 stdout 으로 흘린다',
    code === 0 && prompted.chunks.join('').includes('작업을 시작합니다'),
  );
  check(
    '과정은 stdout 을 더럽히지 않는다',
    !prompted.chunks.join('').includes('[토큰]') && !prompted.chunks.join('').includes('[툴]'),
  );

  const streamed = captureIo();
  code = await runCli(['session', 'prompt', id, '두', '번째', '--wait', '--json'], streamed);
  const events = streamed.lines.map((l) => JSON.parse(l));
  check(
    '연달아 프롬프트 + 원시 이벤트 JSONL',
    code === 0 && events.some((e) => e.type === 'turn_completed'),
  );

  const listed = captureIo();
  code = await runCli(['session', 'list', '--json'], listed);
  check(
    'session list --json 은 한 줄',
    code === 0 && listed.lines.length === 1 && JSON.parse(listed.lines[0]).sessions.length > 0,
  );

  const ws = captureIo();
  code = await runCli(['workspace', 'new', '--root', cwd, '--name', '수용'], ws);
  check('workspace new --root', code === 0 && !!ws.lines[0], ws.lines[0] ?? ws.errors.join('|'));

  const failed = captureIo();
  code = await runCli(['session', 'prompt', 'no-such', '안녕', '--json'], failed);
  check(
    '실패는 stderr 봉투로, stdout 은 비어 있다',
    code === 1 &&
      failed.lines.length === 0 &&
      JSON.parse(failed.errors[0]).error.code === 'not_found',
  );

  await runCli(['session', 'close', id], captureIo());
}

// ── 부가: 검색(WP 7.4) · 제목(WP 7.6) ──────────────────────────────────────
console.log('\n── 부가: 검색·제목 (WP 7.4·7.6) ──');
{
  const session = await daemon.manager.createSession({ harness: 'mock', cwd });
  await daemon.manager.prompt(session.sessionId, '폐쇄망 인덱스 전략을 확정한다');

  check(
    '타임라인 전문 검색이 한국어 부분일치를 찾는다',
    await waitFor(() => daemon.searchIndex.search({ query: '전략' }).length > 0),
  );
  check(
    '델타 경계를 넘는 문자열도 잡는다',
    await waitFor(() => daemon.searchIndex.search({ query: '작업을 시작합니다' }).length > 0),
  );

  const titled = await waitFor(async () => {
    const s = (await daemon.manager.listSessions()).find((x) => x.sessionId === session.sessionId);
    return s?.title !== undefined;
  });
  const s = (await daemon.manager.listSessions()).find((x) => x.sessionId === session.sessionId);
  check('첫 프롬프트로 제목이 붙는다 (비 LLM 기본)', titled, s?.title);
}

await daemon.stop();
await rm(root, { recursive: true, force: true, maxRetries: 5 });
await rm(cwd, { recursive: true, force: true, maxRetries: 5 });

console.log(
  failures === 0
    ? '\nM7 ACCEPTANCE PASS — 완료 기준 3개 + 부가 2개 전부 충족'
    : `\nM7 ACCEPTANCE FAIL — ${failures}건 실패`,
);
process.exit(failures === 0 ? 0 : 1);
