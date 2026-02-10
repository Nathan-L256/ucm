# Compound Engineering

> 출처: https://every.to/guides/compound-engineering

## 핵심 철학

**"각 작업 단위가 후속 작업을 더 쉽게 만들어야 한다."**

전통적 개발에서는 기능 추가가 복잡성을 증가시킨다. Compound Engineering에서는 각 해결책이 시스템을 강화한다. 버그 수정이 해당 버그 카테고리 전체를 제거하고, 패턴이 재사용 가능한 도구가 된다.

## 메인 루프

**Plan → Work → Review → Compound → Repeat**

시간 배분: 계획/검토 80%, 작업/축적 20%

### 1. Plan — 아이디어를 설계도로 변환

- 요구사항과 제약 조건 이해
- 코드베이스 패턴 조사
- 외부 모범 사례 조사
- 솔루션 접근법 설계
- 완전성 검증

### 2. Work — 계획 실행

- 격리 환경 설정 (git worktree/branch)
- 단계별 구현
- 검증 실행 (테스트, 린팅, 타입 체킹)
- 진행 상황 추적
- 문제 발생 시 계획 수정

### 3. Review — 배포 전 평가

- 다수의 전문 에이전트가 병렬로 검토
- 발견 사항을 P1/P2/P3로 우선순위 지정
- 문제 해결 및 수정 검증
- 예방을 위한 패턴 기록

### 4. Compound — 가장 중요한 단계

- 재사용 가능한 솔루션 포착
- YAML frontmatter로 검색 가능하게 문서화
- 시스템 업데이트 (CLAUDE.md, 새 에이전트)
- 학습 내용이 향후 자동화에 적용되는지 확인

## 플러그인 시스템

| 구분 | 수량 | 설명 |
|------|------|------|
| 전문 에이전트 | 26개 | 검토, 연구, 디자인, 워크플로우, 문서화 |
| 워크플로우 명령어 | 23개 | 메인 루프 + 유틸리티 |
| 기술(Skills) | 13개 | 도메인 전문 지식 |

### 설치

```bash
# Claude Code
claude /plugin marketplace add https://github.com/EveryInc/every-marketplace
claude /plugin install compound-engineering

# OpenCode (실험적)
bunx @every-env/compound-plugin install compound-engineering --to opencode

# Codex (실험적)
bunx @every-env/compound-plugin install compound-engineering --to codex
```

## 프로젝트 구조

```
your-project/
├── CLAUDE.md              # 에이전트 지시사항, 선호도, 패턴
├── docs/
│   ├── brainstorms/       # /workflows:brainstorm 출력
│   ├── solutions/         # /workflows:compound 출력 (분류됨)
│   └── plans/             # /workflows:plan 출력
└── todos/                 # /triage 및 검토 발견 사항
    ├── 001-ready-p1-fix-auth.md
    └── 002-pending-p2-add-tests.md
```

- **CLAUDE.md** — 에이전트가 매 세션 읽는 가장 중요한 파일. 선호도, 패턴, 프로젝트 컨텍스트 포함
- **docs/solutions/** — 해결된 문제의 검색 가능한 문서. 향후 발견을 위한 축적
- **todos/** — 우선순위와 상태가 포함된 작업 항목 추적

## 핵심 워크플로우 명령어

### /workflows:brainstorm

요구사항이 불명확할 때 사용. 목적, 사용자, 제약 조건, 엣지 케이스에 대해 질문하며 명확화한다. 결과는 `docs/brainstorms/`에 저장.

```
/workflows:brainstorm Add user notifications
```

### /workflows:plan

3개의 병렬 연구 에이전트가 분석:
1. 레포 패턴
2. 프레임워크 문서
3. 업계 모범 사례

spec-flow-analyzer가 사용자 흐름과 엣지 케이스를 검토. 결과가 영향받는 파일 목록과 함께 구조화된 계획으로 병합된다.

```
/workflows:plan Add email notifications when users receive new comments
```

**Ultrathink 모드**: 40개 이상의 병렬 연구 에이전트를 생성하여 심층 분석.

### /workflows:work

4단계로 구성:
1. **Quick Start** — git worktree 생성, 브랜치 설정
2. **Execute** — 태스크별 구현
3. **Quality Check** — 5개 이상의 리뷰어 에이전트 (선택)
4. **Ship It** — 린팅, PR 생성

### /workflows:review

14개 이상의 전문 에이전트가 동시에 병렬 분석을 수행한다.

#### 보안
- **security-sentinel** — OWASP Top 10, 인젝션, 인증 결함

#### 성능
- **performance-oracle** — N+1 쿼리, 누락된 인덱스, 캐싱, 알고리즘

#### 아키텍처
- **architecture-strategist** — 설계 결정, 컴포넌트 경계
- **pattern-recognition-specialist** — 디자인 패턴, 안티패턴, 코드 스멜

#### 데이터
- **data-integrity-guardian** — 마이그레이션, 트랜잭션, 참조 무결성
- **data-migration-expert** — ID 매핑, 롤백 안전성, 프로덕션 검증

#### 품질
- **code-simplicity-reviewer** — YAGNI, 복잡성, 가독성
- **kieran-rails-reviewer** — Rails 컨벤션, Turbo Streams, 책임 분리
- **kieran-python-reviewer** — PEP 8, 타입 힌트, 관용구
- **kieran-typescript-reviewer** — 타입 안전성, ES 패턴, 아키텍처
- **dhh-rails-reviewer** — 37signals 컨벤션, Omakase 스택

#### 배포
- **deployment-verification-agent** — 체크리스트, 검증 단계, 롤백 계획

#### 프론트엔드
- **julik-frontend-races-reviewer** — JavaScript/Stimulus 레이스 컨디션

#### 에이전트 네이티브
- **agent-native-reviewer** — 에이전트의 기능 접근성 확인

#### 출력 형식

```
P1 - CRITICAL (반드시 수정):
[ ] 검색 쿼리의 SQL 인젝션 취약점 (security-sentinel)
[ ] 사용자 생성 시 트랜잭션 누락 (data-integrity-guardian)

P2 - IMPORTANT (수정 권장):
[ ] 댓글 로딩의 N+1 쿼리 (performance-oracle)
[ ] 컨트롤러에서 비즈니스 로직 수행 (kieran-rails-reviewer)

P3 - MINOR (수정하면 좋음):
[ ] 미사용 변수 (code-simplicity-reviewer)
```

### /triage

검토 발견 사항을 하나씩 제시하여 인간이 결정:
- approve (목록에 추가)
- skip (삭제)
- customize (우선순위 수정)

### /workflows:compound

6개 서브에이전트를 생성:
1. context analyzer
2. solution extractor
3. related docs finder
4. prevention strategist
5. category classifier
6. documentation writer

YAML frontmatter가 포함된 검색 가능한 마크다운을 생성한다.

### /lfg

전체 파이프라인 자동화. 아이디어에서 PR까지 50개 이상의 에이전트 실행:

plan → deepen-plan → work → review → resolve findings → browser tests → feature video → compound

```
/lfg Add dark mode toggle to settings page
```

### /resolve_pr_parallel

모든 발견 사항을 자동 처리. P1 이슈를 먼저 수정한 후 P2 처리. 각 수정은 격리된 환경에서 실행.

## 폐기해야 할 신념

### 1. "코드는 손으로 작성해야 한다"
유지보수 가능하고 올바른 문제를 해결하는 코드가 중요하다. 누가 타이핑했는지는 중요하지 않다.

### 2. "모든 라인을 수동 검토해야 한다"
자동 시스템이 동일한 문제를 포착한다. 수동 보상보다 시스템을 고쳐라.

### 3. "솔루션은 엔지니어에서 나와야 한다"
엔지니어의 역할은 AI가 추천한 솔루션 중 컨텍스트에 맞는 것을 선택하는 것이 된다.

### 4. "코드가 주요 산출물이다"
코드를 생산하는 시스템이 개별 코드보다 가치 있다.

### 5. "코드 작성이 핵심 업무다"
개발자의 업무는 가치 배출이다. 계획, 검토, 시스템 교육 모두 포함.

### 6. "첫 시도는 좋아야 한다"
첫 시도의 95%는 엉망이고, 두 번째는 50%. 이것은 실패가 아니라 프로세스다.

### 7. "코드는 자기 표현이다"
코드는 팀, 제품, 사용자의 것이다. 내려놓으면 해방되고, 피드백 수용이 나아진다.

### 8. "더 많이 타이핑하면 더 많이 배운다"
AI 구현 10개를 검토하는 개발자가 직접 2개를 타이핑한 개발자보다 더 많은 패턴을 이해한다.

### 전환의 어려움

- **타이핑이 줄면 일하지 않는 느낌** — 실제로는 중요한 결정에 대해 더 많은 사고가 필요
- **내려놓으면 위험한 느낌** — 통제력은 제약 조건, 컨벤션, 검토에 인코딩되어 있음
- **이걸 누가 만들었지?** — 계획, 검토, 품질 보증이 곧 작업. 사고는 일어났음

## 채택해야 할 신념

### 취향을 시스템에 추출

CLAUDE.md/AGENTS.md에 선호도를 문서화:
- 네이밍 컨벤션
- 에러 처리 방식
- 테스트 접근법
- 스타일 가이드
- 아키텍처 문서
- 예시가 포함된 결정 기록

전문화된 검토/테스트/배포 에이전트를 구축하고, 취향을 반영하는 skill을 생성한다.

### 50/50 규칙

| 항목 | 전통적 개발 | Compound Engineering |
|------|------------|---------------------|
| 기능 구축 | 90% | 50% |
| 시스템 개선 | 10% | 50% |

리뷰 에이전트를 만드는 데 투자한 1시간이 향후 1년간 10시간의 리뷰를 절약한다.

### 프로세스를 신뢰하되 안전망 구축

수동 검토로 보상하지 말고, 해당 단계를 신뢰할 수 있게 만드는 시스템(리뷰 에이전트, 테스트, 모니터링)을 추가하라. AI 지원은 맹신이 아니라 가드레일과 함께 확장된다.

### 에이전트-네이티브 환경

개발자가 볼 수 있고 할 수 있는 것은 에이전트도 할 수 있어야 한다:
- 테스트 실행
- 프로덕션 로그 확인
- 디버깅 스크린샷
- Pull Request 생성

완전한 환경 동등성이 필요하다.

### 병렬화

새로운 병목은 컴퓨팅 — 동시에 실행할 수 있는 에이전트 수가 중요하다. 여러 에이전트와 기능을 동시에 실행하고, 검토/테스트/문서화를 한꺼번에 수행한다.

### 계획이 새로운 코드

계획 문서가 가장 중요한 산출물이다. 상세한 계획(진실의 원천)으로 시작하라. 아이디어를 종이에서 수정하는 것이 코드에서 수정하는 것보다 저렴하다.

## 5단계 채택 사다리

### Stage 0: 수동 개발
AI 없이 한 줄씩 코드 작성. 문서/Stack Overflow로 조사. 코드 읽기와 print문으로 디버깅.

### Stage 1: 채팅 기반 지원
AI를 스마트 레퍼런스 도구로 활용 (ChatGPT, Claude, Cursor). 유용한 스니펫 복사-붙여넣기. 모든 라인을 검토하며 완전한 통제 유지.

### Stage 2: 에이전트 도구 + 라인별 검토
AI가 파일을 읽고 직접 변경 (Claude Code, Cursor Composer, Copilot Chat). 개발자가 모든 것을 승인/거부하며 게이트키핑.

### Stage 3: 계획 우선, PR만 검토 (핵심 전환점)
요구사항, 접근법, 엣지 케이스를 포함한 상세 협업 계획. AI가 감독 없이 구현. 산출물은 PR. 검토로 문제를 포착하며 감시하지 않음. **Compound Engineering이 여기서 시작.**

### Stage 4: 아이디어에서 PR까지 (단일 머신)
아이디어 → 코드베이스 조사 → 계획 → 구현 → 테스트 → 자체 검토 → 이슈 해결 → PR. 3단계: 아이디어 제시, PR 검토, 머지. 단일 머신에서 실행.

### Stage 5: 클라우드 병렬 실행
여러 디바이스에서 에이전트가 독립적으로 실행. 어디서든 에이전트에 지시. 3개 기능, 3개 에이전트가 독립 작업. 개인 기여자가 아닌 함대 지휘관.

## 단계별 레벨업 방법

### 0 → 1: 협업 시작
- 도구 하나 선택 (Cursor with Opus 4.5 또는 Claude Code)
- 먼저 질문하기
- 보일러플레이트 위임 (테스트, 설정, 반복 함수)
- 모든 것 검토
- **축적**: 잘 작동한 프롬프트 보관

### 1 → 2: 에이전트 진입 허용
- 에이전틱 모드 전환 (파일 시스템 접근)
- 타겟팅된 변경부터 시작
- 각 액션 승인
- 코드가 아닌 diff 검토
- **축적**: CLAUDE.md에 선호도 문서화

### 2 → 3: 계획을 신뢰 (핵심)
- 계획에 투자
- 에이전트가 조사하게 하기
- 계획을 명시적으로 만들기
- 실행 후 자리 비우기
- PR 수준에서 검토
- **축적**: 계획이 놓친 항목 문서화

### 3 → 4: 설명하되 계획하지 않기
- 지시가 아닌 결과를 제시
- 에이전트가 계획하게 하기
- 구현 전 접근법 승인
- 최종 PR 검토
- **축적**: 결과 중심 지시 라이브러리 구축

### 4 → 5: 모든 것을 병렬화
- 실행을 클라우드로 이동
- 병렬 작업 스트림 실행
- 큐 구축
- 사전 대응적 운영 활성화
- **축적**: 병렬화가 잘 되는 태스크 문서화

## AI 산출물에 대한 3가지 질문

1. **"가장 어려운 결정은 무엇이었나?"** — AI가 까다로운 부분과 판단 근거를 드러내게 함
2. **"어떤 대안을 거부했고, 왜?"** — 고려한 옵션을 보여주고 잘못된 선택을 포착
3. **"가장 자신 없는 부분은?"** — AI가 약점을 인정하게 함

## 에이전트-네이티브 아키텍처

### 개발 환경 체크리스트

**개발:**
- 로컬에서 앱 실행
- 테스트 스위트 실행
- 린터/타입 체커 실행
- DB 마이그레이션 실행
- 개발 데이터 시딩

**Git 작업:**
- 브랜치 생성
- 커밋 생성
- 리모트 푸시
- PR 생성
- PR 코멘트 읽기

**디버깅:**
- 로컬 로그 확인
- 프로덕션 로그 확인 (읽기 전용)
- UI 스크린샷
- 네트워크 요청 검사
- 에러 트래킹 접근

### 에이전트-네이티브 단계

| 레벨 | 범위 |
|------|------|
| Level 1 | 파일 접근, 테스트, git 커밋 |
| Level 2 | 브라우저 접근, 로컬 로그, PR 생성 |
| Level 3 | 프로덕션 로그, 에러 트래킹, 모니터링 |
| Level 4 | 티켓 시스템, 배포 기능, 외부 서비스 |

## --dangerously-skip-permissions

### 사용해야 할 때
- 프로세스를 신뢰할 때 (좋은 계획, 리뷰 시스템 구축됨)
- 안전한 환경 (샌드박스, 사용자에게 영향 없음)
- 속도가 필요할 때 (권한 요청이 워크플로우를 늦춤)

### 사용하지 말아야 할 때
- 학습 중일 때 (권한 요청이 이해를 도움)
- 프로덕션 환경 (라이브 코드에 절대 스킵 불가)
- 롤백이 어려울 때

```bash
alias cc='claude --dangerously-skip-permissions'
```

안전 메커니즘: git이 안전망 (`git reset --hard HEAD~1`), 테스트가 실수 포착, 머지 전 검토, worktree가 리스크 격리.

30초마다 권한 프롬프트가 뜨면 집중력 저하. 권한 스킵으로 5~10배 빠른 반복이 가능하며, 절약된 시간이 간헐적 롤백 비용을 초과한다.

## 디자인 워크플로우

### Baby App 접근법
1. 일회용 프로토타입 레포 생성
2. 반복적으로 "Vibe code"
3. 만족할 때까지 반복
4. 디자인 시스템 추출 (색상, 간격, 타이포그래피, 패턴)
5. 메인 앱으로 이전

### UX 디스커버리 루프
1. 여러 버전 생성
2. 각각 클릭하며 탐색
3. 사용자와 공유
4. 기능적 프로토타입에 대한 피드백 수집
5. 모든 것 삭제 후 적절한 계획으로 재시작 (프로토타입은 학습용)

### 디자이너 협업

**전통적 흐름:** 디자이너 목업 → 개발자 해석 → 왕복 → 결국 맞춤

**Compound 흐름:**
1. 디자이너가 Figma 목업 생성
2. Figma 링크와 함께 /plan 실행
3. AI가 정확히 구현
4. figma-design-sync 에이전트가 구현 일치 여부 확인
5. 디자이너가 라이브 버전 검토
6. 완벽할 때까지 반복

### 디자인 에이전트
- **design-iterator** — 스크린샷 촬영, 문제 분석, 반복 개선
- **figma-design-sync** — Figma 디자인 가져오기, 차이 식별, 자동 수정
- **design-implementation-reviewer** — 구현이 Figma 스펙과 일치하는지 확인

## Vibe Coding

사다리를 건너뛰고 Stage 4로 직행하는 철학. 원하는 것을 설명하면 에이전트가 구축한다.

**빠른 경로:**
1. 원하는 것 설명
2. 기다림 (에이전트가 파악, 코딩, 테스트, 검토, PR 생성)
3. 작동 확인; 문제점 말하면 수정

**신경 쓰지 않아도 되는 것:** 코드 품질 (리뷰 에이전트), 아키텍처 (에이전트가 합리적 선택), 테스트 (자동), 모범 사례 (에이전트에 코드화됨)

**적합한 경우:** 개인 프로젝트, 프로토타입, 실험, 조사, 내부 도구, UX 탐색

**부적합한 경우:** 사용자가 있는 프로덕션, 타인이 유지보수하는 코드, 보안 민감 앱, 성능 크리티컬 시스템

**역설:** Vibe code로 원하는 것을 발견한 후, 스펙으로 제대로 구축한다. Vibe coding은 발견을 가속하고, 최종 구현에서는 항상 스펙이 이긴다.

## 팀 협업

### 새로운 팀 역학

**전통적:** A가 코드 작성 → B가 검토 → PR 토론 → 승인 → 머지

**Compound:** A가 계획 생성 → AI가 구현 → AI 에이전트가 검토 → B가 AI 검토를 검토 → 승인 → 머지

### 팀 표준

- **계획 승인**: 구현 전 명시적 동의. 침묵은 승인이 아님
- **PR 소유권**: 작업을 시작한 사람이 코드 작성자와 무관하게 PR 소유
- **인간 검토 초점**: 의도, 비즈니스 로직, 접근법. 구문/보안/성능/스타일은 리뷰 에이전트가 처리

### 커뮤니케이션 패턴

- **기본 비동기**: 계획 생성, 검토, 승인이 회의 없이 진행
- **명시적 핸드오프**: 상태, 완료된 것, 남은 것, 컨텍스트, 계속하는 방법

### 확장 패턴

- 명확한 소유권 + 비동기 업데이트 (주요 기능마다 한 명의 소유자)
- 피처 플래그 + 작은 PR (자주 머지, 즉시 충돌 해결)
- Compound 문서 = 부족 지식 (/compound 실행으로 솔루션 문서화)

## 사용자 리서치 통합

### 전통적 갭

리서치 인터뷰 → 보고서 → Google Drive에 방치 → 개발자가 구축 → 보고서 읽지 않음 → 기능이 니즈와 불일치

### Compound 흐름

구조화된 인사이트 → 계획 컨텍스트 → AI가 인사이트 참조 → 리서치 기반 기능 → 사용 데이터로 검증

### 리서치 구조화 예시

```markdown
# research/interviews/user-123.md
---
participant: Marketing Manager, B2B SaaS
date: 2025-01-15
focus: Dashboard usage patterns
---

## Key Insights

### Insight: Morning dashboard ritual
**Quote**: "First thing every morning, I check for red flags."
**Implication**: Dashboard needs surfacing problems quickly.
**Confidence** (4/5 participants)
```

### 페르소나 구축 예시

```markdown
# personas/marketing-manager.md

## Goals
1. Prove marketing ROI to leadership
2. Identify underperforming campaigns quickly

## Frustrations
1. Too much data, hard finding what matters
2. Exporting for reports tedious

## Quotes
- "I need to see problems, not everything."
- "My boss wants a PDF, not a link."
```

### 리서치 기반 계획

```
/workflows:plan Add export scheduling

Research context:
- 3/5 interviewed users mentioned exporting weekly
- marketing-manager persona exports every Friday
- Current pain: manual export process

Design for: Automated weekly exports to email
```

## 카피라이팅 통합

### 계획에 카피 포함

```markdown
## Feature: Password Reset Flow

### User-Facing Copy
- Email subject: "Reset your password"
- Success message: "Check your email. We sent reset link."
- Error (not found): "We couldn't find account with that email. Want to create one instead?"
```

### 음성 가이드 코드화

```markdown
# skill: our-copy-voice

## Principles
1. Talk to users like humans, not robots
2. Error messages should help, not blame
3. Short sentences. Clear words.

## Words to Avoid
- "Invalid" → "didn't work"
- "Error" → describe what happened
- "Successfully" → just say what happened
- "Please" → just ask directly

## Examples
Bad: "Invalid credentials. Please try again."
Good: "That password isn't right. Try again or reset it."
```

### 카피 리뷰 에이전트
- **Clarity**: 비기술 사용자가 이해할 수 있는가?
- **Helpfulness**: 성공하는 데 도움이 되는가?
- **Tone**: 음성 가이드와 일치하는가?
- **Consistency**: 다른 곳의 유사한 텍스트와 일치하는가?

## 제품 마케팅 자동화

1. 엔지니어가 가치 제안을 포함한 계획 작성
2. AI가 기능 구현
3. AI가 계획에서 릴리스 노트 생성
4. AI가 릴리스 노트에서 소셜 포스트 생성
5. AI가 Playwright로 스크린샷 생성
6. 엔지니어가 검토 후 모든 것을 함께 배포

## 핵심 원칙 요약

- 모든 작업 단위가 후속 작업을 더 쉽게 만든다
- 취향은 검토가 아닌 시스템에 포함한다
- 직접 하기보다 시스템을 교육한다
- 검토 프로세스가 아닌 안전망을 구축한다
- 에이전트-네이티브 환경을 조성한다
- 완벽함보다 반복 속도를 추구한다
- 타이핑을 줄이고, 가치 배출을 늘린다
