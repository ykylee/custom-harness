// 게이트웨이 API 키 저장 (WBS 1.4.3, credential-injection-design §1)
// 1차 데몬 단독 구현은 0600 폴백 — Electron safeStorage 는 셸(1.6)에서 SecretCipher 주입으로 배선.
// 키는 로그·설정 파일에 평문 기록 금지, 하네스에는 spawn env 로만 전달 (FR-2.1.4).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 셸이 Electron safeStorage 를 이 인터페이스로 공급한다 (개정 포인트: headless 실측 결과 반영) */
export interface SecretCipher {
  name: string;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(payload: Buffer): Promise<string>;
}

interface StoredCredential {
  cipher: string;
  payload: string; // base64
}

export interface KeyState {
  present: boolean;
  cipher: string | undefined;
  /** 0600 평문 폴백 여부 — doctor·설정 화면 노출 대상 (설계 §1) */
  fallback: boolean;
}

const FALLBACK_CIPHER = 'plaintext-0600';

export class KeyStore {
  constructor(
    private readonly credentialsFile: string,
    private readonly cipher?: SecretCipher,
  ) {}

  async set(apiKey: string): Promise<void> {
    const stored: StoredCredential = this.cipher
      ? {
          cipher: this.cipher.name,
          payload: (await this.cipher.encrypt(apiKey)).toString('base64'),
        }
      : { cipher: FALLBACK_CIPHER, payload: Buffer.from(apiKey, 'utf8').toString('base64') };
    await mkdir(dirname(this.credentialsFile), { recursive: true });
    await writeFile(this.credentialsFile, JSON.stringify(stored), { mode: 0o600 });
  }

  async get(): Promise<string | undefined> {
    const stored = await this.read();
    if (!stored) return undefined;
    const payload = Buffer.from(stored.payload, 'base64');
    if (stored.cipher === FALLBACK_CIPHER) return payload.toString('utf8');
    if (this.cipher && stored.cipher === this.cipher.name) return this.cipher.decrypt(payload);
    // 다른 cipher 로 저장된 키 — 복호화 불가 (예: safeStorage 저장 후 headless 기동)
    return undefined;
  }

  async delete(): Promise<void> {
    await rm(this.credentialsFile, { force: true });
  }

  async state(): Promise<KeyState> {
    const stored = await this.read();
    return {
      present: stored !== undefined,
      cipher: stored?.cipher,
      fallback: stored?.cipher === FALLBACK_CIPHER,
    };
  }

  private async read(): Promise<StoredCredential | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.credentialsFile, 'utf8')) as StoredCredential;
      return typeof parsed?.cipher === 'string' && typeof parsed?.payload === 'string'
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }
}
