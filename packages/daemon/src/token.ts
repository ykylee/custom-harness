// 프로토콜 인증 토큰 (protocol-design §4, NFR-3)
// 데몬 기동 시 생성·회전, 소유자 전용 권한(0600) 파일로 기록, 셧다운 시 삭제.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function writeTokenFile(tokenFile: string, token: string): Promise<void> {
  await mkdir(dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, token, { mode: 0o600 });
}

export async function readTokenFile(tokenFile: string): Promise<string> {
  return (await readFile(tokenFile, 'utf8')).trim();
}

export async function removeTokenFile(tokenFile: string): Promise<void> {
  await rm(tokenFile, { force: true });
}
