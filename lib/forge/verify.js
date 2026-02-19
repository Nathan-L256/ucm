const { spawnAgent } = require("../core/agent");
const { loadArtifact, saveArtifact } = require("../core/worktree");
const { STAGE_MODELS, STAGE_TIMEOUTS } = require("../core/constants");
const { llmJson, extractJson } = require("../core/llm");

async function run({ taskId, dag, project, subtask, timeouts, onLog = () => {} } = {}) {
  const model = STAGE_MODELS.verify;
  const effectiveTimeouts = timeouts || STAGE_TIMEOUTS.verify;
  const artifactSuffix = subtask ? `-${subtask.id}` : "";

  let specContent = "";
  try {
    specContent = await loadArtifact(taskId, "spec.md");
  } catch {
    try {
      specContent = await loadArtifact(taskId, "task.md");
    } catch {}
  }

  let designContent = "";
  try {
    designContent = await loadArtifact(taskId, `design${artifactSuffix}.md`);
  } catch {
    try {
      designContent = await loadArtifact(taskId, "design.md");
    } catch {}
  }

  // Step 1: Run tests
  onLog("[verify] running tests...");

  const testPrompt = `프로젝트의 테스트를 실행하세요.

1. package.json에 test 스크립트가 있으면 실행
2. 테스트 파일이 있으면 실행
3. 없으면 기본 동작 확인 (lint, type check 등)

결과를 JSON으로 보고하세요:
{
  "testsPassed": true/false,
  "summary": "테스트 결과 요약",
  "failures": ["실패 항목1", "실패 항목2"]
}

반드시 JSON만 출력하세요.`;

  const testResult = await spawnAgent(testPrompt, {
    cwd: project,
    model,
    idleTimeoutMs: effectiveTimeouts.idle,
    hardTimeoutMs: effectiveTimeouts.hard,
    taskId,
    stage: `verify-test${artifactSuffix}`,
    onLog,
  });

  let testsPassed = testResult.status === "done";
  let testFailures = [];

  if (testResult.status === "done") {
    try {
      const parsed = extractJson(testResult.stdout);
      testsPassed = parsed.testsPassed !== false;
      testFailures = parsed.failures || [];
    } catch {}
  }

  // Step 2: Self-review (spec compliance check)
  onLog("[verify] running self-review...");

  let reviewScope = "";
  if (subtask) {
    reviewScope = `\n\n## 검토 범위

이 서브태스크만 검토하세요:
- ID: ${subtask.id}
- 제목: ${subtask.title}
- 설명: ${subtask.description || ""}`;
  }

  const reviewPrompt = `아래 명세와 설계를 기반으로 구현을 검토하세요.

## 명세
${specContent}

## 설계
${designContent}${reviewScope}

## 검토 기준
1. 명세의 모든 요구사항이 구현되었는가
2. 설계 문서의 변경 내용이 반영되었는가
3. 에지 케이스가 처리되었는가
4. 보안 취약점 검사:
   - SQL injection, command injection, XSS 여부
   - 하드코딩된 비밀번호/API 키 여부
   - 사용자 입력 검증 누락 여부
   - 경로 조작(path traversal) 위험 여부
   - 안전하지 않은 역직렬화 여부
5. 코드 품질 (가독성, 일관성)

## 응답 형식 (JSON만 출력)
{
  "passed": true/false,
  "issues": [
    { "severity": "critical|major|minor", "description": "이슈 설명", "file": "파일 경로" }
  ],
  "summary": "검토 요약"
}`;

  const { data: reviewResult, tokenUsage: reviewTokenUsage } = await llmJson(reviewPrompt, {
    model,
    cwd: project,
    allowTools: "Read,Glob,Grep",
  });

  const reviewPassed = reviewResult.passed !== false;
  const criticalIssues = (reviewResult.issues || []).filter((i) => i.severity === "critical");

  const passed = testsPassed && reviewPassed && criticalIssues.length === 0;

  let feedback = null;
  if (!passed) {
    const feedbackParts = [];
    if (!testsPassed) {
      feedbackParts.push(`## 테스트 실패\n${testFailures.join("\n")}`);
    }
    if (!reviewPassed || criticalIssues.length > 0) {
      const issues = reviewResult.issues || [];
      feedbackParts.push(`## 리뷰 이슈\n${issues.map((i) => `- [${i.severity}] ${i.description} (${i.file || ""})`).join("\n")}`);
    }
    feedback = feedbackParts.join("\n\n");
  }

  const verifyReport = {
    passed,
    testsPassed,
    reviewPassed,
    testFailures,
    issues: reviewResult.issues || [],
    summary: reviewResult.summary || "",
  };

  await saveArtifact(taskId, `verify${artifactSuffix}.json`, JSON.stringify(verifyReport, null, 2));

  onLog(`[verify] result: ${passed ? "PASS" : "FAIL"}`);

  const totalTokenUsage = {
    input: (testResult.tokenUsage?.input || 0) + (reviewTokenUsage?.input || 0),
    output: (testResult.tokenUsage?.output || 0) + (reviewTokenUsage?.output || 0),
  };

  return { passed, feedback, report: verifyReport, tokenUsage: totalTokenUsage };
}

module.exports = { run };
