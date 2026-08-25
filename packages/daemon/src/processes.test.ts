import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProcessSupervisor } from './processes.js';

const node = process.execPath;

describe('ProcessSupervisor', () => {
  it('rejects a non-absolute command (FR-1.1.1 PATH 탐색 금지)', async () => {
    const supervisor = new ProcessSupervisor();
    await expect(supervisor.spawn({ command: 'node', args: [] })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects a missing executable', async () => {
    const supervisor = new ProcessSupervisor();
    await expect(
      supervisor.spawn({ command: '/nonexistent/harness-bin', args: [] }),
    ).rejects.toMatchObject({ code: 'internal' });
  });

  it('passes the env overlay to the child', async () => {
    const supervisor = new ProcessSupervisor();
    const proc = await supervisor.spawn({
      command: node,
      args: ['-e', 'process.stdout.write(process.env.CH_TEST ?? "")'],
      env: { CH_TEST: 'overlay-ok' },
    });
    let out = '';
    proc.child.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
    await proc.exited;
    expect(out).toBe('overlay-ok');
  });

  it('detects an abnormal exit as expected=false (FR-1.1.3)', async () => {
    const supervisor = new ProcessSupervisor();
    const proc = await supervisor.spawn({ command: node, args: ['-e', 'process.exit(3)'] });
    expect(await proc.exited).toMatchObject({ code: 3, expected: false });
  });

  it('terminates gracefully with SIGTERM as expected=true (FR-1.1.2)', async () => {
    const supervisor = new ProcessSupervisor();
    const proc = await supervisor.spawn({
      command: node,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    expect(await proc.terminate()).toMatchObject({ signal: 'SIGTERM', expected: true });
  });

  // Windows 는 SIGTERM 에뮬레이션이 즉시 강제 종료라 "무시" 시나리오가 성립하지 않음
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when SIGTERM is ignored',
    async () => {
      const supervisor = new ProcessSupervisor({ gracePeriodMs: 150 });
      const proc = await supervisor.spawn({
        command: node,
        args: [
          '-e',
          'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
        ],
      });
      // SIGTERM 핸들러가 설치된 뒤에 종료 — 준비 신호 대기
      await new Promise<void>((resolve) => proc.child.stdout?.once('data', () => resolve()));
      expect(await proc.terminate()).toMatchObject({ signal: 'SIGKILL', expected: true });
    },
  );

  it('records and clears the PID ledger (daemon-design §3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proc-'));
    const ledgerPath = join(dir, 'processes.json');
    const supervisor = new ProcessSupervisor({ ledgerPath, bundleVersion: '0.1.0' });
    const proc = await supervisor.spawn({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 200)'],
      sessionId: 's-1',
      harness: 'pi',
    });

    const entries = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(entries).toMatchObject([
      { pid: proc.pid, sessionId: 's-1', harness: 'pi', bundleVersion: '0.1.0' },
    ]);

    await proc.terminate();
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual([]);
    });
  });

  it('writes harness stderr to per-session log files (WBS 2.6.2, FR-5.3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proc-'));
    const logDir = join(dir, 'logs');
    const supervisor = new ProcessSupervisor({ harnessLogDir: logDir });
    const proc = await supervisor.spawn({
      command: node,
      args: ['-e', 'process.stderr.write("하네스 오류 로그\\n")'],
      sessionId: 'sess-log-1',
      harness: 'pi',
    });
    await proc.exited;
    await vi.waitFor(async () => {
      const content = await readFile(join(logDir, 'pi-sess-log-1.log'), 'utf8');
      expect(content).toContain('하네스 오류 로그');
    });
  });

  it('reaps stale processes from a previous run (FR-1.1.4, WBS 2.3.2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proc-'));
    const ledgerPath = join(dir, 'processes.json');
    // 이전 데몬 실행 흉내: 원장에 남았지만 이번 supervisor 가 spawn 하지 않은 프로세스
    const orphan = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => orphan.once('spawn', resolve));
    await writeFile(
      ledgerPath,
      JSON.stringify([
        { pid: orphan.pid, harness: 'pi', spawnedAt: 'x', daemonPid: 999_999_999 },
        { pid: 999_999_998, harness: 'omp', spawnedAt: 'x', daemonPid: 999_999_999 }, // 죽은 항목
      ]),
    );

    const supervisor = new ProcessSupervisor({ ledgerPath, gracePeriodMs: 500 });
    const result = await supervisor.reapStale();
    expect(result.terminated).toEqual([orphan.pid]);
    expect(result.removed).toEqual([999_999_998]);
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual([]);
    // 프로세스가 실제로 죽었는지 확인 (수용 기준: stale 하네스 0개)
    await vi.waitFor(() => {
      expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
    });
  });

  it('keeps entries owned by the current daemon during reap (FR-5.2 소유 구분)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-proc-'));
    const ledgerPath = join(dir, 'processes.json');
    const supervisor = new ProcessSupervisor({ ledgerPath, gracePeriodMs: 500 });
    const proc = await supervisor.spawn({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 3000)'],
      harness: 'pi',
    });
    // 이번 실행(daemonPid = 현재 pid) 항목은 회수 대상이 아니다
    const result = await supervisor.reapStale();
    expect(result.terminated).toEqual([]);
    expect(result.removed).toEqual([]);
    const entries = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(entries).toMatchObject([{ pid: proc.pid, daemonPid: process.pid }]);
    await proc.terminate();
  });
});
