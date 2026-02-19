const { spawnAgent } = require("../core/agent");
const { llmJson } = require("../core/llm");
const { saveArtifact, loadArtifact } = require("../core/worktree");
const { STAGE_MODELS, STAGE_TIMEOUTS } = require("../core/constants");

async function run({ taskId, dag, project, subtask, timeouts, onLog = () => {} } = {}) {
  const model = STAGE_MODELS.design;
  const effectiveTimeouts = timeouts || STAGE_TIMEOUTS.design;
  const artifactSuffix = subtask ? `-${subtask.id}` : "";

  let specContent = "";
  try {
    specContent = await loadArtifact(taskId, "spec.md");
  } catch {
    try {
      specContent = await loadArtifact(taskId, "task.md");
    } catch {}
  }

  let decisionsContent = "";
  try {
    decisionsContent = await loadArtifact(taskId, "decisions.json");
  } catch {}

  // hivemind 컨텍스트 조회
  let hivemindContext = "";
  if (project) {
    hivemindContext = await searchHivemind(specContent.slice(0, 200));
  }

  let subtaskContext = "";
  if (subtask) {
    const files = (subtask.estimatedFiles || []).join(", ");
    subtaskContext = `\n\n## 현재 서브태스크

- ID: ${subtask.id}
- 제목: ${subtask.title}
- 설명: ${subtask.description || ""}
${files ? `- 예상 파일: ${files}\n` : ""}
이 서브태스크의 범위에 맞게 설계하세요. 다른 서브태스크의 영역은 건드리지 마세요.`;
  }

  const prompt = `당신은 소프트웨어 설계 전문가입니다.
아래 명세와 프로젝트 코드를 분석하여 구현 계획을 작성하세요.

## 명세

${specContent}

${decisionsContent ? `## 설계 결정\n\n${decisionsContent}` : ""}${subtaskContext}${hivemindContext ? `\n\n## 관련 과거 지식\n\n${hivemindContext}` : ""}

## 지시사항

1. Read, Glob, Grep 도구로 프로젝트 코드베이스를 분석하세요.
2. 명세의 각 요구사항을 구현하기 위해 변경해야 할 파일을 파악하세요.
3. 구체적인 변경 내용, 구현 순서, 위험 요소를 포함한 설계 문서를 작성하세요.

## 출력 형식

다음 구조의 마크다운으로 작성하세요:

### 1. 영향 파일
- 각 파일별 변경 내용 요약

### 2. 구현 순서
- 단계별 구현 계획 (의존성 순서대로)

### 3. 위험 요소
- 잠재적 문제와 대응 방안

### 4. 테스트 계획
- 검증 방법과 기대 결과

마크다운 텍스트만 출력하세요. 코드펜스로 감싸지 마세요.`;

  const result = await spawnAgent(prompt, {
    cwd: project,
    model,
    idleTimeoutMs: effectiveTimeouts.idle,
    hardTimeoutMs: effectiveTimeouts.hard,
    taskId,
    stage: `design${artifactSuffix}`,
    onLog,
  });

  if (result.status !== "done") {
    throw new Error(`design failed: ${result.status} (${result.stderr?.slice(0, 200)})`);
  }

  // 토큰 사용량 집계 (spawnAgent + validation)
  let totalTokenUsage = { input: result.tokenUsage?.input || 0, output: result.tokenUsage?.output || 0 };

  // Sonnet으로 설계 검증 (명세 커버리지) — artifact 저장 전에 검증
  onLog("[design] validating design against spec...");
  try {
    const { data: validation, tokenUsage: valTokenUsage } = await llmJson(
      `아래 명세의 모든 요구사항이 설계에 반영되었는지 검증하세요.

## 명세
${specContent.slice(0, 3000)}

## 설계
${result.stdout.slice(0, 5000)}

## 응답 형식 (JSON만)
{
  "covered": true/false,
  "gaps": ["누락된 요구사항1", "누락된 요구사항2"],
  "summary": "검증 요약"
}`,
      { model: STAGE_MODELS.verify, allowTools: "" },
    );

    if (valTokenUsage) {
      totalTokenUsage.input += valTokenUsage.input || 0;
      totalTokenUsage.output += valTokenUsage.output || 0;
    }

    await saveArtifact(taskId, `design-validation${artifactSuffix}.json`, JSON.stringify(validation, null, 2));

    if (!validation.covered && validation.gaps?.length > 0) {
      dag.warnings.push(`design gaps: ${validation.gaps.join(", ")}`);
      onLog(`[design] validation: ${validation.gaps.length} gap(s) found`);
    } else {
      onLog("[design] validation: all requirements covered");
    }
  } catch (e) {
    onLog(`[design] validation skipped: ${e.message}`);
  }

  await saveArtifact(taskId, `design${artifactSuffix}.md`, result.stdout);

  return { status: "pass", output: result.stdout, tokenUsage: totalTokenUsage };
}

async function searchHivemind(query) {
  try {
    const { search } = require("../hivemind/search");
    const indexer = require("../hivemind/indexer");
    indexer.loadFromDisk();
    const results = await search(query, { limit: 3 });
    if (results.length === 0) return "";
    return results.map((r) => `- **${r.title}**: ${r.body?.slice(0, 200) || ""}`).join("\n");
  } catch {
    return "";
  }
}

module.exports = { run };
