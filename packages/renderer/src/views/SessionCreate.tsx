// 세션 생성 화면 (WBS 1.5.2, FR-3.1) — 하네스·작업 디렉토리·모델 선택.
// 네이티브 폴더 픽커는 셸 통합(1.6)에서 — 1차는 직접 입력 + 최근 목록(localStorage).
import { useState } from 'react';
import type { HarnessId, HarnessInfo } from '@custom-harness/protocol';
import type { GatewaySettings } from '../store/app-store.js';

const RECENT_KEY = 'custom-harness.recent-cwds';

function loadRecentCwds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecentCwd(cwd: string): void {
  try {
    const next = [cwd, ...loadRecentCwds().filter((c) => c !== cwd)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // localStorage 불가 환경 — 최근 목록만 포기
  }
}

export function SessionCreate({
  harnesses,
  gateway,
  onCreate,
}: {
  harnesses: HarnessInfo[];
  gateway: GatewaySettings | null;
  onCreate: (params: { harness: HarnessId; cwd: string; modelId?: string }) => Promise<void>;
}): React.JSX.Element {
  const [harness, setHarness] = useState<HarnessId | ''>(harnesses[0]?.id ?? '');
  const [cwd, setCwd] = useState('');
  const [modelId, setModelId] = useState(gateway?.defaultModel ?? '');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const recents = loadRecentCwds();

  const create = async (): Promise<void> => {
    if (!harness || !cwd.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate({
        harness,
        cwd: cwd.trim(),
        ...(modelId ? { modelId } : {}),
      });
      saveRecentCwd(cwd.trim());
    } catch (err) {
      // 원인별 안내 (FR-3.1.2) — 데몬 RpcError 메시지 표출
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="session-create">
      <h2>새 세션</h2>
      <label>
        하네스
        <select value={harness} onChange={(event) => setHarness(event.target.value as HarnessId)}>
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        작업 디렉토리
        <input
          value={cwd}
          placeholder="/path/to/project"
          list="recent-cwds"
          onChange={(event) => setCwd(event.target.value)}
        />
        <datalist id="recent-cwds">
          {recents.map((recent) => (
            <option key={recent} value={recent} />
          ))}
        </datalist>
      </label>
      <label>
        모델
        <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
          <option value="">(하네스 기본값)</option>
          {(gateway?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.name ?? model.id}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="create-error" data-testid="create-error">
          세션 생성 실패: {error}
        </div>
      )}
      <button onClick={() => void create()} disabled={creating || !harness || !cwd.trim()}>
        {creating ? '생성 중…' : '세션 생성'}
      </button>
    </div>
  );
}
