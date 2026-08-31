// 역방향 툴 감사 로그 (WBS 7.2.4, FR-1.5 audit)
//
// 하네스가 데몬을 되부른 기록이다. "누가(세션) 무엇을(툴) 어떤 인자로 불렀고, 승인은 어떻게
// 됐고, 결과가 무엇이었나" — 사후에 이것 없이는 세션 타임라인만 남는데, 거기에는 *다른* 세션이
// 내 세션을 조작한 흔적이 안 남는다.
//
// **기록자는 데몬 하나다.** 하네스마다 MCP 서버 프로세스가 따로 뜨므로 각자 append 하면 줄이
// 섞인다(append 원자성은 PIPE_BUF 이하에서만이고, 인자를 실은 줄은 쉽게 그보다 길다).
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AuditEntry {
  at: string;
  tool: string;
  effect: 'read' | 'write';
  /** 호출자 세션 — 원장으로 판정한 값. 판정 실패 시 생략 */
  callerSessionId?: string;
  callerHarness?: string;
  /** 승인을 물었는가 / 결과 — read 툴은 묻지 않으므로 생략 */
  approval?: 'granted' | 'denied';
  outcome: 'ok' | 'error' | 'blocked';
  /** blocked·error 사유 한 줄 */
  reason?: string;
  /** 인자 요약 — 원문 전체는 싣지 않는다 (프롬프트·터미널 입력이 통째로 남는다) */
  args?: Record<string, unknown>;
}

/** 한 줄이 무한정 길어지지 않게 자른다 — 감사 기록이지 입력 보관소가 아니다 */
const MAX_VALUE_CHARS = 200;
/** 회전 임계. 넘으면 `.1` 로 밀어내고 새로 시작한다 (세대는 1개만 보관) */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 인자에서 감사에 쓸 만큼만 남긴다.
 *
 * 문자열은 자르되 **길이는 남긴다** — `term_send` 로 무엇을 보냈는지는 앞부분으로 알 수 있고,
 * 얼마나 보냈는지는 길이로 알 수 있다. 통째로 남기면 감사 로그가 사실상 프롬프트 사본이 된다.
 */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
      out[key] = `${value.slice(0, MAX_VALUE_CHARS)}…(${value.length}자)`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface AuditLogger {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * JSONL 감사 로거. 기록 실패는 **삼킨다** — 감사를 못 남긴다고 툴 호출을 죽이면 디스크 문제
 * 하나가 역방향 툴 전체를 멈춘다. 대신 실패는 stderr 로 한 번 알린다.
 */
export function createAuditLogger(logPath: string): AuditLogger {
  let chain: Promise<void> = Promise.resolve();
  let warned = false;

  const write = async (entry: AuditEntry): Promise<void> => {
    await mkdir(dirname(logPath), { recursive: true });
    const size = await stat(logPath).then(
      (s) => s.size,
      () => 0,
    );
    if (size > MAX_BYTES) {
      await rename(logPath, join(dirname(logPath), `${baseName(logPath)}.1`)).catch(() => {});
    }
    await appendFile(logPath, `${JSON.stringify(entry)}\n`);
  };

  return {
    record(entry: AuditEntry): Promise<void> {
      chain = chain.then(() =>
        write(entry).catch((error: unknown) => {
          if (warned) return;
          warned = true;
          console.warn('[daemon] 역방향 툴 감사 로그 기록 실패 (이후 경고 생략):', error);
        }),
      );
      return chain;
    },
  };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
