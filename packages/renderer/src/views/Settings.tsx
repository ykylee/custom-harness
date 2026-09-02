// 설정 화면 (WBS 1.5.6·2.4.4, FR-3.6) — 키(3.6.1), 기본 모델(3.6.2),
// 하네스 상태 패널(3.6.3 — 버전·검증·가용성·경계 경고), 알림·자동 승인 정책 표시(3.6.4).
import { useEffect, useState } from 'react';
import type { HarnessId, HarnessInfo, ProbeResult } from '@custom-harness/protocol';
import type { GatewaySettings, KeyState } from '../store/app-store.js';
import { HarnessBadge } from '../components/Sidebar.js';

export interface SettingsActions {
  setKey(apiKey: string): Promise<{ valid: boolean; detail?: string }>;
  setDefaultModel(modelId: string): Promise<void>;
  probeHarness(harness: HarnessId): Promise<void>;
  setNotificationsEnabled(enabled: boolean): void;
  openAbout(): void;
  back(): void;
}

export function Settings({
  gateway,
  keyState,
  harnesses,
  probes,
  maxSessions,
  notificationsEnabled,
  autoApproveCount,
  actions,
}: {
  gateway: GatewaySettings | null;
  keyState: KeyState | null;
  harnesses: HarnessInfo[];
  probes: Record<string, ProbeResult>;
  maxSessions: number | null;
  notificationsEnabled: boolean;
  autoApproveCount: number;
  actions: SettingsActions;
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 하네스 상태 패널 — 진입 시 1회 probe (FR-3.6.3)
  useEffect(() => {
    for (const harness of harnesses) {
      if (!(harness.id in probes)) void actions.probeHarness(harness.id);
    }
    // probes 를 의존성에 넣으면 갱신 루프 — 최초 목록 기준 1회면 충분
  }, [harnesses]);

  const submitKey = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await actions.setKey(apiKey.trim());
      setNotice(result.valid ? '키 저장·연결 확인 완료' : (result.detail ?? '연결 확인 실패'));
      if (result.valid) setApiKey('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // 모델 후보 — 게이트웨이 카탈로그(harness.list models, FR-2.4)가 있으면 우선
  const catalog = harnesses.find((h) => h.models?.length)?.models ?? gateway?.models ?? [];

  return (
    <div className="settings">
      <h2>설정</h2>
      <section>
        <h3>게이트웨이</h3>
        <p>
          주소: <code>{gateway?.baseUrl ?? '미설정'}</code>
          {maxSessions !== null && (
            <>
              {' '}
              {' · '}동시 세션 상한: {maxSessions}
            </>
          )}
        </p>
        <label>
          기본 모델 (FR-3.6.2)
          <select
            data-testid="default-model"
            value={gateway?.defaultModel ?? ''}
            onChange={(event) => void actions.setDefaultModel(event.target.value)}
          >
            <option value="" disabled>
              모델 선택
            </option>
            {catalog.map((model) => (
              <option key={model.id} value={model.id}>
                {('displayName' in model ? (model.displayName as string) : undefined) ??
                  ('name' in model ? (model.name as string | undefined) : undefined) ??
                  model.id}
              </option>
            ))}
          </select>
        </label>
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
        <button onClick={() => void submitKey()} disabled={busy || !apiKey.trim()}>
          {busy ? '확인 중…' : '저장 + 연결 확인'}
        </button>
        {notice && <div className="settings-notice">{notice}</div>}
      </section>

      <section data-testid="harness-panel">
        <h3>하네스 상태 (FR-3.6.3)</h3>
        <table className="harness-table">
          <thead>
            <tr>
              <th>하네스</th>
              <th>가용성</th>
              <th>버전</th>
              <th>검증</th>
              <th>경고</th>
            </tr>
          </thead>
          <tbody>
            {harnesses.map((harness) => {
              const probe = probes[harness.id];
              const warnings = [...(harness.warnings ?? []), ...(probe?.warnings ?? [])];
              return (
                <tr key={harness.id}>
                  <td>
                    <HarnessBadge harness={harness.id} />
                  </td>
                  <td>
                    {probe === undefined ? '확인 중…' : probe.available ? '사용 가능' : '불가'}
                  </td>
                  <td>
                    <code>{probe?.version ?? '—'}</code>
                  </td>
                  <td>
                    {probe?.verified === true
                      ? '✓ manifest 일치'
                      : probe?.available
                        ? '미검증'
                        : '—'}
                  </td>
                  <td className="harness-warnings">
                    {warnings.length > 0 ? warnings.map((w, i) => <div key={i}>⚠ {w}</div>) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3>알림·승인 정책 (FR-3.6.4)</h3>
        <label className="notifications-toggle">
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(event) => actions.setNotificationsEnabled(event.target.checked)}
          />
          네이티브 알림 (승인 대기·턴 완료/실패)
        </label>
        <p className="auto-approve-policy">
          자동 승인: {autoApproveCount > 0 ? `⚠ ${autoApproveCount}개 세션에서 활성` : '비활성'} —
          세션 한정 opt-in 이며 앱 재시작 시 해제됩니다.
        </p>
      </section>

      <section>
        <h3>앱 정보</h3>
        <p>버전·동봉 오픈소스 고지(FR-4.5)를 여기서 확인합니다.</p>
        <button data-testid="open-about" onClick={() => actions.openAbout()}>
          앱 정보 · 오픈소스 고지
        </button>
      </section>

      <button className="back" onClick={() => actions.back()}>
        돌아가기
      </button>
    </div>
  );
}
