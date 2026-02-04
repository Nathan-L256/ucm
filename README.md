# ucm — Ultimate Click Machine

소프트웨어 팩토리 빌딩 블록

## 도구 목록

| 명령어 | 설명 |
|--------|------|
| mem    | hivemind 메모리 관리 (save/search/boost/context/delete/gc) |
| memd   | hivemind 데몬 (세션 자동 감시 + 기억 축적) |
| rsa    | Recursive Self Aggregation 파이프라인 |
| qna    | 템플릿 기반 설계 Q&A |
| spec   | EARS 요구사항 스펙 생성 |
| prl    | 병렬 프롬프트 실행 |
| req    | qna → spec 통합 워크플로 |

## 설치

```bash
npm link
npm run install-skill    # Claude Code /recall 스킬
```

## LLM 프로바이더

`LLM_PROVIDER` 환경변수로 프로바이더를 지정합니다 (기본: claude).

```bash
export LLM_PROVIDER=claude   # 또는 codex
```

---

## prl — 병렬 실행 빌딩블록

```bash
prl --project <dir> --prompt <file> [--count N] [--model <model>] [--output <dir>]
```

- 프롬프트 파일을 읽어 N개 Claude 인스턴스를 동시 실행
- 결과를 `output/1.md, 2.md, ...`에 저장
- `--output` 미지정 시 `/tmp/prl-<timestamp>/`에 저장
- 완료 시 stdout으로 output 경로 출력
- 2초 간격 폴링으로 개별 완료/실패 감지
- 30분 타임아웃, 초과 시 남은 프로세스 kill
- `--model` 미지정 시 CLI 기본 모델 사용
- 실패 시 1회 자동 재시도
- 쿼타 초과(rate limit) 감지 시 재시도 없이 중단, 새 쿼타 할당 후 재실행 안내

---

## rsa — RSA 워크플로

```bash
rsa --project <dir> --prompt <file> [--count N] [--rounds 1|2]
echo "프롬프트" | rsa --project <dir> [--count N]
```

### 1라운드 (기본)

1. **classify** — Sonnet으로 복잡도(light/heavy)와 취합 전략(converge/diverge) 판단
2. **parallel** — light면 Sonnet, heavy면 Opus로 N개 병렬 실행
3. **aggregate** — Opus로 취합

### 2라운드 (`--rounds 2`)

1라운드 결과를 초안으로 사용하여 추가 개선:

4. **refine** — 초안을 기반으로 N개 개선안 병렬 생성 (Opus)
5. **aggregate** — 개선안을 취합하여 최종 결과 생성

1라운드는 "무에서 다양하게 생성", 2라운드는 "있는 것을 다각도로 개선".

출력 구조 (`--rounds 2`):
```
/tmp/rsa-<timestamp>/
├── round1/              ← N개 병렬 결과
├── round1-agg/          ← 1라운드 취합 (초안)
│   └── 1.md
├── round2/              ← N개 개선 결과
├── round2-agg/          ← 최종 결과
│   └── 1.md
└── *-prompt.md          ← 각 단계 프롬프트
```

### 취합 전략

classify 단계에서 작업 성격에 따라 자동 선택된다.

| 전략 | 방식 | 적합한 작업 |
|------|------|------------|
| converge | 공통점 선별, 이상치 제거 | 분석, 문서화, 팩트 기반 |
| diverge | 대립점에서 상위 관점 도출 | 설계, 전략, 창의적 작업 |

---

## qna — 설계 결정 수집

```bash
qna [--template <file>] [--project <dir>] [--feedback <text>] [--output <dir>]
qna --resume <file> [--project <dir>] [--feedback <text>] [--output <dir>]
```

- 템플릿을 기반으로 Claude가 객관식 질문을 생성, 사용자가 선택하여 설계 결정 수집
- `--template`, `--resume` 모두 없으면 일반 소프트웨어 설계 질문으로 시작
- `--project` 지정 시 브라운필드: Claude가 프로젝트 코드를 스캔하여 질문에 반영
- `--project` 미지정 시 그린필드: 일반 소프트웨어 설계 질문
- 최대 20라운드, 커버리지 충분 시 자동 종료
- 사용자 입력: 번호 선택, 직접 입력, `/done`으로 조기 종료
- Ctrl+C 또는 rate limit 시 진행 상황 저장 + `--resume` 경로 안내
- 완료 시 `decisions.md` 경로를 stdout으로 출력

출력 구조:
```
/tmp/qna-<timestamp>/
├── decisions.md         ← 수집된 설계 결정
└── conversation.jsonl   ← 대화 로그
```

---

## spec — EARS 요구사항 명세 생성 + 검증

```bash
spec --decisions <file> [--template <file>] [--project <dir>] [--output <dir>]
```

- decisions.md를 입력받아 EARS(Easy Approach to Requirements Syntax) 형식의 requirements.md 생성
- 생성된 요구사항을 7개 기준으로 자동 검증
- 검증 미통과 시 gap-report.md 생성 (부족한 항목 목록)
- `--template` 지정 시 해당 형식으로 요구사항 생성, 미지정 시 기본 EARS 형식
- `--project` 지정 시 브라운필드: Claude가 프로젝트 코드를 참조하여 요구사항 생성
- 완료 시 stdout으로 requirements.md 경로 출력 (pass/fail 무관)
- gap-report.md 존재 여부로 충분성 판단

검증 기준:

| # | 기준 | 검증 질문 |
|---|------|----------|
| 1 | 볼륨 충분성 | 각 기능의 동작이 구현 가능할 만큼 구체적인가 |
| 2 | 엣지 케이스 | 실패, 경계 조건, 예외 상황이 명시되어 있는가 |
| 3 | 인터페이스 명세 | 입출력, 시그니처, 데이터 구조가 구체적인가 |
| 4 | 범위 경계 | "하지 않는 것"이 명시되어 있는가 |
| 5 | 내적 일관성 | 기능 간 모순, 용어 불일치가 없는가 |
| 6 | 비기능 요구사항 | 성능, 보안, 호환성, 에러 처리 정책이 있는가 |
| 7 | 테스트 가능성 | 각 기능의 성공/실패 기준이 명확한가 |

출력 구조:
```
/tmp/spec-<timestamp>/
├── requirements.md    ← EARS 형식 요구사항 명세
└── gap-report.md      ← 검증 실패 시에만 생성
```

---

## req — qna + spec 반복 워크플로

```bash
req [--template <file>] [--spec-template <file>] [--project <dir>] [--output <dir>] [--max-rounds <n>]
```

- qna(설계 결정 수집)와 spec(요구사항 생성 + 검증)를 반복 실행
- spec 검증 통과(gap-report.md 없음) 시 종료, 미통과 시 gap 내용을 feedback으로 qna 재실행
- `--max-rounds` 미지정 시 최대 3회 반복
- qna는 stdin을 inherit하여 사용자가 직접 대화
- 완료 시 stdout으로 requirements.md 경로 출력

흐름:
```
┌─→ qna (대화형 Q&A) → decisions.md
│       ↓
│   spec (생성 + 검증) → requirements.md + gap-report.md?
│       ↓
│   gap-report.md 있으면?
│     yes → gap 내용을 feedback으로 ──┐
│     no  → 완료                      │
└─────────────────────────────────────┘
```

출력 구조:
```
/tmp/req-<timestamp>/
├── decisions.md       ← 최종 설계 결정
├── requirements.md    ← 최종 요구사항 명세
├── gap-report.md      ← 마지막 검증의 gap (pass 시 없음)
└── conversation.jsonl ← qna 대화 로그
```

---

## mem — 에이전트 기억 빌딩블록

```bash
cat transcript.md | mem save [--project <name>] [--provider <claude|codex>]
mem save --file <file> [options]
mem search <query> [--project <name>]
mem boost <id>
mem context [--project <name>] [--limit <N>]
mem reindex [--project <name>] [--rebuild]
mem gc [--threshold <0-1>] [--dry-run]
mem restore [<id>] [--all]
mem purge [--dry-run]
```

세션 트랜스크립트를 지식으로 변환하여 저장/검색하는 도구.

### 커맨드

| 커맨드 | 설명 |
|--------|------|
| save | 트랜스크립트를 LLM으로 분석하여 제목/태그/scope 추출 후 저장 (멀티토픽 분리 지원) |
| search | BM25 + 키워드 이중 랭킹 → RRF 결합으로 기억 검색 |
| boost | 특정 기억의 lastBoosted 갱신 + boostCount 증가 (쇠퇴 방지) |
| context | 상위 N개 기억으로 LLM 컨텍스트 브리핑 생성 |
| reindex | originals/ 파일 기반으로 인덱스 재구축 + 요약 생성 |
| gc | 쇠퇴 점수가 임계값 미만인 기억 삭제 |

### 검색 모델

```
query → tokenize (한국어+영어 혼합, Unicode 기반)
     → BM25 scoring (title×3 + tags×2 + summary×1)  → BM25 랭킹
     → keyword includes matching (제목/태그 부분문자열) → keyword 랭킹
     → RRF(BM25 랭킹, keyword 랭킹)  — k=60
     → RRF 점수 × Ebbinghaus decay 점수
     → Top-K 반환 (기본 10개)
```

- **BM25**: TF-IDF 개선 버전. 희귀 토큰 우대, 필드 길이 보정 (k1=1.2, b=0.75)
- **RRF (Reciprocal Rank Fusion)**: 서로 다른 스케일의 랭킹을 합산. 양쪽에서 상위면 점수 증폭
- threshold 없이 항상 Top-K 반환

### 쇠퇴/강화 모델

에빙하우스 망각곡선 기반 지수 감쇠:

```
score = exp(-(now - lastBoosted) / (decayDays × (1 + ln(1 + boostCount)) × 86400000))
```

- `decayDays`: 기본 30일 (config.json으로 조정)
- `boostCount`가 높을수록 감쇠 속도가 느려짐 (핵심 지식 보호)
- gc 임계값 기본 0.05 — 약 90일 미참조 시 삭제 대상

### 저장 구조

```
~/.mem/
├── global/
│   ├── index.jsonl        # 검색 진입점 (제목, 태그, 점수)
│   ├── summaries/         # LLM 추출 요약 (1-3KB)
│   └── originals/         # 원본 트랜스크립트
├── projects/
│   └── <project-name>/
│       ├── index.jsonl
│       ├── summaries/
│       └── originals/
└── config.json            # decayDays, gcThreshold
```

---

## memd — 세션 감시 데몬

```bash
memd start [--foreground]     # 데몬 시작
memd stop                     # 데몬 종료
memd status                   # 상태 확인
memd search <query> [--project <name>]  # 검색 (데몬 경유)
memd boost <id>               # 강화 (데몬 경유)
memd log [--lines <N>]        # 로그 tail (기본 50)
```

mem 위에 구축된 데몬. Claude Code 세션을 자동 감시하여 지식을 축적한다.

### 동작 원리

```
Claude Code 세션 종료
  ↓
memd 스캔 (60초 주기)
  → .jsonl 파일 직접 스캔으로 완료 세션 감지 (5분 이상 미변경)
  ↓
트랜스크립트 추출
  → JSONL 파싱, user/assistant 텍스트 + tool 이름만 추출
  → 2KB 미만 세션 건너뜀
  ↓
LLM 분석 (2회 호출)
  → 1차: 토픽/태그/scope 추출 + 기존 기억과 정합 (updates/updateReason)
  → 2차: 토픽별 재사용 가능한 지식 요약 (가치 없으면 SKIP)
  ↓
저장 (토픽별, update/new 분리)
  → update 토픽: 기존 entry를 in-place 수정
  → new 토픽: originals/ + summaries/ + index.jsonl에 새 entry 생성
```

### 주기적 작업

| 작업 | 주기 | 설명 |
|------|------|------|
| 세션 스캔 | 60초 | .jsonl 파일 직접 스캔, 완료 세션 큐잉 |
| 처리 루프 | 연속 | 큐에서 하나씩 순차 처리 (LLM 호출) |
| Auto-boost | 5분 | 완료 세션의 검색 사용 여부 확인 |
| Git commit | 1시간 | `~/.mem/`에서 `git add -A && git commit` |
| GC | 24시간 | 쇠퇴 기억 정리 |

### /recall 스킬

Claude Code에서 `/recall <검색어>`로 과거 기억을 검색합니다.

```bash
npm run install-skill   # 스킬 설치
```

---

## 사용 예시

```bash
# RSA 1라운드 (기본)
rsa --project ~/git/my-project --prompt task.md

# RSA 2라운드 (초안 → 개선)
rsa --project ~/git/my-project --prompt task.md --rounds 2

# prl 단독 사용 (Opus 5개 병렬)
prl --project ~/git/my-project --prompt prompt.md --count 5 --model opus

# qna 그린필드 (템플릿 기반)
qna --template design-template.md

# qna 브라운필드 (프로젝트 코드 참조)
qna --template design-template.md --project ~/git/my-project

# qna 이어서 진행
qna --resume /tmp/qna-.../decisions.md

# spec 요구사항 생성
spec --decisions /tmp/qna-.../decisions.md

# req (qna → spec 자동 반복)
req --project ~/git/my-project

# 메모리 데몬 시작
memd start

# 기억 검색
mem search "webhook" --all
```
