// 워크스페이스 파일 접근 (WBS 6.4, workbench-tabs §3).
//
// 경계는 `safe-path.ts` 의 공용 가드가 본다 — 워크스페이스 밖의 파일은 읽지 않는다
// (`..`·절대경로·심링크 탈출 전부 거절). 이 모듈의 몫은 크기·바이너리 방어다.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PathEscapeError, resolveUnderRoot } from '../safe-path.js';

export { PathEscapeError };

/** 뷰어 상한 (workbench-tabs §3) — 초과분은 내용 대신 메타데이터만 준다 */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** 트리 한 번에 돌려주는 최대 항목 — 거대 디렉토리가 응답을 막지 않게 */
export const MAX_ENTRIES = 2000;

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

/** 워크스페이스 루트에 봉쇄된 경로 해석 (공용 가드 위임) */
export async function resolveInWorkspace(
  workspaceCwd: string,
  relativePath: string,
): Promise<string> {
  return resolveUnderRoot(workspaceCwd, relativePath, '워크스페이스');
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

// ── 파일 이름 검색 (M7 WBS 7.4.2, FR-9.4) ─────────────────────────────────

/**
 * 훑는 파일 수 상한. 워크스페이스 크기는 우리가 못 정하는데(사용자 저장소다) 팔레트는
 * 타이핑마다 부른다 — 상한이 없으면 큰 저장소에서 한 글자가 수십만 stat 이 된다.
 */
const MAX_SEARCH_SCAN = 20_000;
/** 돌려주는 경로 수 상한 — 순위는 렌더러가 매기므로 후보만 넉넉히 준다 */
const MAX_SEARCH_RESULTS = 200;

/**
 * 워크스페이스 전체에서 경로가 질의에 맞는 파일을 찾는다.
 *
 * `listDirectory` 는 한 단계만 본다(트리 펼치기용). 팔레트는 "이름 일부만 아는 파일"을
 * 찾아야 해서 전체 순회가 필요하다 — 그래서 별도 함수다.
 *
 * **판정은 부분 문자열이 아니라 부분 수열(subsequence)** 이다: `dsi` 로
 * `daemon/src/index.ts` 를 찾을 수 있어야 팔레트답다. 다만 **순위는 매기지 않는다** —
 * 렌더러가 세션·워크스페이스·명령까지 한 줄에 세워야 하고, 점수 계산이 두 곳에 있으면
 * 파일만 다른 규칙으로 정렬된다.
 */
export async function searchFiles(
  workspaceCwd: string,
  query: string,
  limit = MAX_SEARCH_RESULTS,
): Promise<{ paths: string[]; truncated: boolean }> {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { paths: [], truncated: false };
  const cap = Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS);
  const root = await resolveInWorkspace(workspaceCwd, '.');
  const paths: string[] = [];
  let scanned = 0;
  let truncated = false;

  // 너비 우선 — 얕은 경로가 먼저 차면 상한에 걸려도 사용자가 아는 파일이 남을 확률이 높다
  const queue: string[] = [''];
  while (queue.length > 0) {
    const relativeDir = queue.shift() as string;
    let dirents;
    try {
      dirents = await readdir(relativeDir === '' ? root : join(root, relativeDir), {
        withFileTypes: true,
      });
    } catch {
      continue; // 권한 없는 디렉토리 등 — 검색이 거기서 멈출 이유는 없다
    }
    for (const dirent of dirents) {
      if (IGNORED_DIRS.has(dirent.name)) continue;
      const childRelative = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        queue.push(childRelative);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (scanned >= MAX_SEARCH_SCAN) {
        return { paths, truncated: true };
      }
      scanned += 1;
      if (!matchesSubsequence(childRelative.toLowerCase(), needle)) continue;
      if (paths.length >= cap) {
        truncated = true;
        continue; // 계속 훑되 더 담지는 않는다 — scanned 상한 판정을 유지한다
      }
      paths.push(childRelative);
    }
  }
  return { paths, truncated };
}

/** 질의의 글자들이 순서대로 나타나는가. 공백은 구분자가 아니라 글자로 본다 */
function matchesSubsequence(haystack: string, needle: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}
