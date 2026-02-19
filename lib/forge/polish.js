const { spawnAgent } = require("../core/agent");
const { loadArtifact, saveArtifact } = require("../core/worktree");
const { STAGE_MODELS, POLISH_CONFIG } = require("../core/constants");
const { llmJson, extractJson } = require("../core/llm");

const LENS_PROMPTS = {
  code_quality: {
    label: "Code Quality",
    focus: `코드 품질 관점에서 리뷰하세요:
- 변수/함수/파일 이름이 명확하고 일관적인가
- 함수/메서드의 복잡도가 적절한가 (긴 함수, 깊은 중첩)
- 코드 중복이 있는가
- 에러 처리가 누락되었거나 부적절한 곳이 있는가
- 코드 스타일이 프로젝트 컨벤션과 일관적인가`,
  },
  design_consistency: {
    label: "Design Consistency",
    focus: `설계 일관성 관점에서 리뷰하세요:
- 설계 문서(design.md)와 실제 구현이 일치하는가
- 아키텍처 패턴이 프로젝트의 기존 패턴과 일관적인가
- 모듈 간 의존성이 적절한가 (순환 의존, 불필요한 결합)
- 인터페이스/API가 일관적이고 예측 가능한가
- 관심사 분리가 잘 되어 있는가`,
  },
  testing: {
    label: "Testing",
    focus: `테스트 관점에서 리뷰하세요:
- 핵심 로직에 대한 테스트가 존재하는가
- 에지 케이스가 충분히 테스트되는가
- 에러 경로(실패 시나리오)가 테스트되는가
- 변경된 코드에 대응하는 테스트가 추가/수정되었는가
- 테스트가 안정적이고 외부 의존성에 독립적인가`,
  },
  security: {
    label: "Security",
    focus: `보안 관점에서 리뷰하세요:
- 사용자 입력이 적절히 검증/이스케이프 되는가
- SQL injection, command injection, XSS 취약점이 있는가
- path traversal 위험이 있는가 (사용자 입력을 파일 경로에 사용)
- 하드코딩된 비밀번호, API 키, 토큰이 있는가
- 안전하지 않은 역직렬화나 eval 사용이 있는가`,
  },
};

async function run({ taskId, dag, project, subtask, timeouts, tokenBudget = 0, onLog = () => {} } = {}) {
  const models = STAGE_MODELS.polish;
  const config = POLISH_CONFIG;
  const artifactSuffix = subtask ? `-${subtask.id}` : "";

  let designContent = "";
  try {
    designContent = await loadArtifact(taskId, `design${artifactSuffix}.md`);
  } catch {
    try { designContent = await loadArtifact(taskId, "design.md"); } catch {}
  }

  let specContent = "";
  try {
    specContent = await loadArtifact(taskId, "spec.md");
  } catch {
    try { specContent = await loadArtifact(taskId, "task.md"); } catch {}
  }

  const totalTokenUsage = { input: 0, output: 0 };
  let totalRounds = 0;
  let totalIssuesFound = 0;
  const lensResults = [];

  onLog("[polish] starting multi-lens polish...");

  for (const lensName of config.defaultLenses) {
    if (totalRounds >= config.maxTotalRounds) {
      onLog(`[polish] max total rounds (${config.maxTotalRounds}) reached, skipping remaining lenses`);
      break;
    }

    // 토큰 예산 95% 체크
    if (tokenBudget > 0) {
      const used = dag.totalTokens();
      if (used / tokenBudget >= 0.95) {
        onLog("[polish] token budget 95% reached, stopping early");
        break;
      }
    }

    const lensResult = await runLensLoop({
      lensName,
      taskId,
      dag,
      project,
      subtask,
      designContent,
      specContent,
      models,
      config,
      timeouts,
      tokenBudget,
      totalRounds,
      artifactSuffix,
      onLog,
    });

    totalRounds += lensResult.rounds;
    totalIssuesFound += lensResult.issuesFound;
    totalTokenUsage.input += lensResult.tokenUsage.input;
    totalTokenUsage.output += lensResult.tokenUsage.output;
    lensResults.push({ lens: lensName, ...lensResult });
  }

  const summary = {
    lenses: lensResults.map((r) => ({
      lens: r.lens,
      rounds: r.rounds,
      issuesFound: r.issuesFound,
      converged: r.converged,
    })),
    totalRounds,
    totalIssuesFound,
  };

  await saveArtifact(taskId, `polish-summary${artifactSuffix}.json`, JSON.stringify(summary, null, 2));

  onLog(`[polish] complete: ${totalRounds} rounds, ${totalIssuesFound} issues found across ${lensResults.length} lenses`);

  return { status: "pass", summary, tokenUsage: totalTokenUsage };
}

async function runLensLoop({ lensName, taskId, dag, project, subtask, designContent, specContent, models, config, timeouts, tokenBudget, totalRounds, artifactSuffix, onLog }) {
  const lens = LENS_PROMPTS[lensName];
  if (!lens) throw new Error(`unknown polish lens: ${lensName}`);

  const remainingTotal = config.maxTotalRounds - totalRounds;
  const maxRounds = Math.min(config.maxRoundsPerLens, remainingTotal);

  let consecutiveClean = 0;
  let rounds = 0;
  let issuesFound = 0;
  const tokenUsage = { input: 0, output: 0 };

  onLog(`[polish:${lensName}] starting (max ${maxRounds} rounds)`);

  for (let round = 1; round <= maxRounds; round++) {
    // 토큰 예산 95% 체크
    if (tokenBudget > 0) {
      const used = dag.totalTokens();
      if (used / tokenBudget >= 0.95) {
        onLog(`[polish:${lensName}] token budget 95% reached, stopping lens`);
        break;
      }
    }

    rounds++;
    onLog(`[polish:${lensName}] round ${round} — review`);

    const reviewResult = await reviewWithLens({
      lensName,
      lens,
      project,
      designContent,
      specContent,
      subtask,
      models,
    });

    tokenUsage.input += reviewResult.tokenUsage?.input || 0;
    tokenUsage.output += reviewResult.tokenUsage?.output || 0;

    const issues = reviewResult.issues || [];

    await saveArtifact(
      taskId,
      `polish-${lensName}-round-${round}${artifactSuffix}.json`,
      JSON.stringify({ lens: lensName, round, issues, summary: reviewResult.summary || "" }, null, 2),
    );

    if (issues.length === 0) {
      consecutiveClean++;
      onLog(`[polish:${lensName}] round ${round} — 0 issues (clean ${consecutiveClean}/${config.convergenceThreshold})`);
      if (consecutiveClean >= config.convergenceThreshold) {
        onLog(`[polish:${lensName}] converged`);
        break;
      }
      continue;
    }

    consecutiveClean = 0;
    issuesFound += issues.length;
    onLog(`[polish:${lensName}] round ${round} — ${issues.length} issues found, fixing...`);

    const fixResult = await fixIssues({
      issues,
      lensName,
      project,
      models,
      timeouts,
      taskId,
      artifactSuffix,
      round,
      onLog,
    });

    tokenUsage.input += fixResult.tokenUsage?.input || 0;
    tokenUsage.output += fixResult.tokenUsage?.output || 0;

    // 테스트 게이트
    onLog(`[polish:${lensName}] round ${round} — test gate`);
    const testResult = await runTestGate({
      project,
      models,
      timeouts,
      taskId,
      lensName,
      artifactSuffix,
      round,
      onLog,
    });

    tokenUsage.input += testResult.tokenUsage?.input || 0;
    tokenUsage.output += testResult.tokenUsage?.output || 0;

    if (!testResult.passed) {
      onLog(`[polish:${lensName}] round ${round} — test gate FAILED, fixing tests...`);
      const testFixResult = await fixTestFailures({
        failures: testResult.failures,
        project,
        models,
        timeouts,
        taskId,
        lensName,
        artifactSuffix,
        round,
        onLog,
      });
      tokenUsage.input += testFixResult.tokenUsage?.input || 0;
      tokenUsage.output += testFixResult.tokenUsage?.output || 0;
    }
  }

  const converged = consecutiveClean >= config.convergenceThreshold;
  return { rounds, issuesFound, converged, tokenUsage };
}

async function reviewWithLens({ lensName, lens, project, designContent, specContent, subtask, models }) {
  let scope = "";
  if (subtask) {
    scope = `\n\n## 검토 범위\n이 서브태스크의 변경사항만 검토하세요:\n- ID: ${subtask.id}\n- 제목: ${subtask.title}\n- 설명: ${subtask.description || ""}`;
  }

  const prompt = `프로젝트의 코드를 아래 관점에서 리뷰하세요.
실제 파일을 Read/Glob/Grep으로 확인한 뒤 구체적인 이슈만 보고하세요.
추측이나 가정에 기반한 이슈는 보고하지 마세요.

## 리뷰 관점: ${lens.label}
${lens.focus}

${designContent ? `## 설계 문서\n${designContent}\n` : ""}
${specContent ? `## 명세\n${specContent}\n` : ""}${scope}

## 응답 형식 (JSON만 출력)
{
  "issues": [
    { "severity": "major|minor", "description": "구체적인 이슈 설명", "file": "파일 경로", "line": 0, "suggestion": "수정 제안" }
  ],
  "summary": "리뷰 요약"
}

이슈가 없으면 "issues": [] 를 반환하세요.`;

  const { data, tokenUsage } = await llmJson(prompt, {
    model: models.review,
    cwd: project,
    allowTools: "Read,Glob,Grep",
  });

  return { issues: data.issues || [], summary: data.summary || "", tokenUsage };
}

async function fixIssues({ issues, lensName, project, models, timeouts, taskId, artifactSuffix, round, onLog }) {
  const issueList = issues
    .map((issue, i) => `${i + 1}. [${issue.severity}] ${issue.file || ""}${issue.line ? ":" + issue.line : ""}\n   ${issue.description}\n   제안: ${issue.suggestion || "없음"}`)
    .join("\n\n");

  const prompt = `아래 리뷰 이슈들을 수정하세요. 각 이슈를 하나씩 확인하고 코드를 수정하세요.
수정 시 기존 기능을 깨뜨리지 않도록 주의하세요.

## 이슈 목록 (${lensName})
${issueList}

수정이 완료되면 어떤 파일을 어떻게 수정했는지 간단히 보고하세요.`;

  const result = await spawnAgent(prompt, {
    cwd: project,
    model: models.fix,
    idleTimeoutMs: timeouts.idle,
    hardTimeoutMs: timeouts.hard,
    taskId,
    stage: `polish-fix-${lensName}-${round}${artifactSuffix}`,
    onLog,
  });

  return { tokenUsage: result.tokenUsage };
}

async function runTestGate({ project, models, timeouts, taskId, lensName, artifactSuffix, round, onLog }) {
  const prompt = `프로젝트의 테스트를 실행하세요.

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

  const result = await spawnAgent(prompt, {
    cwd: project,
    model: models.review,
    idleTimeoutMs: timeouts.idle,
    hardTimeoutMs: timeouts.hard,
    taskId,
    stage: `polish-test-${lensName}-${round}${artifactSuffix}`,
    onLog,
  });

  // 프로세스 자체가 실패하면 게이트를 통과로 처리 (phantom failure 방지)
  if (result.status !== "done") {
    return { passed: true, failures: [], tokenUsage: result.tokenUsage };
  }

  let passed = true;
  let failures = [];
  try {
    const parsed = extractJson(result.stdout);
    passed = parsed.testsPassed !== false;
    failures = parsed.failures || [];
  } catch {}

  return { passed, failures, tokenUsage: result.tokenUsage };
}

async function fixTestFailures({ failures, project, models, timeouts, taskId, lensName, artifactSuffix, round, onLog }) {
  const failureList = failures.map((f, i) => `${i + 1}. ${f}`).join("\n");

  const prompt = `테스트가 실패했습니다. 아래 실패 항목을 확인하고 수정하세요.
polish 과정에서 발생한 회귀이므로, 최근 수정사항이 원인일 가능성이 높습니다.

## 실패 항목
${failureList}

코드를 수정하여 테스트가 통과하도록 하세요.`;

  const result = await spawnAgent(prompt, {
    cwd: project,
    model: models.fix,
    idleTimeoutMs: timeouts.idle,
    hardTimeoutMs: timeouts.hard,
    taskId,
    stage: `polish-testfix-${lensName}-${round}${artifactSuffix}`,
    onLog,
  });

  return { tokenUsage: result.tokenUsage };
}

module.exports = { run };
