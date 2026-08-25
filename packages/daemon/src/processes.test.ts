import { mkdtemp, readFile } from 'node:fs/promises';
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

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
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
  });

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
});
