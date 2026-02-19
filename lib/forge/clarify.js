const path = require("path");
const { llmJson, llmText } = require("../core/llm");
const {
  computeCoverage, isFullyCovered,
  buildQuestionPrompt, buildAutopilotRefinementPrompt,
  formatDecisions, formatRefinedRequirements,
  REFINEMENT_GREENFIELD, REFINEMENT_BROWNFIELD,
  EXPECTED_GREENFIELD, EXPECTED_BROWNFIELD,
} = require("../core/qna");
const { saveArtifact, loadArtifact } = require("../core/worktree");
const { STAGE_MODELS } = require("../core/constants");

const MAX_ROUNDS = 20;

async function scanRepoContext(project) {
  const prompt = `당신은 코드베이스를 요약하는 분석가입니다.
로컬 저장소를 스캔하여 아래 형식으로 요약하세요.

## 출력 형식 (Markdown)
- Summary: 프로젝트 성격과 범위를 3~5문장으로 요약
- Tech Stack: 언어/프레임워크/빌드/테스트/배포 핵심만 나열
- Key Files: README, 설정 파일, 주요 엔트리포인트 등 핵심 파일 목록
- Module/Area Candidates: 질문 선택지로 쓸 수 있는 모듈/폴더/파일 후보 8~15개

규칙:
- 근거가 되는 파일 경로를 괄호로 표시
- 추측은 "추정"으로 표시
- 결과는 한국어로 작성`;

  const { text } = await llmText(prompt, {
    model: STAGE_MODELS.clarify,
    cwd: project,
    allowTools: "Read,Glob,Grep",
  });
  return text;
}

async function run({ taskId, dag, project, autopilot, timeouts, onQuestion, onLog = () => {} } = {}) {
  const isBrownfield = !!project;
  const model = STAGE_MODELS.clarify;

  let taskDescription = "";
  try {
    taskDescription = await loadArtifact(taskId, "task.md");
  } catch {}

  let repoContext = null;
  if (isBrownfield) {
    onLog("[clarify] scanning repo context...");
    try {
      repoContext = await scanRepoContext(project);
      await saveArtifact(taskId, "repo-context.md", repoContext);
    } catch (e) {
      onLog(`[clarify] repo scan failed: ${e.message}`);
    }
  }

  const decisions = [];

  if (autopilot || !onQuestion) {
    return runAutopilot({ taskId, taskDescription, decisions, isBrownfield, repoContext, model, onLog });
  }

  return runInteractive({ taskId, taskDescription, decisions, isBrownfield, repoContext, model, project, onQuestion, onLog });
}

async function runAutopilot({ taskId, taskDescription, decisions, isBrownfield, repoContext, model, onLog }) {
  const expected = isBrownfield ? REFINEMENT_BROWNFIELD : REFINEMENT_GREENFIELD;
  const totalTokenUsage = { input: 0, output: 0 };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const coverage = computeCoverage(decisions, expected);

    if (isFullyCovered(coverage)) {
      onLog("[clarify] all areas covered");
      break;
    }

    const session = {
      title: taskDescription.split("\n")[0]?.replace(/^#\s*/, "") || "task",
      description: taskDescription,
      decisions,
      isBrownfield,
      repoContext,
    };

    onLog(`[clarify] autopilot round ${round + 1}...`);

    const prompt = buildAutopilotRefinementPrompt(session);
    let response;
    try {
      const { data, tokenUsage } = await llmJson(prompt, { model, allowTools: "" });
      response = data;
      totalTokenUsage.input += tokenUsage.input;
      totalTokenUsage.output += tokenUsage.output;
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        onLog("[clarify] rate limited, saving progress");
        break;
      }
      throw e;
    }

    if (response.done) {
      onLog("[clarify] LLM determined coverage is sufficient");
      break;
    }

    decisions.push({
      area: response.area || "기타",
      question: response.question,
      answer: response.answer,
      reason: response.reason || "",
      requirement: response.requirement || "",
    });

    onLog(`[clarify] [${response.area}] ${response.question?.slice(0, 60)}`);
  }

  const coverage = computeCoverage(decisions, expected);
  const decisionsMarkdown = formatDecisions(decisions, coverage);
  await saveArtifact(taskId, "decisions.md", decisionsMarkdown);

  const requirements = formatRefinedRequirements(decisions);
  await saveArtifact(taskId, "decisions.json", JSON.stringify(decisions, null, 2));

  return { decisions, coverage, tokenUsage: totalTokenUsage };
}

async function runInteractive({ taskId, taskDescription, decisions, isBrownfield, repoContext, model, project, onQuestion, onLog }) {
  const expected = isBrownfield ? EXPECTED_BROWNFIELD : EXPECTED_GREENFIELD;
  const totalTokenUsage = { input: 0, output: 0 };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const coverage = computeCoverage(decisions, expected);

    if (isFullyCovered(coverage)) {
      onLog("[clarify] all areas covered");
      break;
    }

    const prompt = buildQuestionPrompt(null, decisions, taskDescription, {
      isResume: false,
      isBrownfield,
      coverage,
      repoContext,
    });

    onLog(`[clarify] generating question ${round + 1}...`);

    let response;
    try {
      const { data, tokenUsage } = await llmJson(prompt, {
        model,
        cwd: repoContext ? undefined : project,
        allowTools: repoContext ? "" : (project ? "Read,Glob,Grep" : ""),
      });
      response = data;
      totalTokenUsage.input += tokenUsage.input;
      totalTokenUsage.output += tokenUsage.output;
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        onLog("[clarify] rate limited, saving progress");
        break;
      }
      throw e;
    }

    if (response.done) {
      onLog("[clarify] LLM determined coverage is sufficient");
      break;
    }

    if (!response.question || !response.options || response.options.length < 2) {
      onLog("[clarify] invalid response, retrying...");
      continue;
    }

    // 사용자에게 질문을 전달하고 응답을 받음
    const userAnswer = await onQuestion({
      area: response.area || "기타",
      question: response.question,
      options: response.options,
    });

    if (!userAnswer || !userAnswer.trim()) {
      onLog("[clarify] empty answer, skipping");
      continue;
    }

    const selected = response.options.find((o) => o.label === userAnswer) || { label: userAnswer.trim(), reason: "" };
    decisions.push({
      area: response.area || "기타",
      question: response.question,
      answer: selected.label,
      reason: selected.reason || "",
    });

    onLog(`[clarify] [${response.area}] ${response.question?.slice(0, 60)} → ${selected.label?.slice(0, 40)}`);
  }

  const coverage = computeCoverage(decisions, expected);
  const decisionsMarkdown = formatDecisions(decisions, coverage);
  await saveArtifact(taskId, "decisions.md", decisionsMarkdown);
  await saveArtifact(taskId, "decisions.json", JSON.stringify(decisions, null, 2));

  return { decisions, coverage, tokenUsage: totalTokenUsage };
}

module.exports = { run };
