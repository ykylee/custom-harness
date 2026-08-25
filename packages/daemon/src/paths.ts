// 데이터 디렉토리 배치 (daemon-design §1) — versions/ 는 불변, data/ 는 버전 중립.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonPaths {
  root: string;
  dataDir: string;
  sessionsDir: string;
  grokHomeDir: string;
  /** pi 격리 홈 (PI_CODING_AGENT_DIR) — models.json 주입 대상 (credential-injection-design §2) */
  piHomeDir: string;
  /** omp 격리 홈 (PI_CODING_AGENT_DIR, omp 도 동일 env 실측) — models.yml·config.yml 주입 대상 (WBS 2.1.3) */
  ompHomeDir: string;
  tokenFile: string;
  pidFile: string;
  processesFile: string;
  /** 게이트웨이 API 키 암호문/폴백 저장 (credential-injection-design §1) */
  credentialsFile: string;
  settingsFile: string;
  logsDir: string;
}

/** 테스트·개발은 CUSTOM_HARNESS_HOME 으로 루트를 격리한다 */
export function resolvePaths(
  root: string = process.env.CUSTOM_HARNESS_HOME ?? join(homedir(), '.custom-harness'),
): DaemonPaths {
  const dataDir = join(root, 'data');
  return {
    root,
    dataDir,
    sessionsDir: join(dataDir, 'sessions'),
    grokHomeDir: join(dataDir, 'grok-home'),
    piHomeDir: join(dataDir, 'pi-home'),
    ompHomeDir: join(dataDir, 'omp-home'),
    tokenFile: join(dataDir, 'daemon.token'),
    pidFile: join(dataDir, 'daemon.pid'),
    processesFile: join(dataDir, 'processes.json'),
    credentialsFile: join(dataDir, 'credentials.enc'),
    settingsFile: join(dataDir, 'settings.json'),
    logsDir: join(root, 'logs'),
  };
}
