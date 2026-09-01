// 세션 제목 자동 생성 (M7 WBS 7.6.1, FR-9.5).
//
// **기본은 비 LLM 이다.** 제목 한 줄에 모델 호출을 붙이면 세션을 만들 때마다 토큰이 나가고,
// 그건 폐쇄망의 제한된 예산에서 가장 값싸게 아낄 수 있는 지출이다(NFR 토큰 절약).
// LLM 은 설정에서 켜는 선택지이고, 켜더라도 **실패하면 휴리스틱으로 떨어진다** —
// 게이트웨이가 한 번 흔들렸다고 세션이 제목 없이 남을 이유는 없다.

/** 제목 상한 — 탭·사이드바 한 줄에 들어가야 한다 */
export const TITLE_MAX = 60;
/** LLM 에 보낼 프롬프트 상한. 제목을 뽑는 데 전문이 필요하지 않다 (NFR 토큰 절약) */
const LLM_INPUT_MAX = 500;

/**
 * 비 LLM 제목 — 첫 문장을 다듬는다.
 *
 * 규칙이 몇 개 있는 이유는 실제 첫 프롬프트가 산문만은 아니기 때문이다: 코드 펜스로
 * 시작하거나, 마크다운 제목·목록으로 시작하거나, 스택 트레이스를 통째로 붙여 넣는다.
 * 그런 입력에서 첫 줄을 그대로 쓰면 제목이 "```ts" 가 된다.
 */
export function heuristicTitle(prompt: string): string | undefined {
  const line = firstProseLine(prompt);
  if (line === undefined) return undefined;
  const cleaned = stripDecoration(line);
  if (cleaned === '') return undefined;
  // 문장 부호가 일찍 나오면 거기서 끊는다 — 첫 문장이 곧 요지인 경우가 많다
  const sentence = cutAtSentence(cleaned);
  return truncate(sentence, TITLE_MAX);
}

/** 코드 펜스 블록을 건너뛰고 내용이 있는 첫 줄을 고른다 */
function firstProseLine(prompt: string): string | undefined {
  let inFence = false;
  for (const raw of prompt.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '') continue;
    return line;
  }
  // 전부 코드였다면 제목을 지어내지 않는다 — 호출자가 폴백을 정한다
  return undefined;
}

/** 마크다운 장식·인용·목록 기호를 앞에서 걷어내고 공백을 접는다 */
function stripDecoration(line: string): string {
  return line
    .replace(/^[#>\s]*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 첫 문장 끝에서 자른다. 너무 이른 곳(마침표가 3자 안)에서는 자르지 않는다 —
 * "v1. 로그인 고쳐줘" 같은 입력이 "v1" 이 되어 버린다.
 */
function cutAtSentence(text: string): string {
  const match = /[.!?。？!]\s/.exec(text);
  if (match === null || match.index < 4) return text;
  return text.slice(0, match.index + 1);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // 단어 중간을 자르지 않으려 시도하되, 잘릴 자리가 너무 앞이면 그냥 자른다
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

export type SessionTitleMode = 'off' | 'heuristic' | 'llm';

export interface TitleGeneratorDeps {
  mode(): SessionTitleMode;
  /** 빈 값이면 게이트웨이 기본 모델 */
  model(): string;
  /** 게이트웨이 접속 정보만 필요하다 — 서비스 전체를 끌어오지 않는다 */
  gateway: {
    getConfig(): Promise<{ baseUrl: string; defaultModel?: string } | undefined>;
  };
  apiKey(): Promise<string | undefined>;
  /** 테스트 주입 지점 */
  fetchImpl?: typeof fetch;
}

/**
 * 제목 생성기 — 모드에 따라 휴리스틱 또는 LLM.
 *
 * `off` 는 `undefined` 를 돌려준다(제목 없음). 그 경우 UI 는 지금처럼 cwd 를 보여 준다.
 */
export function createTitleGenerator(
  deps: TitleGeneratorDeps,
): (prompt: string) => Promise<string | undefined> {
  return async (prompt: string): Promise<string | undefined> => {
    const mode = deps.mode();
    if (mode === 'off') return undefined;
    const fallback = heuristicTitle(prompt);
    if (mode === 'heuristic') return fallback;
    try {
      const generated = await requestLlmTitle(prompt, deps);
      // 모델이 빈 문자열·장황한 문단을 돌려줄 수 있다 — 다듬고, 못 쓰면 휴리스틱
      const cleaned = generated === undefined ? undefined : heuristicTitle(generated);
      return cleaned ?? fallback;
    } catch {
      // 게이트웨이 실패가 세션을 제목 없이 남길 이유는 없다
      return fallback;
    }
  };
}

async function requestLlmTitle(
  prompt: string,
  deps: TitleGeneratorDeps,
): Promise<string | undefined> {
  const config = await deps.gateway.getConfig();
  if (config === undefined) return undefined;
  const configured = deps.model().trim();
  const model = configured !== '' ? configured : (config.defaultModel ?? '');
  if (model === '') return undefined; // 쓸 모델을 모르면 부르지 않는다
  const key = await deps.apiKey();
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(joinUrl(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      // 짧게 시키고 짧게 받는다 — 제목 하나에 나가는 토큰을 양쪽에서 줄인다 (FR-9.5 NFR)
      messages: [
        {
          role: 'system',
          content:
            '사용자 요청을 5단어 이내의 짧은 제목으로 요약한다. 따옴표·마침표·설명 없이 제목만 출력한다.',
        },
        { role: 'user', content: prompt.slice(0, LLM_INPUT_MAX) },
      ],
      max_tokens: 24,
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : undefined;
}

/** baseUrl 끝의 슬래시 유무를 흡수 (gateway/service.ts 와 같은 규칙) */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
