// @vitest-environment jsdom
// 앱 정보 화면 (WBS 3.3.2, FR-4.5)
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AboutInfo, LicenseChunk } from '../store/app-store.js';
import { About } from './About.js';

afterEach(cleanup);

const bundled: AboutInfo = {
  version: '0.1.0',
  protocolVersion: 1,
  bundle: {
    root: '/Users/u/.custom-harness/current',
    version: '0.1.0',
    os: 'darwin',
    arch: 'arm64',
    electronVersion: '44.0.0',
  },
  licenses: {
    available: true,
    root: '/Users/u/.custom-harness/current/licenses',
    notice: '# NOTICE\n\n동봉물 목록입니다.',
    provenance: '# PROVENANCE\n\n반입 출처.',
    components: [
      { name: 'pi', version: '0.84.1', license: 'MIT', paths: ['pi/LICENSE'] },
      {
        name: 'Electron',
        version: '44.0.0',
        license: 'MIT (+ Chromium/Node 고지)',
        paths: ['electron/LICENSE', 'electron/LICENSES.chromium.html'],
      },
    ],
    files: [
      { path: 'pi/LICENSE', size: 1064 },
      { path: 'electron/LICENSES.chromium.html', size: 20_000_000 },
    ],
  },
};

function chunk(over: Partial<LicenseChunk> = {}): LicenseChunk {
  return {
    path: 'pi/LICENSE',
    size: 17,
    offset: 0,
    nextOffset: 17,
    text: 'MIT License — pi\n',
    eof: true,
    ...over,
  };
}

describe('앱 정보 화면', () => {
  it('버전·번들 신원과 동봉물 표를 보여 준다', async () => {
    render(
      <About
        actions={{
          load: () => Promise.resolve(bundled),
          readLicense: () => Promise.resolve(chunk()),
          back: vi.fn(),
        }}
      />,
    );
    await screen.findByTestId('about');
    expect(screen.getAllByText('44.0.0').length).toBeGreaterThan(0); // 번들 정보 + 동봉물 표
    expect(screen.getByText('/Users/u/.custom-harness/current')).toBeTruthy();
    expect(screen.getByText('pi')).toBeTruthy();
    expect(screen.getByText('MIT (+ Chromium/Node 고지)')).toBeTruthy();
    // 원문이 둘인 동봉물은 버튼도 둘 (FR-4.5 — Electron 은 Chromium 고지가 따로 있다)
    expect(screen.getAllByRole('button', { name: 'LICENSE' }).length).toBe(2);
  });

  it('원문 버튼을 누르면 그 파일을 읽어 보여 준다', async () => {
    const readLicense = vi.fn(() => Promise.resolve(chunk()));
    render(
      <About actions={{ load: () => Promise.resolve(bundled), readLicense, back: vi.fn() }} />,
    );
    await screen.findByTestId('about');
    fireEvent.click(screen.getAllByRole('button', { name: 'LICENSE' })[0] as HTMLElement);
    await screen.findByTestId('license-viewer');
    expect(readLicense).toHaveBeenCalledWith('pi/LICENSE', 0);
    await waitFor(() => expect(screen.getByText(/MIT License — pi/)).toBeTruthy());
    // 다 읽었으면 "더 보기"는 없다
    expect(screen.queryByTestId('license-more')).toBeNull();
  });

  it('큰 원문은 이어 읽는다 — 20MB Chromium 고지도 열람 가능해야 한다', async () => {
    const readLicense = vi.fn((path: string, offset: number) =>
      Promise.resolve(
        offset === 0
          ? chunk({ path, size: 30, offset: 0, nextOffset: 10, text: '첫 조각', eof: false })
          : chunk({ path, size: 30, offset: 10, nextOffset: 30, text: '둘째 조각', eof: true }),
      ),
    );
    render(
      <About actions={{ load: () => Promise.resolve(bundled), readLicense, back: vi.fn() }} />,
    );
    await screen.findByTestId('about');
    fireEvent.click(screen.getByRole('button', { name: 'LICENSES.chromium.html' }) as HTMLElement);
    const more = await screen.findByTestId('license-more');
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByText(/첫 조각둘째 조각/)).toBeTruthy());
    expect(readLicense).toHaveBeenLastCalledWith('electron/LICENSES.chromium.html', 10);
    expect(screen.queryByTestId('license-more')).toBeNull();
  });

  it('번들이 아니면 고지 없음을 알리고 화면은 성립한다', async () => {
    render(
      <About
        actions={{
          load: () =>
            Promise.resolve({
              version: '0.1.0',
              protocolVersion: 1,
              licenses: { available: false, components: [], files: [] },
            } satisfies AboutInfo),
          readLicense: () => Promise.resolve(chunk()),
          back: vi.fn(),
        }}
      />,
    );
    await screen.findByTestId('about');
    expect(screen.getByText(/번들 설치본이 아니라/)).toBeTruthy();
    expect(screen.queryByTestId('about-files')).toBeNull();
  });

  it('열람 거절은 화면에 그대로 드러난다 — 조용히 빈 화면이 되지 않는다', async () => {
    render(
      <About
        actions={{
          load: () => Promise.resolve(bundled),
          readLicense: () =>
            Promise.reject(new Error('라이선스 디렉토리 밖 경로는 접근할 수 없음')),
          back: vi.fn(),
        }}
      />,
    );
    await screen.findByTestId('about');
    fireEvent.click(screen.getAllByRole('button', { name: 'LICENSE' })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText(/라이선스 디렉토리 밖/)).toBeTruthy());
  });
});
