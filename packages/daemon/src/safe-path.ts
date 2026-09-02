// 경로 봉쇄 (WBS 6.4·3.3.2) — 정해진 루트 밖의 파일은 읽지 않는다.
//
// 워크스페이스 파일 뷰어(FR-3.5)와 라이선스 고지 열람(FR-4.5)이 같은 가드를 쓴다:
// 루트만 다르고 위협(`..`·절대경로·심링크 탈출)은 같다. 가드가 두 벌이면 한쪽만
// 고쳐지는 날이 온다.
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

export class PathEscapeError extends Error {
  constructor(
    readonly requested: string,
    readonly scope = '워크스페이스',
  ) {
    super(`${scope} 밖 경로는 접근할 수 없음: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * 루트 상대 경로 → 절대 경로. 탈출 시도는 예외.
 *
 * lexical 정규화로 1차 거절하고, 실제 경로(realpath)로 2차 확인한다 —
 * 심링크가 밖을 가리키는 경우는 lexical 검사만으로 못 잡는다.
 *
 * 루트 자체가 심링크 아래일 수 있으므로(`~/.custom-harness/current/licenses`)
 * 2차 확인은 루트도 함께 realpath 로 편다.
 */
export async function resolveUnderRoot(
  root: string,
  relativePath: string,
  scope?: string,
): Promise<string> {
  if (isAbsolute(relativePath)) throw new PathEscapeError(relativePath, scope);
  const normalized = normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new PathEscapeError(relativePath, scope);
  }
  const target = join(root, normalized);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathEscapeError(relativePath, scope);

  // 심링크 탈출 확인 — 대상이 아직 없으면(신규 파일 등) lexical 판정으로 만족한다
  try {
    const realTarget = await realpath(target);
    const realRoot = await realpath(root);
    const realRel = relative(realRoot, realTarget);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new PathEscapeError(relativePath, scope);
    }
  } catch (error) {
    if (error instanceof PathEscapeError) throw error;
  }
  return target;
}
