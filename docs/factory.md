# 팩토리 도구 설계

## RSA (Recursive Self Aggregation)

AI의 비결정성을 활용하는 3단계 파이프라인:
1. **Classify**: Sonnet으로 복잡도(light/heavy)와 취합 전략(converge/diverge) 판단
2. **Parallel**: 같은 프롬프트를 N개 인스턴스로 병렬 실행하여 다양성 확보
3. **Aggregate**: Opus로 취합하여 품질 수렴 (converge: 공통점 선별 / diverge: 대립점에서 상위 관점 도출)

## QnA 템플릿 설계

- 템플릿 기반 설계 Q&A 수집 도구
- qna-template.md에 질문 구조 정의
- LLM이 코드베이스를 분석하여 답변 생성
- 결과를 구조화된 마크다운으로 출력

## EARS 스펙 생성

- Easy Approach to Requirements Syntax 기반
- QnA 결과를 입력으로 받아 정형 요구사항 생성
- When/While/If/Where 조건 패턴으로 요구사항 구조화

## 파이프라인 연결 (req = qna → spec)

req는 qna와 spec을 하나의 워크플로로 연결:
1. qna로 설계 질문 수집
2. 수집된 답변을 spec에 전달
3. EARS 형식 요구사항 스펙 자동 생성

## 병렬 실행 (prl)

- 여러 프롬프트를 동시에 LLM에 전송
- 결과를 순서대로 수집하여 출력
- rsa 내부 scatter 단계에서도 활용
