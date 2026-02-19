const { spawnAgent } = require("../core/agent");
const { loadArtifact } = require("../core/worktree");
const { STAGE_MODELS, STAGE_TIMEOUTS } = require("../core/constants");

async function run({ taskId, dag, project, autopilot, subtask, feedback, timeouts, onLog = () => {} } = {}) {
  const model = STAGE_MODELS.implement;
  const effectiveTimeouts = timeouts || STAGE_TIMEOUTS.implement;
  const artifactSuffix = subtask ? `-${subtask.id}` : "";

  let designContent = "";
  try {
    designContent = await loadArtifact(taskId, `design${artifactSuffix}.md`);
  } catch {
    try {
      designContent = await loadArtifact(taskId, "design.md");
    } catch {}
  }

  let specContent = "";
  try {
    specContent = await loadArtifact(taskId, "spec.md");
  } catch {
    try {
      specContent = await loadArtifact(taskId, "task.md");
    } catch {}
  }

  // hivemind 컨텍스트 조회
  let hivemindContext = "";
  try {
    const { search } = require("../hivemind/search");
    const indexer = require("../hivemind/indexer");
    indexer.loadFromDisk();
    const query = subtask ? subtask.title : specContent.slice(0, 200);
    const results = await search(query, { limit: 3 });
    if (results.length > 0) {
      hivemindContext = results.map((r) => `- **${r.title}**: ${r.body?.slice(0, 200) || ""}`).join("\n");
    }
  } catch {}

  let prompt;
  if (designContent) {
    prompt = `당신은 소프트웨어 구현 전문가입니다.
아래 설계 문서를 정확히 따라 구현하세요. 즉흥적인 변경은 금지입니다.

## 설계 문서

${designContent}

## 명세

${specContent}

## 구현 규칙

1. 설계 문서에 명시된 파일만 변경하세요.
2. 각 논리적 변경 단위마다 atomic commit을 만드세요.
3. 기존 코드 스타일과 패턴을 따르세요.
4. 보안 취약점(injection, XSS 등)을 도입하지 마세요.
5. 불필요한 주석, 로그, TODO를 남기지 마세요.
6. 현재 worktree 외부의 파일을 수정하지 마세요.
7. API 키, 비밀번호 등을 코드에 하드코딩하지 마세요.`;
  } else {
    prompt = `당신은 소프트웨어 구현 전문가입니다.
아래 요청을 직접 구현하세요.

## 요청

${specContent}

## 구현 규칙

1. 먼저 Read, Glob, Grep으로 기존 코드를 파악하세요.
2. 각 논리적 변경 단위마다 atomic commit을 만드세요.
3. 기존 코드 스타일과 패턴을 따르세요.
4. 보안 취약점(injection, XSS 등)을 도입하지 마세요.
5. 불필요한 주석, 로그, TODO를 남기지 마세요.
6. 현재 worktree 외부의 파일을 수정하지 마세요.
7. API 키, 비밀번호 등을 코드에 하드코딩하지 마세요.`;
  }

  if (subtask) {
    prompt += `\n\n## 현재 서브태스크

- ID: ${subtask.id}
- 제목: ${subtask.title}
- 설명: ${subtask.description || ""}

이 서브태스크의 범위만 구현하세요.`;
  }

  if (hivemindContext) {
    prompt += `\n\n## 관련 과거 지식\n\n${hivemindContext}`;
  }

  if (feedback) {
    prompt += `\n\n## 이전 검증 피드백 (반드시 수정)\n\n${feedback}`;
  }

  const result = await spawnAgent(prompt, {
    cwd: project,
    model,
    idleTimeoutMs: effectiveTimeouts.idle,
    hardTimeoutMs: effectiveTimeouts.hard,
    taskId,
    stage: `implement${artifactSuffix}`,
    onLog,
  });

  if (result.status !== "done") {
    throw new Error(`implement failed: ${result.status} (${result.stderr?.slice(0, 200)})`);
  }

  return { status: "pass", output: result.stdout, tokenUsage: result.tokenUsage };
}

module.exports = { run };
