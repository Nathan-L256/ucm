# 24시간 소프트웨어 팩토리 구현 계획

## Context

ucm 레포에 24시간 자율 소프트웨어 팩토리를 추가한다. 사람은 **웹 대시보드**에서 태스크를 제출하고 진행 상황을 모니터링하며, 오케스트레이터가 내부 서브에이전트들을 관리하여 분석 → 구현 → 테스트 → 리뷰까지 자율 수행한다. 서브에이전트는 사람과 직접 대화하지 않는다. 로컬 데몬 + 웹 대시보드 구조로, CLI/GitHub/Slack/Telegram 등 어댑터를 붙일 수 있다. 데몬 하나가 여러 프로젝트의 태스크를 동시에 관리하며, 프로젝트를 오가며 병렬 작업이 가능하다.

### 핵심 원칙: 오케스트레이터

오케스트레이터는 서브에이전트를 스케줄링하고 결과를 수집하는 **내부 엔진**이다. 사람과의 주 접점은 **웹 대시보드**이고, 오케스트레이터는 그 뒤에서 동작한다.

**오케스트레이터의 역할**:
- 서브에이전트(analyze, implement, test 등)를 스케줄링하고 결과를 수집
- 파이프라인 진행 상태를 대시보드에 실시간 반영
- gather(interactive) 모드에서 요구사항 Q&A를 대시보드 UI로 중개
- 적응형 파라미터 조정 (난이도 기반)
- 리소스/쿼터 상태에 따라 동시성 조절

**서브에이전트는 사람과 직접 대화하지 않는다**:
- 서브에이전트는 프롬프트를 받아 작업하고 산출물을 반환할 뿐
- 대시보드가 진행 상태, 로그, 결과를 시각적으로 보여줌

**대화형 인터페이스는 외부 채널용**:

대시보드와 별개로, 오케스트레이터는 **채팅 프로토콜**도 지원한다. 이는 Slack, Telegram 등 외부 메신저 어댑터를 붙이기 위한 것이다.

```
[Slack 채널에서]
사람: "지금 상황이 어때?"
팩토리봇: "현재 3개 태스크가 실행 중입니다.
  - task-1(webhook v2): implement 진행 중
  - task-2(rate limit): 리뷰 대기
  상세는 http://localhost:7777 에서 확인하세요."

사람: "task-2 approve"
팩토리봇: "task-2 승인 완료. main에 merge했습니다."
```

대시보드를 열 수 없는 상황(모바일, 외출 중)에서 간단한 조작을 할 수 있도록 하는 보조 인터페이스다. Phase 5 어댑터에서 구현한다.

### 핵심 원칙: 오케스트레이션

AI 에이전트의 세 가지 근본 특성에 대응하는 설계를 한다 (참고: `docs/ai-agent-strategy.md`).

| AI 특성 | 대응 전략 | 팩토리 적용 |
|---------|----------|------------|
| 기억 불가 (정적 모델, 한정 컨텍스트) | 하네스, 컨텍스트 엔지니어링 | 작업 기억 시스템, 구조화된 산출물 |
| 비결정성 (같은 입력, 다른 출력) | 반복, 병렬, RSA | loop 스텝, 워커 풀, RSA 스텝 |
| 환각 (자신 있게 틀린 출력) | Generator-Critic, 워크플로 검증 | implement→test 루프, self-review 게이트 |

파이프라인은 단순 순차 실행이 아니라, **반복(iteration)**과 **병렬(parallelism)**을 조합하는 오케스트레이션이다.

**반복 (비결정성 대응)**: 실패 → 피드백 → 재시도 루프가 파이프라인의 핵심 패턴이다.
```
implement ─→ test ─→ 실패 ─→ implement (에러 컨텍스트 포함) ─→ test ─→ 통과
```

**병렬 (비결정성 활용)**: 독립적인 작업은 동시에 실행한다.
```
태스크 레벨:  task-1(my-api) ─────→    여러 프로젝트/태스크가 동시 실행
              task-2(my-web) ─────→    각자 독립 worktree
              task-3(my-web) ─────→
```

**검증 (환각 대응)**: Generator-Critic 패턴으로 역할을 분리하고, 결정적 도구(테스트, 린터)로 비결정적 출력을 검증한다.
```
implement(Generator) ─→ test(Critic: 결정적 검증) ─→ self-review(Critic: AI 검증)
```

파이프라인 스텝 타입:
- **stage**: 단일 AI 에이전트 실행 (analyze, implement, test 등)
- **loop**: 포함된 스텝을 반복 실행, 마지막 게이트 통과 시 종료 (피드백 루프)
- **rsa**: N개 에이전트에 다관점 병렬 실행 후 결과를 취합
- **deliberation** [차후]: 연속 실패 시 자동 발동. 다관점 병렬 분석 → 취합 → 방안 도출 (또는 spec 수정 제안). Phase 1에서는 연속 실패 시 사람에게 에스컬레이션

```
pipeline = [ step, step, ... ]
step     = "stageName"                                                           # 순차 실행
         | { "loop": [step, ...], "maxIterations": N }                           # 반복 실행
         | { "rsa": "stageName", "count": N, "strategy": "converge|diverge",     # 다관점 병렬 취합
             "perspectives": ["관점1", "관점2", ...] }                            #   (생략 시 자동 분배)
```

### 핵심 원칙: 요구사항 완수 — 반복, 다관점 분석, 취합

파이프라인은 **모든 요구사항이 충족될 때까지** 끝나지 않는다. 단순히 코드를 짜고 테스트를 돌리는 게 아니라, 막히면 같은 문제를 다른 관점의 프롬프트로 N개 독립 실행하여 결과를 취합하고, 그래도 안 되면 사람에게 보고하는 워크플로다.

**요구사항 체크리스트**:

spec.md에는 인수 기준이 체크리스트로 명시된다. self-review는 이 체크리스트를 하나씩 검증하고, 미충족 항목이 있으면 loop를 계속한다.

```markdown
# spec.md 의 인수 기준
- [x] IP당 분당 5회 제한
- [x] 429 응답 + Retry-After 헤더
- [ ] 화이트리스트 IP 지원         ← 미충족 → loop 계속
- [x] 기존 테스트 통과
```

self-review가 "체크리스트 100% 완료"를 확인해야 review 단계로 넘어간다. 미충족 항목이 남아 있으면 해당 항목을 피드백으로 implement에 전달한다. **self-review는 implement와 다른 모델(프로바이더)로 실행한다.** 같은 모델이 Generator와 Critic을 겸하면 같은 사각지대를 공유하기 때문이다.

**막힌 상황 → 다관점 병렬 분석 (deliberation)** [차후]:

loop를 반복해도 특정 요구사항을 충족하지 못하면, 단순 재시도 대신 **deliberation 스텝**이 개입한다. Phase 1에서는 연속 실패 시 task failed로 전환하여 사람에게 에스컬레이션한다. 같은 문제를 다른 관점의 프롬프트로 N개 에이전트에 독립 실행하고, 취합 에이전트가 결과를 통합하여 새 방안을 도출한다. 에이전트 간 실시간 상호작용은 없다 — RSA와 동일한 메커니즘이다.

```
loop iteration 1: implement → test FAIL (요구사항 3 미충족)
loop iteration 2: implement (피드백) → test FAIL (여전히 미충족)
→ maxIterations 도달 전, 연속 실패 감지 → deliberation 발동

[deliberation — 다관점 병렬 분석]
  agent-1 (미들웨어 관점): 화이트리스트를 미들웨어 레벨로 구현 → skip 옵션 활용
  agent-2 (운영 관점): 설정 파일 기반으로 IP 목록 관리 → config.json 활용
  agent-3 (통합 관점): 기존 rate limit과 합쳐서 하나의 config으로 관리
  → 취합 에이전트: 세 산출물에서 공통점 + 보완점 추출
  → "express-rate-limit의 skip 옵션 + config.json으로 IP 관리" 도출
  → 취합된 방안으로 implement 재실행
```

**요구사항 자체가 문제일 때 → 대안 도출**:

기술적으로 불가능하거나, 요구사항 간 충돌이 있을 때는 요구사항 자체를 수정하는 제안을 한다.

```
[deliberation — 요구사항 충돌 감지]
  문제: "실시간 알림"과 "폴링 방식"이 모순
  agent-1 (실시간 관점): WebSocket으로 실시간 구현, 폴링은 fallback
  agent-2 (단순성 관점): SSE가 WebSocket보다 단순하고 요구에 충분
  → 취합: spec 수정 제안 — "SSE 기반 실시간 + 폴링 fallback"
  → spec.md 업데이트 (git commit으로 변경 추적)
  → 수정된 spec 기반으로 구현 재개
```

spec 수정이 발생하면 summary.md에 **"원래 요구사항 → 변경 이유 → 최종 취합 결과"**가 기록되어, 사람이 review할 때 왜 요구사항이 바뀌었는지 알 수 있다.

**deliberation 스텝의 동작**:

| 트리거 | 동작 |
|--------|------|
| 같은 요구사항이 2회 연속 실패 | rsa(deliberation, 3, converge) — 다관점 병렬 분석 후 방안 취합 |
| 요구사항 간 충돌 감지 | rsa(deliberation, 3, converge) — 다관점 분석 후 대안 취합, spec 수정 제안 |
| maxIterations 도달 직전 | 마지막 기회 — deliberation 후 1회 더 시도 |
| deliberation 후에도 실패 | failed가 아니라 **review로 전달** — 미충족 항목 + 시도 내역 + 제안을 사람에게 보고 |

핵심: **자동으로 포기하지 않는다.** 끝까지 방법을 찾고, 그래도 안 되면 사람에게 "이 부분은 이런 이유로 못 했고, 이런 대안을 제안합니다"라고 보고한다.

### 핵심 원칙: 최소 컨텍스트

서브에이전트는 **자기 역할에 딱 맞는 컨텍스트만** 받고, 결과만 파일로 남긴다. 전체 히스토리나 다른 에이전트의 내부 사정을 알 필요가 없다.

**왜 최소 컨텍스트인가**:
- AI의 컨텍스트 윈도우는 유한하다. 불필요한 정보를 넣으면 핵심을 놓친다
- 각 에이전트가 명확한 입력/출력 계약을 가지면 교체·재실행이 쉽다
- 산출물 파일이 유일한 통신 채널이므로 디버깅이 쉽다 (파일만 보면 됨)

**에이전트별 컨텍스트 매핑**:

| 에이전트 | 받는 컨텍스트 | 만드는 산출물 |
|----------|-------------|-------------|
| gather | 태스크 원문, 코드베이스 접근 | `gather.md` (정제된 요구사항 + Q&A 기록) |
| spec | `gather.md` (또는 태스크 원문) | `spec.md` (구조화된 명세 + 인수 기준) |
| analyze | `spec.md`, 코드베이스 접근, [DevTools: 기존 화면] | `analyze.md` (영향 범위 + 구현 계획 + 난이도 판정) |
| implement | `spec.md`, `analyze.md`, 코드베이스 접근, [DevTools], [피드백] | 코드 변경 + commit + `implement.md` (변경 요약, 덮어쓰기) |
| visual-check | `spec.md`, `implement.md`, DevTools 접근 | `visual-check.md` (시각 검증 결과, 덮어쓰기) |
| test | `spec.md`, `implement.md`, 코드베이스 접근, [DevTools: e2e] | `test.md` (테스트 결과, 덮어쓰기) |
| self-review | `spec.md`, 전체 diff | `self-review.md` (체크리스트 전수 검증 결과) |
| deliberation | `spec.md`, `test.md`(실패 내역), 코드베이스 접근 | `deliberation.md` (다관점 분석 내역 + 취합 방안, 또는 spec 수정 제안) |
| research | 태스크 원문, 코드베이스/웹 접근 | `research.md` (조사 보고서) |

`[DevTools]` 표기는 프론트엔드 프로젝트일 때만 해당. 백엔드 태스크에서는 DevTools 없이 실행된다.

**핵심: 산출물 파일이 유일한 인터페이스다.**

```
gather → gather.md ─┐
                     ├→ spec → spec.md ─┐
                                         ├→ analyze → analyze.md ─┐
                                         │                         ├→ implement → code + implement.md
                                         │                         │        ↓
                                         │                         │   test → test.md (FAIL)
                                         │                         │        ↓ (피드백: test.md)
                                         │                         ├→ implement → code + implement.md (덮어쓰기)
                                         │                         │        ↓
                                         │                         │   test → test.md (PASS)
                                         └─────────────────────────┴→ self-review → self-review.md
```

각 에이전트는 자기에게 명시된 파일만 읽고, 자기 산출물만 쓴다. 오케스트레이터가 어떤 파일을 어떤 에이전트에게 넘길지 결정한다.

### 핵심 원칙: 적응형 오케스트레이션

파이프라인의 반복 횟수, 병렬 에이전트 수, 워크플로 구성은 고정값이 아니라 **태스크의 난이도와 성격에 따라 동적으로 조정**된다.

파이프라인은 **난이도**와 **품질 수준** 두 축으로 조정된다.

**난이도 판정**: analyze 단계에서 태스크의 복잡도를 판정한다.

**품질 수준**: 태스크 제출 시 사람이 지정하거나, 오케스트레이터가 태스크 성격에 따라 자동 결정한다.

```json
// analyze 산출물
{
  "difficulty": "simple | moderate | complex",
  "estimatedFiles": 3,
  "estimatedScope": "단일 함수 수정",
  "risks": ["기존 테스트 깨질 가능성"]
}
```

```yaml
# 태스크 frontmatter
quality: normal | high   # 기본: normal. 설계/기획은 자동 high
```

**핵심: 고품질이 필요한 단계는 다관점 병렬 실행 + 취합**

같은 작업이라도 관점을 달리하여 여러 에이전트가 병렬로 실행하면, 한 에이전트가 놓치는 고려사항을 다른 에이전트가 잡아낸다. 특히 **설계·기획·분석** 단계에서 이 패턴이 중요하다.

```
[normal quality] 분석을 1개 에이전트가 수행
  agent-1: "파일 A, B에 영향, 방법 X로 구현"
  → 그대로 사용

[high quality] 같은 분석을 3개 에이전트가 각자 다른 관점으로 수행
  agent-1 (성능 관점): "파일 A, B에 영향. 캐시 레이어 필요"
  agent-2 (보안 관점): "파일 A, C에 영향. 입력 검증 누락"
  agent-3 (유지보수 관점): "파일 A, B, D에 영향. 기존 패턴과 불일치 위험"
  → 취합: 모든 관점을 통합한 포괄적 분석
```

**난이도 × 품질 매트릭스**:

| 난이도 | normal 품질 | high 품질 |
|--------|-----------|-----------|
| **simple** | analyze → implement → review | analyze → implement → review |
| **moderate** | analyze → loop(impl → test, 3) → self-review | **rsa(analyze, 3)** → loop(impl → test, 3) → self-review |
| **complex** | rsa(analyze, 3) → loop(impl → test, 5) → self-review | **rsa(analyze, 5)** → **rsa(spec, 3, diverge)** → loop(impl → test, 5) → **rsa(self-review, 3)** |

high quality에서는 설계·분석 단계뿐 아니라 **self-review도 다관점**으로 실행한다. 여러 리뷰어가 각자 다른 기준(성능, 보안, 코드 품질 등)으로 검토하고 취합한다.

**자동 high quality 적용**:

다음 성격의 태스크는 사람이 지정하지 않아도 자동으로 high quality:
- `pipeline: design` — 아키텍처/API 설계
- `pipeline: research` — 조사/기획
- spec 단계 — 요구사항 명세는 항상 꼼꼼해야 하므로
- analyze에서 difficulty: complex로 판정된 경우

**다관점 프롬프트**:

RSA로 병렬 실행할 때, 각 에이전트에 **서로 다른 관점 지시**를 넣는다. 같은 프롬프트를 복사하는 게 아니라, 관점을 분배한다.

```json
// rsa 실행 시 관점 분배
{
  "rsa": "analyze",
  "count": 3,
  "strategy": "converge",
  "perspectives": ["성능/확장성", "보안/안전성", "유지보수/코드 품질"]
}
```

perspectives를 지정하지 않으면 오케스트레이터가 태스크 성격에 맞게 자동 분배한다. 예:
- 백엔드 API → 성능, 보안, 에러 처리
- 프론트엔드 UI → 접근성, 반응형, 사용성
- DB 스키마 → 정규화, 쿼리 성능, 마이그레이션 안전성
- 기획/설계 → 기술 타당성, 비용/복잡도, 확장성

**멀티 프로바이더 — 모델 다양성** [차후]:

관점뿐 아니라 **모델 자체를 섞어서** 다양성을 높일 수 있다. 같은 모델은 비슷한 편향을 갖기 때문에, 서로 다른 모델이 같은 문제를 보면 다른 해법을 제시한다.

```json
{
  "rsa": "analyze",
  "count": 3,
  "strategy": "converge",
  "providers": ["claude", "codex", "claude"]
}
```

providers를 지정하면 각 에이전트가 다른 모델로 실행된다. 생략하면 defaultProvider를 사용한다. deliberation에서도 모델을 섞으면 한 모델의 사각지대를 다른 모델이 보완할 수 있다.

config에 등록된 프로바이더라면 어떤 것이든 사용 가능하다. 프로바이더별로 command(실행 방법)가 다르므로, 서브에이전트 spawn 시 해당 프로바이더의 command를 사용한다.

**예시**:
```
태스크: "README에 배지 추가"
  → difficulty: simple, quality: normal
  → analyze → implement → review

태스크: "결제 시스템에 환불 기능 추가"
  → difficulty: complex, quality: auto → high
  → rsa(analyze, 5, converge, [성능, 보안, 에러처리, DB일관성, 기존코드호환])
    → 5개 관점의 분석 취합
  → rsa(spec, 3, diverge) → 요구사항의 빈틈 탐색
  → loop(implement → test, max 5)
  → rsa(self-review, 3, converge, [성능, 보안, 코드품질])
  → review

태스크: "x402 프로토콜 조사" (pipeline: research)
  → quality: auto → high
  → rsa(research, 5, converge, [프로토콜스펙, 구현사례, 보안, 생태계, 제한사항])
  → 5개 관점의 종합 보고서

태스크: "웹훅 v2 API 설계" (pipeline: design)
  → quality: auto → high
  → rsa(analyze, 3, converge) → 현황 분석
  → rsa(design, 5, diverge, [RESTful, 이벤트드리븐, 성능최적화, 하위호환, 확장성])
  → 5개 설계안에서 상위 관점 도출 → 최종 설계
```

**config.json의 파이프라인 정의는 기본 템플릿**이고, 난이도 판정 + 품질 수준에 따라 오케스트레이터가 실제 실행 파라미터를 오버라이드한다. 사람이 태스크 제출 시 `quality: high`를 명시하거나, "이건 꼼꼼하게 해줘" 같이 힌트를 줄 수도 있다.

### 핵심 원칙: 로컬 리소스 인식

로컬 머신은 한 대이고 CPU, 메모리, 디스크 모두 유한하다. 팩토리는 **현재 리소스 상태를 상시 모니터링**하여 동시 작업량을 동적으로 조절하고, 필요하면 정리 작업을 수행한다.

**모니터링 지표**:

| 지표 | 측정 방법 | 임계값 (기본) |
|------|----------|-------------|
| CPU 사용률 | `os.loadavg()` / CPU 코어 수 | 80% |
| 메모리 잔여 | `os.freemem()` / `os.totalmem()` | 가용 20% 미만 |
| 디스크 잔여 | `~/.factory/` 마운트 포인트의 여유 공간 | 가용 5GB 미만 |
| Docker 리소스 | `docker stats` (컨테이너 실행 중일 때) | — |

**동적 동시성 조절**:

config의 `concurrency`는 **상한선**이지, 항상 그만큼 실행하는 게 아니다. 오케스트레이터는 리소스 상태에 따라 실제 동시 실행 수를 조절한다.

```
리소스 여유 충분  → concurrency 상한까지 태스크 실행
리소스 압박       → 신규 태스크 픽업 중단, 실행 중인 것만 완료 대기
리소스 위험       → 실행 중 태스크도 stage 사이에서 일시정지 (suspended)
```

**구체적 동작**:

1. **스케줄러 체크**: 태스크를 큐에서 꺼낼 때마다 리소스 체크
   - 여유 있음 → 실행
   - 압박 → 스킵 (다음 스캔까지 대기)
2. **stage 간 체크**: 하나의 stage가 끝나고 다음 stage 시작 전에 리소스 체크
   - 위험 수준이면 태스크를 suspended로 전환 (쿼터 부족과 동일한 메커니즘)
3. **RSA 제한**: rsa 스텝의 에이전트 수를 리소스에 맞춰 축소
   - 예: RSA 5 요청이지만 메모리 부족 → RSA 3 또는 RSA 2로 축소 실행

**정리 작업 (Cleanup)**:

리소스가 부족하거나 누적 데이터가 쌓이면 오케스트레이터가 자동으로 정리한다.

| 대상 | 조건 | 정리 방식 |
|------|------|----------|
| 완료된 worktree | done/failed 상태 + 보존 기간 경과 | `git worktree remove` + 브랜치 삭제 |
| 오래된 산출물 | done/failed + 보존 기간 경과 | `artifacts/{task-id}/` 삭제 |
| 오래된 로그 | 크기 초과 또는 기간 경과 | truncate 또는 삭제 |
| Docker 잔여물 | 테스트 후 미정리 | `docker compose down -v`, `docker system prune` |
| 고아 worktree | 태스크 파일은 없는데 worktree만 남은 경우 | worktree + 브랜치 삭제 |

**정리 타이밍**:
- **주기적**: 데몬 스캔 루프마다 경량 체크 (보존 기간 경과한 것만)
- **디스크 압박 시**: 즉시 done/failed 태스크부터 정리
- **수동**: 사람이 채팅으로 "정리해줘" 또는 "디스크 확보해줘" 요청
- **데몬 시작 시**: 고아 worktree, 미정리 Docker 컨테이너 탐지 + 정리

**config.json 확장**:
```json
{
  "resources": {
    "cpuThreshold": 0.8,
    "memoryMinFreeMb": 2048,
    "diskMinFreeGb": 5,
    "checkIntervalMs": 30000
  },
  "cleanup": {
    "retentionDays": 7,
    "autoCleanOnDiskPressure": true,
    "dockerPruneAfterTest": true
  }
}
```

**오케스트레이터 채팅 연동**:
```
🤖: "메모리 사용량이 85%에 도달했습니다. 새 태스크 픽업을 일시 중단하고,
     현재 실행 중인 task-1, task-2만 완료합니다."

🤖: "디스크 여유가 3GB로 부족합니다. 완료된 태스크 5건의 worktree와
     산출물을 정리하면 12GB를 확보할 수 있습니다. 정리할까요?"
👤: "해줘"
🤖: "정리 완료. 12.3GB 확보. 디스크 여유: 15.3GB. 태스크 픽업을 재개합니다."
```

### 핵심 원칙: 쿼터 관리

Claude Max 플랜은 5시간 롤링 윈도우와 주간 제한이 있다. 팩토리가 쿼터를 독점하면 대화형 작업이 불가능해진다. ccusage를 통해 실제 소비량을 측정하고, 모드별로 사용 한도를 조절한다.

**모드 기반 쿼터 배분**:

| 모드 | 팩토리 몫 | 대화형 예비 | 전환 방식 |
|------|----------|------------|----------|
| work | 50% | 50% | 수동 (출근 시) |
| off | 90% | 10% | 수동 (퇴근 시) |

**동작**:

stage 실행 전마다 `ccusage blocks --json`으로 현재 5시간 윈도우의 소비량을 확인한다.

```
stage 시작 전
  → ccusage blocks --json
  → 현재 모드의 팩토리 몫 확인
  → 팩토리 몫의 80% 소진 → 신규 태스크 픽업 중단 (soft limit)
  → 팩토리 몫의 95% 소진 → 실행 중 태스크도 stage 간 일시정지 (hard limit)
```

**이중 안전망**:

| 장치 | 역할 |
|------|------|
| ccusage 체크 | 소진 **전에** 미리 속도 조절 |
| stderr rate limit 감지 (기존) | 소진 **후** 감지하는 안전망 |

ccusage가 미설치되어 있으면 기존 rate limit 감지만으로 동작한다.

**차후 계획**: ccusage 의존 제거, `~/.claude/` JSONL 직접 파싱으로 내재화.

### 핵심 원칙: 장애 복구와 타임아웃

**장애 구분**:

stage 종료 상태를 세 가지로 구분한다.

| 종료 상태 | 판정 기준 | 처리 |
|-----------|----------|------|
| 정상 완료 | exit 0 | 다음 stage로 |
| 게이트 실패 | exit 1 (테스트 실패 등) | loop 재시도 (기존 설계) |
| 크래시 | exit > 1, OOM, 타임아웃, SIGKILL | 1회 재시도 → 또 실패 시 task failed |

**타임아웃**:

작업 복잡도에 따라 타임아웃을 차등 적용한다. analyze 단계에서 난이도를 판정하면 해당 값이 적용되고, analyze 자체에는 config 기본값이 적용된다.

| 난이도 | stage 타임아웃 | task 타임아웃 |
|--------|--------------|-------------|
| simple | 10분 | 30분 |
| moderate | 30분 | 2시간 |
| complex | 1시간 | 4시간 |

타임아웃 초과 시: SIGTERM → 10초 대기 → SIGKILL → 크래시 처리와 동일. 태스크 제출 시 사람이 직접 타임아웃을 지정할 수도 있다.

**일반 원칙**:

복잡한 복구 로직을 짜지 않는다. worktree 격리 덕분에 최악의 경우에도 task failed로 빠지면 되고, 사람이 로그 보고 판단한다.

| 장애 | 처리 |
|------|------|
| 에이전트 OOM/크래시 | 1회 재시도 → failed |
| git 실패 | 1회 재시도 → failed |
| Docker/dev server 실패 | 1회 재시도 → failed |
| 디스크 부족 | 자동 cleanup 시도 → 여전히 부족 → 데몬 paused |

### 핵심 원칙: 작업 기억

AI는 세션이 끝나면 모든 컨텍스트를 잃는다. 팩토리는 이를 극복하기 위해 **구조화된 작업 기억**을 유지한다.

**단계 간 기억**: 각 산출물 파일의 **현재 상태**가 다음 stage의 입력이 된다. loop로 덮어쓰여도 항상 최신 버전이 다음 에이전트에 넘어간다.
```
spec.md + analyze.md   → implement 컨텍스트에 주입
spec.md + implement.md → test 컨텍스트에 주입
test.md (실패 시)       → implement 피드백으로 주입 (loop, implement.md 덮어쓰기)
```

**일시정지/재개 기억**: suspended → resume 시 에이전트가 작업 내역을 재파악한다.
- 중단 시점 저장: 현재 stage 이름, loop iteration 횟수, task 상태를 frontmatter에 기록
- 재개 시 복원이 아닌 **재파악**: 에이전트가 worktree의 코드 상태, 산출물 파일들, git log를 읽고 현재 상황을 스스로 판단
- LLM 컨텍스트(대화 히스토리)는 복원되지 않는다 — 산출물과 코드가 유일한 상태 전달 수단

**데몬 재시작 기억**: 데몬이 종료/재시작되어도 작업 상태가 완전히 보존된다.
- 태스크 .md 파일의 frontmatter에 현재 상태 기록
- `artifacts/{task-id}/` 에 모든 stage 산출물 구조화 저장
- worktree는 파일시스템에 그대로 존재

**산출물 저장 구조**:
```
~/.factory/artifacts/{task-id}/
├── task.md                            # 원본 태스크 설명
├── summary.md                         # ★ 최종 요약 (사람이 review할 때 보는 것)
├── workspace.json                     # 워크스페이스 매니페스트
├── gather.md                          # 요구사항 (최신 상태만)
├── spec.md                            # 명세 (최신 상태만)
├── analyze.md                         # 분석 결과 (최신 상태만)
├── implement.md                       # 구현 요약 (최신 상태만)
├── test.md                            # 테스트 결과 (최신 상태만)
├── self-review.md                     # 셀프 리뷰 (최신 상태만)
└── memory.json                        # 실행 메타
```

**memory.json 구조**:
```json
{
  "templateVersion": "5f8e313",
  "timeline": [],
  "metrics": {
    "totalSpawns": 8,
    "loopIterations": 2,
    "crashes": [],
    "result": "done",
    "reviewScore": 4,
    "reviewComment": "커밋 구조 깔끔"
  }
}
```
`templateVersion`은 `templates/` 디렉토리의 마지막 git commit hash. templateVersion별 평균 reviewScore를 비교하여 어떤 템플릿 변경이 효과 있었는지 데이터로 확인한다.

**핵심: 산출물은 항상 최신 상태 하나만 유지한다.**

`implement-1.md`, `implement-2.md` 같은 번호 붙은 히스토리를 쌓지 않는다. loop 재실행 시 `implement.md`를 **덮어쓴다**. 파이프라인 진행 기록은 `memory.json`의 `timeline`에 남긴다.

```json
// memory.json timeline 예시
"timeline": [
  { "stage": "spec", "at": "...", "result": "done" },
  { "stage": "analyze", "at": "...", "result": "done", "difficulty": "moderate" },
  { "stage": "implement", "at": "...", "result": "done", "iteration": 1 },
  { "stage": "test", "at": "...", "result": "fail", "iteration": 1, "error": "auth.test.js line 42" },
  { "stage": "implement", "at": "...", "result": "done", "iteration": 2 },
  { "stage": "test", "at": "...", "result": "pass", "iteration": 2 },
  { "stage": "self-review", "at": "...", "result": "pass" }
]
```

**산출물 파일은 최신 결과만, 과정은 timeline으로 추적한다.** 별도 git repo를 만들지 않아 태스크별 오버헤드가 없다.

**태스크 간 시간순 취합**:

여러 태스크가 같은 프로젝트를 동시에 수정할 수 있다. approve 시 **시간 순서대로** merge하여 선행 태스크의 변경이 후행 태스크에 반영되도록 한다.

```
task-1 (13:00 완료) → approve → merge 먼저
task-2 (13:05 완료) → approve → task-1 변경분 위에 merge
                       ↓ conflict 발생 시
                       task-2의 worktree에 task-1을 rebase → 재검증 → 다시 review
```

오케스트레이터는 같은 프로젝트의 review 대기 태스크를 **완료 시각 순으로 정렬**하여 approve 순서를 안내한다. 먼저 끝난 것부터 승인해야 충돌 가능성이 줄어든다.

**사람이 보는 것**: `summary.md` + 커밋 히스토리 + diff. 이것만으로 승인 판단이 가능해야 한다. 산출물 파일을 열어볼 수도 있지만, 거기에도 최신 결과만 있으므로 깔끔하다.

### 핵심 원칙: 시행착오 학습 (Lessons Learned)

팩토리는 파이프라인 실행 중 발생한 시행착오에서 교훈을 추출하여 저장한다. 같은 실수를 반복하지 않기 위한 장치다.

**교훈이 나오는 시점**:

| 시점 | 교훈 예시 |
|------|----------|
| loop 실패 → 성공 | "이 에러는 이렇게 고치면 된다" |
| 크래시 → 재시도 성공 | "타임아웃은 이 정도 필요하다" |
| 사람 review 피드백 | "이 접근은 안 되고 이렇게 해야 한다" |
| reject | "이 유형의 태스크는 이 방식이 안 통한다" |

**추출**: 파이프라인 종료 시 (done이든 failed든) summary 생성 직후에 lessons 추출 스텝을 실행한다. 산출물(test.md 실패 내역, implement.md 수정 내역, reviewScore, reviewComment)을 읽고 "문제 → 해결" 패턴을 추출한다.

```
파이프라인 완료 → summary.md 생성 → lessons 추출 → lessons 저장
```

**저장 구조**:

```
~/.factory/lessons/
├── {project-name}/
│   ├── lesson-abc123.md
│   └── lesson-def456.md
└── global/
    └── lesson-ghi789.md
```

```markdown
---
task: abc123
project: my-api
tags: [rate-limit, express, middleware]
stage: implement→test loop
created: 2026-02-08T15:00:00Z
---

## 문제
express-rate-limit의 skip 옵션에 async 함수를 넘기면 무시됨

## 해결
skip 대신 keyGenerator에서 화이트리스트 IP를 체크하여 빈 키 반환
```

프로젝트 특화 교훈은 `{project-name}/`에, 범용 교훈은 `global/`에 저장한다.

**활용 — 컨텍스트 주입** [차후]:

새 태스크의 analyze/implement 단계에서 관련 교훈을 검색하여 에이전트 컨텍스트에 주입한다. Phase 1에서는 추출 + 저장만 구현하고, 검색 + 주입은 차후에 추가한다.

```
[차후] implement 실행 시
  → lessons에서 프로젝트 + 태그로 검색
  → 관련 교훈 발견: "express-rate-limit skip에 async 안 됨"
  → implement 에이전트 컨텍스트에 주입
  → 같은 실수 반복 안 함
```

### 핵심 원칙: 사람이 이해 가능한 결과물

AI가 만든 결과물은 사람이 읽고 **왜 그런 판단을 했는지** 이해할 수 있어야 한다. 승인할 때 판단 근거가 없으면 승인할 수 없다.

**커밋 구조**:

커밋은 가능한 한 **논리적 변경 단위**로 나누도록 지시한다. 거대 단일 커밋보다 관심사별로 나눈 커밋이 리뷰하기 쉽다. 다만 AI가 완벽한 아토믹 커밋을 일관되게 만들기는 어렵고, 중간 커밋에서 빌드가 깨질 수도 있다. 최종 결과물이 동작하면 허용한다.

```
# 이상적 예시:
abc1234 feat: rate limit 미들웨어 추가
def5678 feat: 로그인 라우터에 rate limit 적용
ghi9012 test: rate limit 동작 테스트 추가
jkl3456 fix: 429 응답에 Retry-After 헤더 추가

# 최소 기대:
abc1234 feat: rate limit 구현
def5678 test: rate limit 테스트 추가
```

implement 에이전트에게 다음을 지시하되, 엄격한 보장은 아니다:
- 논리적 단위로 나눠서 커밋할 것 (best effort)
- 커밋 메시지에 "무엇을" + "왜"를 기록할 것
- conventional commit 형식 사용 (`feat:`, `fix:`, `test:`, `refactor:` 등)

**최종 결과물만 깔끔하게**:

중간 과정의 시시콜콜한 기록은 필요 없다. 사람이 review할 때 보는 건 **최종 결과물**이고, 그것만 잘 설명되면 된다.

```
[review 화면에서 사람이 보는 것]

1. 커밋 히스토리 — 변경 흐름 파악
2. summary.md — 뭘 했고, 왜 이렇게 했는지 (1페이지 요약)
3. diff — 실제 코드 변경

이것만 보고 approve / reject / request-changes 판단
```

`summary.md`는 파이프라인 종료 시 자동 생성되는 **최종 요약**이다:
- 무엇을 변경했는지 (변경 파일 목록 + 요약)
- 왜 이 방식을 선택했는지 (핵심 판단 근거만 간결하게)
- 테스트 결과 (pass/fail 한 줄)
- 알려진 제한사항이나 주의점 (있으면)

중간 산출물(analyze.md, test-N.md 등)은 파이프라인 내부용이다. 에이전트 간 컨텍스트 전달에 쓰이고, 사람이 굳이 볼 필요는 없다. 필요하면 열어볼 수 있지만, review의 기본 뷰는 summary + 커밋 + diff다.

조사(research)도 마찬가지다. 과정의 모든 질문-답변을 나열하는 게 아니라, **최종 보고서**가 "A, B, C를 비교한 결과 X 이유로 A를 추천합니다" 식으로 깔끔하게 정리되면 된다.

### 핵심 원칙: 원본 격리

모든 태스크는 **git worktree**에서 실행된다. 원본 프로젝트의 코드는 절대 직접 수정하지 않는다. 태스크별로 브랜치 + worktree를 생성하여 완전히 격리된 환경에서 작업하고, 파이프라인이 끝나면 사람의 승인을 받아야만 원본에 통합된다.

**단일 프로젝트 태스크**:
```
~/git/my-api (main) ────────────────────────────────────→
    ├─ factory/abc123 (worktree) → rate limit 구현 → 승인 → merge ↗
    └─ factory/def456 (worktree) → 로깅 개선 → 승인 → merge ──↗
```

**크로스-레포 태스크** — 하나의 태스크가 여러 레포를 동시에 변경:
```
태스크: "webhook v2 콘솔 연동" (id: xyz789)

~/git/lambda256-fe (main) ──────────────────────────────→
    └─ factory/xyz789 (worktree) ─┐
~/git/baas-console-be (main) ───────────────────────────→
    └─ factory/xyz789 (worktree) ─┼─ 하나의 태스크로
~/git/nodit-subscription-worker (main) ─────────────────→  묶여서 작업
    └─ factory/xyz789 (worktree) ─┘
                                   ↓
                              모든 레포 변경을 한 번에 review
                                   ↓
                         approve → 전체 merge / reject → 전체 폐기
```

레거시 시스템처럼 역할이 여러 레포에 분산된 환경에서, 하나의 기능 변경이 여러 레포를 동시에 건드려야 하는 경우를 지원한다. AI 에이전트는 모든 worktree를 하나의 워크스페이스로 인식하고 레포 간 의존성을 파악하여 일관된 변경을 수행한다.

**최소 컨텍스트 원칙과의 트레이드오프**: 크로스-레포 태스크에서는 레포 간 API 계약, 타입 정의, 호출 규약 등을 추가 컨텍스트로 주입해야 하므로 "최소 컨텍스트" 원칙을 엄격히 적용하기 어렵다. 컨텍스트 윈도우 부담이 커지므로, 크로스-레포 태스크는 난이도를 한 단계 올려서 취급한다.

### 핵심 원칙: 개밥먹기 (Dogfooding)

이 소프트웨어 팩토리 자체를 소프트웨어 팩토리로 개발한다. Phase 1 이후의 모든 기능 추가·버그 수정은 팩토리에 태스크로 넣어서 팩토리가 스스로 자신을 발전시키는 구조다.

**릴리즈 간 마이그레이션**:

팩토리가 자기 자신을 업데이트하면 config 포맷, 산출물 구조, 데몬 프로토콜 등이 변경될 수 있다. 이를 안전하게 처리하기 위해 **마이그레이션 파이프라인**을 내장한다.

```
릴리즈 v0.2 → v0.3 업데이트 시:

1. 팩토리가 자신의 코드를 변경하는 태스크 완료 → review
2. approve 시 merge + 데몬 재시작
3. 재시작 시 마이그레이션 체크:
   - state.json 스키마 변경 → 자동 마이그레이션
   - config.json 새 필드 → 기본값으로 채우기
   - artifacts 구조 변경 → 기존 태스크에 영향 없도록 호환 유지
   - 진행 중이던 태스크 → 중단 지점부터 재개 가능 확인
```

**마이그레이션 시스템** [차후 — 스키마 안정 후 추가]:
- `~/.factory/version` 파일에 현재 데이터 버전 기록
- 데몬 시작 시 코드 버전과 데이터 버전 비교
- 차이가 있으면 마이그레이션 함수를 순차 실행 (`migrate-v0.2-to-v0.3.js` 등)
- 마이그레이션 실패 시 데몬 시작 차단 + 사람에게 알림

**자기 업데이트 안전 장치 — watchdog + 5단계 안전망**:

팩토리 자신의 코드를 변경하는 태스크는 worktree에서 작업 (다른 태스크와 동일). 변경이 자신을 망가뜨리지 않도록 단계별로 검증하고, 문제 발견 시 자동 롤백한다.

**핵심 제약: 데몬은 자기 자신을 재시작/롤백할 수 없다.** 재시작 대상인 코드가 재시작 로직을 실행하면 데드락이고, 망가진 코드가 자기 롤백을 실행할 수 없다. 따라서 데몬 외부에 **watchdog**이 필요하다.

**watchdog** — 팩토리가 절대 수정하지 않는 독립 프로세스:

```
lib/
  factory-watchdog.js   # 변경 금지 (팩토리 태스크 대상에서 제외)
  factoryd.js           # 팩토리가 수정하는 대상
```

```javascript
// factory-watchdog.js 역할 (극도로 단순, 50줄 이내)
// 1. factoryd 프로세스 spawn + 감시
// 2. 주기적 소켓 ping (헬스체크)
// 3. 크래시 또는 헬스체크 실패 → rollback tag로 git reset + 재시작
// 4. 베이크 타임 타이머 관리 → 종료 시 tag 정리
// 5. 롤백 발생 시 사람에게 알림 (파일 기록 또는 webhook)
```

watchdog이 담당하는 것과 데몬이 담당하는 것의 경계:

| 역할 | 담당 |
|------|------|
| factoryd 프로세스 시작/종료 | watchdog |
| 헬스체크 (소켓 ping) | watchdog |
| 자동 롤백 (git reset + 재시작) | watchdog |
| 베이크 타임 타이머 | watchdog |
| 롤백 tag 생성/정리 | watchdog |
| 포그라운드 테스트 (merge 전) | factoryd (아직 이전 코드로 실행 중) |
| merge 실행 | factoryd |
| restart 요청 (watchdog에 시그널) | factoryd |
| 장기 메트릭 기록 | factoryd |

**5단계 안전망**:

```
[1] 포그라운드 테스트 (merge 전, factoryd가 실행)
  → 새 코드로 테스트 데몬 기동 (다른 포트)
  → 스모크 테스트: 소켓 응답, 태스크 제출/취소, 상태 조회
  → 기존 state.json/config.json 호환성 체크
  → 실패 → 태스크 failed, merge 안 함

[2] 롤백 포인트 + restart 요청 (factoryd → watchdog)
  → factoryd가 git tag factory/pre-{task-id} 생성
  → factoryd가 merge 실행
  → factoryd가 watchdog에 restart 시그널 전송
  → watchdog이 factoryd를 종료 → 새 코드로 재시작

[3] 즉시 헬스체크 (restart 직후, watchdog이 실행)
  → watchdog이 N초 내에 소켓 ping
  → 실패 → watchdog이 git reset --hard factory/pre-{task-id} + 재시작

[4] 베이크 타임 (24시간 또는 태스크 10개, watchdog이 실행)
  → watchdog이 주기적 헬스체크 + factoryd 크래시 감시
  → factoryd가 에러율을 state.json에 기록 → watchdog이 읽어서 판단
  → 에러율 급증 또는 연속 크래시 → watchdog이 자동 롤백 + 알림
  → 윈도우 종료 → watchdog이 rollback tag 제거, 릴리즈 확정

[5] 장기 모니터링 (일 단위, factoryd가 실행)
  → memory.json에 릴리즈 버전별 메트릭 기록
  → self-review 통과율, 평균 iteration 횟수, 태스크 성공률 등
  → 이전 버전 대비 품질 지표 하락 감지 → 사람에게 보고
  → 자동 롤백은 안 함 (애매한 품질 변화는 사람이 판단)
```

| 단계 | 시점 | 실행 주체 | 감지 대상 | 대응 |
|------|------|----------|----------|------|
| 1. 포그라운드 테스트 | merge 전 | factoryd | 기동 실패, API 불통 | 태스크 failed |
| 2. 롤백 포인트 + restart | merge 직후 | factoryd → watchdog | — | tag 생성, restart |
| 3. 즉시 헬스체크 | restart 직후 | watchdog | 데몬 미응답 | 자동 롤백 |
| 4. 베이크 타임 | 24h / 10 tasks | watchdog | 에러율 급증, 크래시 | 자동 롤백 |
| 5. 장기 모니터링 | 일 단위 | factoryd | 품질 지표 하락 | 사람에게 보고 |

## Phase 1 — 코어 데몬 + 웹 GUI + 기본 파이프라인

가장 먼저 "태스크를 넣으면 AI가 실행하고 결과를 돌려주는" 최소 루프를 만든다. 주 인터페이스는 **웹 GUI**이고, CLI는 데몬 시작/종료 등 최소한만 제공한다.

**Phase 1 범위**: 단일 프로젝트 태스크만 지원. 크로스-레포 태스크는 Phase 2 이후에 추가한다. 단, `project` 필드를 나중에 `projects` 배열로 확장 가능하도록 인터페이스를 설계한다.

### 파일 구조

```
lib/
  factoryd.js           # 팩토리 데몬 (큐 감시 + 오케스트레이터 + HTTP/WS 서버)
  factory-watchdog.js   # watchdog (데몬 시작/종료/헬스체크/롤백, 변경 금지)
  factory-ui.js         # 웹 대시보드 (HTML/CSS/JS를 문자열로 내장, SPA)
bin/
  factoryd.js           # 데몬 엔트리포인트 (start/stop/foreground)
templates/
  factory-analyze.md       # 분석 단계 프롬프트
  factory-implement.md     # 구현 단계 프롬프트
```

`package.json`에 `"factoryd"` bin 추가. CLI는 Phase 3에서 별도 추가.

### 태스크 파일 포맷

**단일 프로젝트 태스크**:
```markdown
---
id: abc123
title: 로그인 API에 rate limit 추가
project: ~/git/my-api
pipeline: implement
priority: normal
status: pending
created: 2025-02-08T12:00:00Z
---

## 설명

로그인 엔드포인트에 IP당 분당 5회 제한을 건다.
실패 시 429 응답과 Retry-After 헤더를 반환한다.
```

**크로스-레포 태스크**:
```markdown
---
id: xyz789
title: Webhook V2 콘솔 연동
projects:
  - path: ~/git/lambda256-fe
    role: 웹훅 v2 콘솔 프론트엔드
  - path: ~/git/baas-console-be
    role: API gateway, 인증 미들웨어
  - path: ~/git/baas-console-service
    role: 계정 관리, 인증 기능
  - path: ~/git/nodit-subscription-worker
    role: 웹훅 v2 백엔드 워커
pipeline: implement
priority: normal
status: pending
created: 2025-02-08T12:00:00Z
---

## 설명

웹훅 v2 콘솔 화면을 lambda256-fe에 추가한다.
baas-console-be에서 v2 웹훅 API를 라우팅하고,
nodit-subscription-worker에서 v2 구독 처리 로직을 구현한다.

## 레포 간 관계

- lambda256-fe → baas-console-be API 호출
- baas-console-be → baas-console-service 인증 위임
- baas-console-be → nodit-subscription-worker 구독 관리 호출
```

- YAML frontmatter로 메타데이터, 본문이 실제 요구사항
- `project` (단일) 또는 `projects` (배열) — 내부적으로 `project`는 `projects: [{ path }]`로 정규화
- `projects[].role` — AI 에이전트에게 각 레포의 역할을 알려주는 컨텍스트
- `status`: blocked → pending → running → review → done | failed
- `pipeline`: implement (기본), review, refactor, spec 등
- `quality`: normal (기본) | high. design/research 파이프라인은 자동 high
- `autoApprove`: true | false. 태스크 단위로 auto-approve 오버라이드
- `dependsOn`: 선행 태스크 ID 배열. 선행 태스크가 모두 done이어야 pending으로 전환
- `parent`: 부모 태스크 ID (auto-split에 의해 생성된 서브태스크)
- `children`: 자식 태스크 ID 배열 (auto-split에 의해 분할된 부모 태스크)

### 상태 흐름

```
blocked ─→ pending ─→ gathering ─→ running ─⇄─ suspended
  ↑            │           │            │              │
  │            │           │            ├→ failed      ├→ running (리줌)
  │            │           │            │              │
  └(dependsOn) └→ running  └→ running   └→ review ─────┼→ done
                                              │        │
                                              └→ running (변경 요청 → 재실행)

자기 업데이트 태스크의 추가 경로:
  done ─→ (watchdog: 헬스체크 실패 또는 베이크 타임 에러율 급증)
       ─→ watchdog이 코드 롤백 + 데몬 재시작
       ─→ 해당 태스크는 done 유지, 롤백 이력을 memory.json에 기록
```

- **blocked**: dependsOn에 명시된 선행 태스크가 아직 done이 아닌 상태. 선행 태스크 완료 시 자동으로 pending으로 전환
- **pending**: 제출됨, 대기 중
- **gathering**: 요구사항 수집/정제 중, 사람과의 대화 또는 자율 Q&A 진행 중
- **running**: worktree 생성 완료, 파이프라인 실행 중
- **suspended**: 쿼터 부족으로 일시정지됨, worktree 보존, 쿼터 회복 시 자동 재개
- **review**: 파이프라인 완료, 사람의 인수 테스트 대기 중
- **done**: 인수 완료, 원본에 merge됨, worktree 정리됨
- **failed**: 파이프라인 실패 또는 사람이 최종 거절

### 태스크 저장소

```
~/.factory/
├── tasks/
│   ├── pending/       # 제출된 태스크 .md 파일
│   ├── running/       # 실행 중 (파일 이동)
│   ├── review/        # 파이프라인 완료, 승인 대기
│   ├── done/          # 승인 완료, merge됨
│   └── failed/        # 실패 또는 거절
├── worktrees/
│   └── {task-id}/
│       ├── {project-name}/  # 프로젝트별 git worktree
│       ├── {project-name}/  # 크로스-레포 시 여러 개
│       └── workspace.json   # 워크스페이스 매니페스트 (프로젝트 목록, 역할, 경로)
├── logs/
│   └── {task-id}.log  # 태스크별 실행 로그
├── artifacts/
│   └── {task-id}/
│       ├── task.md           # 원본 태스크
│       ├── stages/           # stage별 산출물 (순서 번호 + 이름)
│       ├── rsa/              # RSA 결과 (개별 + 취합)
│       └── memory.json       # 실행 메타 (타임라인, 토큰, 재시도)
├── discoveries/
│   └── {project-name}/
│       ├── latest.md          # 최신 분석 결과
│       ├── proposals.json     # 제안 목록 (상태 관리)
│       └── history/           # 과거 분석 기록
├── daemon/
│   ├── factoryd.pid
│   ├── factory.sock
│   ├── factoryd.log
│   └── state.json
└── config.json        # 동시 실행 수, 프로바이더, 모델 등
```

태스크는 디렉토리 이동으로 상태를 전이한다 (파일시스템이 곧 큐).

### Git Worktree 라이프사이클

태스크가 running으로 전이될 때 — **모든 projects에 대해** worktree를 생성:
```bash
# 각 프로젝트마다 반복
for project in task.projects:
  cd {project.path}
  git branch factory/{task-id}
  git worktree add ~/.factory/worktrees/{task-id}/{project-name} factory/{task-id}
```

결과 디렉토리 구조 (크로스-레포 예시):
```
~/.factory/worktrees/xyz789/
├── lambda256-fe/              # ~/git/lambda256-fe 의 worktree
├── baas-console-be/           # ~/git/baas-console-be 의 worktree
├── nodit-subscription-worker/ # ~/git/nodit-subscription-worker 의 worktree
└── workspace.json
```

`workspace.json`:
```json
{
  "taskId": "xyz789",
  "projects": [
    { "name": "lambda256-fe", "path": "lambda256-fe", "origin": "~/git/lambda256-fe", "role": "웹훅 v2 콘솔 프론트엔드" },
    { "name": "baas-console-be", "path": "baas-console-be", "origin": "~/git/baas-console-be", "role": "API gateway" },
    { "name": "nodit-subscription-worker", "path": "nodit-subscription-worker", "origin": "~/git/nodit-subscription-worker", "role": "웹훅 v2 워커" }
  ]
}
```

파이프라인 실행 시:
- **단일 프로젝트**: cwd = `~/.factory/worktrees/{task-id}/{project-name}/`
- **크로스-레포**: cwd = `~/.factory/worktrees/{task-id}/` (워크스페이스 루트)
- AI 에이전트는 `workspace.json`을 읽고 각 프로젝트 디렉토리를 오가며 작업

태스크가 approve될 때 — **통합 테스트 검증 후 전체 merge**:
- 크로스-레포의 경우 각 프로젝트마다 `factory/{task-id}` 브랜치가 존재
- approve 전에 팩토리가 **통합 테스트로 브랜치 간 호환성을 자동 검증**
- 통합 테스트 통과 후 사람이 approve → 모든 프로젝트를 순회하여 merge
```bash
for project in task.projects:
  cd {project.origin}
  git merge factory/{task-id}
  git worktree remove ~/.factory/worktrees/{task-id}/{project-name}
  git branch -d factory/{task-id}
```
- 어느 한 프로젝트에서 merge conflict 발생 시 → 전체 approve 중단, 충돌 프로젝트 리포트

태스크가 reject될 때 — **모든 프로젝트의 worktree + 브랜치 폐기**:
```bash
for project in task.projects:
  git worktree remove ~/.factory/worktrees/{task-id}/{project-name}
  cd {project.origin}
  git branch -D factory/{task-id}
```

이 구조 덕분에:
- **모든 원본 프로젝트는 절대 수정되지 않음** (approve 전까지)
- **같은 프로젝트에 여러 태스크 병렬 실행 가능** (각자 독립 worktree)
- **여러 레포를 동시에 변경하는 크로스-레포 태스크 지원**
- **review 중 모든 프로젝트의 변경사항을 직접 확인 가능**
- **크로스-레포 approve 전 통합 테스트 자동 검증** — 부분 merge 없이 전체 통과 후 한번에 처리

### 데몬 (factoryd.js)

memd 패턴을 따른다:

- **프로세스**: fork + detach, PID 파일, `--foreground` 옵션
- **IPC**: Unix 소켓 (`~/.factory/daemon/factory.sock`), JSON-RPC
- **스캔 루프**: `pending/` 디렉토리를 주기적(10초)으로 스캔
- **실행 루프**: 큐에서 태스크를 꺼내 파이프라인 실행, 동시 실행 수 제한 (기본 1)
- **상태 관리**: state.json에 현재 실행 중 태스크, 통계 기록, 디바운스 저장
- **종료**: SIGTERM/SIGINT → 현재 태스크 상태 저장 후 종료
- **쿼터 관리**: 아래 "쿼터 모니터 + 자동 일시정지/리줌" 참조

소켓 메서드:
| 메서드 | 설명 |
|--------|------|
| submit | 태스크 제출 (frontmatter 파싱 → pending/ 저장) |
| list | 상태별/프로젝트별 태스크 목록 |
| status | 특정 태스크 상태 + 현재 단계 + worktree 경로 |
| cancel | 실행 중 태스크 취소 + worktree 정리 |
| approve | review 상태 태스크 인수 승인 → merge + worktree 정리 → done |
| reject | review 상태 태스크 최종 거절 → worktree 폐기 → failed |
| request-changes | review 상태 태스크에 피드백 → implement부터 재실행 → running |
| diff | review 상태 태스크의 변경사항 diff 조회 |
| logs | 태스크 로그 tail |
| pause | 데몬 수동 일시정지 (쿼터와 무관하게) |
| resume | 데몬 수동 재개 |
| stats | 전체/프로젝트별 통계 + 데몬 상태 + 쿼터 + 리소스 정보 |
| cleanup | 완료/실패 태스크의 worktree, 산출물, Docker 잔여물 정리 |
| shutdown | 데몬 종료 |

대시보드는 이 메서드들을 직접 호출한다. 외부 채널 어댑터(Slack, Telegram)에서는 자연어를 의도 파싱하여 이 메서드들로 변환한다 (Phase 5).

### 쿼터 모니터 + 자동 일시정지/리줌

Claude Code 세션의 API 쿼터를 모니터링하여, 쿼터가 부족하면 파이프라인을 일시정지하고 쿼터가 회복되면 자동 재개한다.

**감지 방식**:
- Claude 에이전트 spawn 시 stderr/종료 코드를 감시
- 쿼터 초과 패턴 감지: `rate limit`, `quota exceeded`, `429`, `overloaded` 등
- 에이전트가 쿼터 에러로 종료하면 → 데몬 전체를 **paused** 상태로 전환

**일시정지 (paused)**:
- 새 태스크 픽업 중단 (스캔 루프는 유지하되 실행하지 않음)
- 현재 실행 중인 태스크의 stage가 자연 종료될 때까지 대기
- 실행 중이던 태스크는 **suspended** 상태로 전환 (현재 stage 진행도 기록)
- worktree는 그대로 보존 (작업 결과 유지)

**쿼터 회복 판정**:
- paused 전환 시 ccusage의 5시간 롤링 윈도우 잔여 시간을 계산하여 예상 회복 시각을 산출
- 예상 회복 시각까지 대기 후 자동 재개 (별도 프로브 API 호출 불필요, 쿼터 낭비 없음)
- ccusage 미설치 시 고정 대기 시간(기본 30분) 후 최소 토큰 요청으로 확인

**자동 리줌**:
- 예상 회복 시각 도달 → 데몬을 **running** 상태로 복귀
- suspended 태스크를 중단된 stage부터 재개 — 새 에이전트가 worktree/산출물/git log를 읽고 상황을 재파악한 뒤 해당 stage를 실행 (LLM 컨텍스트 복원이 아닌 산출물 기반 재파악)
- 새 태스크 픽업도 재개

**상태 흐름**:
```
데몬: running ──(쿼터 초과)──→ paused ──(예상 회복 시각 도달)──→ running
태스크: running ──(일시정지)──→ suspended ──(리줌)──→ running
```

**태스크 suspended 상태**:
- 태스크 파일은 `running/`에 유지 (별도 디렉토리 불필요)
- frontmatter에 `suspended: true`, `suspendedAt`, `suspendedStage` 기록
- worktree 보존 → 리줌 시 이전 작업 결과를 그대로 이어감

**state.json 확장**:
```json
{
  "daemonStatus": "paused",
  "pausedAt": "2025-02-08T14:30:00Z",
  "pauseReason": "quota_exceeded | resource_pressure",
  "estimatedRecoveryAt": "2025-02-08T15:30:00Z",
  "suspendedTasks": ["abc123", "def456"],
  "effectiveConcurrency": 1,
  "resources": {
    "cpuLoad": 0.72,
    "memoryFreeMb": 1843,
    "diskFreeGb": 14.2,
    "dockerContainers": 2
  },
  "lastCleanup": "2025-02-08T10:00:00Z"
}
```

**CLI/GUI 연동**:
- `factory stats` → 데몬 상태에 paused/running 표시, 쿼터 잔량 또는 예상 회복 시각
- 대시보드 → 상단에 "⏸ Paused (quota, recovery at 15:30)" 배너
- `factory pause` / `factory resume` → 수동 일시정지/재개도 가능

### 파이프라인 엔진

태스크의 `pipeline` 필드에 따라 오케스트레이션을 결정한다.

**implement 파이프라인** (Phase 1 기본):
```
analyze → implement → [review: 사람 인수]
```

**implement 파이프라인** (Phase 2 전체):
```
[gather: 요구사항 수집] → analyze → loop(implement → test, max 3) → self-review → [review: 사람 인수]
```

**전체 파이프라인** (gather 포함, Phase 2):
```
gather(자율/인터렉티브) → spec → analyze → loop(implement → test, max 3) → self-review → [review: 사람 인수]
```

#### 스텝 실행 방식

**stage 스텝**:
1. 템플릿 로드 (`templates/factory-{stage}.md`)
2. **최소 컨텍스트 주입** — 에이전트별 컨텍스트 매핑에 따라 필요한 산출물 파일만 선택하여 주입
   - 예: implement 에이전트에는 `spec.md` + `analyze.md` + (있으면) `test.md` 피드백만
   - 예: test 에이전트에는 `spec.md` + `implement.md`만
3. Claude 에이전트 spawn (**워크스페이스 디렉토리**에서 실행, 도구 사용 허용)
   - 단일 프로젝트: cwd = `worktrees/{task-id}/{project-name}/`
   - 크로스-레포: cwd = `worktrees/{task-id}/` + `workspace.json`으로 프로젝트 맵 제공
4. stdout → 산출물 파일 저장 (`artifacts/{task-id}/{stage}.md`, 이전 결과 덮어쓰기 + timeline 기록)
5. stderr → 로그 기록
6. 종료 코드로 성공/실패 판정

**loop 스텝**:
1. 포함된 스텝을 순서대로 실행
2. 마지막 스텝(게이트)이 성공하면 루프 탈출 → 다음 스텝으로
3. 게이트 실패 시 에러 출력을 **피드백 컨텍스트**로 수집
4. 피드백을 첫 번째 스텝에 주입하여 루프 재시작
5. **같은 항목이 2회 연속 실패** → deliberation 발동 (다관점 병렬 분석 → 취합 → 새 방안으로 재시도)
6. deliberation 후에도 실패 → review로 전달 (미충족 항목 + 시도 내역 + 대안 제안을 사람에게 보고)

```
[iteration 1]  implement → test(FAIL: "auth.test.js line 42 assertion error")
[iteration 2]  implement(feedback: "auth.test.js line 42...") → test(PASS)
→ 루프 탈출, 다음 스텝으로
```

**gather 스텝** (요구사항 수집/정제):

요구사항이 모호하거나 불충분할 때, 파이프라인 실행 전에 요구사항을 구체화한다. 두 가지 모드가 있다.

**인터렉티브 모드** — 오케스트레이터가 사람과 대화하며 수집:
1. 서브에이전트가 태스크 설명을 분석하여 질문 목록을 생성
2. 오케스트레이터가 질문을 채팅 패널에 표시, 사람이 답변
3. 답변을 반영하여 추가 질문 또는 정제된 요구사항 생성
4. 사람이 "충분하다" 확인 시 다음 단계로

```
[gather - interactive, 오케스트레이터 채팅으로 진행]
  🤖: "rate limit 구현을 위해 몇 가지 확인이 필요합니다.
       제한 기준은 IP인가요, 사용자 ID인가요?"
  👤: "IP 기준"
  🤖: "제한 초과 시 응답 코드는 429? 차단 기간은?"
  👤: "429, 1분"
  🤖: "화이트리스트 IP가 필요한가요?"
  👤: "아니요, 충분합니다"
  🤖: "요구사항을 정리했습니다. spec을 생성하고 구현을 시작합니다."
  → spec 생성
```

**자율 모드** — AI가 스스로 질문과 답변을 반복:
1. AI가 태스크 설명을 분석하여 모호한 부분 식별
2. 에지 케이스, 누락된 요구사항, 기술적 제약을 자문자답으로 탐색
3. 코드베이스를 분석하여 기존 패턴과 제약사항을 반영
4. 최종 정제된 요구사항 + 구현 세부사항을 생성

```
[gather - autonomous]
  Q: "기존 rate limit 구현이 있는가?"
  A: (코드 분석) "express-rate-limit 패키지 사용 중, 현재 글로벌 100req/min"
  Q: "로그인 엔드포인트에만 별도 제한을 걸 수 있는 구조인가?"
  A: (코드 분석) "라우터별 미들웨어 적용 가능"
  Q: "실패 응답의 기존 포맷은?"
  A: (코드 분석) "{ error: string, code: number } 형태"
  → 기존 코드와 일관된 구현 세부사항 포함한 spec 생성
```

태스크 frontmatter에 `gather: interactive | autonomous | skip`으로 모드 지정 (기본: autonomous).

**spec 스텝** (요구사항 문서화):
- gather 결과를 구조화된 요구사항 명세로 변환
- 인수 기준(acceptance criteria) 명시
- 이 spec이 이후 모든 단계의 기준 문서가 됨
- `artifacts/{task-id}/spec.md`에 저장

**파이프라인 종료 및 인수 테스트**:
- 모든 스텝 완료 → **review/로 이동** (사람 인수 테스트 대기)
- 스텝 실패 (loop maxIterations 초과 포함) → **failed/로 이동**

**review 단계에서 사람의 선택지**:
| 액션 | 설명 | 결과 |
|------|------|------|
| **approve** | 인수 기준 충족, 모든 변경 승인 | → done, merge |
| **reject** | 근본적 문제, 전체 폐기 | → failed, worktree 삭제 |
| **request-changes** | 수정 필요, 피드백과 함께 재실행 | → running (피드백 주입하여 implement부터 재실행) |

**리뷰 점수**:

approve/reject 시 코드 품질 점수(1~5)와 코멘트(선택)를 남긴다. 이 점수는 memory.json에 `templateVersion`과 함께 기록되어 템플릿 품질 추적에 활용된다. 개밥먹기 과정에서 templateVersion별 평균 점수를 비교하여 프롬프트 템플릿을 개선한다.

```
[Approve 시] 코드 품질: 4/5, 코멘트: "커밋 구조 깔끔" (선택)
[Reject 시]  코드 품질: 1/5, 코멘트: "요구사항 반도 못 했음" (선택)
```

**request-changes 흐름**:
```
[review]
  사람: "rate limit 동작은 좋은데, 에러 응답에 Retry-After 헤더가 빠져있어"
  → 피드백을 implement 컨텍스트에 주입
  → implement → test → self-review → [review] (재순환)
```

이 재순환은 횟수 제한 없이 사람이 최종 approve/reject 할 때까지 반복된다. 각 iteration의 피드백과 변경사항은 모두 `artifacts/`에 기록된다.

**rsa 스텝** (Phase 2):
1. 같은 프롬프트를 N개 에이전트에 병렬 실행
2. 각 에이전트는 독립적으로 작업 (비결정성에 의해 각자 다른 결과)
3. 모든 에이전트 완료 후 취합 에이전트가 결과를 통합
4. 취합 전략: converge(합집합 수집) 또는 diverge(상위 관점 도출)
5. 개별 결과 + 취합 결과 모두 `artifacts/{task-id}/rsa/`에 저장

```
[rsa: analyze, count 5, converge]
  agent-1: "파일 A, B에 영향"
  agent-2: "파일 A, C에 영향"
  agent-3: "파일 B, D에 영향"
  → 취합: "파일 A, B, C, D에 영향" (혼자서는 못 찾은 것까지)
```

#### 단계 정의

| 단계 | 역할 | 게이트 | RSA 적합도 | 사람 개입 | 활성화 |
|------|------|--------|-----------|----------|--------|
| gather | 요구사항 수집/정제. 자율 Q&A 또는 인터렉티브 대화 | 아니오 | — | interactive 모드 시 | Phase 2 |
| spec | gather 결과를 구조화된 명세 + 인수 기준으로 변환 | 아니오 | — | — | Phase 2 |
| analyze | 코드베이스를 읽고 태스크 이해, 영향 범위 파악, 구현 계획 수립 | 아니오 | converge | — | **Phase 1** |
| research | 조사/기획. 정보 수집 후 구조화된 문서 생성 | 아니오 | converge | — | Phase 2 (RSA) |
| design | 아키텍처/API 설계 | 아니오 | diverge | — | Phase 2 (RSA) |
| implement | spec/analyze/피드백을 참고하여 코드 수정 + commit. 프론트엔드 시 DevTools로 스타일 확인 | 아니오 | — | — | **Phase 1** |
| visual-check | 프론트엔드 전용. 헤드리스 브라우저에서 구현 결과의 시각적 요구사항 검증 | 예 (pass/fail) | — | — | Phase 2 |
| test | 유닛 테스트 또는 인프라 테스트 실행, 결과 리포트 (인프라 필요 시 큐 대기) | 예 (pass/fail) | — | — | **Phase 2** |
| self-review | spec 체크리스트 전수 검증. 100% 완료해야 통과 | 예 (pass/fail) | — | — | **Phase 2** |
| deliberation | 연속 실패 시 다관점 병렬 분석. 취합하여 해결 방안 또는 spec 수정 제안 도출 | 아니오 | converge | — | 차후 |
| review | 사람 인수 테스트: approve / reject / request-changes | 예 | — | **항상** | **Phase 1** |

### 테스트 인프라

사람 팀이 개발하는 것처럼, 에이전트들도 **유닛 테스트 → 통합 테스트** 단계를 거친다. 통합 테스트에는 Docker 인프라가 필요하고, 로컬 머신 자원은 유한하므로 인프라 선점 큐가 필요하다.

#### 테스트 레벨

| 레벨 | 실행 환경 | 인프라 필요 | 큐 대기 |
|------|----------|-----------|---------|
| **unit** | 프로세스 내 (jest, vitest 등) | 없음 | 불필요 |
| **integration** | Docker Compose로 DB/Redis/MQ 등 기동 | 있음 | **필요** |
| **e2e** | Docker Compose + 앱 서버 기동 | 있음 | **필요** |

프로젝트의 `factory.test` 설정 또는 analyze 산출물에서 어떤 레벨이 필요한지 판단한다.

#### 인프라 큐 (Infrastructure Lock)

로컬 머신은 한 대이고 Docker 자원은 유한하다. 여러 태스크가 동시에 인프라 테스트를 실행하면 포트 충돌, 메모리 부족 등이 발생한다. 따라서 인프라 테스트는 **선점 큐**로 순서를 관리한다.

```
태스크 파이프라인 실행 흐름:
                                                    ┌───────────────┐
task-1: ... → implement → test(unit) ───────────→ │ infra queue   │ → test(integration) → ...
task-2: ... → implement → test(unit) ───────────→ │  (FIFO, 1슬롯) │ → 대기 중...
task-3: ... → implement → test(unit) → 완료 ──→   └───────────────┘
                                       (unit만 필요해서 큐 안 탐)
```

**동작 방식**:
1. test 스텝 시작 시 유닛 테스트부터 실행 (큐 불필요, 항상 즉시)
2. 유닛 테스트 통과 + 통합 테스트 필요 시 → **인프라 큐에 진입**
3. 큐에서 차례가 오면 인프라 lock 획득 → Docker Compose up → 테스트 실행 → Compose down → lock 해제
4. 큐 대기 중인 태스크는 `waiting-infra` 상태로 표시
5. 큐는 FIFO, 동시 인프라 슬롯 수는 config로 설정 (기본 1)

**인프라 프로파일**:

프로젝트별로 필요한 Docker 환경이 다르다. 프로젝트 루트의 `docker-compose.test.yml` 또는 factory 설정으로 정의한다.

```yaml
# 프로젝트 루트/docker-compose.test.yml
services:
  postgres:
    image: postgres:15
    ports: ["5432:5432"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

**config.json 확장**:
```json
{
  "infra": {
    "slots": 1,
    "composeFile": "docker-compose.test.yml",
    "upTimeoutMs": 60000,
    "downAfterTest": true
  }
}
```

**태스크 파이프라인에서의 위치**:
```
analyze → loop(implement → test[unit → integration]) → self-review → review
```

test 스텝 내부가 두 단계로 나뉜다:
1. **unit**: 즉시 실행, 빠른 피드백 (실패 시 바로 loop 재시작)
2. **integration**: 유닛 통과 후에만 실행, 인프라 큐 대기 가능

이 구조의 이점:
- 유닛 테스트 실패 시 인프라를 기동하지 않아 자원 절약
- 여러 태스크가 병렬 구현 중이어도 인프라 테스트는 순서대로 안전하게 실행
- 사람 팀의 개발 프로세스와 동일: 로컬 테스트 → CI 테스트

### 프론트엔드 작업: 헤드리스 브라우저 + DevTools

프론트엔드 태스크는 코드만 보고 작업하면 안 된다. **실제 렌더링된 화면의 스타일과 DOM 구조를 확인**하면서 작업해야 정확하다. 서브에이전트가 Chrome DevTools MCP를 통해 헤드리스 브라우저에 접속하여 실제 화면을 기반으로 구현·검증한다.

#### 왜 DevTools인가

- CSS는 코드만 읽어서는 최종 렌더링 결과를 알 수 없다 (상속, 캐스케이딩, 미디어 쿼리 등)
- computed style, 레이아웃 박스, z-index 스태킹 등은 브라우저에서 직접 확인해야 정확
- 기존 화면의 스타일 패턴을 분석해서 일관된 UI를 만들 수 있음
- 스크린샷은 전체 조망에만 사용하고, 구체적 검증은 DOM API로 텍스트 기반 확인

#### 프론트엔드 파이프라인 흐름

```
[프론트엔드 태스크]

analyze
  ↓
implement ←──── DevTools: 기존 화면의 스타일/구조 분석 후 코드 작성
  ↓
visual-check ── DevTools: 구현 결과를 헤드리스 브라우저에서 확인
  ↓ (스타일 불일치 → implement에 피드백)
test(unit)
  ↓
test(e2e) ───── DevTools: 사용자 인터랙션 시뮬레이션 + 결과 검증
  ↓
self-review
  ↓
review ──────── 사람이 최종 화면 확인
```

#### 서브에이전트의 DevTools 접근

서브에이전트는 **Chrome DevTools MCP 설정**을 가진 채로 spawn된다. 오케스트레이터가 태스크의 프로젝트 유형(프론트엔드)을 인식하면 자동으로 DevTools 환경을 구성한다.

**헤드리스 브라우저 라이프사이클**:
1. 프론트엔드 태스크가 implement 단계에 진입하면 → 헤드리스 Chrome 기동
2. 프로젝트의 dev server 기동 (`npm run dev` 등)
3. 서브에이전트에 DevTools MCP 연결 정보 제공
4. 서브에이전트가 DevTools를 통해 작업:
   - DOM 탐색, computed style 조회, 레이아웃 검사
   - JavaScript 실행으로 동적 상태 확인
   - 필요 시 스크린샷으로 전체 화면 조망
5. 태스크 완료 또는 일시정지 시 → 브라우저 + dev server 종료

**서브에이전트가 DevTools로 하는 일**:

| 단계 | DevTools 활용 | 예시 |
|------|-------------|------|
| analyze | 기존 화면 구조/스타일 패턴 파악 | "버튼은 `bg-blue-500` 클래스, 간격은 `gap-4`" |
| implement | 구현하면서 실시간 스타일 확인 | `getComputedStyle(el).padding` 으로 정확한 값 확인 |
| visual-check | 구현 결과 검증 | "헤더 높이 64px 맞음, 사이드바 폭 240px 맞음" |
| test(e2e) | 사용자 흐름 시뮬레이션 | 클릭 → 모달 열림 → 폼 입력 → 제출 → 결과 확인 |

**DevTools 사용 원칙** (스크린샷보다 DOM API 우선):
- 스타일 확인: `document.querySelector()` + `getComputedStyle()` → 텍스트로 정확한 값
- 구조 확인: `element.children`, `element.getAttribute()` → DOM 트리 텍스트 확인
- 상태 확인: `javascript_tool`로 React/Vue 컴포넌트 상태 직접 조회
- 스크린샷: 전체 레이아웃 조망이 필요할 때만 사용 (해상도·토큰 비용 고려)

#### 인프라 큐와의 연동

헤드리스 브라우저 + dev server도 **인프라 리소스**다. Docker 인프라와 마찬가지로 동시 실행을 제한한다.

```
인프라 큐:
  ├── docker 슬롯 (DB, Redis 등)  ← 백엔드 통합 테스트
  └── browser 슬롯 (Chrome + dev server) ← 프론트엔드 작업
```

**config.json 확장**:
```json
{
  "infra": {
    "slots": 1,
    "browserSlots": 1,
    "composeFile": "docker-compose.test.yml",
    "upTimeoutMs": 60000,
    "downAfterTest": true
  },
  "frontend": {
    "devCommand": "npm run dev",
    "devPort": 3000,
    "devReadyPattern": "ready|started|listening",
    "headless": true,
    "devtoolsPort": 9222
  }
}
```

프로젝트 루트에 `.factory.json`으로 프로젝트별 설정을 오버라이드할 수 있다:
```json
{
  "type": "frontend",
  "devCommand": "pnpm dev",
  "devPort": 5173,
  "testCommand": "pnpm test",
  "e2eCommand": "pnpm test:e2e"
}
```

#### visual-check 스텝

프론트엔드 전용 게이트 스텝. implement 후, 유닛 테스트 전에 실행한다.

1. 헤드리스 브라우저에서 변경된 페이지를 로드
2. spec에 명시된 시각적 요구사항을 DevTools DOM API로 검증
   - 요소 존재 여부, 올바른 텍스트, 스타일 값, 레이아웃 위치
3. 불일치 발견 시 → 구체적 피드백 (어떤 요소의 어떤 속성이 틀린지)과 함께 implement 재실행
4. 모든 검증 통과 시 → 다음 스텝으로

```
[visual-check 예시]
  spec: "버튼은 파란색(bg-blue-500), 패딩 8px 16px, 우측 정렬"
  검증:
    ✓ button.bg-blue-500 존재
    ✓ computed padding: 8px 16px
    ✗ justify-content: flex-start (기대값: flex-end)
  → 피드백: "버튼 컨테이너의 justify-content가 flex-start인데 flex-end여야 함"
  → implement 재실행
```

### 데몬 제어 (최소 CLI)

Phase 1에서는 데몬 시작/종료만 CLI로 제공. 나머지 조작은 모두 웹 GUI.

```bash
factoryd start                 # 데몬 시작 (fork + detach, 웹 서버 포함)
factoryd stop                  # 데몬 종료
factoryd --foreground          # 포그라운드 실행 (디버깅용)
```

시작 시 터미널에 `Factory running at http://localhost:7777` 출력.

### 웹 GUI (Phase 1 주 인터페이스)

데몬에 HTTP + WebSocket 서버를 내장. 모든 태스크 관리를 브라우저에서 수행한다.

- **HTTP**: `http.createServer()`, 포트 7777 (기본)
- **WebSocket**: Node.js 내장 방식 (HTTP Upgrade + 프레임 파싱)
- **SPA**: 단일 HTML 페이지, vanilla JS, CSS-in-HTML (`factory-ui.js`에서 내장)

#### 대시보드

태스크 목록 + 상세 패널의 2단 구조. 대시보드가 주 인터페이스이고, 모든 조작은 GUI로 수행한다.

```
┌──────────────────────────────────────────────────────────────┐
│  Factory                              ● Running  ⏸ Pause     │
│  [All] [my-api] [my-web] [lambda256-fe]  ← 프로젝트 필터     │
├──────────┬───────────────────────────────────────────────────┤
│          │                                                    │
│ Running  │  Title: Webhook V2 콘솔 연동                       │
│ ──────── │  Projects:                                         │
│ ▶ task-1 │    lambda256-fe (프론트엔드)                        │
│ ▶ task-2 │    baas-console-be (API gateway)                    │
│   my-api │    nodit-subscription-worker (워커)                 │
│          │                                                    │
│ Review   │  Pipeline:                                         │
│ ──────── │  gather ✓ → spec ✓ → analyze ✓ → implement ▶      │
│ ★ task-3 │                                                    │
│   my-api │  Summary                                           │
│          │  ─────────                                         │
│ Pending  │  rate limit 미들웨어 추가. IP당 분당 5회 제한.      │
│ ──────── │  express-rate-limit 기존 패턴 활용.                 │
│   task-4 │  변경: src/middleware/rate.ts (+45), ...             │
│          │  테스트 2/2 통과.                                   │
│ Done     │                                                    │
│ ──────── │  Commits                    Diff                   │
│ ✓ task-0 │  ─────────                  ─────────              │
│          │  abc123 feat: rate limit    + const limiter = ...   │
│          │  def456 test: rate limit    + describe('rate...'    │
│          │                                                    │
│          │  Live Log                                          │
│          │  ─────────                                         │
│          │  [12:01] Analyzing codebase...                     │
│          │  [12:02] Writing implementation...                 │
│          │  [12:03] Running tests... 2/2 passed               │
│          │                                                    │
│          │  [Approve] [Request Changes] [Reject]              │
│          │                                                    │
├──────────┴───────────────────────────────────────────────────┤
│ ⏸ Paused (quota, recovery at 15:30)  ← 쿼터 부족 시 배너     │
│ 3 repos | 12 done | 1 running | 2 review | 1 queued           │
│ CPU 45% | Mem 6.2GB free | Disk 32GB free                     │
└──────────────────────────────────────────────────────────────┘
```

#### 주요 화면/기능

**태스크 목록 (좌측)**:
- 상태별 그룹 (running, review, pending, done)
- 프로젝트 필터
- 클릭하면 상세 패널에 해당 태스크 정보 표시

**태스크 상세 (우측, 메인)**:
- summary.md 내용 (최종 요약 — 뭘 했고, 왜, 테스트 결과)
- 커밋 히스토리
- 프로젝트별 diff 뷰 (크로스-레포 시 프로젝트별 탭)
- 파이프라인 진행 상태 시각화 (gather ✓ → spec ✓ → analyze ✓ → implement ▶)
- 실시간 로그 스트리밍
- Approve / Request Changes / Reject 버튼

**태스크 제출**:
- [+ New Task] 버튼 → 제출 폼
- 제목, 파이프라인 선택, 프로젝트 추가 (단일 또는 여러 개 + 역할 설명)
- 마크다운 에디터로 설명 작성
- .md 파일 드래그앤드롭 업로드

**gather(interactive) 화면**:
- 태스크가 gathering 상태일 때 상세 패널에 Q&A UI 표시
- 오케스트레이터가 생성한 질문에 답변하는 폼

**통계 바 (하단)**:
- 프로젝트별 처리 수, 데몬 상태 (running/paused), 쿼터, 리소스 정보

#### WebSocket 프로토콜

서버 → 클라이언트 이벤트:
- `task:created` — 새 태스크 추가
- `task:updated` — 상태/단계 변경
- `task:log` — 실시간 로그 라인
- `gather:question` — interactive 모드: 오케스트레이터가 사람에게 질문
- `stats:updated` — 통계 갱신
- `daemon:status` — 데몬 상태 변경 (paused/running), 리소스 정보

클라이언트 → 서버 액션:
- `task:submit` — 태스크 제출 (단일/크로스-레포)
- `task:cancel` — 태스크 취소
- `task:approve` — 인수 승인
- `task:reject` — 최종 거절
- `task:request-changes` — 피드백과 함께 재실행 요청
- `task:diff` — 변경사항 요청
- `gather:answer` — interactive 모드: 질문에 답변
- `gather:done` — interactive 모드: 수집 완료
- `daemon:pause` — 수동 일시정지
- `daemon:resume` — 수동 재개

### config.json

```json
{
  "concurrency": 2,
  "providers": {
    "claude": { "model": "opus", "command": "claude" },
    "codex": { "model": "codex-mini", "command": "codex" }
  },
  "defaultProvider": "claude",
  "scanIntervalMs": 10000,
  "timeoutMs": 1800000,
  "pipelines": {
    "implement": [
      { "gather": "autonomous" },
      "spec",
      "analyze",
      { "loop": ["implement", "test"], "maxIterations": "auto" },
      "self-review"
    ],
    "implement-interactive": [
      { "gather": "interactive" },
      "spec",
      "analyze",
      { "loop": ["implement", "test"], "maxIterations": "auto" },
      "self-review"
    ],
    "frontend": [
      { "gather": "autonomous" },
      "spec",
      "analyze",
      { "loop": ["implement", "visual-check", "test"], "maxIterations": "auto" },
      "self-review"
    ],
    "quick": [
      "analyze",
      "implement"
    ],
    "refactor": [
      "analyze",
      { "loop": ["refactor", "test"], "maxIterations": "auto" }
    ],
    "research": [
      { "rsa": "research", "count": "auto", "strategy": "converge" }
    ],
    "design": [
      { "rsa": "analyze", "count": "auto", "strategy": "converge" },
      { "rsa": "design", "count": "auto", "strategy": "diverge" }
    ],
    "discover": [
      { "rsa": "discover", "count": "auto", "strategy": "converge" }
    ]
  },
  "autoApprove": {
    "enabled": false,
    "conditions": {
      "testsPass": true,
      "selfReviewPass": true,
      "maxDifficulty": "moderate",
      "maxFilesChanged": 10
    }
  },
  "costAlerts": {
    "tokenMultiplier": 3,
    "durationMultiplier": 3
  },
  "adaptive": {
    "simple/normal":   { "maxIterations": 1, "rsaCount": 0 },
    "moderate/normal": { "maxIterations": 3, "rsaCount": 0 },
    "moderate/high":   { "maxIterations": 3, "rsaCount": 3 },
    "complex/normal":  { "maxIterations": 5, "rsaCount": 3 },
    "complex/high":    { "maxIterations": 5, "rsaCount": 5, "reviewRsa": 3 }
  },
  "perspectives": {
    "backend":  ["성능/확장성", "보안/안전성", "에러 처리", "DB 일관성", "코드 품질"],
    "frontend": ["접근성", "반응형", "사용성", "성능", "코드 품질"],
    "design":   ["기술 타당성", "비용/복잡도", "확장성", "하위 호환", "운영 편의"]
  },
  "quota": {
    "source": "ccusage",
    "mode": "work",
    "modes": {
      "work": { "windowBudgetPercent": 50 },
      "off": { "windowBudgetPercent": 90 }
    },
    "softLimitPercent": 80,
    "hardLimitPercent": 95,
    "fallbackWaitMs": 1800000
  },
  "timeouts": {
    "simple":   { "stageMs":  600000, "taskMs":  1800000 },
    "moderate": { "stageMs": 1800000, "taskMs":  7200000 },
    "complex":  { "stageMs": 3600000, "taskMs": 14400000 }
  },
  "projects": {}
}
```

- `concurrency`: 동시 실행 워커 수 (프로젝트 무관, 전체 슬롯)
- `pipelines`: 스텝 배열. `"auto"` 값은 난이도 + 품질 수준에 따라 런타임에 결정
- `adaptive`: 난이도/품질 조합별 파라미터. `rsaCount`는 병렬 에이전트 수, `reviewRsa`는 self-review 다관점 수
- `perspectives`: 프로젝트 유형별 기본 관점 목록. RSA 실행 시 에이전트에 분배
- `autoApprove`: auto-approve 전역 정책. 프로젝트별/태스크별 오버라이드 가능
- `costAlerts`: 비용 이상 감지 설정. 같은 난이도/파이프라인 평균 대비 N배 이상이면 경고
- `quota`: 쿼터 관리 설정
- `projects`: 프로젝트별 설정 (FSD, discovery, autoApprove 등). 기본 빈 객체. FSD 구현 시 활성화
- 사람이 파이프라인 정의에 숫자를 직접 넣으면 (`"maxIterations": 3`) 적응형을 무시하고 고정값 사용
- Phase 1에서는 `quick` 파이프라인(loop 없는 순차)만 지원, loop/rsa는 Phase 2에서 활성화

---

## Phase 2 — loop/rsa 스텝 활성화 + 워커 풀

### 오케스트레이션 활성화

Phase 1에서 순차 실행만 지원하던 파이프라인 엔진에 **loop 스텝**과 **rsa 스텝**을 활성화한다.

**implement 파이프라인 전체 흐름**:
```
analyze → loop(implement → test, max 3) → self-review → [review: 사람 승인]
```

실행 예시:
```
[1] analyze                          → 코드 분석, 구현 계획 수립
[2] implement (iteration 1)          → 코드 작성 + commit
[3] test (iteration 1)               → FAIL: 2 tests failed
[4] implement (iteration 2, feedback)→ 테스트 에러 기반으로 코드 수정
[5] test (iteration 2)               → PASS
[6] self-review                      → 품질 체크 통과
[7] → review/ 이동                    → 사람 승인 대기
```

### 워커 풀

```javascript
// concurrency 설정에 따라 동시 태스크 실행
const workerSlots = new Array(config.concurrency).fill(null);
// 슬롯이 비면 큐에서 다음 태스크를 꺼내 실행
// 각 워커는 독립 worktree에서 작업하므로 충돌 없음
```

- priority 기반 큐 정렬 (high > normal > low)
- 워커당 독립 프로세스 (spawn), 각자 별도 worktree
- 같은 프로젝트에 여러 태스크 동시 실행 가능 (worktree 격리)
- **서로 다른 프로젝트의 태스크도 동시 실행** (프로젝트 간 완전 독립)
- 태스크 간 간섭 없음
- 큐는 프로젝트 구분 없이 하나, priority + FIFO로 스케줄링

**병렬 실행 예시** (concurrency: 3):
```
시간 →
워커1: [task-1 my-api] analyze → implement → test(FAIL) → implement → test(PASS) → review
워커2: [task-2 my-web] analyze → implement → test(PASS) → self-review → review
워커3: [task-3 my-web] analyze → implement → test(PASS) → self-review → review
       ↑ 세 프로젝트/태스크가 동시에 진행, 각자 독립 worktree
```

### RSA 활용 예시

**조사 태스크** (pipeline: research):
```
rsa(research, count 5, converge)
  agent-1: "x402 프로토콜은 HTTP 402를 활용..."
  agent-2: "x402의 지원 체인은 Base, Arbitrum..."
  agent-3: "x402 구현 시 서명 검증이 핵심..."
  → 취합: 빠짐없는 종합 보고서

결과 저장: artifacts/{id}/rsa/round-1/aggregated.md
```

**설계 태스크** (pipeline: design):
```
rsa(analyze, count 3, converge)  → 빠짐없는 현황 분석
rsa(design, count 3, diverge)   → 다양한 관점 → 상위 설계안 도출

결과 저장:
  artifacts/{id}/rsa/round-1/  (analyze 개별 + 취합)
  artifacts/{id}/rsa/round-2/  (design 개별 + 취합)
```

---

## Phase 3 — CLI

웹 GUI의 모든 기능을 커맨드라인으로도 사용할 수 있게 한다.

### 파일 구조

```
lib/
  factory.js          # CLI 로직
bin/
  factory.js          # CLI 엔트리포인트
```

`package.json`에 `"factory"` bin 추가.

### 커맨드

```bash
factory submit <file.md>              # 태스크 제출 (단일/크로스-레포)
factory submit --title "..." --project ~/git/x  # 단일 프로젝트 인라인 생성
factory list [--status ...] [--project ~/git/x]
factory status <task-id>
factory logs <task-id> [--follow]
factory diff <task-id>                # 프로젝트별 diff 표시
factory approve <task-id>             # 전체 프로젝트 merge
factory reject <task-id>              # 전체 프로젝트 폐기
factory cancel <task-id>
factory pause / factory resume
factory stats [--project ~/git/x]
```

소켓으로 데몬과 통신. 데몬 미실행 시 자동 시작 (ensureDaemon 패턴).

**크로스-레포 예시**:
```bash
$ factory diff xyz789
  ─── lambda256-fe ───
  src/pages/webhook-v2/index.tsx     (new)
  src/api/webhook.ts                 (modified, +45 -3)
  ─── baas-console-be ───
  src/routes/webhook-v2.js           (new)
  ─── nodit-subscription-worker ───
  src/workers/subscription-v2.js     (new)

$ factory approve xyz789
  ✓ Merged factory/xyz789 into main (lambda256-fe)
  ✓ Merged factory/xyz789 into main (baas-console-be)
  ✓ Merged factory/xyz789 into main (nodit-subscription-worker)
  ✓ All worktrees removed
```

---

## Phase 4 — 데스크톱 앱 (Electron) [필요 시]

웹 GUI를 Electron으로 감싸서 네이티브 데스크톱 앱으로 제공한다. 웹 대시보드 + Web Notification API로 충분할 수 있으므로 필요성을 재평가한다.

### 구조

- Electron main process = factoryd (데몬을 내장, 별도 프로세스 불필요)
- Electron renderer = 기존 웹 GUI SPA
- 시스템 트레이 아이콘: 데몬 상태 표시 (running/paused), 빠른 접근
- 네이티브 알림: 태스크 완료/실패, 쿼터 복구 시 OS 알림
- 메뉴바에서 바로 태스크 제출 가능

### 이점

- 브라우저 탭 없이 독립 창으로 모니터링
- OS 네이티브 알림 (review 대기 중인 태스크 알림)
- 데몬 자동 시작/종료 (앱 실행 = 데몬 시작)
- 향후 로컬 파일 드래그앤드롭, 시스템 연동 등 확장 가능

---

## Phase 5 — 입력 어댑터

### 어댑터 인터페이스

어댑터에는 두 가지 유형이 있다:
- **입력 어댑터**: 외부 소스에서 태스크를 감지하여 `~/.factory/tasks/pending/`에 .md 파일을 생성
- **채팅 어댑터**: 외부 메신저와 연동하여 자연어로 팩토리를 조작 (상태 확인, approve 등)

```
adapters/
  github.js     # GitHub Issues 감시 (gh CLI 활용)
  webhook.js    # HTTP endpoint로 태스크 수신
  watcher.js    # 특정 디렉토리 감시 (fs.watch)
  slack.js      # Slack 봇 — 자연어 → 소켓 메서드 변환
  telegram.js   # Telegram 봇 — 자연어 → 소켓 메서드 변환
```

### 채팅 어댑터

대시보드를 열 수 없는 상황(모바일, 외출 중)에서 메신저로 간단한 조작을 할 수 있다. 자연어 메시지를 받아 의도를 파싱하고, 데몬의 소켓 메서드(list, approve, status 등)를 호출하여 결과를 응답한다.

```
[Slack]
사람: "상황 알려줘"
팩토리봇: "task-1(webhook v2) implement 진행 중, task-3(rate limit) 리뷰 대기"

사람: "task-3 approve"
팩토리봇: "승인 완료. main에 merge."
```

### GitHub 어댑터 예시
- `gh api` 폴링으로 라벨이 `factory` 인 이슈 감지
- 이슈 본문 → 태스크 .md 변환
- 완료 시 이슈에 코멘트 + PR 생성

---

## 구현 순서 (Phase 1 상세)

### Step 1: 기반 구조
1. `~/.factory/` 디렉토리 구조 생성 로직 (worktrees/ 포함)
2. config.json 로드/기본값 생성
3. 태스크 .md 파일 파싱 (YAML frontmatter + body)
4. 태스크 ID 생성 (nanoid 스타일, crypto.randomBytes)
5. git worktree 헬퍼 (생성/삭제/목록 조회, 크로스-레포 워크스페이스 셋업)
6. 산출물 디렉토리 생성 (`artifacts/{task-id}/` + memory.json 초기화)
7. **버전 + 마이그레이션 시스템** (`~/.factory/version`, 마이그레이션 함수 체인)

### Step 2: 데몬 코어
1. fork + detach + PID 관리
2. Unix 소켓 서버 (JSON-RPC)
3. pending/ 디렉토리 스캔 루프
4. 상태 관리 (state.json, 디바운스 저장)
5. 시그널 핸들러 (graceful shutdown, 실행 중 worktree 보존)
6. 로깅 (append-only, 자동 truncate)
7. **쿼터 모니터** (에러 패턴 감지 → paused 전환 → 예상 회복 시각 계산 → 자동 리줌)
8. **리소스 모니터** (CPU/메모리/디스크 주기적 체크 → 동적 동시성 조절)
9. **정리 작업** (보존 기간 경과 worktree/산출물 삭제, 고아 worktree 탐지, Docker 잔여물 정리)

### Step 3: 파이프라인 엔진 (오케스트레이터)
1. 파이프라인 정의 파싱 (문자열 → stage, 객체 → loop)
2. **워크스페이스 생성** (projects 순회 → 각 프로젝트 branch + worktree add + workspace.json 생성)
3. **stage 실행기**: 템플릿 로드 → 최소 컨텍스트 주입 → Claude spawn → 산출물 파일 저장
4. **적응형 파라미터**: analyze 산출물의 difficulty를 읽어 loop maxIterations, rsa count 등 결정
5. **loop 실행기**: 게이트 판정 → 실패 시 피드백 수집 → 재주입 → 재실행 (Phase 1에서는 순차만, Phase 2에서 활성화)
6. **rsa 실행기**: N개 에이전트 병렬 spawn → 완료 대기 → 취합 에이전트 실행 (Phase 2에서 활성화)
7. **산출물 관리**: 각 stage 결과를 `artifacts/{task-id}/{stage}.md`에 덮어쓰기 + memory.json timeline에 기록
8. **최종 요약 생성**: 파이프라인 종료 시 `summary.md` 자동 생성 (변경 요약 + 판단 근거 + 테스트 결과)
8. **인프라 큐**: test 스텝에서 통합 테스트 필요 시 infra lock 획득 대기 → Docker Compose up → 테스트 → down → lock 해제
9. **모든 스텝 완료 → review/로 이동** (사람 승인 대기)
10. 스텝 실패 → failed/로 이동
11. Rate limit 감지 + 백오프

### Step 4: 웹 대시보드
1. HTTP 서버 (factoryd에 내장, 포트 7777)
2. WebSocket 서버 (실시간 이벤트 스트리밍)
3. SPA 페이지 (`factory-ui.js`에 HTML/CSS/JS 내장)
4. 태스크 목록 + 상세 패널 (2단 구조)
5. 태스크 제출 폼 (단일/크로스-레포, .md 파일 업로드)
6. Review 화면: summary + 커밋 히스토리 + diff + approve/reject/request-changes
7. gather(interactive) Q&A UI
8. 통계 바 + 리소스 모니터 + 데몬 pause/resume

### Step 6: 프롬프트 템플릿

각 템플릿은 해당 에이전트에게 **필요한 산출물 파일만** 주입하도록 설계한다. 전체 히스토리를 넘기지 않는다.

1. factory-analyze.md — 코드베이스 분석 + 구현 계획 + **난이도 판정** (difficulty 필드 필수 출력)
3. factory-implement.md — spec + analyze 기반 코드 구현 + **커밋 구조** (관심사별 분리 best effort, 판단 근거 기록). 프론트엔드 시 DevTools MCP 활용 지시 포함
4. factory-visual-check.md — 프론트엔드 전용. spec의 시각적 요구사항을 DevTools DOM API로 검증 + pass/fail
5. factory-test.md — spec + implement 결과 기반 테스트 실행 + pass/fail 판정. e2e 시 DevTools 활용
6. factory-self-review.md — spec + 전체 diff 기반 품질 셀프 리뷰
7. factory-gather.md — 요구사항 수집 (자율/인터렉티브)
8. factory-spec.md — gather 결과 → 구조화된 명세 변환
9. factory-research.md — 정보 수집 + 구조화된 보고서 작성 (RSA converge용)
10. factory-design.md — 아키텍처/API 설계 (RSA diverge용)
11. factory-deliberation.md — 연속 실패 시 다관점 병렬 분석. 문제 분석 + 해결 방안/대안 도출
12. factory-rsa-converge.md — RSA 취합: 합집합으로 빠짐없이 수집
13. factory-rsa-diverge.md — RSA 취합: 대립점에서 상위 관점 도출
14. factory-lessons.md — 파이프라인 산출물에서 "문제 → 해결" 교훈 추출

**템플릿 변수 (에이전트별 최소 컨텍스트)**:

| 변수 | 설명 | 사용하는 에이전트 |
|------|------|-----------------|
| `{{task}}` | 태스크 원문 | gather, analyze (spec 없을 때) |
| `{{workspace}}` | 프로젝트 목록, 역할, 디렉토리 경로 | 코드 접근이 필요한 모든 에이전트 |
| `{{gather}}` | gather.md 내용 | spec |
| `{{spec}}` | spec.md 내용 | analyze, implement, test, self-review |
| `{{analyze}}` | analyze.md 내용 (계획 + 난이도) | implement |
| `{{implement}}` | implement.md 내용 (최신) | test, visual-check |
| `{{feedback}}` | test.md 또는 visual-check.md 실패 내용 (loop 재실행 시) | implement |
| `{{diff}}` | 전체 변경사항 diff | self-review |
| `{{devtools}}` | DevTools MCP 연결 정보 (host, port) | implement(FE), visual-check, test(e2e) |

각 템플릿에는 자기에게 필요한 변수만 포함된다. 예를 들어 test 에이전트는 `{{spec}}` + `{{implement}}` + `{{workspace}}`만 받고, analyze 결과나 이전 iteration 히스토리는 받지 않는다. `{{devtools}}`는 프론트엔드 프로젝트일 때만 주입된다.

## 검증 방법

### 기본 흐름
1. `factoryd start` → 데몬 기동, `http://localhost:7777` 접속 확인
2. 웹 GUI에서 태스크 제출 (title: "README에 배지 추가", project: ~/git/test-repo)
3. 대시보드에서 pending → running 전이 확인
4. 실시간 로그 스트리밍 확인
5. 파이프라인 완료 → review 상태 전이 확인
6. Diff 뷰에서 변경사항 확인
7. **원본 프로젝트에 변경이 없는지 확인** (`cd ~/git/test-repo && git status` → clean)
8. Approve 클릭 → done 상태 전이 + merge 확인
9. 원본 프로젝트에 변경사항 반영 확인
10. worktree 정리 확인

### 멀티 프로젝트 병렬 실행
1. 웹 GUI에서 프로젝트 A, B에 각각 태스크 제출
2. 대시보드에서 두 태스크가 동시 running 확인 (concurrency >= 2)
3. 프로젝트 필터로 각각 확인
4. 각 프로젝트 원본이 모두 clean 상태인지 확인
5. 각각 독립적으로 approve/reject

### 같은 프로젝트 병렬 실행
1. 같은 프로젝트에 태스크 2개 제출
2. 두 태스크가 각자 독립 worktree에서 실행되는지 확인
3. 원본은 변경 없음
4. 각각 독립적으로 approve → 순서대로 merge

### 크로스-레포 태스크
1. 웹 GUI에서 여러 프로젝트 + 역할을 지정하여 태스크 제출 (또는 .md 파일 업로드)
2. 모든 프로젝트에 대해 worktree가 생성되는지 확인
3. `ls ~/.factory/worktrees/<id>/` → 프로젝트별 디렉토리 + workspace.json
4. AI 에이전트가 여러 프로젝트를 오가며 코드를 수정하는지 로그 확인
5. Diff 뷰에서 프로젝트별 탭으로 변경사항 확인
6. **모든 원본 프로젝트가 clean 상태인지 확인**
7. Approve → 모든 프로젝트에 merge, 상태 표시 확인
8. 각 원본 프로젝트에 변경사항 반영 확인
9. 모든 worktree + 브랜치 정리 확인

### 인프라 테스트 큐
1. 통합 테스트가 필요한 태스크 2개를 동시 제출
2. 첫 번째 태스크가 유닛 테스트 통과 후 인프라 lock 획득 → Docker Compose up 확인
3. 두 번째 태스크가 유닛 테스트 통과 후 `waiting-infra` 상태로 대기 확인
4. 첫 번째 태스크 통합 테스트 완료 → Compose down → lock 해제
5. 두 번째 태스크가 자동으로 lock 획득 → 통합 테스트 실행 확인
6. 유닛 테스트만 필요한 태스크는 인프라 큐 없이 즉시 완료 확인

10. `factoryd stop` → 정상 종료 확인

---

## FSD (Full Self-Driving)

> **구현 시점**: Auto-approve + Discovery 안정화 후. Phase 1-2에서는 설계만, 코드 구현은 하지 않는다.

프로젝트 단위로 완전 자율 개선을 활성화하는 모드. FSD가 켜진 프로젝트는 팩토리가 스스로 개선점을 발굴하고, 구현하고, 테스트 통과 시 자동으로 머지한다. 사람 개입 없이 전체 사이클이 돌아간다.

### 개념

FSD는 기존 기능들을 프로젝트 단위 플래그 하나로 묶는 상위 개념이다:

| FSD 켜짐 | FSD 꺼짐 |
|----------|----------|
| Discovery 자동 실행 → 태스크 자동 생성 | 사람이 태스크 제출 |
| Auto-approve 활성화 → 자동 머지 | 사람이 리뷰 후 approve |
| 파이프라인 전체가 자율적으로 순환 | 사람이 각 단계를 확인 |

```
FSD 프로젝트 사이클:
  discovery → proposals 자동 accept
    → analyze → loop(implement ⇄ test) → self-review
      → auto-approve → merge
        → 다음 discovery 주기에서 새 개선점 발굴
        → (반복)
```

### config.json

```json
{
  "projects": {
    "~/git/ucm": {
      "fsd": true,
      "discovery": {
        "schedule": "daily 03:00",
        "focus": ["test-coverage", "tech-debt", "dependencies"]
      },
      "autoApprove": {
        "conditions": {
          "testsPass": true,
          "selfReviewPass": true,
          "maxDifficulty": "moderate"
        }
      }
    },
    "~/git/my-api": {
      "fsd": false
    }
  }
}
```

`fsd: true`는 해당 프로젝트에 대해:
- `discovery.enabled`를 암묵적으로 true로 설정
- `autoApprove.enabled`를 암묵적으로 true로 설정
- discovery에서 나온 proposal을 자동으로 accept하여 태스크 생성

`fsd: false`(기본값)인 프로젝트는 기존과 동일 — 사람이 제출, 사람이 승인.

### FSD 안전 장치

- auto-approve 조건(`maxDifficulty`, `maxFilesChanged` 등)은 여전히 적용 — complex 태스크는 FSD 프로젝트라도 사람 리뷰
- merge conflict 발생 시 자동 중단 → 사람에게 에스컬레이션
- FSD로 처리된 태스크는 대시보드에 `(fsd)` 뱃지 표시, 사후 확인 가능
- memory.json에 `"reviewType": "fsd"` 기록
- 연속 실패 (같은 프로젝트에서 N회 연속 태스크 실패) 시 FSD 자동 일시정지 → 사람에게 알림

### 전역 모드와의 관계

기존 `quota.mode` (work/off)는 **팩토리 전체의 리소스 사용량**을 조절하는 것이고, FSD는 **프로젝트별 자율 수준**을 결정하는 것이다. 두 개는 독립:

- work 모드 + FSD 프로젝트: 쿼터 50% 내에서 FSD 사이클이 돌아감
- off 모드 + FSD 프로젝트: 쿼터 90%로 더 많이 돌아감
- work 모드 + non-FSD 프로젝트: 사람이 제출/승인, 쿼터 50% 내에서 실행

---

## Auto-approve 정책

review 단계에서 사람 개입이 필수인 병목을 해소한다. self-review + 테스트가 모두 통과한 경우 사람의 승인 없이 자동으로 merge하는 정책을 추가한다. FSD 프로젝트에서는 이 정책이 자동 활성화된다.

### 조건 기반 auto-approve

태스크 제출 시 또는 프로젝트별 설정으로 auto-approve 조건을 지정한다. 모든 조건을 만족하면 review 단계를 건너뛰고 자동 merge.

```json
{
  "autoApprove": {
    "enabled": false,
    "conditions": {
      "testsPass": true,
      "selfReviewPass": true,
      "maxDifficulty": "moderate",
      "maxFilesChanged": 10
    }
  }
}
```

- `enabled`: 전역 토글. 프로젝트별 오버라이드 가능
- `testsPass`: 유닛 + 통합 테스트 전부 통과 필수
- `selfReviewPass`: self-review 체크리스트 100% 완료 필수
- `maxDifficulty`: 이 난이도 이하만 auto-approve (complex는 항상 사람 리뷰)
- `maxFilesChanged`: 변경 파일 수 상한. 대규모 변경은 사람이 확인

### 태스크 단위 오버라이드

```markdown
---
title: README 배지 추가
autoApprove: true
---
```

간단한 태스크는 제출 시 명시적으로 auto-approve를 켤 수 있다.

### 안전 장치

- auto-approve된 태스크도 대시보드 done 목록에 표시, 사후 확인 가능
- auto-approve 이력은 memory.json에 `"reviewType": "auto"` 기록
- merge conflict 발생 시 auto-approve 중단 → 사람에게 에스컬레이션

---

## Discovery (자율 태스크 발굴)

프로젝트를 분석하여 필요한 작업을 스스로 찾아내고, 사람에게 보고한다. non-FSD 프로젝트에서는 사람이 제안을 골라서 승인하면 실제 태스크로 전환된다. FSD 프로젝트에서는 proposal이 자동 accept되어 태스크로 전환된다.

### 실행 모드

- **on-demand**: 대시보드에서 프로젝트 선택 → "분석" 버튼. 또는 CLI `factory discover ~/git/my-api`
- **scheduled**: 프로젝트별 토글 ON/OFF + 주기 설정

### 분석 관점

RSA로 다관점 병렬 분석하여 한 에이전트가 놓치는 것을 다른 에이전트가 잡아낸다.

| 관점 | 찾는 것 |
|------|--------|
| security | 의존성 취약점, 코드 패턴 (injection, XSS 등) |
| test-coverage | 커버리지 부족 모듈, 테스트 없는 핵심 경로 |
| tech-debt | TODO/FIXME/HACK 주석, 코드 중복, 복잡도 높은 함수 |
| dependencies | 메이저 업데이트 가능 패키지, deprecated API 사용 |
| performance | N+1 쿼리, 불필요한 재렌더링, 비효율 알고리즘 |
| documentation | README 누락, API 문서 불일치, 변경 후 미반영 문서 |

프로젝트별 `focus` 설정으로 관심 있는 관점만 선택 가능.

### config.json 확장

```json
{
  "projects": {
    "~/git/my-api": {
      "discovery": {
        "enabled": true,
        "schedule": "daily 03:00",
        "focus": ["security", "test-coverage", "tech-debt"]
      }
    },
    "~/git/my-web": {
      "discovery": {
        "enabled": false
      }
    }
  }
}
```

### 산출물 구조

```
~/.factory/discoveries/{project-name}/
├── latest.md          # 최신 분석 결과 (사람이 읽는 보고서)
├── proposals.json     # 제안 목록 (상태 관리)
└── history/           # 과거 분석 기록
```

### proposals.json

```json
[
  {
    "id": "disc-001",
    "title": "auth 모듈 테스트 커버리지 32% -> 80%",
    "category": "test-coverage",
    "difficulty": "moderate",
    "reason": "auth는 핵심 모듈인데 커버리지가 32%로 낮음",
    "affectedFiles": ["src/auth/*.ts"],
    "status": "new",
    "discoveredAt": "2026-02-08T03:00:00Z"
  }
]
```

**status 흐름**: `new` → `accepted`(태스크로 전환) | `dismissed`(무시)

dismissed된 항목은 다음 분석 때 다시 제안하지 않는다. "이건 의도된 거야"를 기억하는 장치.

### 대시보드 연동

- 프로젝트 설정 화면에서 discovery 토글 ON/OFF + 주기 선택
- "Proposals" 탭에 발굴 결과 목록
- 이전 분석과 비교하여 "새로 발견된 것"만 하이라이트
- 체크박스로 골라서 한 번에 태스크로 전환
- dismissed 항목은 접어두기 (필요하면 복원 가능)

### 파이프라인

`pipeline: discover`로 기존 체계에 맞춘다. scheduled 실행은 데몬 스캔 루프에 cron 스타일 체크를 추가.

```json
{
  "pipelines": {
    "discover": [
      { "rsa": "discover", "count": "auto", "strategy": "converge" }
    ]
  }
}
```

---

## 태스크 자동 분할 (Auto-split)

큰 태스크가 들어오면 analyze 단계에서 규모를 판단하고, 너무 크면 **자동으로 서브태스크로 분할**한다.

### 왜 필요한가

현재 설계에서 태스크는 하나의 파이프라인이 통으로 처리한다. complex로 판정되면 loop 횟수를 늘릴 뿐, 쪼개지지 않는다. 하지만 실제로 큰 태스크는:
- 컨텍스트 윈도우에 다 안 들어감 → 품질 저하
- 변경 범위가 넓어 리뷰가 어려움
- 하나가 막히면 전체가 멈춤
- 작은 단위로 쪼개면 병렬 실행 가능

### 동작 흐름

```
태스크 제출 → analyze → "이건 너무 크다" 판정
  → split 스텝: 서브태스크 분할 계획 생성
  → 서브태스크 N개 자동 생성 (의존성 체인 포함)
  → 각 서브태스크가 독립 파이프라인으로 실행
  → 전부 완료 → 통합 검증 → review (사람은 최종 결과만 승인)
```

### 분할 기준

analyze 산출물에 split 판정을 추가한다.

```json
{
  "difficulty": "complex",
  "shouldSplit": true,
  "splitReason": "3개의 독립적인 관심사: API 엔드포인트, DB 스키마, 프론트엔드 연동",
  "proposedSplit": [
    { "title": "환불 API 엔드포인트 구현", "scope": ["src/routes/refund.ts"], "order": 1 },
    { "title": "환불 DB 스키마 + 마이그레이션", "scope": ["src/models/refund.ts", "migrations/"], "order": 1 },
    { "title": "환불 프론트엔드 연동", "scope": ["src/pages/refund/"], "order": 2, "dependsOn": [0, 1] }
  ]
}
```

### 부모-자식 관계

```markdown
---
id: parent-001
title: 결제 시스템 환불 기능 추가
status: running
children: [sub-001, sub-002, sub-003]
---
```

```markdown
---
id: sub-001
title: 환불 API 엔드포인트 구현
parent: parent-001
status: pending
---
```

- 부모 태스크는 모든 자식이 완료될 때까지 running 유지
- 자식 태스크는 각자 독립 worktree에서 실행
- 전체 완료 후 부모 태스크가 통합 검증 → review

### 대시보드

부모 태스크를 펼치면 자식 태스크 목록이 트리로 표시. 각 자식의 진행 상태를 한눈에 확인.

---

## 태스크 의존성 체인

태스크 간 실행 순서를 지정한다. 선행 태스크가 완료(merge)되어야 후행 태스크가 시작된다.

### 사용 사례

- 자동 분할의 서브태스크 간 순서 (API 먼저 → 프론트 연동)
- 사람이 직접 의존성 지정 ("인증 리팩터링 끝나면 권한 시스템 작업 시작해")
- Discovery에서 발굴한 태스크 간 자연스러운 순서

### 태스크 frontmatter 확장

```markdown
---
id: task-002
title: 환불 프론트엔드 연동
dependsOn: [task-001]
status: pending
---
```

### 동작

```
task-001 (pending) ─→ running ─→ review ─→ done (merge)
                                              ↓ 트리거
task-002 (blocked) ──────────────────────→ pending ─→ running ─→ ...
```

- `dependsOn`에 명시된 태스크가 모두 done이 될 때까지 `blocked` 상태 유지
- blocked 태스크는 대시보드에 별도 표시 (어떤 태스크를 기다리는지 표시)
- 선행 태스크가 failed되면 → 후행 태스크도 자동 blocked 해제 대신 사람에게 알림
- 순환 의존성 감지 → 제출 시 거부

### 상태 흐름 확장

```
blocked ─→ pending ─→ running ─→ ...
  ↑
  └─ dependsOn 태스크가 아직 done이 아님
```

### 대시보드

의존성 그래프를 시각적으로 표시. 어떤 태스크가 어떤 태스크를 기다리는지 화살표로 연결.

---

## 비용 추적 (Cost Tracking)

태스크별 토큰 소비량, 소요 시간, 리소스 사용량을 추적한다. 프로젝트별/파이프라인별 통계로 비용 효율을 파악하고 이상을 감지한다.

### 수집 지표

| 지표 | 수집 방법 | 단위 |
|------|----------|------|
| 토큰 소비 | 에이전트 spawn 시 usage 집계 | input/output tokens |
| 소요 시간 | stage 시작~종료 타임스탬프 | 초 |
| loop 횟수 | loop 스텝 iteration 카운트 | 회 |
| RSA 에이전트 수 | rsa 스텝 실제 spawn 수 | 개 |
| 크래시/재시도 | 크래시 발생 횟수 | 회 |

### memory.json 확장

```json
{
  "cost": {
    "totalTokens": { "input": 45000, "output": 12000 },
    "totalDurationMs": 342000,
    "stages": [
      { "name": "analyze", "tokens": { "input": 8000, "output": 3000 }, "durationMs": 45000 },
      { "name": "implement-1", "tokens": { "input": 15000, "output": 5000 }, "durationMs": 120000 },
      { "name": "test-1", "tokens": { "input": 10000, "output": 2000 }, "durationMs": 60000 },
      { "name": "implement-2", "tokens": { "input": 12000, "output": 2000 }, "durationMs": 90000 }
    ],
    "loopIterations": 2,
    "rsaSpawns": 0,
    "crashes": 0
  }
}
```

### 대시보드 통계

- 태스크 상세에 비용 요약 표시 (토큰, 시간, loop 횟수)
- 통계 탭에서 프로젝트별/파이프라인별/기간별 집계
- 평균 대비 이상치 하이라이트 ("이 태스크는 평균의 3배 토큰 소비")

### 이상 감지

```json
{
  "costAlerts": {
    "tokenMultiplier": 3,
    "durationMultiplier": 3
  }
}
```

같은 난이도/파이프라인의 과거 평균 대비 N배 이상이면 대시보드에 경고 표시. 프롬프트 개선이나 태스크 설계 문제를 조기에 발견하는 장치.

---

## 추가 하네스

파이프라인 엔진의 현재 한계를 보완하는 12개 하네스를 4개 카테고리로 구성한다. AI의 세 가지 근본 한계(기억 불가, 비결정성, 환각)에 대응하며, 12개 중 8개가 AI 호출 없이 결정적 코드로 동작한다.

현재 파이프라인의 주요 한계:
- 에이전트가 코드베이스 탐색에 토큰을 낭비 (사전 컨텍스트 부재)
- 프로젝트 컨벤션 인식 없이 "관례를 따라라"고만 지시
- loop 반복 시 이전 실패 접근법의 구조화된 기록이 없어 같은 시도 반복
- stage 간 검증이 모두 AI 기반 (결정적 검증 부재)
- 산출물 크기 관리 없이 컨텍스트 윈도우 오버플로 위험
- lessons 추출은 하지만 다시 주입하지 않음 (write-only)
- 게이트 파싱이 마지막 20줄 regex에 의존 (취약)
- analyze 계획 vs implement 실행 간 드리프트 감지 없음

### 카테고리 1: 컨텍스트 최적화

기억/컨텍스트 윈도우 한계에 대응하는 4개 하네스.

#### `task-refinement` — 태스크 제출 시 Q&A 기반 요구사항 구체화

**문제**: 태스크가 "로그인 기능 추가" 같은 한 줄 제목만으로 제출되면, 파이프라인이 모호한 입력으로 시작하여 analyze가 추측으로 범위를 설정하고 implement가 의도와 다른 방향으로 구현한다. 현재 gather 스텝(interactive)이 파이프라인 내부에서 Q&A를 하지만, 이미 파이프라인이 시작된 후라 워커를 점유한 채 사람 응답을 기다린다.

**메커니즘**: 태스크 제출 시점에 두 가지 모드로 요구사항을 구체화한다.

**모드 1: Interactive Q&A** (사람이 응답)
- 대시보드 태스크 폼에 "Q&A로 구체화" 버튼 추가
- 제목/설명 입력 → 버튼 클릭 → AI가 커버리지 기반 질문 생성 → 사람 응답 → 반복
- qna.js의 커버리지 영역 개념 재사용:
  - 브라운필드(기존 프로젝트): 작업 목표, 변경 범위, 설계 결정, 제약 조건
  - 각 영역 1.0 도달 또는 최대 5라운드로 종료
- 프로젝트 경로가 지정되면 코드베이스 스캔으로 구체적 선택지 제시 (qna.js의 브라운필드 모드)
- 질문/응답을 실시간 대시보드에 표시, WebSocket으로 양방향 통신
- 결과: 구조화된 요구사항이 태스크 description에 병합되어 제출

**모드 2: Auto-pilot** (AI가 질문 + 응답 모두 수행)
- 대시보드에 "자동 구체화" 버튼 추가
- 주제/제목만 입력 → 버튼 클릭 → AI가 질문 생성 + 자동 응답
- 응답 근거는 프로젝트 경로 유무에 따라 달라짐:
  - **프로젝트 있음 (브라운필드)**: 코드베이스 스캔으로 기존 패턴, 아키텍처, 컨벤션에 맞는 답변 생성
  - **프로젝트 없음 (그린필드)**: 일반적인 소프트웨어 설계 원칙과 업계 관행에 따라 답변 생성 (qna.js의 그린필드 커버리지 영역 사용: 제품 정의, 핵심 기능, 기술 스택, 설계 결정)
- 커버리지 기반 종료 조건 동일 (영역별 1.0 또는 최대 5라운드)
- 생성된 요구사항을 대시보드에 표시 → 사람이 리뷰/수정 후 제출
- 워커를 점유하지 않음 (제출 전 단계이므로 파이프라인 밖에서 실행)

**모드 전환**: Interactive → Auto-pilot 중간 전환 지원
- Interactive Q&A 진행 중 "나머지 자동 완성" 버튼으로 auto-pilot 전환
- 사람이 핵심 결정(인증 방식, DB 선택 등)만 직접 응답하고, 나머지 세부사항은 AI가 프로젝트 컨텍스트 기반으로 채움
- 전환 시 지금까지의 Q&A를 컨텍스트로 유지하여 일관성 보장
- auto-pilot이 채운 답변도 제출 전 리뷰/수정 가능

```
[대시보드]
┌─────────────────────────────────────┐
│ Title: 로그인 기능 추가              │
│ Project: /path/to/my-app            │
│ Description: (비어있음)              │
│                                     │
│ [Q&A로 구체화]  [자동 구체화]  [제출] │
└─────────────────────────────────────┘
        │                │
        ▼                ▼
  Interactive Q&A    Auto-pilot
  (사람이 응답)      (AI가 자동 응답)
        │
        ├─ 핵심 질문 직접 응답
        │
        ├─ [나머지 자동 완성] ──→ Auto-pilot
        │                        (기존 Q&A 컨텍스트 유지)
        ▼                        │
  ┌─────────────────────────────────┐
  │ Generated Requirements          │
  │ - OAuth2 기반 인증 (사람 응답)    │
  │ - JWT 토큰 관리 (AI 추론)        │
  │ - ...                           │
  │ [수정]                [제출]     │
  └─────────────────────────────────┘
```

**gather 스텝과의 관계**:
- task-refinement는 파이프라인 밖(제출 전)에서 동작, gather는 파이프라인 안에서 동작
- task-refinement으로 구체화된 태스크는 파이프라인에서 gather 스텝을 스킵 가능
- 구체화 없이 제출된 태스크는 기존대로 gather 스텝에서 처리
- 파이프라인 config에 `skipGatherIfRefined: true` 옵션으로 제어

**통합**:
- 대시보드(ucm-ui.js)에 Q&A/Auto-pilot UI 추가
- 백엔드(ucmd.js)에 `/api/refine` 엔드포인트 + WebSocket `refine:question`/`refine:answer` 이벤트
- qna.js의 `computeCoverage()`, `buildQuestionPrompt()`, `loadRepoContext()` 로직 재사용
- 결과를 태스크 body에 `## Refined Requirements` 섹션으로 병합
- `artifacts/{taskId}/refinement.md`에 Q&A 기록 저장

**config**:
```js
taskRefinement: { enabled: true, maxRounds: 5, skipGatherIfRefined: true, autoTimeoutMs: 60000 }
```

#### `context-prefetch` — 관련 파일 사전 조립

**문제**: 에이전트가 매번 Glob/Grep/Read 도구로 코드베이스를 탐색하며 토큰과 시간을 소모한다.

**메커니즘**: 파이프라인 시작 시 결정적(비AI) 스캔으로 관련 컨텍스트를 사전 조립한다.
- 태스크 제목/설명에서 키워드 추출 → `git grep`으로 파일 매칭, 적중 밀도로 랭킹
- 상위 파일의 import/require 의존성 추적
- `git log --since=30d --name-only`로 최근 활성 파일 반영
- 파일 경로 + 발췌(첫 10줄 + 매칭 줄) + 디렉토리 트리를 마크다운으로 조립
- 토큰 상한(기본 4000) 내로 제한

**통합**:
- `runPipeline()`에서 worktree 생성 후, step 루프 전에 1회 실행
- `stageResults.relevantContext`에 저장
- `{{RELEVANT_CONTEXT}}` 템플릿 변수로 analyze, implement에 주입
- `artifacts/{taskId}/context-prefetch.md`에 저장

**config**:
```js
contextPrefetch: { enabled: true, maxTokens: 4000, maxFiles: 20, recentDays: 30 }
```

#### `context-budget` — 토큰 예산 관리자

**문제**: 큰 산출물이 컨텍스트 윈도우를 넘칠 수 있다. 현재 `buildStageResultsSummary`는 stage당 2000자 제한이 있지만, 개별 템플릿 변수에는 크기 제한이 없다.

**메커니즘**: 총 토큰 예산을 변수별 우선순위 가중치에 따라 분배한다.
- 변수별 우선순위: SPEC(9) > TEST_FEEDBACK(9) > TASK_TITLE(10) > FEEDBACK(8) > ANALYZE_RESULT(7) > RELEVANT_CONTEXT(6) > WORKSPACE(3)
- 총합이 예산 초과 시 저우선순위부터 잘라냄
- 잘라냄 전략: head-tail (앞 60% + 뒤 40% 보존, 중간에 `...(truncated: N tokens removed)...` 삽입)
- 토큰 추정: `Math.ceil(text.length / 4)`

**통합**:
- `buildStagePrompt()` 내부에서 변수 치환 전 후처리 단계로 실행
- `applyContextBudget(assembledVars, budgetConfig)` 함수

**config**:
```js
contextBudget: { enabled: true, totalTokenBudget: 30000, truncationStrategy: "head-tail" }
```

#### `convention-inject` — 프로젝트 컨벤션 자동 주입

**문제**: 에이전트가 프로젝트 컨벤션(네이밍, import 스타일, 테스트 패턴 등)을 모른 채 코드를 작성한다.

**메커니즘**: 결정적(비AI) 프로젝트 스캔으로 컨벤션 문서를 생성한다.
- `package.json`/`tsconfig.json` 등에서 스택/프레임워크/테스트 러너 감지
- 소스 파일 샘플(최대 10개)에서 패턴 추출: 네이밍(camelCase/snake_case), import 스타일, 인덴트, 세미콜론, 에러 처리
- `.eslintrc`, `.prettierrc` 등 린터 설정 반영
- 결과를 ~1500 토큰 마크다운으로 조립
- 프로젝트별 캐시 (`~/.ucm/conventions/{projectName}.md`, TTL 24시간)

**통합**:
- worktree 생성 시 1회 실행 (캐시 있으면 스킵)
- `{{CONVENTIONS}}` 템플릿 변수로 implement, self-review에 주입

**config**:
```js
conventionInject: { enabled: true, cacheTtlMs: 86400000, maxSampleFiles: 10 }
```

### 카테고리 2: 비결정성 대응

반복/병렬 개선을 위한 3개 하네스.

#### `iteration-history` — 구조화된 반복 기억

**문제**: loop 실패 시 원시 테스트 출력만 피드백으로 전달되어, 에이전트가 이전에 실패한 접근법을 반복 시도한다.

**메커니즘**: iteration마다 {접근법, 실패 항목, 변경 파일}을 구조화하여 기록한다.
```markdown
## Iteration History (DO NOT repeat failed approaches)

### Iteration 1 (45s)
- Approach: express-rate-limit 미들웨어 기반 구현
- Failed: whitelist IP bypass 미구현, custom header 미전달
- Files: src/middleware/rateLimit.js, src/config.js

### Remaining failures to fix:
- custom header 미전달

### What NOT to repeat:
- rate limiting 재구현 불필요 (iteration 1 방식 동작함)
- 집중: custom header 전달 (2회 연속 실패)
```

**통합**:
- `executeLoopStep()`에서 게이트 실패 후 `extractIterationSummary()` 호출
- 기존 `stageResults.testFeedback` 대체 (원시 출력 대신 구조화된 히스토리)
- `{{ITERATION_HISTORY}}` 템플릿 변수로 implement에 주입
- `artifacts/{taskId}/iteration-history.json`에 저장

**config**:
```js
iterationHistory: { enabled: true, maxHistoryEntries: 5 }
```

#### `rsa-dedup` — RSA 수렴 감지 및 중복 제거

**문제**: RSA에서 N개 에이전트가 비슷한 결과를 내면 취합 프롬프트에 중복 정보가 넘친다.

**메커니즘**: 취합 전 결정적 중복 제거를 수행한다.
- 문장 단위 word trigram Jaccard 유사도 계산 (O(N²), N은 보통 3~5)
- 유사도 > 0.8인 출력을 클러스터링, 클러스터당 가장 상세한 것만 대표로 선정
- 다양성 점수 = distinct clusters / total outputs
  - 다양성 < 0.3이면 "RSA count가 이 태스크 유형에 과다" 경고
- 대표 출력만 취합 에이전트에 전달, "이 결과는 agent X, Y, Z의 공통 출력을 대표" 주석 포함

**통합**:
- `executeRsaStep()`에서 에이전트 완료 후, 취합 프롬프트 구성 전에 실행
- `artifacts/{taskId}/{stage}-rsa-dedup.json`에 클러스터 메타데이터 저장

**config**:
```js
rsaDedup: { enabled: true, similarityThreshold: 0.8, minDiversityWarning: 0.3 }
```

#### `adaptive-loop` — 실패 패턴 감지 기반 적응형 루프

**문제**: loop가 고정 maxIterations까지 돌면서 정체(같은 실패 반복)에도 계속하고, 진전 중에도 일찍 중단한다.

**메커니즘**: iteration별 실패 시그니처를 추적하여 세 가지 판단을 내린다.
- **정체 감지**: 동일 실패 시그니처가 2회 연속 → 조기 중단, 에스컬레이션
- **진전 추적**: 실패 수가 단조 감소 → 진행 중
- **동적 조정**: 진전 시 maxIterations + 2 추가 허용, 정체 시 조기 중단

실패 시그니처: 테스트 실패명/메시지를 정렬 후 해시

**통합**:
- `executeLoopStep()`의 게이트 실패 체크 후 `detectLoopTrend()` 호출
- iteration-history와 연동 (iteration-history의 데이터를 입력으로 사용)
- `memory.json` timeline에 trend 메타데이터 추가

**config**:
```js
adaptiveLoop: { enabled: true, stagnationThreshold: 2, maxExtension: 2 }
```

### 카테고리 3: 환각 방지

검증/유효성 확인을 위한 3개 하네스.

#### `deterministic-gate` — 비AI 결정적 검증 계층

**문제**: 모든 검증이 AI 기반이라 AI가 "완료했습니다"라고 환각할 수 있다. `GATE: PASS` 출력도 실제와 불일치할 수 있다.

**메커니즘**: stage 완료 후 결정적 검사를 자동 실행한다.

**implement 후**:
- `git diff --stat` 비어있지 않은지 확인
- merge conflict 마커 (`<<<<<<<`) 없는지 확인
- 변경 파일 구문 검사 (`node -c`, `python -m py_compile`)
- 린터 설정 존재 시 변경 파일만 린트

**test 후**:
- 테스트 출력에서 표준 패턴 파싱 (Jest: `Tests: X passed, Y failed`, Mocha: `X passing, Y failing`)
- AI의 `GATE: PASS` 주장과 실제 테스트 카운트 교차 검증
- AI가 PASS라 했는데 파싱된 결과에 실패가 있으면 FAIL로 오버라이드

**self-review 후**:
- spec의 체크리스트 항목 수 vs self-review의 `[x]`/`[ ]` 카운트
- `[ ]` > 0인데 AI가 PASS라 하면 FAIL로 오버라이드

**통합**:
- `executeStageStep()`에서 `parseGateResult` 후, 반환 전에 `runDeterministicGate()` 실행
- AI 게이트 결과를 오버라이드 가능
- `artifacts/{taskId}/{stage}-deterministic-gate.json`에 결과 저장
- 오버라이드 발생 시 `{{DETERMINISTIC_FEEDBACK}}` 변수로 다음 iteration에 주입

**config**:
```js
deterministicGate: { enabled: true, syntaxCheck: true, lintCheck: true, overrideAiGate: true }
```

#### `drift-detector` — 계획 vs 실행 드리프트 감지

**문제**: analyze가 세운 계획과 implement의 실제 변경이 달라질 수 있다 (scope creep, 누락).

**메커니즘**: implement 완료 후 결정적 비교를 수행한다.
- analyze 출력에서 파일 경로 추출 (정규식으로 "Affected Files" 섹션 파싱)
- `git diff --name-only`로 실제 변경 파일 목록 추출
- 집합 연산: 계획O 실제O (일치), 계획X 실제O (미계획 추가), 계획O 실제X (누락)
- scope creep 점수 = 미계획 파일 수 / 전체 변경 파일 수
- 점수 > 0.3이면 경고

**통합**:
- `executeStageStep()`에서 `stage === "implement"` 완료 후, `stageResults.analyze` 존재 시 실행
- `artifacts/{taskId}/drift-report.md`에 저장
- scope creep 경고 시 `{{DRIFT_WARNING}}` 변수로 self-review에 주입

**config**:
```js
driftDetector: { enabled: true, scopeCreepThreshold: 0.3, warnOnMissingPlanned: true }
```

#### `gate-parser-v2` — 강화된 게이트 결과 파서

**문제**: 현재 `parseGateResult`가 마지막 20줄에서 `GATE: PASS/FAIL` regex만 검색. 변형, 위치, 모순에 취약.

**메커니즘**: 다전략 게이트 파서.
- 검색 범위 확대: 마지막 50줄 + 전체 출력 검색
- 유연한 regex: `GATE:\s*(PASS|FAIL)`, `Gate Result:\s*(PASS|FAIL)`, 공백 없는 변형 등
- 모순 감지: GATE: PASS 주변 5줄에 "however", "but", "critical issue", "missing", "not implemented" 등 존재 시 신뢰도 "low"
- 복수 게이트 감지: PASS와 FAIL 모두 출현 시 마지막 것 채택
- 폴백: 명시적 게이트 없으면 `[x]`/`[ ]` 체크리스트 비율로 추정

반환값: `{ gate: "pass"|"fail"|"unknown", confidence: "high"|"low", contradictions: [...] }`

**통합**:
- 기존 `parseGateResult()` 직접 대체
- 반환 객체에서 `.gate`로 하위 호환 유지
- confidence가 "low"이면 로그 경고

**config**:
```js
gateParser: { version: 2, searchLines: 50, detectContradictions: true }
```

### 카테고리 4: 학습/적응

태스크 간 개선을 위한 2개 하네스.

#### `lesson-inject` — 태스크 간 교훈 주입

**문제**: `extractLessons`가 교훈을 추출·저장하지만 다시 읽지 않는다. 같은 프로젝트의 새 태스크가 같은 실수를 반복.

**메커니즘**: 파이프라인 시작 시 관련 교훈을 로드하여 주입한다.
- `~/.ucm/lessons/{projectName}/`와 `~/.ucm/lessons/global/`에서 lesson 파일 로드
- YAML frontmatter의 tags와 태스크 제목/설명 간 키워드 겹침으로 관련도 산정
- 최근 교훈에 가중치 부여 (지수 감쇠, 기본 30일)
- 상위 N개(기본 3) 선택, ~1500 토큰 이내로 조립

```markdown
## Lessons from Previous Tasks

### express-rate-limit skip 옵션 (2026-02-08)
**Problem**: skip 옵션에 async 함수를 넘기면 무시됨
**Solution**: keyGenerator에서 whitelist IP 체크하여 빈 키 반환
```

**통합**:
- `runPipeline()`에서 context-prefetch와 함께 1회 실행
- `{{LESSONS}}` 템플릿 변수로 analyze, implement에 주입
- AI 호출 없음 (결정적 로딩/스코어링)

**config**:
```js
lessonInject: { enabled: true, maxLessons: 3, maxTokens: 1500, includeGlobal: true, recencyDecayDays: 30 }
```

#### `improvement-proposal` — 작업 중 개선안 구조화 추출

**문제**: 에이전트가 태스크 수행 중 태스크 범위 밖의 개선 기회(리팩토링, 잠재 버그, 성능 문제, 기술 부채 등)를 발견해도 이를 전달할 경로가 없다. 발견한 개선 사항이 무시되거나 태스크 범위를 벗어난 scope creep으로 이어진다.

**메커니즘**: implement/self-review 프롬프트에 개선안 섹션을 요청하고, 출력에서 결정적 파싱한다.
- 프롬프트에 지시 추가: "태스크 범위 밖이지만 발견한 개선 사항이 있으면 `## Improvement Proposals` 섹션에 기록하라. 현재 태스크에는 반영하지 마라."
- AI 출력에서 `## Improvement Proposals` 섹션을 정규식으로 추출
- 각 항목을 구조화: `{ file, category, description, severity }`
  - category: `refactoring` | `bug-risk` | `performance` | `tech-debt` | `security` | `testing`
  - severity: `low` | `medium` | `high`
- 대시보드 proposals 목록에 표시, 사람이 승인하면 새 태스크로 변환
- 동일 파일 + 유사 description의 중복 제안 제거 (word trigram Jaccard > 0.7)

**통합**:
- `executeStageStep()`에서 implement, self-review 완료 후 `extractProposals()` 호출
- 추출된 제안은 태스크 산출물과 분리 저장 (scope creep 방지)
- `artifacts/{taskId}/proposals.json`에 저장
- `memory.json`의 태스크 메타데이터에 proposal 수 기록
- 대시보드 `/api/tasks/:id/proposals` 엔드포인트로 조회

**config**:
```js
improvementProposal: { enabled: true, stages: ["implement", "self-review"], deduplicateThreshold: 0.7 }
```

### 새 템플릿 변수 요약

| 변수 | 하네스 | 주입 대상 템플릿 |
|------|--------|-----------------|
| `{{RELEVANT_CONTEXT}}` | context-prefetch | analyze, implement |
| `{{CONVENTIONS}}` | convention-inject | implement, self-review |
| `{{ITERATION_HISTORY}}` | iteration-history | implement |
| `{{DRIFT_WARNING}}` | drift-detector | self-review |
| `{{LESSONS}}` | lesson-inject | analyze, implement |
| `{{DETERMINISTIC_FEEDBACK}}` | deterministic-gate | implement (재iteration 시) |

### 하네스 config 구조

```js
harnesses: {
  taskRefinement:    { enabled: true, maxRounds: 5, skipGatherIfRefined: true, autoTimeoutMs: 60000 },
  contextPrefetch:   { enabled: true, maxTokens: 4000, maxFiles: 20, recentDays: 30 },
  contextBudget:     { enabled: true, totalTokenBudget: 30000, truncationStrategy: "head-tail" },
  conventionInject:  { enabled: true, cacheTtlMs: 86400000, maxSampleFiles: 10 },
  iterationHistory:  { enabled: true, maxHistoryEntries: 5 },
  rsaDedup:          { enabled: true, similarityThreshold: 0.8, minDiversityWarning: 0.3 },
  adaptiveLoop:      { enabled: true, stagnationThreshold: 2, maxExtension: 2 },
  deterministicGate: { enabled: true, syntaxCheck: true, lintCheck: true, overrideAiGate: true },
  driftDetector:     { enabled: true, scopeCreepThreshold: 0.3, warnOnMissingPlanned: true },
  gateParser:        { version: 2, searchLines: 50, detectContradictions: true },
  lessonInject:      { enabled: true, maxLessons: 3, maxTokens: 1500, includeGlobal: true, recencyDecayDays: 30 },
  improvementProposal: { enabled: true, stages: ["implement", "self-review"], deduplicateThreshold: 0.7 },
}
```

### 구현 우선순위

| 순서 | 하네스 | 규모 | 영향도 | 비고 |
|------|--------|------|--------|------|
| 1 | gate-parser-v2 | 소 | 높음 | 기반 신뢰성 문제 해결 |
| 2 | deterministic-gate | 중 | 높음 | 핵심 환각 방지 |
| 3 | iteration-history | 중 | 높음 | loop 효율 직접 개선 |
| 4 | context-prefetch | 중 | 높음 | 매 태스크 토큰 절감 |
| 5 | context-budget | 중 | 중 | 컨텍스트 오버플로 방지 |
| 6 | lesson-inject | 중 | 중 | 학습 루프 완성 |
| 7 | convention-inject | 중 | 중 | 스타일 피드백 감소 |
| 8 | drift-detector | 소 | 중 | scope creep 감지 |
| 9 | adaptive-loop | 중 | 중 | iteration-history 의존 |
| 10 | rsa-dedup | 중 | 낮음 | RSA 토큰 최적화 |
| 11 | task-refinement | 중 | 높음 | qna.js 재사용, 입력 품질 개선 |
| 12 | improvement-proposal | 소 | 중 | 개선안 축적 → 태스크 변환 |

### 핵심 설계 원칙

- **결정적 우선**: 12개 중 8개가 AI 호출 없이 결정적 코드로 동작. 환각에 영향받지 않음
- **기존 패턴 활용**: `buildStagePrompt()`의 변수 치환, `executeStageStep()`의 후처리, `stageResults` 딕셔너리 패턴을 그대로 활용
- **개별 토글**: 모든 하네스가 `enabled: true/false`로 독립 제어
- **점진적 도입**: 하위 호환 유지하며 하나씩 활성화 가능
- **artifacts 활용**: 모든 하네스 결과를 기존 `artifacts/{taskId}/`에 저장하여 디버깅 가능

### 검증 방법

- 각 하네스의 순수 함수에 대해 유닛 테스트 추가 (test/ucm.test.js)
- context-prefetch: 실제 git repo에서 키워드 검색 → 관련 파일 반환 확인
- deterministic-gate: 의도적으로 구문 오류 있는 코드 → 감지 확인
- iteration-history: 3회 loop 시뮬레이션 → 구조화된 히스토리 생성 확인
- gate-parser-v2: 다양한 AI 출력 패턴 → 올바른 gate 추출 확인
- drift-detector: 계획과 다른 파일 변경 → scope creep 감지 확인
- improvement-proposal: AI 출력에 `## Improvement Proposals` 섹션 포함 → 구조화 추출 확인
- task-refinement: 주제 입력 → Q&A 라운드 → 구조화된 요구사항 생성 확인, auto-pilot 모드에서 코드베이스 기반 자동 응답 확인
- 통합 테스트: 전체 파이프라인에서 하네스 활성화/비활성화 비교

---

## 차후 계획

본문에 `[차후]` 태그로 표시된 항목들의 요약. 설계 문서에는 방향성을 남겨두되, Phase 1 구현 범위에서는 제외한다.

| 항목 | 현재 상태 | Phase 1 대체 | 추가 시점 |
|------|----------|-------------|----------|
| **크로스-레포 태스크** | 설계 완료 | 단일 프로젝트만 지원. `project` → `projects` 확장 가능하게 인터페이스 설계 | Phase 2 이후 |
| **Deliberation 스텝** | 설계 완료 | 연속 실패 시 task failed → 사람에게 에스컬레이션 | 효과 입증 후 |
| **멀티 프로바이더 RSA** | 설계 완료 | `defaultProvider` 하나만 사용 | 단일 프로바이더로 RSA 가치 증명 후 |
| **마이그레이션 시스템** | 설계 완료 | 스키마 변경 시 `~/.factory` 리셋 | 스키마 안정 후 |
| **Electron 앱** | Phase 4 | 웹 대시보드 + Web Notification API | 필요성 재평가 |
| **ccusage 내재화** | — | ccusage CLI 의존 | 안정화 후 JSONL 직접 파싱으로 교체 |
| **교훈 검색 + 주입** | 설계 완료 (lesson-inject 하네스) | 저장된 교훈을 수동으로 참고 | 교훈 데이터 축적 후 |
| **FSD (Full Self-Driving)** | 설계 완료 | 프로젝트별 fsd 플래그 없음, 모든 태스크 사람 리뷰 | Auto-approve + Discovery 안정화 후 |
| **Auto-approve 정책** | 설계 완료 (FSD 하위) | 모든 태스크 사람 리뷰 | loop/self-review 안정화 후 |
| **Discovery (자율 태스크 발굴)** | 설계 완료 (FSD 하위) | 사람이 직접 태스크 제출 | RSA 파이프라인 안정화 후 |
| **태스크 자동 분할 (Auto-split)** | 설계 완료 | complex 태스크는 loop 횟수 증가로 대응 | 의존성 체인 구현 후 |
| **태스크 의존성 체인** | 설계 완료 | 태스크 간 독립 실행 | Phase 2 이후 |
| **비용 추적 (Cost Tracking)** | 설계 완료 | memory.json의 기본 metrics만 기록 | Phase 2 이후 |
| **프로젝트별 FSD 토글 UI** | 미설계 | CLI 또는 config.json 직접 편집 | FSD 구현 시 |
| **Proposals 탭** | Discovery 섹션에 설계 | 사람이 직접 태스크 제출 | Discovery 구현 시 |
| **FSD/auto-approved 뱃지** | 미설계 | done 목록에서 구분 없음 | FSD 구현 시 |
| **원격 접속 (headless 서버)** | 미설계 | 로컬 브라우저에서 대시보드 접근 | Mac mini 등 상시 서버 운용 시 |
| **네이티브 앱 visual-check** | 미설계 | DevTools 기반 웹 프론트엔드만 지원. 네이티브 앱은 visual-check 스킵 | 스크린샷 비교 등 대안 검토 후 |
| **AWS 인프라 접근** | 미설계 | 코드 변경만 수행, 인프라 접근 없음 | FSD 안정화 후. IAM 최소 권한 + Budget alert으로 예산 제한. 참고: [OpenClaw](https://github.com/openclaw/openclaw) — 범용 자율 에이전트, 로컬 Gateway + 메신저 인터페이스 + 100+ AgentSkills, 시스템 접근 권한 부여 방식의 선례 |
