import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBundleManifest, verifyProbeAgainstManifest } from './manifest.js';

const probe = (version: string) => ({
  available: true,
  version,
  verified: false,
  warnings: ['manifest 버전 대조(FR-1.8)는 M2 에서 구현'],
});

describe('bundle manifest 검증 (WBS 2.3.3, FR-1.8)', () => {
  it('loads the 1.7.1 prototype manifest shape tolerantly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ch-manifest-'));
    const path = join(dir, 'manifest.json');
    await writeFile(
      path,
      JSON.stringify({
        bundleVersion: 'custom-harness-0.1.0-darwin-arm64',
        harnesses: [
          { name: 'pi', version: '0.84.1', checksum: 'x', unknownField: true },
          { name: 'broken', version: 42 }, // 형 불일치 — 무시
        ],
      }),
    );
    const manifest = await loadBundleManifest(path);
    expect(manifest?.bundleVersion).toContain('0.1.0');
    expect(manifest?.harnessVersions.get('pi')).toBe('0.84.1');
    expect(manifest?.harnessVersions.has('broken')).toBe(false);
  });

  it('returns undefined for missing or unparsable files (검증 생략 신호)', async () => {
    expect(await loadBundleManifest('/nonexistent/manifest.json')).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), 'ch-manifest-'));
    const bad = join(dir, 'manifest.json');
    await writeFile(bad, 'not json');
    expect(await loadBundleManifest(bad)).toBeUndefined();
  });

  it('marks verified on version match and clears placeholder warnings', () => {
    const manifest = { harnessVersions: new Map([['pi', '0.84.1']]) };
    const result = verifyProbeAgainstManifest('pi', probe('0.84.1'), manifest);
    expect(result).toMatchObject({ verified: true, warnings: [] });
  });

  it('warns on mismatch without blocking (FR-1.8 — 동작 차단 금지)', () => {
    const manifest = { harnessVersions: new Map([['pi', '0.84.1']]) };
    const result = verifyProbeAgainstManifest('pi', probe('0.85.0'), manifest);
    expect(result.available).toBe(true); // 차단하지 않는다
    expect(result.verified).toBe(false);
    expect(result.warnings.join()).toContain('버전 불일치');
  });

  it('passes through when manifest is absent or harness unlisted', () => {
    expect(verifyProbeAgainstManifest('pi', probe('1.0'), undefined)).toEqual(probe('1.0'));
    const manifest = { harnessVersions: new Map([['omp', '17.3.8']]) };
    const result = verifyProbeAgainstManifest('pi', probe('1.0'), manifest);
    expect(result.warnings.join()).toContain('등재되지 않은');
  });
});
