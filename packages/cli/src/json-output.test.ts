// 기계 판독 출력 일관화 (M7 WBS 7.5.3, FR-9.6).
//
// FR-9.6 은 "**모든** 명령에 JSON 옵션"을 요구한다. 명령마다 따로 붙이면 어떤 명령은 되고
// 어떤 명령은 안 되는 상태가 조용히 생기므로, 규약을 한 곳에서 확인한다:
//   ① 성공 → stdout 에 JSON **한 줄** (스트리밍만 여러 줄 JSONL)
//   ② 실패 → **stderr** 에 {"error":{code,message}}, stdout 은 비어 있다
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

/** stdout 한 줄을 JSON 으로 — 규약 ① 을 이 헬퍼가 강제한다 */
function singleJson(io: CapturedIo): Record<string, unknown> {
  expect(io.lines).toHaveLength(1);
  return JSON.parse(io.lines[0] as string) as Record<string, unknown>;
}

describe('CLI --json 일관화 (M7 7.5.3, FR-9.6)', () => {
  const savedEnv = { ...process.env };
  let daemon: DaemonHandle;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-cli-json-'));
    cwd = await mkdtemp(join(tmpdir(), 'ch-cli-json-cwd-'));
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
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
  });

  it('version', async () => {
    const io = captureIo();
    expect(await runCli(['version', '--json'], io)).toBe(0);
    expect(singleJson(io)).toMatchObject({ version: '0.1.0', protocolVersion: 1 });
  });

  it('daemon status — 실행 중', async () => {
    const io = captureIo();
    expect(await runCli(['daemon', 'status', '--json'], io)).toBe(0);
    const parsed = singleJson(io);
    expect(parsed).toMatchObject({ running: true });
    expect((parsed.sessions as { total: number }).total).toBe(0);
  });

  it('daemon status — 정지됨은 오류가 아니라 상태다', async () => {
    await daemon.stop();
    const io = captureIo();
    // 종료 코드로는 구분하되 error 봉투에 싣지 않는다 — 정지는 정상적인 상태다
    expect(await runCli(['daemon', 'status', '--json'], io)).toBe(1);
    expect(singleJson(io)).toEqual({ running: false });
    expect(io.errors).toEqual([]);
  });

  it('doctor — 사람이 읽는 줄을 파싱하게 두지 않는다', async () => {
    const io = captureIo();
    await runCli(['doctor', '--json'], io);
    const parsed = singleJson(io);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.summary).toMatchObject({ pass: expect.any(Number), fail: expect.any(Number) });
  });

  it('logs 목록', async () => {
    const io = captureIo();
    expect(await runCli(['logs', '--json'], io)).toBe(0);
    const parsed = singleJson(io);
    expect(typeof parsed.logsDir).toBe('string');
    expect(Array.isArray(parsed.files)).toBe(true);
  });

  it('session list · workspace list', async () => {
    const sessionIo = captureIo();
    expect(await runCli(['session', 'list', '--json'], sessionIo)).toBe(0);
    expect(Array.isArray(singleJson(sessionIo).sessions)).toBe(true);

    const workspaceIo = captureIo();
    expect(await runCli(['workspace', 'list', '--json'], workspaceIo)).toBe(0);
    expect(Array.isArray(singleJson(workspaceIo).workspaces)).toBe(true);
  });

  it('실패는 stderr 봉투로, stdout 은 비어 있다', async () => {
    const io = captureIo();
    expect(await runCli(['session', 'approve', 'no-such-session', '--json'], io)).toBe(1);
    // stdout 이 payload 전용이라야 `cmd --json > out.json` 이 성공했을 때만 내용을 갖는다
    expect(io.lines).toEqual([]);
    const parsed = JSON.parse(io.errors[0] as string) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe('not_found');
    expect(parsed.error.message).toContain('no-such-session');
  });

  it('데몬 RPC 오류의 코드가 봉투에 실린다', async () => {
    const io = captureIo();
    // 없는 세션에 프롬프트 — 데몬이 not_found 로 거절한다
    expect(await runCli(['session', 'prompt', 'no-such', '안녕', '--json'], io)).toBe(1);
    expect(io.lines).toEqual([]);
    const parsed = JSON.parse(io.errors[0] as string) as { error: { code: string } };
    expect(parsed.error.code).toBe('not_found');
  });

  it('사용법 오류도 봉투로 나간다', async () => {
    const io = captureIo();
    expect(await runCli(['workspace', 'new', '--json'], io)).toBe(2);
    const parsed = JSON.parse(io.errors[0] as string) as { error: { code: string } };
    expect(parsed.error.code).toBe('bad_request');
  });

  it('스트리밍만 여러 줄이다 — 나머지는 한 줄 규약을 지킨다', async () => {
    const created = captureIo();
    await runCli(['session', 'new', '--harness', 'mock', '--cwd', cwd], created);
    const streamed = captureIo();
    expect(
      await runCli(
        ['session', 'prompt', created.lines[0] as string, '안녕', '--wait', '--json'],
        streamed,
      ),
    ).toBe(0);
    expect(streamed.lines.length).toBeGreaterThan(1);
    for (const line of streamed.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
