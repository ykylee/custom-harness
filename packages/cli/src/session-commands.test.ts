// CLI 세션 명령 (M7 WBS 7.5.1, FR-9.6) — 실제 데몬 + mock 하네스로 왕복시킨다.
//
// 단위로 잘라 fake 를 물리면 "연결을 하나만 열고 그 위에서 구독한다"는 이 명령들의
// 핵심 성질이 검증되지 않는다 — 그 부분이 틀리면 스트리밍이 조용히 빈손이 된다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter, startDaemon, type DaemonHandle } from '@custom-harness/daemon';
import { runCli } from './commands.js';
import type { CliIo } from './io.js';

interface CapturedIo extends CliIo {
  lines: string[];
  errors: string[];
  chunks: string[];
}

function captureIo(): CapturedIo {
  const lines: string[] = [];
  const errors: string[] = [];
  const chunks: string[] = [];
  return {
    lines,
    errors,
    chunks,
    out: (l) => lines.push(l),
    write: (c) => chunks.push(c),
    err: (l) => errors.push(l),
  };
}

describe('CLI 세션 명령 (M7 7.5.1, FR-9.6)', () => {
  const savedEnv = { ...process.env };
  let daemon: DaemonHandle;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-cli-session-'));
    cwd = await mkdtemp(join(tmpdir(), 'ch-cli-cwd-'));
    process.env.CUSTOM_HARNESS_HOME = home;
    daemon = await startDaemon({
      root: home,
      version: '0.1.0',
      managedBy: 'test',
      adapters: [new MockAdapter()],
    });
  });

  afterEach(async () => {
    await daemon.stop();
    process.env = { ...savedEnv };
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const newSession = async (): Promise<string> => {
    const io = captureIo();
    expect(await runCli(['session', 'new', '--harness', 'mock', '--cwd', cwd], io)).toBe(0);
    return io.lines[0] as string;
  };

  it('세션을 만들고 id 만 낸다 — 파이프로 바로 넘길 수 있게', async () => {
    const sessionId = await newSession();
    expect(sessionId).toMatch(/\S/);
    expect(sessionId).not.toContain(' ');
  });

  it('workspaceId 없이 cwd 만으로 만들어진다 — 스크립트가 워크스페이스를 먼저 만들 필요가 없다', async () => {
    const sessionId = await newSession();
    const sessions = await daemon.manager.listSessions();
    const created = sessions.find((s) => s.sessionId === sessionId);
    expect(created?.workspaceId).toBeDefined(); // 데몬이 cwd 로 열어 귀속시킨다
  });

  it('--harness 없이는 사용법 오류다', async () => {
    const io = captureIo();
    expect(await runCli(['session', 'new'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('--harness');
  });

  it('목록은 기본적으로 닫힌 세션을 숨긴다', async () => {
    const sessionId = await newSession();
    expect(await runCli(['session', 'close', sessionId], captureIo())).toBe(0);

    const hidden = captureIo();
    await runCli(['session', 'list'], hidden);
    expect(hidden.lines.join('\n')).not.toContain(sessionId);

    const shown = captureIo();
    await runCli(['session', 'list', '--all'], shown);
    expect(shown.lines.join('\n')).toContain(sessionId);
  });

  it('--json 목록은 한 줄짜리 기계 판독 출력이다', async () => {
    const sessionId = await newSession();
    const io = captureIo();
    expect(await runCli(['session', 'list', '--json'], io)).toBe(0);
    expect(io.lines).toHaveLength(1);
    const parsed = JSON.parse(io.lines[0] as string) as { sessions: { sessionId: string }[] };
    expect(parsed.sessions.map((s) => s.sessionId)).toContain(sessionId);
  });

  it('--wait 없는 프롬프트는 turnId 만 내고 끝난다', async () => {
    const sessionId = await newSession();
    const io = captureIo();
    expect(await runCli(['session', 'prompt', sessionId, '작업', '해줘'], io)).toBe(0);
    expect(io.lines[0]).toMatch(/\S/);
    expect(io.chunks).toEqual([]); // 스트리밍은 --wait 일 때만
  });

  it('--wait 는 턴이 끝날 때까지 답을 stdout 으로 흘린다', async () => {
    const sessionId = await newSession();
    const io = captureIo();
    expect(await runCli(['session', 'prompt', sessionId, '작업', '해줘', '--wait'], io)).toBe(0);
    // mock 어댑터는 '작업을 ' + '시작합니다' 두 델타로 흘린다 — 이어 붙어야 한다
    expect(io.chunks.join('')).toContain('작업을 시작합니다');
  });

  it('과정은 stderr 로 간다 — stdout 은 답만 담는다', async () => {
    const sessionId = await newSession();
    const io = captureIo();
    await runCli(['session', 'prompt', sessionId, '툴', '써줘', '--wait'], io);
    // `… --wait > answer.txt` 가 기대대로 동작해야 한다
    expect(io.chunks.join('')).not.toContain('[툴]');
    expect(io.chunks.join('')).not.toContain('[토큰]');
  });

  it('--json --wait 는 원시 이벤트 JSONL 이다 — CLI 가 스키마를 새로 만들지 않는다', async () => {
    const sessionId = await newSession();
    const io = captureIo();
    expect(
      await runCli(['session', 'prompt', sessionId, '작업', '해줘', '--wait', '--json'], io),
    ).toBe(0);
    const events = io.lines.map((line) => JSON.parse(line) as { type: string; seq: number });
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => typeof e.seq === 'number')).toBe(true);
    expect(events.some((e) => e.type === 'turn_completed')).toBe(true);
    // seq 는 단조 증가 — 중복 없이 한 번씩만 나온다
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
  });

  it('watch 가 백필과 라이브를 이어 붙이되 중복을 내지 않는다', async () => {
    const sessionId = await newSession();
    await runCli(['session', 'prompt', sessionId, '먼저', '한', '턴', '--wait'], captureIo());

    // 이미 끝난 이력을 fromSeq 0 으로 되짚으면서, 그 뒤 라이브 턴까지 본다
    const io = captureIo();
    const watching = runCli(['session', 'watch', sessionId, '--from-seq', '0', '--json'], io);
    await daemon.manager.prompt(sessionId, '두 번째 턴');
    expect(await watching).toBe(0);

    const seqs = io.lines.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs.length).toBeGreaterThan(2);
    expect(new Set(seqs).size).toBe(seqs.length); // 백필·라이브 겹침 구간이 두 번 나오면 안 된다
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('중단·종료는 멱등이다 — 스크립트가 상태를 먼저 확인할 필요가 없다', async () => {
    const sessionId = await newSession();
    expect(await runCli(['session', 'interrupt', sessionId], captureIo())).toBe(0);
    expect(await runCli(['session', 'interrupt', sessionId], captureIo())).toBe(0);
    expect(await runCli(['session', 'close', sessionId], captureIo())).toBe(0);
  });

  it('승인 대기가 없으면 그렇게 말한다', async () => {
    const sessionId = await newSession();
    const io = captureIo();
    expect(await runCli(['session', 'approve', sessionId], io)).toBe(1);
    expect(io.errors.join('\n')).toContain('승인 대기 중인 요청이 없습니다');
  });

  it('없는 세션은 오류다', async () => {
    const io = captureIo();
    expect(await runCli(['session', 'approve', 'no-such-session'], io)).toBe(1);
    expect(io.errors.join('\n')).toContain('세션 없음');
  });

  it('알 수 없는 하위명령은 사용법과 종료 코드 2', async () => {
    const io = captureIo();
    expect(await runCli(['session', 'bogus'], io)).toBe(2);
    expect(io.errors.join('\n')).toContain('세션 (FR-9.6');
  });

  it('데몬이 없으면 기동 안내를 낸다', async () => {
    await daemon.stop();
    const io = captureIo();
    expect(await runCli(['session', 'list'], io)).toBe(1);
    expect(io.errors.join('\n')).toContain('daemon start');
  });
});
