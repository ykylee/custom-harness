// 확인용 웹 시안 — 데몬·PTY에 연결하지 않고도 실제 대화·승인 표면을 검토한다.
import type { SessionView } from '../timeline.js';
import { Conversation } from './Conversation.js';

const previewView: SessionView = {
  status: 'idle',
  lastSeq: 5,
  totalTokens: 18_420,
  items: [
    { kind: 'user', seq: 1, turnId: 'turn-1', text: '배포 전 변경 사항을 점검해줘.' },
    {
      kind: 'assistant',
      seq: 2,
      turnId: 'turn-1',
      reasoning: '변경 범위와 테스트 결과를 먼저 확인합니다.',
      text: '검증 명령을 실행했고, 배포 전에 확인이 필요한 변경을 찾았습니다.',
      status: 'completed',
    },
    {
      kind: 'tool',
      seq: 3,
      toolCallId: 'tool-1',
      toolKind: 'shell',
      toolName: 'npm test',
      summary: 'npm test',
      status: 'ok',
      rawInput: { command: 'npm test' },
      rawOutput: { passed: 708 },
    },
    {
      kind: 'permission',
      seq: 4,
      status: 'pending',
      request: {
        requestId: 'permission-1',
        kind: 'shell',
        summary: 'git push origin main',
        detail: { command: 'git push origin main' },
        options: [
          { optionId: 'allow', label: '허용', kind: 'allow_once' },
          { optionId: 'deny', label: '거부', kind: 'reject_once' },
        ],
      },
    },
  ],
};

export function SessionDetailPreview(): React.JSX.Element {
  return (
    <main className="review-preview" aria-label="세션 상세 확인용 시안">
      <header className="review-preview-heading">
        <div>
          <p>STATIC REVIEW</p>
          <h1>세션 상세</h1>
          <span>정적 fixture · 데몬과 원격 셸에 연결하지 않습니다.</span>
        </div>
        <a href="?preview=work-queue">워크 큐 시안</a>
      </header>
      <section className="review-preview-grid">
        <div className="review-preview-conversation">
          <Conversation
            view={previewView}
            actions={{
              prompt: () => undefined,
              interrupt: () => undefined,
              respondPermission: () => undefined,
            }}
          />
        </div>
        <section className="review-preview-terminal" aria-label="터미널 정적 시안">
          <header className="terminal-cockpit-header">
            <div className="terminal-context">
              <span className="terminal-eyebrow">LIVE SHELL</span>
              <strong>터미널</strong>
            </div>
            <code className="terminal-id">terminal-preview</code>
          </header>
          <pre>
            {
              '$ git status --short\n M packages/renderer/src/views/Conversation.tsx\n M packages/renderer/src/components/PermissionCard.tsx\n\n$ npm test\n ✓ 708 passed | 2 skipped'
            }
          </pre>
        </section>
      </section>
    </main>
  );
}
