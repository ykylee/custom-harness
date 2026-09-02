// 라이선스 고지 열람 (WBS 3.3.2, FR-4.5·NFR-4) — 번들 `licenses/` 를 읽기 전용으로 노출한다.
//
// 고지의 SSOT 는 빌드가 만드는 번들 산출물이다(3.3.1). 데몬은 그것을 **해석하지 않고**
// 그대로 읽어 보여 준다 — 앱이 목록을 따로 들고 있으면 번들과 어긋난 고지를 띄우는 날이
// 온다. 기계 판독용 `notices.json` 이 있으면 표를 그리고, 없으면(구 번들) NOTICE.md 원문과
// 파일 목록만으로 성립한다 (NFR-5 관대한 파싱).
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PathEscapeError, resolveUnderRoot } from './safe-path.js';

/** 한 번에 돌려주는 원문 조각의 기본 크기 — Chromium 고지가 20MB 라 통째로 못 준다 */
export const LICENSE_CHUNK_BYTES = 256 * 1024;
export const LICENSE_CHUNK_MAX = 1024 * 1024;
/** NOTICE.md·PROVENANCE.md 는 통째로 싣는다 — 사람이 읽는 요약이라 작다 */
const SUMMARY_MAX_BYTES = 512 * 1024;

const SCOPE = '라이선스 디렉토리';

export interface NoticeComponent {
  name: string;
  version?: string;
  license?: string;
  /** `licenses/` 기준 상대 경로 (Electron 처럼 원문이 둘일 수 있다) */
  paths: string[];
}

export interface LicenseFile {
  /** `licenses/` 기준 상대 경로 */
  path: string;
  size: number;
}

export interface LicenseIndex {
  available: boolean;
  /** 번들 안 licenses/ 절대 경로 — 앱에서 못 여는 원문의 위치를 사용자에게 알려 준다 */
  root?: string;
  notice?: string;
  provenance?: string;
  components: NoticeComponent[];
  files: LicenseFile[];
}

/** 번들 manifest 경로에서 licenses/ 를 유도한다. 번들이 아니면(개발 실행) undefined */
export function resolveLicensesDir(manifestPath: string | undefined): string | undefined {
  return manifestPath === undefined ? undefined : join(dirname(manifestPath), 'licenses');
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > SUMMARY_MAX_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** licenses/ 아래 실제 파일 목록 — 고지 표가 없어도 "무엇이 동봉됐는지"는 여기서 보인다 */
async function listLicenseFiles(root: string): Promise<LicenseFile[]> {
  const files: LicenseFile[] = [];
  async function walk(relative: string): Promise<void> {
    const dirents = await readdir(relative === '' ? root : join(root, relative), {
      withFileTypes: true,
    });
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (dirent.isSymbolicLink()) continue; // 봉쇄 밖을 가리킬 수 있다 — 목록에도 올리지 않는다
      const child = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        files.push({ path: child, size: (await stat(join(root, child))).size });
      } catch {
        // 경쟁 상태로 사라진 파일 — 목록에서 빠지는 것으로 충분하다
      }
    }
  }
  await walk('');
  return files;
}

function parseComponents(raw: unknown): NoticeComponent[] {
  if (!Array.isArray(raw)) return [];
  const components: NoticeComponent[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string') continue;
    components.push({
      name: record.name,
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
      ...(typeof record.license === 'string' ? { license: record.license } : {}),
      paths: Array.isArray(record.paths) ? record.paths.filter((p) => typeof p === 'string') : [],
    });
  }
  return components;
}

export async function readLicenseIndex(root: string | undefined): Promise<LicenseIndex> {
  if (root === undefined) return { available: false, components: [], files: [] };
  let files: LicenseFile[];
  try {
    files = await listLicenseFiles(root);
  } catch {
    return { available: false, components: [], files: [] }; // 번들에 licenses/ 가 없다
  }
  const noticesJson = await readIfPresent(join(root, 'notices.json'));
  let components: NoticeComponent[] = [];
  if (noticesJson !== undefined) {
    try {
      const parsed = JSON.parse(noticesJson) as { components?: unknown };
      components = parseComponents(parsed.components);
    } catch {
      components = []; // 훼손된 색인은 표를 비울 뿐 — 원문 열람은 계속된다
    }
  }
  const notice = await readIfPresent(join(root, 'NOTICE.md'));
  const provenance = await readIfPresent(join(root, 'PROVENANCE.md'));
  return {
    available: true,
    root,
    ...(notice !== undefined ? { notice } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    components,
    files,
  };
}

export interface LicenseChunk {
  path: string;
  size: number;
  offset: number;
  /** 다음 요청에 넣을 오프셋 — 다중바이트 문자가 잘리지 않도록 조각 끝을 당길 수 있다 */
  nextOffset: number;
  text: string;
  eof: boolean;
}

/**
 * 원문 한 조각. 20MB Chromium 고지도 "열람 가능"해야 하므로 통째로 보내지 않고 이어 읽는다.
 *
 * 바이트 범위를 UTF-8 로 디코딩하면 조각 경계에서 문자가 잘린다 — 끝의 불완전한 시퀀스는
 * 버리고 `nextOffset` 을 그만큼 당겨, 다음 조각이 그 문자부터 다시 읽게 한다.
 */
export async function readLicenseChunk(
  root: string | undefined,
  relativePath: string,
  offset = 0,
  limit = LICENSE_CHUNK_BYTES,
): Promise<LicenseChunk> {
  if (root === undefined) throw new PathEscapeError(relativePath, SCOPE);
  const target = await resolveUnderRoot(root, relativePath, SCOPE);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`파일이 아님: ${relativePath}`);
  const start = Math.max(0, Math.min(Math.trunc(offset), info.size));
  const span = Math.min(Math.max(Math.trunc(limit), 1), LICENSE_CHUNK_MAX);
  const buffer = Buffer.alloc(Math.min(span, info.size - start));
  if (buffer.length > 0) {
    const handle = await open(target, 'r');
    try {
      await handle.read(buffer, 0, buffer.length, start);
    } finally {
      await handle.close();
    }
  }
  const end = start + buffer.length;
  const usable = end >= info.size ? buffer.length : trimPartialUtf8(buffer);
  return {
    path: relativePath,
    size: info.size,
    offset: start,
    nextOffset: start + usable,
    text: buffer.subarray(0, usable).toString('utf8'),
    eof: start + usable >= info.size,
  };
}

/** 끝에 걸린 불완전한 UTF-8 시퀀스를 잘라낸 길이 (최대 3바이트만 되돌린다) */
function trimPartialUtf8(buffer: Buffer): number {
  for (let back = 1; back <= 3 && back <= buffer.length; back += 1) {
    const byte = buffer[buffer.length - back] as number;
    if ((byte & 0b1100_0000) !== 0b1000_0000) {
      // 선두 바이트 — 이 문자가 몇 바이트짜리인지 보고 온전한지 판정한다
      const needed =
        (byte & 0b1000_0000) === 0
          ? 1
          : (byte & 0b1110_0000) === 0b1100_0000
            ? 2
            : (byte & 0b1111_0000) === 0b1110_0000
              ? 3
              : 4;
      return needed === back ? buffer.length : buffer.length - back;
    }
  }
  return buffer.length;
}
