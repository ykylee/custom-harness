// 번들 manifest 대조 버전 검증 (WBS 2.3.3·2.6.1, FR-1.8·FR-5.3)
// manifest 스키마: bundle/lib/manifest.mjs v1 (2.5.1 확정) — 여기서는 관대하게 읽는다
// (미지 필드 보존·형 불일치 무시). 불일치는 경고만 — 동작 차단은 하지 않는다 (FR-1.8).
// 체크섬 알고리즘(dirHash/fileHash)은 bundle/lib/manifest.mjs 와 동일해야 한다 —
// 빌드(생성)와 doctor(재검증)가 같은 값을 내야 하므로 변경 시 양쪽 동기화 필수.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ProbeResult } from '@custom-harness/protocol';

export interface BundleManifest {
  bundleVersion?: string;
  /** harness name → 검증(동봉) 버전 */
  harnessVersions: Map<string, string>;
}

interface RawManifest {
  bundleVersion?: string;
  os?: string;
  arch?: string;
  harnesses?: {
    name?: string;
    version?: string;
    kind?: string;
    path?: string;
    checksum?: string;
    entry?: string;
  }[];
  app?: { checksum?: string; checksumScope?: string };
}

/** 결정적 디렉토리 해시 — bundle/lib/manifest.mjs 와 동일 알고리즘 (정렬 순회·심링크 제외) */
export async function dirHash(dir: string): Promise<string> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dir);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(dir, file).split('\\').join('/'));
    hash.update(await readFile(file));
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function fileHash(path: string): Promise<string> {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

export interface BundleVerifyResult {
  ok: boolean;
  raw: RawManifest;
  mismatches: { target: string; expected: string; actual: string }[];
}

/** 번들 트리 체크섬 재검증 (FR-4.2.1·FR-5.3 doctor) — bundle/lib verifyBundle 과 동일 의미 */
export async function verifyBundleTree(bundleRoot: string): Promise<BundleVerifyResult> {
  const raw = JSON.parse(await readFile(join(bundleRoot, 'manifest.json'), 'utf8')) as RawManifest;
  const mismatches: BundleVerifyResult['mismatches'] = [];
  const check = async (
    target: string,
    expected: string | undefined,
    compute: () => Promise<string>,
  ): Promise<void> => {
    if (expected === undefined) return;
    let actual: string;
    try {
      actual = await compute();
    } catch (error) {
      actual = `error:${error instanceof Error ? error.message : String(error)}`;
    }
    if (actual !== expected) mismatches.push({ target, expected, actual });
  };
  for (const h of raw.harnesses ?? []) {
    if (typeof h.path !== 'string') continue;
    const absolute = join(bundleRoot, h.path);
    await check(`harness:${h.name ?? h.path}`, h.checksum, () =>
      h.kind === 'file' ? fileHash(absolute) : dirHash(absolute),
    );
  }
  if (raw.app?.checksum) {
    await check('app', raw.app.checksum, () =>
      dirHash(join(bundleRoot, raw.app?.checksumScope ?? 'app/node_modules')),
    );
  }
  return { ok: mismatches.length === 0, raw, mismatches };
}

/** manifest.json 관대 로드 — 없거나 파싱 불가면 undefined (검증 생략 신호) */
export async function loadBundleManifest(path: string): Promise<BundleManifest | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = parsed as { bundleVersion?: unknown; harnesses?: unknown };
  const harnessVersions = new Map<string, string>();
  if (Array.isArray(raw.harnesses)) {
    for (const h of raw.harnesses) {
      const entry = h as { name?: unknown; version?: unknown };
      if (typeof entry.name === 'string' && typeof entry.version === 'string') {
        harnessVersions.set(entry.name, entry.version);
      }
    }
  }
  return {
    ...(typeof raw.bundleVersion === 'string' ? { bundleVersion: raw.bundleVersion } : {}),
    harnessVersions,
  };
}

/**
 * probe 결과를 manifest 와 대조해 verified/경고를 보정한다 (하향만 — 상향 금지와 동일 정신).
 * manifest 미보유·해당 하네스 미등재 → 검증 불가 상태 그대로 통과.
 */
export function verifyProbeAgainstManifest(
  harness: string,
  probe: ProbeResult,
  manifest: BundleManifest | undefined,
): ProbeResult {
  if (!probe.available || manifest === undefined) return probe;
  const expected = manifest.harnessVersions.get(harness);
  if (expected === undefined) {
    return {
      ...probe,
      warnings: [...probe.warnings, 'manifest 에 등재되지 않은 하네스 — 버전 검증 불가'],
    };
  }
  if (probe.version !== undefined && probe.version === expected) {
    // 기존 "manifest 대조 미구현" 류 경고는 검증 완료로 대체
    return { ...probe, verified: true, warnings: [] };
  }
  return {
    ...probe,
    verified: false,
    warnings: [
      ...probe.warnings,
      `하네스 버전 불일치: 실측 ${probe.version ?? '(미상)'} ≠ manifest ${expected} — 동작은 계속 (FR-1.8)`,
    ],
  };
}
