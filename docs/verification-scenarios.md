# UCM 실전 검증 시나리오

## 사전 준비

```bash
# UI 서버 시작 (데몬은 UI가 자동 관리)
ucm ui

# 대시보드
open http://localhost:7777
```

- `ucm ui`가 데몬 시작/중지/상태 확인을 자동 처리 (UI에서 Start/Stop 버튼)
- 데몬은 `--no-http` 모드로 소켓만 운영, UI 서버가 프록시
- 개발 중 UI 변경을 즉시 반영하려면: `ucm ui --dev`
- 테스트용 프로젝트: 기존 git 레포 아무거나 (예: `~/git/sample-app`)

---

## Level 1 — 기본 동작 확인

### S1. quick 파이프라인 (analyze → implement)

**목적**: 가장 단순한 파이프라인의 전체 흐름 확인

**실행**:
- UI에서 태스크 제출: title="README에 설치 가이드 추가", project=테스트 레포
- pipeline: quick (기본값)

**확인 포인트**:
- [ ] pending → running 전환 (UI 실시간 반영)
- [ ] analyze 스테이지 실행, artifacts에 analyze.md 생성
- [ ] implement 스테이지 실행, worktree에 실제 코드 변경
- [ ] running → review 전환
- [ ] Diff 탭에서 변경 내용 확인 가능
- [ ] Logs 탭에서 실시간 로그 확인 가능
- [ ] Summary 탭에 summary.md 표시
- [ ] Approve → worktree 머지 → done 상태
- [ ] 프로젝트 레포에 변경 실제 반영 확인

### S2. 태스크 거부 (Reject without feedback)

**실행**:
- S1과 동일하게 태스크 제출, review까지 대기
- Reject 클릭 (피드백 없이)

**확인 포인트**:
- [ ] review → failed 전환
- [ ] worktree 정리됨
- [ ] Retry 버튼으로 failed → pending 복구 가능
- [ ] Delete 버튼으로 태스크 완전 삭제 가능

### S3. 태스크 취소 (Cancel while running)

**실행**:
- 태스크 제출, running 상태에서 Cancel 클릭

**확인 포인트**:
- [ ] 에이전트 프로세스 SIGTERM으로 종료
- [ ] running → failed 전환
- [ ] worktree 정리됨

---

## Level 2 — 반복 파이프라인

### S4. implement 파이프라인 (loop with gate)

**목적**: loop + gate(test, self-review) 동작 검증

**실행**:
- title="간단한 유틸 함수와 테스트 작성", project=테스트 레포
- pipeline: implement

**확인 포인트**:
- [ ] analyze 실행 후 loop 진입
- [ ] implement → test → self-review 순서로 실행
- [ ] self-review에서 GATE: PASS → loop 탈출, review 상태로
- [ ] self-review에서 GATE: FAIL → 피드백 추출, 다음 iteration으로
- [ ] artifacts에 implement-1.md, test-1.md, self-review-1.md 등 iteration별 파일
- [ ] maxIterations(3) 도달 시 강제 loop 탈출

### S5. Request Changes (reject with feedback)

**목적**: 피드백 기반 재실행 — analyze 건너뛰고 implement부터 재개

**실행**:
- S4 완료 후 review 상태에서 Request Changes 클릭
- 피드백: "에러 핸들링 추가 필요"

**확인 포인트**:
- [ ] review → running 전환 (failed 아님)
- [ ] analyze 스킵, implement부터 재실행 (findResumeStepIndex 동작)
- [ ] 피드백이 프롬프트에 포함되어 에이전트가 반영
- [ ] 다시 review 도달 → Approve로 완료

---

## Level 3 — 고급 파이프라인

### S6. RSA (다중 에이전트 수렴)

**실행**:
- pipeline: research 또는 thorough (RSA 포함)
- title="이 프로젝트의 성능 병목 분석"

**확인 포인트**:
- [ ] RSA 스텝에서 3개 에이전트 병렬 스폰
- [ ] 각 에이전트 아티팩트: `{stage}-rsa-agent-0.md`, `-1.md`, `-2.md`
- [ ] 집계 에이전트 실행: `{stage}-rsa-aggregate.md`
- [ ] 최종 결과가 stageResults에 반영

### S7. thorough 파이프라인 (loop 안에 RSA)

**실행**:
- pipeline: thorough
- title="새 API 엔드포인트 추가", project=테스트 레포

**확인 포인트**:
- [ ] analyze → loop[implement → test → RSA(self-review)] 순서
- [ ] loop 내에서 RSA가 정상 동작
- [ ] 중첩 구조에서 아티팩트 파일명 올바름

---

## Level 4 — Gather + Refinement

### S8. Gather interactive (프로젝트 경로 질문)

**실행**:
- project 없이 태스크 제출
- pipeline에 gather 스텝 포함 (커스텀 파이프라인 설정 필요)

**확인 포인트**:
- [ ] `project:ask` WebSocket 이벤트 발생
- [ ] UI에서 프로젝트 경로 입력 패널 표시
- [ ] 경로 입력 후 정상 진행
- [ ] 타임아웃 시 임시 workspace 생성

### S9. Refinement 세션 (interactive)

**실행**:
- UI Refine 버튼으로 refinement 시작
- mode: interactive, project 지정

**확인 포인트**:
- [ ] 코드베이스 스캔 실행 (scanRepoContext)
- [ ] 질문 생성 → UI에 표시
- [ ] 답변 제출 → 다음 질문 생성
- [ ] coverage 100% 도달 시 complete
- [ ] Finalize → 태스크 생성 (refined: true 메타)

### S10. Refinement autopilot

**실행**:
- refinement 시작 후 autopilot 모드 전환

**확인 포인트**:
- [ ] 자동으로 Q&A 반복
- [ ] progress 이벤트로 UI 갱신
- [ ] 최대 15라운드 또는 coverage 충족 시 종료

---

## Level 5 — 인프라 + 에러

### S11. 데몬 재시작 복구

**실행**:
- 태스크 running 중 데몬 강제 종료 (Ctrl+C)
- 데몬 재시작

**확인 포인트**:
- [ ] recoverRunningTasks 실행
- [ ] running 태스크가 pending으로 복구
- [ ] worktree 정리 후 재생성
- [ ] 재처리 정상 진행

### S12. 동시 태스크 (concurrency > 1)

**실행**:
- config에 `concurrency: 2` 설정
- 2개 태스크 연속 제출

**확인 포인트**:
- [ ] 2개 동시 running
- [ ] 각각 독립적으로 파이프라인 진행
- [ ] UI에 2개 모두 실시간 반영

### S13. 리소스 압력

**실행**:
- config에 `resources.memoryMinFreeMb: 999999` (일부러 높게) 설정

**확인 포인트**:
- [ ] getResourcePressure가 "high" 반환
- [ ] 새 태스크 시작 지연/스킵
- [ ] 정상값으로 복원 후 재개

### S14. Self-target 태스크

**실행**:
- project를 UCM 자체 레포로 지정
- title="테스트 케이스 추가"

**확인 포인트**:
- [ ] isSelfTargetProject 감지
- [ ] approve 시 smoke test 실행 (syntax + test)
- [ ] `ucm/pre-{taskId}` 롤백 태그 생성
- [ ] 데몬 자동 재시작 (watchdog respawn)

---

## Level 6 — UI 검증

### S15. WebSocket 실시간성

**확인 포인트**:
- [ ] 태스크 상태 변경 즉시 UI 반영 (polling 없이)
- [ ] 로그 탭 실시간 스트리밍
- [ ] 다른 브라우저 탭에서도 동기화
- [ ] 빠른 태스크 전환 시 이전 데이터 안 보임 (AbortController)

### S16. 모달 + 입력

**확인 포인트**:
- [ ] Submit 모달: Enter 제출, ESC 닫기, auto-focus
- [ ] Pipeline 드롭다운에 모든 파이프라인 표시
- [ ] Request Changes 모달: 빈 피드백 방지 (null 체크)
- [ ] Project-ask 패널 정상 동작

---

## Level 7 — 채팅

### S17. 기본 채팅 대화

**목적**: Chat 패널에서 에이전트와 자유 대화

**실행**:
- 패널 토글에서 Chat 클릭 (Tasks | Proposals | **Chat**)
- 메시지 입력: "현재 프로젝트 구조를 설명해줘"

**확인 포인트**:
- [ ] chat:status → "thinking" 표시
- [ ] 응답 스트리밍 (chat:token 이벤트로 실시간 표시)
- [ ] 완료 후 chat:status → "ready"
- [ ] 대화 이력이 chat-messages 영역에 user/assistant 말풍선으로 표시
- [ ] 연속 대화 시 이전 컨텍스트 유지

### S18. 채팅 컨텍스트 관리

**목적**: 토큰 사용량 추적 + 압축/초기화

**실행**:
- 여러 번 대화 후 컨텍스트 바 확인
- Compress 버튼 클릭
- Clear 버튼 클릭
- New 버튼 클릭

**확인 포인트**:
- [ ] 컨텍스트 바에 토큰 사용량 % 표시 (green/yellow/red)
- [ ] Compress → 이전 대화 요약, 토큰 사용량 감소
- [ ] Clear → 대화 이력 전체 삭제
- [ ] New → 새 세션 시작 (메모리 유지, 이력 초기화)
- [ ] `/api/chat/state` API로 history, memory, meta, tokens 확인 가능

### S19. 채팅 명령어 실행

**목적**: 에이전트가 tool_use로 실제 명령 수행

**실행**:
- 채팅에서 "test/ucm.test.js 파일의 테스트 수를 알려줘" 입력

**확인 포인트**:
- [ ] 에이전트가 파일 읽기 도구 사용
- [ ] 명령 실행 결과가 대화에 반영
- [ ] 실행된 명령이 로그에 기록

---

## 검증 우선순위

| 우선순위 | 시나리오 | 이유 |
|---------|---------|------|
| 1 | S1 (quick) | 기본 happy path — 이게 안 되면 나머지 의미 없음 |
| 2 | S4 (implement loop) | 핵심 파이프라인, gate 동작 검증 |
| 3 | S2, S3 (reject/cancel) | 기본 태스크 관리 |
| 4 | S5 (feedback resume) | 실전에서 빈번한 시나리오 |
| 5 | S11 (restart recovery) | 안정성 필수 |
| 6 | S6 (RSA) | 고급 기능 |
| 7 | S17 (채팅) | 핵심 인터랙션 기능 |
| 8 | S9, S10 (refinement) | UX 차별점 |
| 9 | 나머지 | 엣지 케이스 |
