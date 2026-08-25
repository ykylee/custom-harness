// 설정 화면 (WBS 1.5.6, FR-3.6.1) — 키 등록·변경 + 연결 재확인. 0600 폴백 경고 노출 (설계 §1).
import { useState } from 'react';
import type { GatewaySettings, KeyState } from '../store/app-store.js';

export function Settings({
  gateway,
  keyState,
  onSetKey,
  onBack,
}: {
  gateway: GatewaySettings | null;
  keyState: KeyState | null;
  onSetKey: (apiKey: string) => Promise<{ valid: boolean; detail?: string }>;
  onBack: () => void;
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await onSetKey(apiKey.trim());
      setNotice(result.valid ? '키 저장·연결 확인 완료' : (result.detail ?? '연결 확인 실패'));
      if (result.valid) setApiKey('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <h2>설정</h2>
      <section>
        <h3>게이트웨이</h3>
        <p>
          주소: <code>{gateway?.baseUrl ?? '미설정'}</code>
          {gateway?.defaultModel && (
            <>
              {' · '}기본 모델: <code>{gateway.defaultModel}</code>
            </>
          )}
        </p>
      </section>
      <section>
        <h3>API 키</h3>
        <p>
          상태: {keyState?.present ? '등록됨' : '미등록'}
          {keyState?.fallback && (
            <span className="key-fallback-warning" data-testid="key-fallback-warning">
              {' '}
              ⚠ OS 보안 저장소 미사용 — 파일 권한(0600) 보호만 적용 중
            </span>
          )}
        </p>
        <label>
          새 키 {keyState?.present ? '(변경)' : '(등록)'}
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <button onClick={() => void submit()} disabled={busy || !apiKey.trim()}>
          {busy ? '확인 중…' : '저장 + 연결 확인'}
        </button>
        {notice && <div className="settings-notice">{notice}</div>}
      </section>
      <button className="back" onClick={onBack}>
        돌아가기
      </button>
    </div>
  );
}
