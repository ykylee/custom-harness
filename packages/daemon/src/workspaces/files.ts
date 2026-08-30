// 워크스페이스 파일 접근 (WBS 6.4, workbench-tabs §3).
//
// 이 모듈의 첫 번째 책임은 **경계**다. 데몬은 워크스페이스 밖의 파일을 읽지 않는다 —
// `..`·절대경로·심링크 탈출 전부 거절한다. 두 번째는 크기·바이너리 방어다.
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/** 뷰어 상한 (workbench-tabs §3) — 초과분은 내용 대신 메타데이터만 준다 */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** 트리 한 번에 돌려주는 최대 항목 — 거대 디렉토리가 응답을 막지 않게 */
export const MAX_ENTRIES = 2000;

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

export class PathEscapeError extends Error {
  constructor(readonly requested: string) {
    super(`워크스페이스 밖 경로는 접근할 수 없음: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * 워크스페이스 상대 경로 → 절대 경로. 탈출 시도는 예외.
 *
 * lexical 정규화로 1차 거절하고, 실제 경로(realpath)로 2차 확인한다 —
 * 심링크가 밖을 가리키는 경우는 lexical 검사만으로 못 잡는다.
 */
export async function resolveInWorkspace(
  workspaceCwd: string,
  relativePath: string,
): Promise<string> {
  if (isAbsolute(relativePath)) throw new PathEscapeError(relativePath);
  const normalized = normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new PathEscapeError(relativePath);
  }
  const target = join(workspaceCwd, normalized);
  const rel = relative(workspaceCwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathEscapeError(relativePath);

  // 심링크 탈출 확인 — 대상이 아직 없으면(신규 파일 등) lexical 판정으로 만족한다
  try {
    const realTarget = await realpath(target);
    const realRoot = await realpath(workspaceCwd);
    const realRel = relative(realRoot, realTarget);
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw new PathEscapeError(relativePath);
  } catch (error) {
    if (error instanceof PathEscapeError) throw error;
  }
  return target;
}

export interface FileEntry {
  name: string;
  /** 워크스페이스 상대 경로 */
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

/** 한 단계 목록 — 트리는 클라이언트가 펼칠 때마다 요청한다(증분 로딩) */
export async function listDirectory(
  workspaceCwd: string,
  relativePath: string,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const dir = await resolveInWorkspace(workspaceCwd, relativePath === '' ? '.' : relativePath);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = [];
  let truncated = false;

  for (const dirent of dirents.sort(compareDirents)) {
    if (IGNORED_DIRS.has(dirent.name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const childRelative = relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`;
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: childRelative, kind: 'directory' });
      continue;
    }
    if (!dirent.isFile()) continue; // 소켓·FIFO 등은 보여주지 않는다
    let size: number | undefined;
    try {
      size = (await stat(join(dir, dirent.name))).size;
    } catch {
      size = undefined; // 경쟁 상태로 사라진 파일 — 목록에서만 크기를 비운다
    }
    entries.push({
      name: dirent.name,
      path: childRelative,
      kind: 'file',
      ...(size !== undefined ? { size } : {}),
    });
  }
  return { entries, truncated };
}

function compareDirents(
  a: { name: string; isDirectory(): boolean },
  b: { name: string; isDirectory(): boolean },
): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export interface FileContent {
  path: string;
  size: number;
  /** 내용 — 상한 초과·바이너리면 없다 */
  text?: string;
  binary: boolean;
  tooLarge: boolean;
}

/** 널 바이트가 있으면 바이너리로 본다 — 뷰어에 넣어도 읽을 수 없다 */
function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
}

export async function readWorkspaceFile(
  workspaceCwd: string,
  relativePath: string,
): Promise<FileContent> {
  const target = await resolveInWorkspace(workspaceCwd, relativePath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`파일이 아님: ${relativePath}`);
  if (info.size > MAX_READ_BYTES) {
    return { path: relativePath, size: info.size, binary: false, tooLarge: true };
  }
  const buffer = await readFile(target);
  if (looksBinary(buffer)) {
    return { path: relativePath, size: info.size, binary: true, tooLarge: false };
  }
  return {
    path: relativePath,
    size: info.size,
    text: buffer.toString('utf8'),
    binary: false,
    tooLarge: false,
  };
}
