// manifest 스키마·체크섬 라이브러리 (WBS 2.5.1, FR-4.2)
// 스키마 (FR-4.2 필수 필드):
//   {
//     schemaVersion: 1,                     // additive 진화 전용
//     bundleVersion, os, arch,
//     harnesses: [{ name, version, kind: 'dir'|'file', path, checksum, entry?, verifiedAt }],
//     app: { version, checksumScope, checksum },
//     configTemplates: { <name>: <templateVersion> },
//     electronVersion,
//   }
// checksum 표기: "sha256:<hex>". dir 은 결정적 합성 해시(상대경로+내용, 심링크 제외),
// file 은 파일 해시. 데몬(FR-1.8)의 관대 로더와 호환 — 필드 추가는 additive 로만.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** 결정적 디렉토리 해시 — 정렬 순회, 심링크 제외 (Electron.app 프레임워크 심링크 등) */
export async function dirHash(dir) {
  const files = [];
  async function walk(current) {
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
    hash.update(relative(dir, file).split('\\').join('/')); // Windows 경로 정규화 (NFR-9)
    hash.update(await readFile(file));
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function fileHash(path) {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

/**
 * 번들 트리에서 manifest 를 생성한다.
 * harnesses: [{ name, version, kind, path(번들 상대), entry? }] — checksum 은 여기서 계산.
 */
export async function buildManifest(bundleRoot, spec) {
  const harnesses = [];
  for (const h of spec.harnesses) {
    const absolute = join(bundleRoot, h.path);
    harnesses.push({
      name: h.name,
      version: h.version,
      kind: h.kind,
      path: h.path,
      checksum: h.kind === 'file' ? await fileHash(absolute) : await dirHash(absolute),
      ...(h.entry !== undefined ? { entry: h.entry } : {}),
      verifiedAt: spec.verifiedAt,
    });
  }
  return {
    schemaVersion: 1,
    bundleVersion: spec.bundleVersion,
    os: spec.os,
    arch: spec.arch,
    harnesses,
    app: {
      version: spec.bundleVersion,
      // 자사 코드+런타임 의존만 — Electron 본체는 서명·공증(M3)과 함께 재검토
      checksumScope: 'app/node_modules',
      checksum: await dirHash(join(bundleRoot, 'app', 'node_modules')),
    },
    configTemplates: spec.configTemplates,
    electronVersion: spec.electronVersion,
  };
}

/**
 * 번들 트리를 manifest 와 대조한다 (FR-4.2.1 — 설치기는 불일치 시 중단).
 * 반환: { ok, mismatches: [{ target, expected, actual }] }
 */
export async function verifyBundle(bundleRoot) {
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'manifest.json'), 'utf8'));
  const mismatches = [];
  const check = async (target, expected, compute) => {
    let actual;
    try {
      actual = await compute();
    } catch (error) {
      actual = `error:${error.code ?? error.message}`;
    }
    if (actual !== expected) mismatches.push({ target, expected, actual });
  };

  for (const h of manifest.harnesses ?? []) {
    const absolute = join(bundleRoot, h.path);
    await check(`harness:${h.name}`, h.checksum, () =>
      h.kind === 'file' ? fileHash(absolute) : dirHash(absolute),
    );
  }
  if (manifest.app?.checksum) {
    await check('app', manifest.app.checksum, () =>
      dirHash(join(bundleRoot, manifest.app.checksumScope ?? 'app/node_modules')),
    );
  }
  return { ok: mismatches.length === 0, manifest, mismatches };
}
