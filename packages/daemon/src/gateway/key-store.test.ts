import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyStore, type SecretCipher } from './key-store.js';

async function makeStore(cipher?: SecretCipher): Promise<KeyStore> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-keys-'));
  return new KeyStore(join(dir, 'credentials.enc'), cipher);
}

describe('KeyStore (credential-injection-design §1)', () => {
  it('round-trips a key via the 0600 fallback and reports fallback state', async () => {
    const store = await makeStore();
    await store.set('sk-secret-123');
    expect(await store.get()).toBe('sk-secret-123');
    expect(await store.state()).toEqual({
      present: true,
      cipher: 'plaintext-0600',
      fallback: true,
    });
  });

  it('stores the credentials file with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-keys-'));
    const file = join(dir, 'credentials.enc');
    await new KeyStore(file).set('sk-x');
    // Windows 는 POSIX 모드 무의미(ACL 기반) — 모드 검사는 POSIX 에서만 (credential-injection-design §1)
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    // 파일 자체에 평문 키가 그대로 눕지 않는다 (base64 인코딩 — 암호화는 cipher 주입 시)
    expect(await readFile(file, 'utf8')).not.toContain('sk-x');
  });

  it('uses an injected cipher and reports non-fallback state', async () => {
    const reverse: SecretCipher = {
      name: 'reverse-test',
      encrypt: async (plaintext) => Buffer.from([...plaintext].reverse().join('')),
      decrypt: async (payload) => [...payload.toString()].reverse().join(''),
    };
    const store = await makeStore(reverse);
    await store.set('sk-cipher');
    expect(await store.get()).toBe('sk-cipher');
    expect(await store.state()).toMatchObject({ cipher: 'reverse-test', fallback: false });
  });

  it('cannot decrypt a key stored with a different cipher — headless 시나리오', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-keys-'));
    const file = join(dir, 'credentials.enc');
    const cipher: SecretCipher = {
      name: 'safeStorage',
      encrypt: async (p) => Buffer.from(p),
      decrypt: async (p) => p.toString(),
    };
    await new KeyStore(file, cipher).set('sk-y');
    const headless = new KeyStore(file); // cipher 없음
    expect(await headless.get()).toBeUndefined();
    expect(await headless.state()).toMatchObject({ present: true, cipher: 'safeStorage' });
  });

  it('deletes and reports absence', async () => {
    const store = await makeStore();
    await store.set('sk-z');
    await store.delete();
    expect(await store.get()).toBeUndefined();
    expect(await store.state()).toEqual({ present: false, cipher: undefined, fallback: false });
  });
});
