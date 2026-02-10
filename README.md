# ucm — Ultimate Click Machine

AI 에이전트 오케스트레이션 시스템. 데몬이 Git worktree로 태스크를 격리하고, 파이프라인 스테이지별로 AI를 spawn하여 코드 작업을 자동화한다.

## 설치

```bash
# 릴리즈 배포 (권장)
node ~/git/ucm/bin/ucm.js release   # ~/.ucm/release/ 에 복사 + 데몬 시작
cd ~/.ucm/release && npm link        # ucm 명령어 등록

# Claude Code /recall 스킬
npm run install-skill
```

릴리즈와 개발 인스턴스를 분리 운영한다. `ucm` 명령어는 릴리즈를 가리키고, 개발은 직접 실행한다.

```bash
# 릴리즈 (ucm 명령어)
ucm ui                    # 대시보드 (포트 17172)
ucm submit --title "..." --project ~/git/my-project

# 개발 (직접 실행)
UCM_DIR=~/.ucm-dev node ~/git/ucm/bin/ucm.js ui --port 17173
```

## 시작하기

```bash
# 대시보드
ucm ui

# 채팅
ucm chat

# 태스크 제출
ucm submit --title "버그 수정" --project ~/git/my-project

# 태스크 목록
ucm list

# 리뷰 승인/거절
ucm approve <taskId>
ucm reject <taskId> --feedback "이유"
```

## 아키텍처

```
ucm submit → ucmd (데몬)
               ↓
           Git worktree 생성
               ↓
           파이프라인 실행
               ↓
         ┌─→ gather (요구사항 정제)
         │   analyze (코드 분석)
         │   implement (구현)
         │   test (테스트)
         │   self-review ──→ FAIL → implement (최대 3회)
         │        ↓ PASS
         └── review (사람 승인 대기)
```

### 파이프라인

| 파이프라인 | 스테이지 | 용도 |
|-----------|---------|------|
| quick | implement → test → self-review | 간단한 작업 |
| implement | gather → analyze → implement → test → self-review | 기본 구현 |
| research | analyze | 조사/분석만 |
| thorough | gather → spec → analyze → implement → test → self-review (RSA) | 대규모 작업 |

### 하네스

파이프라인 품질을 높이는 12개 결정적 하네스:

| 하네스 | 역할 |
|--------|------|
| context-prefetch | 관련 파일 사전 조립 (`git grep` + import 추적) |
| context-budget | 토큰 예산 관리 (변수별 우선순위) |
| convention-inject | 프로젝트 코딩 컨벤션 자동 주입 |
| task-refinement | 태스크 요구사항 구체화 (Interactive Q&A / Auto-pilot) |
| lesson-inject | 과거 교훈 자동 주입 (태그 매칭 + 지수 감쇠) |
| iteration-history | 반복 실패 기억 ("What NOT to repeat") |
| rsa-dedup | RSA 결과 중복 제거 (trigram Jaccard) |
| adaptive-loop | 실패 시그니처 추적, 동일 실패 반복 시 조기 중단 |
| deterministic-gate | 결정적 검증 (구문 검사, 린트, 테스트 출력 파싱) |
| drift-detector | 계획 vs 실행 드리프트 감지 |
| gate-parser-v2 | 강화된 게이트 파서 (모순 감지, 신뢰도 판정) |
| improvement-proposal | 범위 밖 개선 기회 구조화 추출 |

### 자기 개선 루프

```
관찰 (ucm observe) → 제안 생성 → 사람 선별 → 파이프라인 실행 → 평가 → 학습 → 반복
```

## 채팅

CLI와 웹 UI 양쪽에서 사용 가능. 세션이 유지되며, UCM 데몬 명령을 직접 실행할 수 있다.

```bash
ucm chat              # CLI 채팅
```

슬래시 명령: `/help`, `/clear`, `/memory`, `/compress`, `/new`

## CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `ucmd start` | 데몬 시작 |
| `ucmd stop` | 데몬 종료 |
| `ucm submit` | 태스크 제출 |
| `ucm list` | 태스크 목록 |
| `ucm status <id>` | 태스크 상태 |
| `ucm approve <id>` | 리뷰 승인 |
| `ucm reject <id>` | 리뷰 거절 |
| `ucm diff <id>` | 변경사항 확인 |
| `ucm logs <id>` | 실행 로그 |
| `ucm chat` | 채팅 모드 |
| `ucm observe` | 로그 분석 → 개선안 생성 |
| `ucm stats` | 데몬 통계 |

## 빌딩블록 도구

UCM 파이프라인 내부에서 사용되는 독립 도구들. 단독으로도 사용 가능.

| 도구 | 설명 |
|------|------|
| `rsa` | Recursive Self Aggregation — N개 병렬 실행 + 취합 |
| `qna` | 템플릿 기반 설계 Q&A (객관식 질문 → 설계 결정 수집) |
| `spec` | EARS 요구사항 스펙 생성 + 7개 기준 검증 |
| `req` | qna → spec 반복 워크플로 |
| `prl` | 병렬 프롬프트 실행 |
| `mem` | 기억 관리 (save/search/boost/gc) |
| `memd` | 세션 감시 데몬 (자동 지식 축적) |

## 디렉토리 구조

```
~/.ucm/
  ├── daemon/          # 데몬 소켓, PID, 로그
  ├── tasks/           # pending, running, failed
  ├── proposals/       # 개선안 대기열
  ├── logs/            # 스테이지별 실행 로그
  ├── artifacts/       # 스테이지 결과물
  ├── lessons/         # 과거 실수 기록
  ├── chat/            # 채팅 세션
  └── workspaces/      # 임시 워크스페이스
```

## Release vs Dev

UCM이 자기 자신을 수정하는 개밥먹기(dogfooding)를 안전하게 하기 위해 두 가지 실행 모드가 있다.

```
개발 소스 (~/git/ucm/)          릴리즈 스냅샷 (~/.ucm/release/)
         │                                │
     npm link                        ucm release
         ↓                                ↓
  ucmd start (dev)                ucmd start (release)
  코드 수정 즉시 반영              스냅샷 고정, 안전한 운영
```

| | Release | Dev |
|---|---|---|
| 소스 위치 | `~/.ucm/release/` (복사본) | `~/git/ucm/` (git repo) |
| 데이터 | `~/.ucm/` | `~/.ucm-dev/` (`UCM_DIR`) |
| 시작 방법 | `ucm release` | `UCM_DIR=~/.ucm-dev node ~/git/ucm/bin/ucmd.js start` |
| `npm link` | `cd ~/.ucm/release && npm link` → `ucm` 명령어 | link하지 않음 (직접 실행) |
| UI 포트 | 17172 (기본) | 17173 (`--port 17173`) |
| 코드 변경 반영 | `ucm release` 재실행 필요 | 재시작 시 즉시 반영 |
| 용도 | UCM이 자기 코드를 수정하는 파이프라인 운영 | UCM 자체 개발 |
| 자기 수정 안전성 | 안전 — worktree의 변경이 실행 중 데몬에 영향 없음 | 위험 — 실행 중인 코드가 변경됨 |

### 릴리즈 업데이트

```bash
ucm release              # 코드 복사 + npm install + 데몬 재시작
```

### 개밥먹기 워크플로

```bash
# 1. 현재 코드를 릴리즈
ucm release

# 2. 릴리즈 데몬으로 UCM 자체를 수정
ucm submit --title "리팩토링" --project ~/git/ucm

# 3. 리뷰 후 승인
ucm approve <taskId>

# 4. 변경된 코드로 릴리즈 갱신
ucm release
```

## LLM 프로바이더

```bash
export LLM_PROVIDER=claude   # 또는 codex
```
