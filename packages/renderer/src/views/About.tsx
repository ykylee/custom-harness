// 앱 정보 화면 (WBS 3.3.2, FR-4.5) — 버전·번들 신원 + 동봉 오픈소스 고지 열람.
//
// 고지 표와 원문은 전부 데몬이 번들 `licenses/` 에서 읽어 온 것이다. 렌더러가 목록을
// 들고 있지 않은 이유는 3.3.1 과 같다: 고지의 SSOT 는 번들 산출물 하나여야 한다.
import { useEffect, useState } from 'react';
import type { AboutInfo, LicenseChunk } from '../store/app-store.js';
import { Markdown } from '../components/Markdown.js';

export interface AboutActions {
  load(): Promise<AboutInfo>;
  readLicense(path: string, offset: number): Promise<LicenseChunk>;
  back(): void;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function About({ actions }: { actions: AboutActions }): React.JSX.Element {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await actions.load();
        if (!cancelled) setInfo(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

  if (error !== null) {
    return (
      <div className="about">
        <div className="about-error">앱 정보를 읽을 수 없음: {error}</div>
        <button className="back" onClick={() => actions.back()}>
          돌아가기
        </button>
      </div>
    );
  }
  if (info === null) return <div className="about-loading">읽는 중…</div>;

  const { bundle, licenses } = info;

  return (
    <div className="about" data-testid="about">
      <h2>앱 정보</h2>

      <section>
        <h3>버전</h3>
        <dl className="about-versions">
          <dt>custom-harness</dt>
          <dd>
            <code>{info.version}</code>
          </dd>
          <dt>프로토콜</dt>
          <dd>
            <code>{info.protocolVersion}</code>
          </dd>
          {bundle !== undefined && (
            <>
              <dt>번들</dt>
              <dd>
                <code>
                  {bundle.version ?? '—'}
                  {bundle.os !== undefined && ` (${bundle.os}-${bundle.arch ?? '?'})`}
                </code>
              </dd>
              <dt>Electron</dt>
              <dd>
                <code>{bundle.electronVersion ?? '—'}</code>
              </dd>
              <dt>설치 경로</dt>
              <dd>
                <code>{bundle.root}</code>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section data-testid="about-notice">
        <h3>오픈소스 고지 (FR-4.5)</h3>
        {!licenses.available ? (
          <p className="about-note">
            번들 설치본이 아니라 동봉 고지가 없습니다 — 개발 실행에서는 저장소의{' '}
            <code>bundle/licenses-src/</code> 를 참조하세요.
          </p>
        ) : (
          <>
            {licenses.components.length > 0 && (
              <table className="about-components">
                <thead>
                  <tr>
                    <th>동봉물</th>
                    <th>버전</th>
                    <th>라이선스</th>
                    <th>원문</th>
                  </tr>
                </thead>
                <tbody>
                  {licenses.components.map((component) => (
                    <tr key={component.name}>
                      <td>{component.name}</td>
                      <td>
                        <code>{component.version ?? '—'}</code>
                      </td>
                      <td>{component.license ?? '—'}</td>
                      <td>
                        {component.paths.length === 0
                          ? '—'
                          : component.paths.map((path) => (
                              <button
                                key={path}
                                className="link"
                                onClick={() => setOpen(path)}
                                title={path}
                              >
                                {path.split('/').pop()}
                              </button>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {licenses.notice !== undefined && (
              <details className="about-details">
                <summary>NOTICE 원문</summary>
                <Markdown text={licenses.notice} />
              </details>
            )}
            {licenses.provenance !== undefined && (
              <details className="about-details">
                <summary>반입 출처·해시 (PROVENANCE)</summary>
                <Markdown text={licenses.provenance} />
              </details>
            )}
            <details className="about-details" data-testid="about-files">
              <summary>동봉된 라이선스 파일 {licenses.files.length}개</summary>
              <ul className="about-file-list">
                {licenses.files.map((file) => (
                  <li key={file.path}>
                    <button className="link" onClick={() => setOpen(file.path)}>
                      {file.path}
                    </button>{' '}
                    <span className="about-size">{formatBytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      {open !== null && (
        <LicenseViewer
          path={open}
          read={actions.readLicense}
          onClose={() => setOpen(null)}
          {...(licenses.root !== undefined ? { root: licenses.root } : {})}
        />
      )}

      <button className="back" onClick={() => actions.back()}>
        돌아가기
      </button>
    </div>
  );
}

/**
 * 원문 뷰어 — 이어 읽기로 표시한다.
 *
 * Chromium 고지는 20MB 라 한 번에 받지도, 한 번에 그리지도 않는다. 사용자가 "더 보기"를
 * 누른 만큼만 붙인다 — 상한을 두고 잘라 버리면 그 원문은 앱에서 *열람 불가* 가 된다.
 */
export function LicenseViewer({
  path,
  root,
  read,
  onClose,
}: {
  path: string;
  root?: string;
  read: (path: string, offset: number) => Promise<LicenseChunk>;
  onClose: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [chunk, setChunk] = useState<LicenseChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFrom = (offset: number): void => {
    setBusy(true);
    void (async () => {
      try {
        const next = await read(path, offset);
        setText((current) => (offset === 0 ? next.text : current + next.text));
        setChunk(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  useEffect(() => {
    setText('');
    setChunk(null);
    setError(null);
    loadFrom(0);
    // path 가 바뀌면 처음부터 다시 읽는다
  }, [path]);

  return (
    <div className="license-viewer" data-testid="license-viewer">
      <div className="license-viewer-head">
        <strong>{path}</strong>
        {root !== undefined && <code className="about-size">{`${root}/${path}`}</code>}
        <button onClick={() => onClose()}>닫기</button>
      </div>
      {error !== null ? (
        <div className="about-error">열 수 없음: {error}</div>
      ) : (
        <>
          <pre className="license-text">{text}</pre>
          {chunk !== null && !chunk.eof && (
            <button
              data-testid="license-more"
              disabled={busy}
              onClick={() => loadFrom(chunk.nextOffset)}
            >
              {busy
                ? '읽는 중…'
                : `더 보기 (${formatBytes(chunk.nextOffset)} / ${formatBytes(chunk.size)})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
