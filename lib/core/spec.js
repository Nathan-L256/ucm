const { llmText, llmJson } = require("./llm");

const DEFAULT_REQUIREMENTS_PROMPT = `아래 설계 결정을 바탕으로 요구사항 명세를 마크다운으로 작성하세요.
마크다운 본문만 출력하세요. 코드펜스(\`\`\`markdown)로 감싸지 마세요.

## 요구사항 명세 구조

### 1. 개요
- 프로젝트 목적, 대상 사용자, 규모

### 2. 기능 요구사항
EARS 표기법으로 작성:
  WHEN [조건/이벤트] THE SYSTEM SHALL [동작]

각 기능에 대해:
- 정상 동작 (happy path)
- 엣지 케이스 (경계값, 빈 입력, 대량 데이터 등)
- 에러 상황 (실패 시 동작)

### 3. 비기능 요구사항
- 성능, 보안, 호환성, 에러 처리 정책

### 4. 범위 경계
- 이 프로젝트가 하지 않는 것을 명시

### 5. 용어 정의
- 문서에서 사용하는 핵심 용어의 정의

## 규칙
- 설계 결정에 없는 기능을 임의로 추가하지 마세요.
- 결정되지 않은 사항은 [NEEDS CLARIFICATION: 설명] 으로 표시하세요.
- 도구를 사용하지 마세요. 마크다운 텍스트만 출력하세요.`;

const VALIDATION_PROMPT = `아래 요구사항 명세를 검증하세요.

## 검증 기준

1. 볼륨 충분성: 각 기능의 동작이 구현 가능할 만큼 구체적인가
2. 엣지 케이스: 실패, 경계 조건, 예외 상황이 명시되어 있는가
3. 인터페이스 명세: 입출력, 시그니처, 데이터 구조가 구체적인가
4. 범위 경계: "하지 않는 것"이 명시되어 있는가
5. 내적 일관성: 기능 간 모순, 용어 불일치가 없는가
6. 비기능 요구사항: 성능, 보안, 호환성, 에러 처리 정책이 있는가
7. 테스트 가능성: 각 기능의 성공/실패 기준이 명확하여 테스트 작성이 가능한가

## 응답 형식 (JSON만 출력)
{
  "pass": true/false,
  "gaps": [
    { "criterion": "기준 이름", "detail": "구체적으로 무엇이 부족한지" }
  ]
}

gaps가 없으면 pass: true.`;

function specLlmOpts({ cwd, provider }) {
  return {
    provider,
    model: provider === "claude" ? "sonnet" : undefined,
    cwd,
    allowTools: provider === "claude" ? (cwd ? "Read,Glob,Grep" : "") : undefined,
  };
}

async function generateRequirements(decisions, { template, cwd, provider }) {
  let prompt = template || DEFAULT_REQUIREMENTS_PROMPT;
  prompt += `\n\n## 설계 결정\n\n`;
  for (const d of decisions) {
    prompt += `- **[${d.area}] ${d.question}**\n  → ${d.answer}\n`;
    if (d.reason) prompt += `  (이유: ${d.reason})\n`;
  }
  const { text, tokenUsage } = await llmText(prompt, specLlmOpts({ cwd, provider }));
  return { text, tokenUsage };
}

async function validateRequirements(requirements, { cwd, provider }) {
  const prompt = VALIDATION_PROMPT + `\n\n## 요구사항 명세\n\n${requirements}`;
  const { data, tokenUsage } = await llmJson(prompt, specLlmOpts({ cwd, provider }));
  return { data, tokenUsage };
}

function formatGapReport(gaps) {
  let md = `# Gap Report\n\n검증 결과 아래 항목이 부족합니다.\n\n`;
  for (const gap of gaps) {
    md += `- **${gap.criterion}**: ${gap.detail}\n`;
  }
  return md;
}

module.exports = {
  DEFAULT_REQUIREMENTS_PROMPT,
  VALIDATION_PROMPT,
  generateRequirements,
  validateRequirements,
  formatGapReport,
};
