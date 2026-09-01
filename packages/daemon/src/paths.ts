// 데이터 디렉토리 배치 (daemon-design §1) — versions/ 는 불변, data/ 는 버전 중립.
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonPaths {
  root: string;
  dataDir: string;
  sessionsDir: string;
  /** 프로젝트·워크스페이스 레지스트리 (workspace-model §5) */
  projectsDir: string;
  /** worktree 백킹 체크아웃 (workspace-model D-1 — 데이터 디렉토리 내부) */
  worktreesDir: string;
  /** 1회성 마이그레이션 완료 마커 (workspace-model §9) */
  migrationsDir: string;
  grokHomeDir: string;
  /** pi 격리 홈 (PI_CODING_AGENT_DIR) — models.json 주입 대상 (credential-injection-design §2) */
  piHomeDir: string;
  /** omp 격리 홈 (PI_CODING_AGENT_DIR, omp 도 동일 env 실측) — models.yml·config.yml 주입 대상 (WBS 2.1.3) */
  ompHomeDir: string;
  /** 하네스 `HOME` 격리 루트 (WBS 7.2.0a, NFR-1) — 하위에 하네스별 가짜 홈 (`<harness>/`) */
  harnessHomesDir: string;
  tokenFile: string;
  pidFile: string;
  processesFile: string;
  /** 게이트웨이 API 키 암호문/폴백 저장 (credential-injection-design §1) */
  credentialsFile: string;
  settingsFile: string;
  /** 타임라인 검색 색인 (WBS 7.4.1) — 파생물이라 지워도 기동 시 재생성된다 */
  searchIndexFile: string;
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
    projectsDir: join(dataDir, 'projects'),
    worktreesDir: join(dataDir, 'worktrees'),
    migrationsDir: join(dataDir, 'migrations'),
    grokHomeDir: join(dataDir, 'grok-home'),
    piHomeDir: join(dataDir, 'pi-home'),
    ompHomeDir: join(dataDir, 'omp-home'),
    harnessHomesDir: join(dataDir, 'harness-home'),
    tokenFile: join(dataDir, 'daemon.token'),
    pidFile: join(dataDir, 'daemon.pid'),
    processesFile: join(dataDir, 'processes.json'),
    credentialsFile: join(dataDir, 'credentials.enc'),
    settingsFile: join(dataDir, 'settings.json'),
    searchIndexFile: join(dataDir, 'search-index.db'),
    logsDir: join(root, 'logs'),
  };
}
