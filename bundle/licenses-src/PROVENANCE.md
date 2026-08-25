# licenses-src — 동봉 라이선스 원문 반입 기록 (WBS 3.3.1, FR-4.5)

빌드 파이프라인(build-bundle.mjs)이 이 디렉토리의 원문을 번들 `licenses/` 로 동봉한다.
바이너리로만 배포되는 하네스는 로컬에 LICENSE 파일이 없어 upstream 저장소에서 반입해 고정한다.
갱신 규칙: 하네스 버전 교체 시 upstream 원문 변경 여부를 재확인하고 url·sha256·수집일을 함께 갱신.

| 파일 | 대상 | 라이선스 | 출처 | 수집일 | sha256 |
|---|---|---|---|---|---|
| `pi-LICENSE.txt` | pi (@earendil-works/pi-coding-agent) | MIT | https://raw.githubusercontent.com/earendil-works/pi/main/LICENSE | 2026-08-25 | `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48` |
| `omp-LICENSE.txt` | oh-my-pi (omp) | MIT | https://raw.githubusercontent.com/can1357/oh-my-pi/main/LICENSE | 2026-08-25 | `16c45f9d667442781f03fa198914cc39abcaa48ec5ed8f644643e554ca2fbf63` |
| `grok-LICENSE.txt` | grok build | Apache-2.0 | https://raw.githubusercontent.com/xai-org/grok-build/main/LICENSE | 2026-08-25 | `116f7778b9802e569b7fa3a532b17bd80eb13c67837def01eed093d4ea472f28` |

비고:

- pi 는 npm 패키지(0.84.1)에 LICENSE 파일이 미동봉이라 저장소 원문을 반입 (package.json `license: MIT` 실측 확인).
- grok upstream(xai-org/grok-build)에는 **NOTICE 파일이 없음**을 2026-08-25 확인(NOTICE/NOTICE.md/NOTICE.txt 404) — Apache-2.0 §4(d) NOTICE 승계 의무는 원문 LICENSE 동봉으로 충족.
- Electron·런타임 의존성(zod/ws/yaml/smol-toml)은 로컬 node_modules 의 LICENSE 파일을 빌드 시 직접 수집 — 여기 반입 불요.
