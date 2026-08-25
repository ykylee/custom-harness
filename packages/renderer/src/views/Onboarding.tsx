// 온보딩 마법사 (WBS 1.5.6, FR-3.8) — ① 게이트웨이 확인 ② 키 입력·연결 확인 ③ 하네스 확인 → 완료.
// zero-config: 번들 설치본은 게이트웨이 프리셋이 이미 있어 ①은 확인만으로 지나간다.
import { useState } from 'react';
import type { HarnessInfo } from '@custom-harness/protocol';
import type { GatewaySettings } from '../store/app-store.js';

export interface OnboardingActions {
  saveGateway(settings: Partial<GatewaySettings>): Promise<void>;
  setKeyAndTest(apiKey: string): Promise<{ valid: boolean; detail?: string }>;
  finish(): void;
}

export function Onboarding({
  gateway,
  harnesses,
  actions,
}: {
  gateway: GatewaySettings | null;
  harnesses: HarnessInfo[];
  actions: OnboardingActions;
}): React.JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(gateway ? 2 : 1);
  const [baseUrl, setBaseUrl] = useState(gateway?.baseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(gateway?.defaultModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const saveGateway = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await actions.saveGateway({
        baseUrl: baseUrl.trim(),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
        models: defaultModel.trim() ? [{ id: defaultModel.trim() }] : [],
      });
      setStep(2);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const submitKey = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await actions.setKeyAndTest(apiKey.trim());
      if (result.valid) {
        setStep(3);
      } else {
        // 원인별 안내 (설계 §3: 네트워크/401/형식)
        setNotice(result.detail ?? '연결 확인 실패');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding" data-testid="onboarding">
      <h1>시작하기</h1>
      <ol className="onboarding-steps">
        <li className={step === 1 ? 'active' : 'done'}>게이트웨이</li>
        <li className={step === 2 ? 'active' : step > 2 ? 'done' : ''}>API 키</li>
        <li className={step === 3 ? 'active' : ''}>확인</li>
      </ol>

      {step === 1 && (
        <div className="onboarding-step">
          <label>
            게이트웨이 주소
            <input
              value={baseUrl}
              placeholder="http://gateway.internal/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            기본 모델
            <input
              value={defaultModel}
              placeholder="grok-4.6"
              onChange={(event) => setDefaultModel(event.target.value)}
            />
          </label>
          <button onClick={() => void saveGateway()} disabled={busy || !baseUrl.trim()}>
            다음
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="onboarding-step">
          <label>
            게이트웨이 API 키
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <button onClick={() => void submitKey()} disabled={busy || !apiKey.trim()}>
            {busy ? '연결 확인 중…' : '키 저장 + 연결 확인'}
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="onboarding-step">
          <p>연결 확인 완료. 사용 가능한 하네스:</p>
          <ul data-testid="harness-list">
            {harnesses.map((harness) => (
              <li key={harness.id}>{harness.id}</li>
            ))}
          </ul>
          <button onClick={() => actions.finish()}>시작</button>
        </div>
      )}

      {notice && (
        <div className="onboarding-notice" data-testid="onboarding-notice">
          {notice}
        </div>
      )}
    </div>
  );
}
