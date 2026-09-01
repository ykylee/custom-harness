// 세션 제목 자동 생성 (M7 WBS 7.6.1, FR-9.5).
import { describe, expect, it, vi } from 'vitest';
import { TITLE_MAX, createTitleGenerator, heuristicTitle } from './session-title.js';

describe('heuristicTitle (비 LLM 기본)', () => {
  it('첫 줄을 제목으로 쓴다', () => {
    expect(heuristicTitle('로그인 버그 고쳐줘')).toBe('로그인 버그 고쳐줘');
  });

  it('첫 문장에서 끊는다', () => {
    expect(heuristicTitle('로그인 버그 고쳐줘. 그리고 테스트도 돌려줘')).toBe(
      '로그인 버그 고쳐줘.',
    );
  });

  it('너무 이른 마침표에서는 끊지 않는다', () => {
    // "v1. 로그인 고쳐줘" 가 "v1" 이 되면 제목이 아무것도 말하지 않는다
    expect(heuristicTitle('v1. 로그인 화면 고쳐줘')).toBe('v1. 로그인 화면 고쳐줘');
  });

  it('마크다운 장식을 걷어낸다', () => {
    expect(heuristicTitle('## **긴급** 배포 스크립트 점검')).toBe('긴급 배포 스크립트 점검');
    expect(heuristicTitle('- 세션 목록 정렬 바꿔줘')).toBe('세션 목록 정렬 바꿔줘');
    expect(heuristicTitle('1) 첫 번째 할 일')).toBe('첫 번째 할 일');
    expect(heuristicTitle('> 인용으로 시작하는 요청')).toBe('인용으로 시작하는 요청');
  });

  it('코드 펜스로 시작하면 그 블록을 건너뛴다', () => {
    // 첫 줄을 그대로 쓰면 제목이 "```ts" 가 된다
    const prompt = '```ts\nconst x = 1;\n```\n이 코드 리뷰해줘';
    expect(heuristicTitle(prompt)).toBe('이 코드 리뷰해줘');
  });

  it('내용이 전부 코드면 제목을 지어내지 않는다', () => {
    expect(heuristicTitle('```\nnpm test\n```')).toBeUndefined();
  });

  it('빈 입력에는 제목이 없다', () => {
    expect(heuristicTitle('')).toBeUndefined();
    expect(heuristicTitle('   \n\n  ')).toBeUndefined();
  });

  it('공백을 접는다', () => {
    expect(heuristicTitle('여러   칸\t띄운   요청')).toBe('여러 칸 띄운 요청');
  });

  it('상한을 넘으면 자르고 말줄임표를 붙인다', () => {
    const long = `${'가나다라마'.repeat(30)}`;
    const title = heuristicTitle(long) as string;
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
  });

  it('자를 때 단어 중간을 피한다', () => {
    const title = heuristicTitle(
      'refactor the session manager event ordering and the adapter contract as well',
    ) as string;
    expect(title.endsWith('…')).toBe(true);
    // 마지막 토큰이 잘린 조각으로 끝나지 않는다
    expect(title.replace('…', '').trimEnd().split(' ').at(-1)).not.toMatch(/^$/);
  });
});

describe('createTitleGenerator', () => {
  const gateway = { getConfig: async () => ({ baseUrl: 'http://gw/v1', defaultModel: 'm-1' }) };
  const apiKey = async (): Promise<string> => 'k';

  it('off 는 제목을 만들지 않는다', async () => {
    const generate = createTitleGenerator({
      mode: () => 'off',
      model: () => '',
      gateway,
      apiKey,
    });
    expect(await generate('무엇이든')).toBeUndefined();
  });

  it('heuristic 은 모델을 부르지 않는다', async () => {
    // 기본값이 이것이다 — 세션마다 토큰이 나가면 안 된다 (FR-9.5 NFR)
    const fetchImpl = vi.fn();
    const generate = createTitleGenerator({
      mode: () => 'heuristic',
      model: () => '',
      gateway,
      apiKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await generate('로그인 고쳐줘')).toBe('로그인 고쳐줘');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const llmFetch = (body: unknown, ok = true): typeof fetch =>
    (async () =>
      ({
        ok,
        json: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;

  it('llm 은 게이트웨이를 거쳐 제목을 받는다', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '세션 제목 생성' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => '',
      gateway,
      apiKey,
      fetchImpl,
    });
    expect(await generate('제목 붙이는 기능 만들어줘')).toBe('세션 제목 생성');
    // 모든 LLM 트래픽은 게이트웨이만 경유한다 (NFR-1)
    expect(calls[0]?.url).toBe('http://gw/v1/chat/completions');
    const sent = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      max_tokens: number;
      stream: boolean;
    };
    expect(sent.model).toBe('m-1'); // 미지정이면 게이트웨이 기본 모델
    expect(sent.max_tokens).toBeLessThanOrEqual(32); // 제목 하나에 길게 받지 않는다
    expect(sent.stream).toBe(false);
  });

  it('지정 모델이 게이트웨이 기본값을 이긴다', async () => {
    let sentModel = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentModel = (JSON.parse(String(init.body)) as { model: string }).model;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '제목' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => 'cheap-model',
      gateway,
      apiKey,
      fetchImpl,
    });
    await generate('무엇이든');
    expect(sentModel).toBe('cheap-model');
  });

  it('LLM 실패는 휴리스틱으로 떨어진다', async () => {
    // 게이트웨이가 한 번 흔들렸다고 세션이 제목 없이 남을 이유는 없다
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => '',
      gateway,
      apiKey,
      fetchImpl: (async () => {
        throw new Error('네트워크 실패');
      }) as unknown as typeof fetch,
    });
    expect(await generate('로그인 고쳐줘')).toBe('로그인 고쳐줘');
  });

  it('LLM 이 비정상 응답을 줘도 휴리스틱으로 떨어진다', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: '   ' } }] }]) {
      const generate = createTitleGenerator({
        mode: () => 'llm',
        model: () => '',
        gateway,
        apiKey,
        fetchImpl: llmFetch(body),
      });
      expect(await generate('로그인 고쳐줘')).toBe('로그인 고쳐줘');
    }
  });

  it('LLM 이 장황하게 답하면 다듬는다', async () => {
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => '',
      gateway,
      apiKey,
      fetchImpl: llmFetch({
        choices: [{ message: { content: '**제목**: 로그인 버그 수정\n(설명 생략)' } }],
      }),
    });
    expect(await generate('로그인 고쳐줘')).toBe('제목: 로그인 버그 수정');
  });

  it('HTTP 실패 상태도 휴리스틱으로 떨어진다', async () => {
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => '',
      gateway,
      apiKey,
      fetchImpl: llmFetch({}, false),
    });
    expect(await generate('로그인 고쳐줘')).toBe('로그인 고쳐줘');
  });

  it('쓸 모델을 모르면 부르지 않는다', async () => {
    const fetchImpl = vi.fn();
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => '',
      gateway: { getConfig: async () => ({ baseUrl: 'http://gw/v1' }) },
      apiKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await generate('로그인 고쳐줘')).toBe('로그인 고쳐줘');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('게이트웨이 미설정이면 부르지 않는다', async () => {
    const generate = createTitleGenerator({
      mode: () => 'llm',
      model: () => '',
      gateway: { getConfig: async () => undefined },
      apiKey,
    });
    expect(await generate('로그인 고쳐줘')).toBe('로그인 고쳐줘');
  });
});
