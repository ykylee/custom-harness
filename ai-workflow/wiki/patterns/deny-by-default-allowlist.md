---
type: pattern
status: active
updated: 2026-08-31
last_ingested_from: packages/daemon/src/gateway/home-isolation.ts, packages/daemon/src/workspaces/files.ts, packages/protocol/src/tools.ts
related_pages: [home-isolation, measure-dont-assume, single-policy-point]
---

# 패턴 — 거부 기본값 + allowlist

**빈 상태에서 시작해 필요한 것만 들인다.** 반대(전부 허용해 놓고 위험한 것을 빼기)는 목록이 완전해야만 성립하는데, 우리가 래핑하는 바이너리들의 표면은 완전히 알 수 없다.

## 적용 지점

### 하네스 홈

격리 홈은 **빈 디렉토리**에서 시작한다. `harness.homeLinks`(기본 `.gitconfig`·`.ssh`)만 심볼릭 링크로 반입한다. → [[concepts/home-isolation]]

이 방향이 아니었으면 불가능했다 — omp 에는 MCP 탐색을 끄는 설정 키가 **없다.** "위험한 소스를 끄는" 접근은 애초에 표면이 없었고, "홈 자체를 비우고 필요한 것만 넣는" 접근만 성립했다.

### 워크스페이스 파일 접근

워크스페이스가 임의 저장소를 여는 구조라 경로가 곧 공격면이다. 절대 경로·`..`·심링크 탈출을 **거절**하고, `realpath` 로 2차 확인한다. 허용은 워크스페이스 루트 하위뿐.

### 역방향 툴 승인

`effect: 'write'` 는 **전부** 승인 대상이다. 새 툴을 추가할 때 "이건 안전하니 빼자"가 기본값이 아니라, write 면 자동으로 승인 대상에 들어간다. → [[decisions/tool-catalog-in-protocol]]

### 아카이브 시 백킹 제거

워크스페이스를 아카이브해도 백킹 체크아웃 제거는 **`data/worktrees` 하위로 한정**한다. 사용자가 직접 만든 체크아웃은 우리 소유가 아니다.

## 실패를 삼키지 않는다

거부 기본값의 짝은 **실패 시 진행 금지**다. 격리 홈 생성에 실패하면 세션 생성이 실패한다 — 격리 없이 조용히 진행하면 거부 기본값이 무의미해진다.

예외는 명시적으로 다룬다: Windows 심볼릭 링크 반입은 권한 문제로 실패할 수 있어 **경고만 남기고 격리는 유지**한다. 반입 없이도 격리는 성립하기 때문이다 — 안전한 쪽으로 실패한다.

## 끄는 방법은 하나만, 그리고 시끄럽게

격리는 `harness.homeIsolation`(env `CUSTOM_HARNESS_HOME_ISOLATION`)로만 끌 수 있고, 꺼져 있으면 데몬이 **기동 경고**를 남긴다. 조용히 꺼진 안전장치는 없는 것보다 나쁘다.
