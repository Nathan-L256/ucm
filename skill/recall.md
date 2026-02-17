---
description: "이전 작업 기억 조회 — /recall webhook, /recall vue 깜빡임"
argument-hint: <검색어>
allowed-tools: Bash, Read
---

## 검색 결과

!`if [ -z "$ARGUMENTS" ]; then hm list --limit 10; else hm search --limit 10 $ARGUMENTS; fi`

## 지침

1. 위 검색 결과에서 관련도 높은 Zettel 경로(.md)를 Read로 읽어라 (상위 5개까지)
2. 현재 작업과 직접 관련된 내용만 간결히 요약해라
3. 결과가 없으면 "관련 기억이 없습니다"로 짧게 안내해라
