# UCM Vision

## 목적

UCM(Ultimate Click Machine)은 24시간 자율 소프트웨어 개선 시스템이다.

소프트웨어 프로젝트를 지속적으로 분석하고, 개선 제안을 생성하며, 검증된 변경사항을 자동으로 적용한다. 사람의 개입을 최소화하면서도 코드 품질과 안정성을 유지하는 것이 핵심 목표다.

## 자율 개선 루프

```
Observer → Proposal → Regulator → Forge → Evaluation → Learning → 반복
```

### Observer (분석)
프로젝트 코드, 테스트 결과, 커밋 이력, 문서 커버리지를 분석하여 개선 기회를 식별한다. 메트릭스 스냅샷을 비교하여 트렌드를 추적한다.

### Proposal (제안)
Observer의 분석 결과를 기반으로 구체적이고 실행 가능한 개선 제안을 생성한다. 각 제안은 문제 설명, 변경 내용, 예상 영향을 포함한다. 기존 제안과 중복되지 않도록 dedup hash로 검증한다.

### Regulator (검증)
나쁜 제안을 자동 차단한다:
- 최근 실패한 제안과 유사한 패턴 차단
- high-risk + core 카테고리 조합 자동 차단
- cost/benefit 임계값 미달 차단

### Forge (실행)
승인된 제안을 실제 코드 변경으로 실행한다. 파이프라인 단계:
- **intake**: 태스크 복잡도 분석, 파이프라인 결정
- **clarify/specify**: 요구사항 구체화
- **decompose**: 대규모 태스크를 서브태스크로 분할
- **design**: 설계 문서 생성
- **implement**: 코드 변경 실행
- **verify**: 테스트 및 검증 (implement-verify 루프)
- **ux-review**: UX 검토
- **polish**: 코드 품질 개선
- **deliver**: 결과물 정리, 머지 또는 리뷰 대기

### Evaluation (평가)
완료된 태스크의 결과를 메트릭스 기반으로 평가한다. baseline 스냅샷과 현재 스냅샷을 비교하여 실제 개선 효과를 측정한다.

### Learning (학습)
실패와 성공 패턴을 lessons로 추출하여 이후 파이프라인에 주입한다. Hivemind(zettelkasten 지식 메모리)에 실행 경험을 축적하여 더 정확한 제안을 생성한다.

## Regulator 원칙

자율 시스템의 안전장치:
1. **보수적 승인**: 의심스러우면 차단한다
2. **데이터 기반 판단**: 과거 실패 이력을 참조한다
3. **프로젝트 컨텍스트**: 프로젝트별 특성을 고려한다
4. **점진적 확대**: 성공 실적이 쌓이면 자율성을 확대한다

## Dogfooding

UCM은 UCM 자체를 개선 대상으로 삼는다:
- UCM 코드에 대한 observer 분석 및 proposal 생성
- self-modification 안전장치: 전체 테스트 스위트 통과 필수, 백업 브랜치 자동 생성
- low-risk 변경만 자동 승인 허용

## 아키텍처

```
bin/ucm.js          CLI (forge, resume, list, status, approve, reject, dashboard)
lib/ucmd.js         Daemon (task queue, pipeline engine, observer, autopilot)
lib/forge/          Forge pipeline (intake, clarify, specify, design, implement, verify, deliver)
lib/hivemind/       Zettelkasten 지식 메모리
lib/ucmd-*.js       Daemon 모듈 (handlers, observer, autopilot, refinement, ...)
lib/ucm-ui.js       Dashboard UI
templates/          Stage 프롬프트 템플릿
```

### 두 개의 파이프라인 엔진

1. **Daemon pipeline** (`lib/ucmd.js`): Dashboard UI를 통한 태스크 관리, observer, autopilot
2. **Forge pipeline** (`lib/forge/`): CLI 직접 실행 및 daemon 위임 모두 지원

Daemon이 forge 메서드를 브릿지하여 Dashboard에서도 forge pipeline을 실행할 수 있다.

## 현재 상태

- Daemon pipeline: 37개 메서드 (task CRUD, observer, autopilot, refinement)
- Forge pipeline: intake → clarify → specify → decompose → design → implement → verify → ux-review → polish → deliver
- Observer: 주기적 분석 + 태스크 완료 트리거
- Autopilot: 자동 planning → execution → review → release 루프
- Hivemind: zettelkasten 지식 메모리, forge 실행 경험 축적
- 테스트: 931 tests

## 로드맵

1. **Regulator 강화**: 나쁜 proposal 자동 차단, 실패 패턴 학습
2. **Feedback Loop**: 평가 결과가 미래 proposal에 반영
3. **Adaptive Scheduling**: 활동량에 따라 observer 주기 조절
4. **Observer-Hivemind 통합**: 과거 경험 기반 제안 생성
5. **Self-improvement**: UCM이 자신을 안전하게 개선
