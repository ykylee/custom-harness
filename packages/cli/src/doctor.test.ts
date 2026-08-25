// doctor·logs 테스트 (WBS 2.6, FR-5.3)
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayService, KeyStore, dirHash, resolvePaths } from '@custom-harness/daemon';
import { runCli, type CliIo } from './commands.js';

interface CapturedIo extends CliIo {
  lines: string[];
  errors: string[];
}

function captureIo(): CapturedIo {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

function startMockGateway(validKey: string): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${validKey}`) {
        res.writeHead(401).end(JSON.stringify({ error: { message: 'invalid key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    });
  });
}

describe('doctor (WBS 2.6.1, FR-5.3)', () => {
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-doctor-'));
    process.env.CUSTOM_HARNESS_HOME = home;
    delete process.env.CUSTOM_HARNESS_MANIFEST;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reports warns (not fails) on a fresh environment — exit 0', async () => {
    const io = captureIo();
    expect(await runCli(['doctor'], io)).toBe(0);
    const output = io.lines.join('\n');
    expect(output).toContain('[WARN] 데몬');
    expect(output).toContain('[WARN] manifest');
    expect(output).toContain('[WARN] 게이트웨이');
    expect(output).toContain('[WARN] 프리셋:omp');
    expect(output).not.toContain('[FAIL]');
    expect(io.lines.at(-1)).toContain('fail 0');
  });

  it('passes gateway/preset/boundary after onboarding, fails on tamper — exit 1', async () => {
    const mock = await startMockGateway('sk-valid');
    try {
      const paths = resolvePaths(home);
      const keyStore = new KeyStore(paths.credentialsFile);
      const gateway = new GatewayService(paths, keyStore);
      await gateway.setConfig({ baseUrl: mock.baseUrl, models: [{ id: 'm-1' }] });
      await keyStore.set('sk-valid');

      const ok = captureIo();
      expect(await runCli(['doctor'], ok)).toBe(0);
      const okOut = ok.lines.join('\n');
      expect(okOut).toContain('[PASS] 게이트웨이');
      expect(okOut).toContain('[PASS] 프리셋:omp');
      expect(okOut).toContain('[PASS] 프리셋:grok');
      expect(okOut).toContain('[PASS] 트래픽 경계');

      // 사용자가 grok 오프라인 스위치를 되돌린 상황 → 프리셋 fail
      await writeFile(
        join(paths.grokHomeDir, 'config.toml'),
        '[cli]\nauto_update = true\n[features]\ntelemetry = true\n',
      );
      const bad = captureIo();
      expect(await runCli(['doctor'], bad)).toBe(1);
      expect(bad.lines.join('\n')).toContain('[FAIL] 프리셋:grok');
    } finally {
      mock.server.close();
    }
  });

  it('verifies bundle manifest checksums and harness versions (FR-4.2.1/FR-1.8)', async () => {
    // 미니 번들: pi(JS 엔트리) 하네스 1종 — manifest 체크섬은 daemon dirHash 로 생성
    const bundleRoot = join(home, 'current');
    const piDir = join(bundleRoot, 'harnesses', 'pi');
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, 'cli.js'), 'console.log("9.9.9");\n');
    const checksum = await dirHash(piDir);
    await writeFile(
      join(bundleRoot, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        bundleVersion: '0.1.0-test',
        harnesses: [
          {
            name: 'pi',
            version: '9.9.9',
            kind: 'dir',
            path: 'harnesses/pi',
            entry: 'harnesses/pi/cli.js',
            checksum,
          },
        ],
      }),
    );

    const ok = captureIo();
    expect(await runCli(['doctor'], ok)).toBe(0);
    const okOut = ok.lines.join('\n');
    expect(okOut).toContain('[PASS] manifest');
    expect(okOut).toContain('[PASS] 하네스:pi — 9.9.9');

    // 변조 → 체크섬 fail + 버전 불일치 warn
    await writeFile(join(piDir, 'cli.js'), 'console.log("0.0.1");\n');
    const bad = captureIo();
    expect(await runCli(['doctor'], bad)).toBe(1);
    const badOut = bad.lines.join('\n');
    expect(badOut).toContain('[FAIL] manifest');
    expect(badOut).toContain('[WARN] 하네스:pi — 버전 불일치');
  });
});

describe('logs (WBS 2.6.2, FR-5.3)', () => {
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ch-logs-'));
    process.env.CUSTOM_HARNESS_HOME = home;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('lists log files and tails a named one', async () => {
    const logsDir = join(home, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'daemon.log'), ['하나', '둘', '셋', ''].join('\n'));
    await writeFile(join(logsDir, 'pi-sess1.log'), 'stderr 내용\n');

    const list = captureIo();
    expect(await runCli(['logs'], list)).toBe(0);
    expect(list.lines[0]).toContain(logsDir);
    expect(list.lines.join('\n')).toContain('daemon.log');
    expect(list.lines.join('\n')).toContain('pi-sess1.log');

    const tail = captureIo();
    expect(await runCli(['logs', 'daemon', '--lines', '2'], tail)).toBe(0);
    expect(tail.lines.join('\n')).toContain('둘');
    expect(tail.lines.join('\n')).toContain('셋');
    expect(tail.lines.join('\n')).not.toContain('하나');

    // 접두 매칭 (세션 로그)
    const prefix = captureIo();
    expect(await runCli(['logs', 'pi-'], prefix)).toBe(0);
    expect(prefix.lines.join('\n')).toContain('stderr 내용');

    const missing = captureIo();
    expect(await runCli(['logs', 'nope'], missing)).toBe(1);
  });

  it('guides when the logs directory does not exist yet', async () => {
    const io = captureIo();
    expect(await runCli(['logs'], io)).toBe(1);
    expect(io.lines[0]).toContain('로그 디렉토리 없음');
  });
});
