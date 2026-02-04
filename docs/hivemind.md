# hivemind 아키텍처

## 설계 원칙

- **외부 의존성 제로**: Node.js 내장 모듈만 사용, npm install 불필요
- **단일 파일 유지**: mem.js 하나에 메모리 엔진 전체를 담아 배포·이해 용이
- **CommonJS 선택**: shebang + require.main 가드로 CLI/라이브러리 겸용

## 메모리 모델

- 에빙하우스 망각 곡선 기반 쇠퇴: `effectiveScore = baseScore * e^(-λt)`
- boost 명령으로 강화 (lastBoosted 갱신, boostCount 증가)
- 정반합 업데이트: 동일 주제 기억 발견 시 LLM이 기존+신규를 합성

## 검색 엔진

- **BM25**: title(x3), tags(x2), summary(x1) 가중치
- **keyword includes**: 정확한 키워드 포함 매칭
- **knowledge graph**: entity-relation triplets 기반 그래프 검색
- **RRF 3-way 결합**: Reciprocal Rank Fusion으로 세 검색 결과 통합

## 지식 그래프

- LLM 기반 엔티티/관계 자동 추출
- 트리플릿 구조: subject, predicate, object + types
- graph.jsonl 저장, GC 연동으로 쇠퇴된 기억의 트리플릿도 정리

## 데몬 (memd)

- Unix 소켓 IPC로 클라이언트-데몬 통신
- 세션 파일 스캔 → 큐 → 처리 파이프라인
- 자동 git commit, GC, auto-boost 주기 실행

## 요약 프롬프트

- P1(결정/이유) / P2(구현 세부) / P3(참고) 우선순위 분류
- SKIP 판정: 의미 없는 세션 자동 건너뛰기
- 대형 트랜스크립트는 파트 분할 후 개별 요약 → 통합
