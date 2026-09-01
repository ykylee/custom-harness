// CLI 출력 채널 (M7 WBS 7.5.1) — 테스트가 갈아 끼우는 지점.
//
// `write` 가 따로 있는 이유는 스트리밍이다: 델타는 줄 단위로 오지 않는다.
// `out` 으로 흘리면 토큰마다 줄바꿈이 붙어 답이 세로로 찢어진다.
export interface CliIo {
  /** 한 줄 (줄바꿈 포함) */
  out(line: string): void;
  /** 줄바꿈 없이 그대로 — 스트리밍 델타용 */
  write(chunk: string): void;
  /** 진단·과정 — stdout 을 답으로 비워 두기 위한 채널 */
  err(line: string): void;
}

export const consoleIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  write: (chunk) => process.stdout.write(chunk),
  err: (line) => process.stderr.write(`${line}\n`),
};
