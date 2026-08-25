import { describe, expect, it } from 'vitest';
import {
  AgentEventSchema,
  ClientMessageSchema,
  HelloSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SessionEventSchema,
  hasCapability,
  rpc,
} from './index.js';

describe('protocol hello', () => {
  it('round-trips a valid hello envelope', () => {
    const hello = {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'renderer', version: '0.1.0' },
      capabilities: { streaming: true },
    };
    expect(HelloSchema.parse(hello)).toEqual(hello);
  });

  it('rejects a wrong protocol version', () => {
    expect(() =>
      HelloSchema.parse({
        type: 'hello',
        protocolVersion: 2,
        clientInfo: { name: 'renderer', version: '0.1.0' },
        capabilities: {},
      }),
    ).toThrow();
  });
});

describe('agent events (FR-1.4)', () => {
  it('round-trips a tool_execution_started and preserves unknown fields (NFR-5)', () => {
    const event = {
      type: 'tool_execution_started',
      toolCallId: 'tc-1',
      kind: 'shell',
      toolName: 'bash',
      rawInput: { command: 'ls' },
      futureField: 'must-survive',
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an unknown tool kind (매핑은 어댑터가 other 로 수행)', () => {
    expect(() =>
      AgentEventSchema.parse({ type: 'tool_execution_started', toolCallId: 'tc-1', kind: 'nuke' }),
    ).toThrow();
  });

  it('wire events require sessionId and monotonic seq envelope', () => {
    const bare = { type: 'message_delta', delta: 'hi' };
    expect(AgentEventSchema.parse(bare)).toEqual(bare);
    expect(() => SessionEventSchema.parse(bare)).toThrow();
    const wired = { ...bare, sessionId: 's-1', seq: 3 };
    expect(SessionEventSchema.parse(wired)).toEqual(wired);
    expect(() => SessionEventSchema.parse({ ...bare, sessionId: 's-1', seq: -1 })).toThrow();
  });

  it('round-trips a permission_requested with neutral options', () => {
    const event = {
      type: 'permission_requested',
      request: {
        requestId: 'p-1',
        kind: 'file_write',
        summary: 'src/a.ts 수정',
        detail: { native: true },
        options: [{ optionId: 'o-1', label: '허용', kind: 'allow_once' }],
      },
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });
});

describe('rpc (protocol-design §2)', () => {
  it('round-trips a session.prompt request/response pair', () => {
    const request = {
      type: 'session.prompt.request',
      requestId: 'r-1',
      params: { sessionId: 's-1', prompt: '파일 고쳐줘' },
    };
    expect(rpc.session.prompt.request.parse(request)).toEqual(request);
    expect(ClientMessageSchema.parse(request)).toEqual(request);

    const ok = {
      type: 'session.prompt.response',
      requestId: 'r-1',
      ok: true,
      result: { turnId: 't-1' },
    };
    expect(rpc.session.prompt.response.parse(ok)).toEqual(ok);

    const fail = {
      type: 'session.prompt.response',
      requestId: 'r-1',
      ok: false,
      error: { code: 'spawn', message: 'pi 실행 파일 없음', retriable: false },
    };
    expect(rpc.session.prompt.response.parse(fail)).toEqual(fail);
    expect(ServerMessageSchema.parse(fail)).toEqual(fail);
  });

  it('rejects an ok response without result payload shape mismatch', () => {
    expect(() =>
      rpc.session.prompt.response.parse({
        type: 'session.prompt.response',
        requestId: 'r-1',
        ok: true,
        result: { turnId: 42 },
      }),
    ).toThrow();
  });

  it('parses a session.list response carrying pending permissions (FR-1.5)', () => {
    const response = {
      type: 'session.list.response',
      requestId: 'r-2',
      ok: true,
      result: {
        sessions: [
          {
            sessionId: 's-1',
            harness: 'pi',
            cwd: '/work',
            status: 'running',
            seq: 12,
            pendingPermissions: [
              {
                requestId: 'p-1',
                kind: 'shell',
                summary: 'rm 실행',
                options: [{ optionId: 'o-1', label: '거부', kind: 'reject_once' }],
              },
            ],
          },
        ],
      },
    };
    expect(rpc.session.list.response.parse(response)).toEqual(response);
  });
});

describe('capability negotiation (protocol-design §3)', () => {
  it('treats absent or unknown flags as false — 기능 숨김, 폴백 금지', () => {
    expect(hasCapability({ streaming: true }, 'streaming')).toBe(true);
    expect(hasCapability({ streaming: true }, 'modelSwitch')).toBe(false);
    expect(hasCapability({ streaming: true }, 'someFutureFlag')).toBe(false);
    expect(hasCapability(undefined, 'streaming')).toBe(false);
  });
});
