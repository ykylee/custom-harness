// 역방향 툴 카탈로그 (M7 WBS 7.2.2, FR-9.2) — 카탈로그가 정본이라는 성질을 지키는 테스트.
import { describe, expect, it } from 'vitest';
import {
  TOOL_CATALOG,
  TOOL_NAME_PATTERN,
  findTool,
  toolDescriptors,
  type ToolSpec,
} from './tools.js';

const catalog = TOOL_CATALOG as readonly ToolSpec[];

describe('툴 카탈로그', () => {
  it('이름이 짧고 유일하다 — 하네스가 다시 접두사를 붙인다', () => {
    const names = catalog.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
      // omp `mcp__<server>_<tool>` / grok `<server>__<tool>` 를 씌워도 다루기 좋은 길이
      expect(`mcp__ch_${name}`.length).toBeLessThanOrEqual(40);
    }
  });

  it('FR-9.2 가 열거한 범위를 모두 덮는다', () => {
    const names = new Set(catalog.map((tool) => tool.name));
    for (const required of [
      'session_new', // 세션 생성
      'session_say', // 프롬프트 전송
      'session_list', // 상태 조회
      'session_stop', // 중단
      'ws_list', // 워크스페이스 조회
      'term_send', // 터미널 조작
    ]) {
      expect(names).toContain(required);
    }
  });

  it('상태를 바꾸는 툴은 전부 승인 대상이다 (FR-1.5)', () => {
    for (const tool of catalog) {
      if (tool.effect === 'write') expect(tool.approval).toBe(true);
    }
  });

  it('읽기 툴은 승인을 요구하지 않는다 — 조회까지 막으면 감시 자체가 불가능하다', () => {
    for (const tool of catalog) {
      if (tool.effect === 'read') expect(tool.approval).toBe(false);
    }
  });

  it('세션을 만드는 툴만 재귀 위험으로 표시된다 (7.2.4 상한의 근거)', () => {
    const spawning = catalog.filter((tool) => tool.spawnsSession === true).map((t) => t.name);
    expect(spawning).toEqual(['session_new']);
  });

  it('모든 툴에 설명이 있다 — 모델이 툴을 고르는 유일한 근거다', () => {
    for (const tool of catalog) expect(tool.description.length).toBeGreaterThan(10);
  });

  it('MCP tools/list 항목으로 변환된다 — 필수 파라미터가 required 로 나온다', () => {
    const descriptors = toolDescriptors();
    expect(descriptors).toHaveLength(catalog.length);
    const say = descriptors.find((d) => d.name === 'session_say');
    expect(say?.inputSchema).toMatchObject({
      type: 'object',
      required: ['sessionId', 'prompt'],
    });
    // 모델의 오타·환각 파라미터가 조용히 통과하면 안 된다
    expect((say?.inputSchema as { additionalProperties?: unknown }).additionalProperties).not.toBe(
      true,
    );
  });

  it('파라미터 스키마가 실제로 검증한다', () => {
    const say = findTool('session_say');
    expect(say?.params.safeParse({ sessionId: 's', prompt: '안녕' }).success).toBe(true);
    expect(say?.params.safeParse({ sessionId: 's' }).success).toBe(false);
  });

  it('없는 이름은 undefined', () => {
    expect(findTool('session_delete_everything')).toBeUndefined();
  });
});
