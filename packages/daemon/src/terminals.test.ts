// 데몬 소유 터미널 (WBS 6.3) — 실제 pty 로 검증한다(모킹하면 이 계층의 의미가 없다).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalManager, defaultShell } from './terminals.js';

const managers: TerminalManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

function makeManager(): TerminalManager {
  const manager = new TerminalManager();
  managers.push(manager);
  return manager;
}

/** 출력에서 기대 문자열이 나올 때까지 기다린다 (pty 는 프롬프트 등 잡음을 섞는다) */
function waitFor(
  manager: TerminalManager,
  terminalId: string,
  needle: string,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const attached = manager.attach(terminalId, (chunk) => {
      seen += Buffer.from(chunk).toString('utf8');
      if (seen.includes(needle)) {
        clearTimeout(timer);
        attached?.detach();
        resolve(seen);
      }
    });
    let seen = Buffer.from(attached?.scrollback ?? new Uint8Array()).toString('utf8');
    if (seen.includes(needle)) {
      attached?.detach();
      resolve(seen);
      return;
    }
    const timer = setTimeout(() => {
      attached?.detach();
      reject(new Error(`타임아웃 — 관측된 출력: ${seen.slice(-200)}`));
    }, timeoutMs);
  });
}

describe('TerminalManager (WBS 6.3.1)', () => {
  it('워크스페이스 cwd 에서 셸을 띄우고 입력·출력이 오간다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    await writeFile(join(cwd, 'marker.txt'), 'x');
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });

    expect(terminal.id).toMatch(/^trm_/);
    expect(terminal.workspaceId).toBe('wsp_1');

    manager.write(terminal.id, new TextEncoder().encode('ls\n'));
    const output = await waitFor(manager, terminal.id, 'marker.txt');
    expect(output).toContain('marker.txt');
  });

  it('진짜 tty 다 — 프로그램이 터미널로 인식한다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });

    // 마커를 셸에서 이어붙인다 — 되울린 명령줄이 검사를 통과시키지 않게
    manager.write(terminal.id, new TextEncoder().encode('tty > /dev/null && echo "IS""_TTY"\n'));
    expect(await waitFor(manager, terminal.id, 'IS_TTY')).toContain('IS_TTY');
  });

  it('attach 는 스크롤백과 구독을 한 번에 준다 — 사이에 출력이 새지 않는다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });

    manager.write(terminal.id, new TextEncoder().encode('echo "FIR""ST_MARK"\n'));
    await waitFor(manager, terminal.id, 'FIRST_MARK');

    // 나중에 붙은 클라이언트도 이전 출력을 본다
    const late = manager.attach(terminal.id, () => undefined);
    expect(Buffer.from(late!.scrollback).toString('utf8')).toContain('FIRST_MARK');
    expect(late!.truncated).toBe(false);
    late!.detach();
  });

  it('read 는 구독하지 않고 스크롤백만 준다 (WBS 7.2.3)', async () => {
    // 역방향 툴은 화면을 그리지 않는다 — attach 로 대신하면 슬롯을 먹고 detach 를 잊으면 샌다
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });

    manager.write(terminal.id, new TextEncoder().encode('echo "READ""_MARK"\n'));
    await waitFor(manager, terminal.id, 'READ_MARK');

    const read = manager.read(terminal.id);
    expect(Buffer.from(read!.scrollback).toString('utf8')).toContain('READ_MARK');
    expect(read!.truncated).toBe(false);

    // 구독자가 늘지 않았다는 증거 — 이후 출력이 read 결과에 영향을 주지 않는다(스냅샷이다)
    const before = read!.scrollback.length;
    manager.write(terminal.id, new TextEncoder().encode('echo "SECOND""_MARK"\n'));
    await waitFor(manager, terminal.id, 'SECOND_MARK');
    expect(read!.scrollback.length).toBe(before);
  });

  it('read 는 bytes 로 끝에서 자르고 truncated 를 알린다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });

    manager.write(terminal.id, new TextEncoder().encode('echo "TAIL""_MARK"\n'));
    await waitFor(manager, terminal.id, 'TAIL_MARK');

    const tail = manager.read(terminal.id, 12);
    expect(tail!.scrollback.length).toBe(12);
    expect(tail!.truncated).toBe(true);
  });

  it('없는 터미널 read 는 undefined 다', () => {
    expect(makeManager().read('nope')).toBeUndefined();
  });

  it('여러 클라이언트가 같은 터미널을 함께 본다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });

    const seenA: string[] = [];
    const seenB: string[] = [];
    const a = manager.attach(terminal.id, (c) => seenA.push(Buffer.from(c).toString('utf8')));
    const b = manager.attach(terminal.id, (c) => seenB.push(Buffer.from(c).toString('utf8')));

    manager.write(terminal.id, new TextEncoder().encode('echo "SHA""RED_MARK"\n'));
    await waitFor(manager, terminal.id, 'SHARED_MARK');
    expect(seenA.join('')).toContain('SHARED_MARK');
    expect(seenB.join('')).toContain('SHARED_MARK');
    a!.detach();
    b!.detach();
  });

  it('종료를 감지해 레코드에 남기고 이벤트를 낸다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const exited = new Promise<{ reason: string; exitCode: number | undefined }>((resolve) => {
      manager.onChange((reason, terminal) => {
        if (reason === 'exited') resolve({ reason, exitCode: terminal.exitCode });
      });
    });
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });
    manager.write(terminal.id, new TextEncoder().encode('exit 7\n'));

    expect((await exited).exitCode).toBe(7);
    expect(manager.find(terminal.id)?.exitedAt).toBeDefined();
  });

  it('kill 은 pty 를 끝내고 목록에는 남긴다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });
    manager.kill(terminal.id);

    expect(manager.find(terminal.id)?.exitedAt).toBeDefined();
    expect(manager.list('wsp_1')).toHaveLength(1);
    // 죽은 터미널에 써도 던지지 않는다
    expect(() => manager.write(terminal.id, new TextEncoder().encode('x'))).not.toThrow();
  });

  it('워크스페이스로 목록을 거른다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });
    manager.create({ workspaceId: 'wsp_2', cwd, cols: 80, rows: 24 });

    expect(manager.list('wsp_1')).toHaveLength(1);
    expect(manager.list()).toHaveLength(2);
  });

  it('resize 는 마지막 요청이 이긴다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const terminal = manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24 });
    manager.resize(terminal.id, 120, 40);
    expect(manager.find(terminal.id)).toMatchObject({ cols: 120, rows: 40 });
  });

  it('없는 터미널 조작은 조용히 무시한다', () => {
    const manager = makeManager();
    expect(manager.attach('trm_none', () => undefined)).toBeUndefined();
    expect(() => manager.resize('trm_none', 10, 10)).not.toThrow();
    expect(() => manager.kill('trm_none')).not.toThrow();
  });

  it('기본 셸은 플랫폼 규약을 따른다 (E-3)', () => {
    expect(defaultShell({ SHELL: '/bin/zsh' })).toBe(
      process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh',
    );
  });
});

describe('감독 터미널 (WBS 6.6)', () => {
  it('명령을 실행하고 출력을 그대로 보여준 뒤 종료한다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const exited = new Promise<number | undefined>((resolve) => {
      manager.onChange((reason, terminal) => {
        if (reason === 'exited') resolve(terminal.exitCode);
      });
    });
    const terminal = manager.create({
      workspaceId: 'wsp_1',
      cwd,
      cols: 80,
      rows: 24,
      command: 'echo "SUPERVISED""_OK"',
      label: 'test',
    });

    expect(terminal.label).toBe('test');
    expect(await waitFor(manager, terminal.id, 'SUPERVISED_OK')).toContain('SUPERVISED_OK');
    expect(await exited).toBe(0);
  });

  it('실패한 명령의 종료 코드를 남긴다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ch-term-'));
    const manager = makeManager();
    const exited = new Promise<number | undefined>((resolve) => {
      manager.onChange((reason, terminal) => {
        if (reason === 'exited') resolve(terminal.exitCode);
      });
    });
    manager.create({ workspaceId: 'wsp_1', cwd, cols: 80, rows: 24, command: 'exit 5' });
    expect(await exited).toBe(5);
  });
});
