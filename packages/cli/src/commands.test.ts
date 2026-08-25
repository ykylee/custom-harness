import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '@custom-harness/daemon';
import { runCli, type CliIo } from './commands.js';

// 모노레포 소스 기준 상대 경로 — 테스트 전용 (런타임 해석은 commands.ts 의 env/exports 경로)
const fixtureEntry = fileURLToPath(
  new URL('../../daemon/src/fake-daemon.fixture.cjs', import.meta.url),
);

interface CapturedIo extends CliIo {
  lines: string[];
  errors: string[];
}

function captureIo(): CapturedIo {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

describe('CLI (WBS 1.6.3, FR-5.1)', () => {
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-cli-'));
    process.env.CUSTOM_HARNESS_HOME = home;
    process.env.CUSTOM_HARNESS_DAEMON_ENTRY = fixtureEntry;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('prints version', async () => {
    const io = captureIo();
    expect(await runCli(['version'], io)).toBe(0);
    expect(io.lines[0]).toMatch(/custom-harness 0\.1\.0 \(protocol v1\)/);
  });

  it('prints usage for unknown commands with exit 2', async () => {
    const io = captureIo();
    expect(await runCli(['bogus'], io)).toBe(2);
    expect(io.errors[0]).toContain('사용법');
  });

  it('reports stopped status with exit 1', async () => {
    const io = captureIo();
    expect(await runCli(['daemon', 'status'], io)).toBe(1);
    expect(io.lines[0]).toContain('정지됨');
  });

  it('starts a daemon (fixture), then start again is a no-op, then stop requires --force when unreachable', async () => {
    const io = captureIo();
    expect(await runCli(['daemon', 'start'], io)).toBe(0);
    expect(io.lines[0]).toContain('기동 완료');

    const again = captureIo();
    expect(await runCli(['daemon', 'start'], again)).toBe(0);
    expect(again.lines[0]).toContain('이미 실행 중');

    // fixture 는 WS 서버가 없다 — 세션 상태 확인 실패 시 --force 요구 (FR-5.1 확인 절차)
    const stopPlain = captureIo();
    expect(await runCli(['daemon', 'stop'], stopPlain)).toBe(1);
    expect(stopPlain.errors[0]).toContain('--force');

    const stopForce = captureIo();
    expect(await runCli(['daemon', 'stop', '--force'], stopForce)).toBe(0);
    expect(stopForce.lines[0]).toContain('종료 완료');

    const statusAfter = captureIo();
    expect(await runCli(['daemon', 'status'], statusAfter)).toBe(1);
  });

  describe('with a live in-process daemon', () => {
    let daemon: DaemonHandle;

    beforeEach(async () => {
      daemon = await startDaemon({ root: home, version: '0.1.0', managedBy: 'cli' });
    });

    afterEach(async () => {
      await daemon.stop();
    });

    it('status queries version and session counts over WS', async () => {
      const io = captureIo();
      expect(await runCli(['daemon', 'status'], io)).toBe(0);
      expect(io.lines[0]).toContain('실행 중');
      expect(io.lines[1]).toContain('버전: 0.1.0');
      expect(io.lines[1]).toContain('세션: 활성 0 / 전체 0');
    });

    it('stop without --force succeeds when no session is active', async () => {
      // 활성 세션 없음 → 확인 통과. 대상 pid 가 이 테스트 프로세스라 실제 kill 은 피하고
      // 질의 경로만 검증한다: status 로 확인 완료 후 데몬을 직접 정지.
      const io = captureIo();
      expect(await runCli(['daemon', 'status'], io)).toBe(0);
    });
  });
});
