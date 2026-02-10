# UCM 구현 진행 상황

최종 업데이트: 2026-02-10

## 완료된 작업

### Phase 1 — 코어 데몬 + 웹 GUI + 기본 파이프라인 (~90%)

ucmd.js, ucm-ui.js, ucm-watchdog.js 및 템플릿 전체 구현 완료.

### Phase 6 — Self-Update Release Cycle (100%)

- self-target 감지 (`isSelfTargetProject`, `isSelfTargetTask`)
- smoke test (syntax check + test suite, review 시 + approve 시 2회)
- `git tag ucm/pre-{taskId}` rollback point + rollback.sh
- `writeRestartMarker` / `readRestartMarker` / `clearRestartMarker` / `autoRollback`
- `restartDaemon()` → watchdog가 respawn + 헬스체크
- `lib/ucm-watchdog.js` 독립 프로세스
- DATA_VERSION 마이그레이션 시스템
- 테스트 15 assertions 추가

### 이번 세션 추가 작업

1. **ws 패키지 전환** — hand-rolled WebSocket 구현 삭제, `ws` npm 패키지로 교체. Chrome 144 호환성 문제 해결.

2. **factory-ui-review.md 버그 수정** (`docs/factory-ui-review.md` 참조):
   - P0: Path Traversal — API URL 패턴 `(.+)` → `([a-f0-9]+)` hex 검증
   - P0: task:updated 이벤트 필드 불일치 — UI에서 `data.stage`, `data.status`도 처리
   - P1: XSS escape 누락 — 모든 동적 값에 `esc()` 적용
   - P1: 빈 catch 블록 — `console.error` 추가
   - P1: CORS `*` → localhost만 허용
   - P2: state/status 통일 — meta에서 `status` → `state`
   - P2: logs lines 파라미터 — query string 파싱 추가
   - P2: approve/reject 후 detail 갱신 — `loadDetail(selectedTaskId)` 호출
   - P2: suspended 상태 UI — CSS, 정렬 order, action 버튼 추가
   - P2: requestChanges 빈 문자열 — `if (feedback)` → `if (feedback !== null)`
   - P2: Diff/Logs 빈 결과 — 안내 메시지 표시
   - P2: readBody 크기 제한 — 1MB

3. **테스트 격리** — `UCM_DIR` 환경변수 지원 추가. 테스트가 `/tmp/ucm-test-{pid}` + 포트 17777 사용. 운영 데몬(~/.ucm + 7777) 안 죽음.

4. **테스트 잔여 데이터 정리** — cancel/approve 후 done/failed 태스크 파일 삭제 추가.

5. **실시간 로그** — `--output-format stream-json`으로 전환. stdout에서 JSON 이벤트 파싱하여 tool 사용, 텍스트 응답을 실시간 WebSocket 전송. UI Logs 탭 자동 스크롤.

6. **Pipeline 선택 UI** — `handleStats`에 pipelines/defaultPipeline 포함. UI 드롭다운 동적 생성. submit 시 pipeline 전달.

7. **Summary 탭** — `/api/artifacts/{taskId}` API 추가. Summary 탭에서 `summary.md` 산출물 우선 표시, 없으면 task body fallback.

8. **factory → ucm 전체 리네임**:
   - 파일: `factoryd.js` → `ucmd.js`, `factory-ui.js` → `ucm-ui.js`, `factory-watchdog.js` → `ucm-watchdog.js`, `factory.js` → `ucm-cli.js`
   - bin: `factoryd` → `ucmd`, `factory` → `ucm`, `factory-watchdog` → `ucm-watchdog`
   - 템플릿: `factory-*.md` → `ucm-*.md` (10개)
   - 테스트: `factory.test.js` → `ucm.test.js`
   - 내부 경로: `.factory` → `.ucm`, `factory.sock` → `ucm.sock`, `factoryd.pid` → `ucmd.pid`
   - 환경변수: `FACTORY_DIR` → `UCM_DIR`, `FACTORY_HTTP_PORT` → `UCM_HTTP_PORT`
   - git 브랜치: `factory/{taskId}` → `ucm/{taskId}`, `factory/pre-{taskId}` → `ucm/pre-{taskId}`
   - config: `.factory.json` → `.ucm.json`

9. **Retry/Delete API + UI**:
   - `handleRetry` — failed → pending 이동, worktree 정리
   - `handleDelete` — done/failed 태스크 파일, 로그, 아티팩트 삭제
   - HTTP API: `/api/retry/{id}`, `/api/delete/{id}`
   - UI: failed 태스크에 Retry/Delete 버튼, done 태스크에 Delete 버튼
   - `task:deleted` WebSocket 이벤트 핸들러

10. **UI 레이아웃 수정**:
    - `#detailView` flex 레이아웃 — 탭 콘텐츠가 남은 공간 채움
    - `detail-header` flex-shrink: 0, word-break 처리
    - `.empty` 클래스 토글 수정
    - footer에 failed 카운트 추가
    - 모달 `<form>` + Enter 제출, ESC 닫기, auto-focus

11. **Graceful shutdown 개선**:
    - `activeChildren` Map으로 에이전트 child process 추적
    - shutdown 시 SIGTERM → 5초 대기 → SIGKILL 순서로 확실히 종료
    - 더 이상 in-flight 대기 타임아웃 걸리지 않음

12. **복구 시 worktree 정리**:
    - `recoverRunningTasks`에서 pending 이동 전에 `removeWorktrees` 호출
    - `removeWorktrees`에 `git worktree prune` 추가
    - `expandHome()` 적용 — `~` 경로 처리
    - 재시작 시 worktree 충돌 없이 깨끗하게 재생성

13. **`~` 경로 확장** — `expandHome()` 함수 추가. UI에서 `~/git/ucm` 입력 시 정상 처리.

14. **parseTaskFile 숫자 파싱 수정** — hex taskId가 모든 숫자일 때 `parseInt`로 변환되던 버그 수정. `key !== "id"` 조건 추가.

15. **mergeWorktrees uncommitted 변경 보호** — 머지 전 워크트리의 uncommitted 변경을 자동 커밋하여 유실 방지.

16. **실시간 로그 상세화** — tool_use 이벤트에 주요 파라미터 포함 (파일 경로, 명령어, 패턴 등).

### ucmd.js 모듈 분해 (2세션에 걸쳐 완료)

원래 ucmd.js 3,175줄을 13개 모듈로 분해하여 1,832줄로 축소.

**1차 분해** (815a97a):
- `ucmd-constants.js` (150줄) — 상수, 경로, 기본 설정
- `ucmd-task.js` (314줄) — 태스크 파싱, git 유틸, 프로세스 관리
- `ucmd-pipeline.js` (112줄) — 파이프라인 정의 파싱/정규화
- `ucmd-worktree.js` (289줄) — git worktree + 아티팩트 관리
- `ucmd-proposal.js` (269줄) — 제안 CRUD + 스냅샷
- `ucmd-prompt.js` (36줄) — 템플릿 로딩

**2차 분해** (8107a0c):
- `ucmd-agent.js` (133줄) — buildCommand, spawnAgent
- `ucmd-refinement.js` (356줄) — Refinement 세션 (QnA 인터랙티브/오토파일럿)
- `ucmd-handlers.js` (481줄) — 태스크 I/O (submit/move/scan/load/recover) + handle* 13개
- `ucmd-server.js` (586줄) — HTTP + Unix Socket + WebSocket 서버

**ucmd.js에 남은 것** (1,832줄):
- 파이프라인 엔진 (executeStageStep, executeLoopStep, executeRsaStep, executeGatherStep)
- Gather 인터랙티브 + 프로젝트 경로 resolve
- Lessons 추출/수집
- 빌드 요약, 태스크 suspend/resume
- runPipeline, scanAndEnqueue, processLoop
- ccusage 쿼타 관리
- 인프라 락 + Docker Compose
- Dev Environment (visual-check)
- 데몬 라이프사이클 (start/stop/restart/shutdown)
- 모듈 와이어링 (setDeps 패턴)

**의존성 와이어링**: `setDeps()` 패턴 — startDaemon()에서 각 모듈에 런타임 의존성 주입. config/daemonState는 getter 함수로 전달하여 항상 최신 값 참조.

**검증**: 727 tests 전체 통과, module.exports spread re-export로 테스트 import 변경 없음.

## 미완료

- P2: loadDetail race condition — AbortController 미적용
- 베이크 타임 (Phase 6 4단계) — 에러율 모니터링/품질 지표 비교는 차후
- 장기 모니터링 (Phase 6 5단계) — 충분한 데이터 축적 후

## Phase별 전체 현황

| Phase | 상태 | 비고 |
|-------|------|------|
| 1. 코어 데몬 + 웹 GUI | ~98% | race condition만 남음 |
| 2. loop/rsa + 워커 풀 | 골격 구현 | 파이프라인 엔진 있음, 실전 검증 시작 |
| 3. CLI | 구현 완료 | `lib/ucm-cli.js` factory→ucm 리네임 완료 |
| 4. 데스크톱 앱 | 미착수 | |
| 5. 입력 어댑터 | 미착수 | |
| 6. Self-Update | 완료 | 1-3단계 안전망 구현, 4-5단계 차후 |

## 테스트

- 727 tests, 727 passed
- `node test/ucm.test.js`

## 현재 상태

- 데몬: `node lib/ucmd.js start` (port 7777)
- 대시보드: http://localhost:7777
- ws 패키지 설치됨
- ucmd.js 모듈 분해 완료 (13개 모듈, 1,832줄 코어)
- main 브랜치 3커밋 ahead of origin
