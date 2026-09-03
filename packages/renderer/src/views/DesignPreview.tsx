import { useMemo, useState } from 'react';
import {
  Bell,
  ChevronDown,
  CircleStop,
  FileText,
  Filter,
  FolderKanban,
  MoreVertical,
  PanelBottomOpen,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { Button } from '../components/ui/button.js';

type Status = 'running' | 'waiting' | 'success' | 'failed';

const rows: {
  id: string;
  title: string;
  harness: string;
  branch: string;
  agent: string;
  status: Status;
  elapsed: string;
  attention?: number;
}[] = [
  {
    id: 'feat',
    title: 'feat/api-validation',
    harness: 'mock',
    branch: 'feature/api-validation',
    agent: 'diryklee',
    status: 'running',
    elapsed: '12분 34초',
  },
  {
    id: 'refactor',
    title: 'refactor/handler',
    harness: 'omp',
    branch: 'refactor/handler',
    agent: 'yklee',
    status: 'running',
    elapsed: '16분 21초',
  },
  {
    id: 'docs',
    title: 'docs/update',
    harness: 'grok',
    branch: 'docs/update',
    agent: '—',
    status: 'waiting',
    elapsed: '대기 중',
  },
  {
    id: 'deps',
    title: 'chore/deps',
    harness: 'mock',
    branch: 'chore/deps',
    agent: 'yklee',
    status: 'success',
    elapsed: '8분 11초',
  },
  {
    id: 'timeout',
    title: 'test/edge-cases',
    harness: 'mock',
    branch: 'test/edge-cases',
    agent: 'yklee',
    status: 'failed',
    elapsed: '3분 02초',
    attention: 2,
  },
];

const statusLabel: Record<Status, string> = {
  running: '실행 중',
  waiting: '대기 중',
  success: '성공',
  failed: '실패',
};

export function DesignPreview(): React.JSX.Element {
  const [selectedId, setSelectedId] = useState('feat');
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [detailOpen, setDetailOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const visible = useMemo(
    () => rows.filter((row) => filter === 'all' || row.status === filter),
    [filter],
  );
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];

  return (
    <div className="preview-shell">
      <p className="preview-static-notice" role="note">
        정적 디자인 미리보기 — 데이터 변경이나 외부 동작은 실행하지 않습니다.
      </p>
      <header className="preview-topbar">
        <div className="preview-brand">
          <span className="preview-mark">CH</span>
          <strong>Custom Harness</strong>
        </div>
        <nav aria-label="주요 탐색">
          <button className="is-active">워크스페이스</button>
          <button>세션</button>
          <button>실행 기록</button>
          <button>아티팩트</button>
          <button>
            알림 <i />
          </button>
        </nav>
        <div className="preview-top-actions">
          <button className="preview-select">
            mock-model <ChevronDown size={14} />
          </button>
          <span className="preview-offline">● 오프라인</span>
          <span className="preview-avatar">YK</span>
        </div>
      </header>
      <aside className="preview-sidebar">
        <div className="preview-sidebar-title">
          워크스페이스{' '}
          <Button size="icon" variant="ghost" aria-label="워크스페이스 추가">
            <Plus size={16} />
          </Button>
        </div>
        <button className="preview-workspace is-selected">
          <span>
            yklee <b>pi</b>
          </span>
          <small>56,688tk</small>
        </button>
        <button className="preview-workspace">
          <span>
            repo <b>pi</b>
          </span>
        </button>
        <div className="preview-nav">
          <button>
            <FolderKanban size={16} /> 리소스
          </button>
          <button>
            <Terminal size={16} /> 하네스 <span>4</span>
          </button>
          <button>
            <PanelBottomOpen size={16} /> 세션 템플릿 <span>2</span>
          </button>
          <button>
            <FileText size={16} /> 파일 <span>12</span>
          </button>
          <button>
            <ShieldAlert size={16} /> 변경 사항 <span>3</span>
          </button>
          <button>
            <Settings size={16} /> 설정
          </button>
        </div>
        <div className="preview-health">● 모든 시스템 정상</div>
      </aside>
      <main className="preview-main">
        <div className="preview-heading">
          <div>
            <h1>워크 큐</h1>
            <p>모든 세션의 실행 상태와 대기 중인 작업을 한눈에 확인합니다.</p>
          </div>
        </div>
        <div className="preview-toolbar">
          <div className="preview-filters">
            {(['all', 'running', 'waiting', 'success', 'failed'] as const).map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={filter === item ? 'is-selected' : ''}
              >
                {item === 'all' ? '전체 5' : statusLabel[item]}
              </button>
            ))}
          </div>
          <div className="preview-search">
            <Search size={16} />
            <input aria-label="세션 검색" placeholder="세션, 하네스, 브랜치 검색" />
            <Button size="icon" variant="outline" aria-label="필터">
              <Filter size={16} />
            </Button>
            <Button onClick={() => setNotice('새 세션 생성 화면으로 이동합니다.')}>
              <Plus size={16} /> 새 세션
            </Button>
          </div>
        </div>
        {notice && (
          <div className="preview-notice">
            {notice}
            <button onClick={() => setNotice(null)}>닫기</button>
          </div>
        )}
        <section className="preview-queue" aria-label="세션 작업 큐">
          <div className="preview-table-head">
            <span>상태</span>
            <span>세션</span>
            <span>하네스</span>
            <span>브랜치</span>
            <span>에이전트</span>
            <span>경과 시간</span>
            <span>승인/알림</span>
            <span />
          </div>
          {visible.map((row) => (
            <button
              key={row.id}
              className={`preview-row ${selected?.id === row.id ? 'is-selected' : ''}`}
              onClick={() => setSelectedId(row.id)}
            >
              <span className={`preview-status ${row.status}`}>● {statusLabel[row.status]}</span>
              <strong>{row.title}</strong>
              <span className={`preview-harness ${row.harness}`}>{row.harness}</span>
              <code>{row.branch}</code>
              <span>
                {row.agent} <b className="preview-agent">pi</b>
              </span>
              <span>{row.elapsed}</span>
              <span>{row.attention ? <em>⚠ {row.attention}</em> : '—'}</span>
              <MoreVertical size={17} />
            </button>
          ))}
        </section>
        {detailOpen && selected && (
          <section className="preview-detail">
            <header>
              <div>
                <strong>{selected.title}</strong>
                <span className={`preview-status ${selected.status}`}>
                  ● {statusLabel[selected.status]}
                </span>
              </div>
              <div>
                <Button variant="outline" size="sm">
                  <FileText size={14} /> 로그
                </Button>
                <Button variant="outline" size="sm">
                  <FolderKanban size={14} /> 아티팩트
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setNotice('세션 중지 요청을 준비했습니다.')}
                >
                  <CircleStop size={14} /> 세션 중지
                </Button>
                <button className="preview-collapse" onClick={() => setDetailOpen(false)}>
                  <ChevronDown size={18} />
                </button>
              </div>
            </header>
            <div className="preview-detail-grid">
              <div>
                <h2>정보</h2>
                <dl>
                  <dt>세션 ID</dt>
                  <dd>sess_9f3c2b1a</dd>
                  <dt>하네스</dt>
                  <dd>{selected.harness} 1.0.0</dd>
                  <dt>브랜치</dt>
                  <dd>{selected.branch}</dd>
                  <dt>에이전트</dt>
                  <dd>{selected.agent}</dd>
                </dl>
              </div>
              <div>
                <h2>실행 단계</h2>
                <ul className="preview-steps">
                  <li>
                    <span>● manifest</span>
                    <b>완료</b>
                    <time>00:18</time>
                  </li>
                  <li className="current">
                    <span>● validate</span>
                    <b>실행 중</b>
                    <time>03:22</time>
                  </li>
                  <li>
                    <span>○ build</span>
                    <b>대기</b>
                    <time>—</time>
                  </li>
                  <li>
                    <span>○ deploy</span>
                    <b>대기</b>
                    <time>—</time>
                  </li>
                </ul>
                <button className="preview-link">단계 로그 보기 ↗</button>
              </div>
              <div>
                <h2>보안/정책</h2>
                <div className="preview-attention">
                  <Bell size={15} /> 승인 대기 1 · 알림 2
                </div>
                <dl>
                  <dt>정책</dt>
                  <dd>OS 보안 저장소 미사용 — 파일 권한(0600) 보호 적용 중</dd>
                  <dt>게이트웨이 키</dt>
                  <dd>
                    ********{' '}
                    <Button variant="outline" size="sm">
                      재발급
                    </Button>
                  </dd>
                  <dt>연결</dt>
                  <dd className="ok">● 로컬 IPC 정상</dd>
                </dl>
              </div>
            </div>
          </section>
        )}
        {!detailOpen && (
          <button className="preview-detail-restore" onClick={() => setDetailOpen(true)}>
            선택한 세션 상세 보기
          </button>
        )}
      </main>
    </div>
  );
}
