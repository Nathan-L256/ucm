---
description: Search and retrieve memories from past sessions
argument-hint: [search query]
allowed-tools: Bash, Read
---

과거 세션에서 축적된 기억을 검색하여 현재 작업에 활용합니다.

## 검색 결과

!`if [ -z "$ARGUMENTS" ]; then mem context --all --limit 5; else mem search --all $ARGUMENTS; fi`

## 지침

1. 위 검색 결과에서 파일 경로(.md)를 Read tool로 읽어라 (상위 5개까지)
2. 읽은 기억 중 현재 작업과 관련된 P1 내용(결정/이유)을 우선 요약해라
3. P2(구현 세부)는 직접 코드를 수정할 때만 참고해라
4. 검색 결과가 없으면 사용자에게 알려라
