// 세션의 워크스페이스 귀속 (WBS 5.4) — 소유권은 workspaceId 로만 판정한다.
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '../adapters/testing.js';
import { startDaemon } from '../index.js';
import { resolvePaths } from '../paths.js';
import { SessionManager } from '../session-manager.js';
import { SessionStore } from '../store.js';

async function tempDir(prefix = 'ch-own-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('세션 귀속 (WBS 5.4.1·5.4.3)', () => {
  it('workspaceId 를 메타·요약에 보존하고 목록을 그 기준으로 거른다', async () => {
    const store = new SessionStore(await tempDir('ch-sess-'));
    const manager = new SessionManager({ store, adapters: [new FakeAdapter()] });
    await manager.init();
    const cwd = await tempDir();

    const first = await manager.createSession({ harness: 'mock', cwd, workspaceId: 'wsp_a' });
    await manager.createSession({ harness: 'mock', cwd, workspaceId: 'wsp_b' });

    expect(first.workspaceId).toBe('wsp_a');
    expect(await manager.listSessions({ workspaceId: 'wsp_a' })).toHaveLength(1);
    expect(await manager.listSessions({ workspaceId: 'wsp_b' })).toHaveLength(1);
    // 같은 cwd 지만 형제 워크스페이스라 섞이지 않는다
    expect(await manager.listSessions()).toHaveLength(2);
    await manager.shutdown();
  });

  it('재기동 후에도 귀속이 유지된다', async () => {
    const sessionsDir = await tempDir('ch-sess-');
    const cwd = await tempDir();
    const first = new SessionManager({
      store: new SessionStore(sessionsDir),
      adapters: [new FakeAdapter()],
    });
    await first.init();
    const created = await first.createSession({ harness: 'mock', cwd, workspaceId: 'wsp_a' });
    await first.shutdown();

    const second = new SessionManager({
      store: new SessionStore(sessionsDir),
      adapters: [new FakeAdapter()],
    });
    await second.init();
    const restored = (await second.listSessions()).find(
      (session) => session.sessionId === created.sessionId,
    );
    expect(restored?.workspaceId).toBe('wsp_a');
    await second.shutdown();
  });
});

describe('워크스페이스 백필 (WBS 5.4.2)', () => {
  it('기존 세션을 기본 워크스페이스에 귀속시키고 마커를 남긴다', async () => {
    const root = await tempDir('ch-daemon-');
    const paths = resolvePaths(root);
    const cwd = await tempDir('ch-proj-');

    // 5.4 이전 형태의 세션 — workspaceId 가 없다
    const first = await startDaemon({
      root,
      version: '0.1.0',
      adapters: () => [new FakeAdapter()],
    });
    const legacy = await first.manager.createSession({ harness: 'mock', cwd });
    await first.stop();

    // 메타에서 workspaceId 를 지우고 마커도 제거해 백필 대상으로 되돌린다
    const metaPath = join(paths.sessionsDir, legacy.sessionId, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta.workspaceId;
    await writeFile(metaPath, JSON.stringify(meta));
    await rm(paths.migrationsDir, { recursive: true, force: true });

    const second = await startDaemon({
      root,
      version: '0.1.0',
      adapters: () => [new FakeAdapter()],
    });
    const restored = (await second.manager.listSessions()).find(
      (session) => session.sessionId === legacy.sessionId,
    );
    expect(restored?.workspaceId).toBeDefined();

    // 귀속된 워크스페이스는 그 cwd 의 기본 워크스페이스다
    const workspace = await second.provisioning.workspaces.find(restored!.workspaceId!);
    expect(workspace?.cwd).toBe(restored?.cwd);
    await access(join(paths.migrationsDir, 'backfill-workspace-id.done'));
    await second.stop();
  });

  it('사라진 디렉토리의 세션은 건너뛴다 (기동을 막지 않는다)', async () => {
    const root = await tempDir('ch-daemon-');
    const paths = resolvePaths(root);
    const cwd = await tempDir('ch-gone-');

    const first = await startDaemon({
      root,
      version: '0.1.0',
      adapters: () => [new FakeAdapter()],
    });
    const legacy = await first.manager.createSession({ harness: 'mock', cwd });
    await first.stop();

    const metaPath = join(paths.sessionsDir, legacy.sessionId, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta.workspaceId;
    await writeFile(metaPath, JSON.stringify(meta));
    await rm(paths.migrationsDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true }); // 디렉토리 소실

    const second = await startDaemon({
      root,
      version: '0.1.0',
      adapters: () => [new FakeAdapter()],
    });
    const restored = (await second.manager.listSessions()).find(
      (session) => session.sessionId === legacy.sessionId,
    );
    expect(restored?.workspaceId).toBeUndefined(); // 귀속되지 않았지만 기동은 성공
    await second.stop();
  });
});
