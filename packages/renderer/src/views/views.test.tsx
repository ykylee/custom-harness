// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@custom-harness/protocol';
import { applyEvents, emptySessionView } from '../timeline.js';
import { Conversation } from './Conversation.js';
import { Onboarding } from './Onboarding.js';
import { SessionCreate } from './SessionCreate.js';

afterEach(cleanup);

let seq = 0;
function ev(body: Record<string, unknown>): SessionEvent {
  return { ...body, sessionId: 's-1', seq: seq++ } as unknown as SessionEvent;
}

function runningView(extra: SessionEvent[] = []) {
  seq = 0;
  return applyEvents(emptySessionView(), [
    ev({ type: 'session_status_changed', status: 'idle' }),
    ev({ type: 'user_message', turnId: 't-1', text: '버그 고쳐줘' }),
    ev({ type: 'turn_started', turnId: 't-1' }),
    ev({ type: 'session_status_changed', status: 'running' }),
    ev({ type: 'reasoning_delta', turnId: 't-1', delta: '원인 분석 중' }),
    ev({ type: 'message_delta', turnId: 't-1', delta: '수정 **진행**합니다' }),
    ev({
      type: 'tool_execution_started',
      toolCallId: 'tc-1',
      kind: 'shell',
      toolName: 'bash',
      rawInput: { command: 'npm test' },
    }),
    ...extra,
  ]);
}

const noopActions = { prompt: vi.fn(), interrupt: vi.fn(), respondPermission: vi.fn() };

describe('Conversation (FR-3.2)', () => {
  it('renders user message, markdown text, collapsed reasoning, and tool summary', () => {
    render(<Conversation view={runningView()} actions={noopActions} />);
    expect(screen.getByTestId('user-message').textContent).toBe('버그 고쳐줘');
    // 마크다운 렌더 — **진행** 이 <strong> 으로
    expect(screen.getByText('진행').tagName).toBe('STRONG');
    // 사고 과정은 기본 접힘 (FR-3.2.2)
    const reasoning = screen.getByTestId('reasoning') as HTMLDetailsElement;
    expect(reasoning.open).toBe(false);
    expect(reasoning.textContent).toContain('원인 분석 중');
    // 툴 카드 요약 (FR-3.2.3)
    expect(screen.getByTestId('tool-card').textContent).toContain('npm test');
    expect(screen.getByTestId('tool-card').textContent).toContain('실행 중');
  });

  it('disables the composer while running and wires the interrupt button (FR-3.2.4/6)', () => {
    const actions = { ...noopActions, interrupt: vi.fn() };
    render(<Conversation view={runningView()} actions={actions} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('중단'));
    expect(actions.interrupt).toHaveBeenCalled();
  });

  it('lets the user respond to a pending permission (FR-3.4.1)', () => {
    const actions = { ...noopActions, respondPermission: vi.fn() };
    const view = runningView([
      ev({
        type: 'permission_requested',
        request: {
          requestId: 'p-1',
          kind: 'shell',
          summary: 'rm -rf 실행',
          options: [
            { optionId: 'allow', label: '허용', kind: 'allow_once' },
            { optionId: 'deny', label: '거부', kind: 'reject_once' },
          ],
        },
      }),
    ]);
    render(<Conversation view={view} actions={actions} />);
    expect(screen.getByTestId('permission-card').textContent).toContain('rm -rf 실행');
    fireEvent.click(screen.getByText('허용'));
    expect(actions.respondPermission).toHaveBeenCalledWith('p-1', { optionId: 'allow' });
  });

  it('enables the composer after the turn completes and submits with Cmd+Enter', () => {
    const actions = { ...noopActions, prompt: vi.fn() };
    const view = runningView([
      ev({ type: 'turn_completed', turnId: 't-1' }),
      ev({ type: 'session_status_changed', status: 'idle' }),
    ]);
    render(<Conversation view={view} actions={actions} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: '다음 작업' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(actions.prompt).toHaveBeenCalledWith('다음 작업');
  });
});

describe('SessionCreate (FR-3.1)', () => {
  const harnesses = [{ id: 'pi' as const, capabilities: { streaming: true } }];

  it('creates a session with harness/cwd/model and surfaces failure causes', async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('pi 실행 파일 없음'));
    render(
      <SessionCreate
        harnesses={harnesses}
        gateway={{
          baseUrl: 'http://gw/v1',
          defaultModel: 'grok-4.6',
          models: [{ id: 'grok-4.6' }],
        }}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByLabelText('작업 디렉토리'), { target: { value: '/work' } });
    fireEvent.click(screen.getByText('세션 생성'));
    expect(onCreate).toHaveBeenCalledWith({ harness: 'pi', cwd: '/work', modelId: 'grok-4.6' });
    // 원인별 안내 (FR-3.1.2)
    expect((await screen.findByTestId('create-error')).textContent).toContain('pi 실행 파일 없음');
  });
});

describe('Onboarding (FR-3.8)', () => {
  it('walks gateway → key(test 실패 안내 포함) → 확인 → finish', async () => {
    const actions = {
      saveGateway: vi.fn().mockResolvedValue(undefined),
      setKeyAndTest: vi
        .fn()
        .mockResolvedValueOnce({ valid: false, detail: '인증 실패 (401) — 키 확인 필요' })
        .mockResolvedValueOnce({ valid: true }),
      finish: vi.fn(),
    };
    render(
      <Onboarding gateway={null} harnesses={[{ id: 'pi', capabilities: {} }]} actions={actions} />,
    );

    // ① 게이트웨이
    fireEvent.change(screen.getByLabelText('게이트웨이 주소'), {
      target: { value: 'http://gw.internal/v1' },
    });
    fireEvent.change(screen.getByLabelText('기본 모델'), { target: { value: 'grok-4.6' } });
    fireEvent.click(screen.getByText('다음'));
    expect(actions.saveGateway).toHaveBeenCalledWith({
      baseUrl: 'http://gw.internal/v1',
      defaultModel: 'grok-4.6',
      models: [{ id: 'grok-4.6' }],
    });

    // ② 키 — 첫 시도 401 안내, 둘째 시도 성공
    const keyInput = await screen.findByLabelText('게이트웨이 API 키');
    fireEvent.change(keyInput, { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByText('키 저장 + 연결 확인'));
    expect((await screen.findByTestId('onboarding-notice')).textContent).toContain('401');

    fireEvent.change(keyInput, { target: { value: 'sk-right' } });
    fireEvent.click(screen.getByText('키 저장 + 연결 확인'));

    // ③ 확인 + 완료
    expect((await screen.findByTestId('harness-list')).textContent).toContain('pi');
    fireEvent.click(screen.getByText('시작'));
    expect(actions.finish).toHaveBeenCalled();
  });
});
