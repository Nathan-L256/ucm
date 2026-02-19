const crypto = require("crypto");
const path = require("path");
const { readFile, writeFile } = require("fs/promises");

const {
  computeCoverage, isFullyCovered,
  REFINEMENT_GREENFIELD, REFINEMENT_BROWNFIELD,
  buildRefinementPrompt, buildAutopilotRefinementPrompt,
  formatRefinedRequirements,
} = require("./qna-core.js");

const { TASKS_DIR, DEFAULT_CONFIG } = require("./ucmd-constants.js");
const { parseTaskFile, serializeTaskFile, expandHome } = require("./ucmd-task.js");

let deps = {};

function setDeps(d) { deps = d; }

const refinementSessions = new Map();
const refinementWaiters = new Map();

function resolveRefinementAnswer(sessionId, answers) {
  const waiter = refinementWaiters.get(sessionId);
  if (waiter) waiter.resolve(answers);
}

async function scanRepoContext(projectPath) {
  const prompt = `당신은 코드베이스를 요약하는 분석가입니다.
로컬 저장소를 **한 번만** 스캔하여 아래 형식으로 요약하세요. 과도하게 길게 쓰지 마세요.

## 출력 형식 (Markdown)
- Summary: 프로젝트 성격과 범위를 3~5문장으로 요약
- Tech Stack: 언어/프레임워크/빌드/테스트/배포 관련 핵심만 나열
- Key Files: README, 설정 파일, 주요 엔트리포인트 등 핵심 파일 목록
- Module/Area Candidates: 질문 선택지로 쓸 수 있는 모듈/폴더/파일 후보 8~15개

규칙:
- 근거가 되는 파일 경로를 괄호로 표시
- 추측은 "추정"으로 표시
- 결과는 한국어로 작성`;

  const config = deps.config();
  const cfg = config || DEFAULT_CONFIG;
  const result = await deps.spawnAgent(prompt, {
    cwd: projectPath,
    provider: cfg.provider || DEFAULT_CONFIG.provider,
    model: "sonnet",
    timeoutMs: 120000,
    taskId: "_refinement",
    stage: "scan-repo",
  });
  deps.daemonState().stats.totalSpawns++;
  deps.markStateDirty();
  if (result.status === "done") return result.stdout || "";
  throw new Error(`repo scan failed: ${result.status}`);
}

function extractJsonFromText(text) {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

async function generateNextQuestion(sessionId) {
  const session = refinementSessions.get(sessionId);
  if (!session) return;

  const coverage = computeCoverage(session.decisions, session.expectedAreas);
  session.coverage = coverage;

  if (isFullyCovered(coverage)) {
    deps.broadcastWs("refinement:complete", { sessionId, coverage, decisions: session.decisions });
    return;
  }

  deps.broadcastWs("refinement:status", { sessionId, status: "질문 생성 중..." });

  const prompt = buildRefinementPrompt(session.decisions, session.description, {
    isBrownfield: session.isBrownfield,
    coverage,
    repoContext: session.repoContext,
  });

  const config = deps.config();
  const cfg = config || DEFAULT_CONFIG;
  const result = await deps.spawnAgent(prompt, {
    cwd: session.projectPath || undefined,
    provider: cfg.provider || DEFAULT_CONFIG.provider,
    model: "sonnet",
    timeoutMs: 120000,
    taskId: "_refinement",
    stage: `refinement-q-${session.decisions.length + 1}`,
  });
  deps.daemonState().stats.totalSpawns++;
  deps.markStateDirty();

  if (result.status !== "done") {
    deps.broadcastWs("refinement:error", { sessionId, error: "question generation failed" });
    return;
  }

  let parsed;
  try {
    parsed = extractJsonFromText(result.stdout || "");
  } catch (e) {
    deps.broadcastWs("refinement:error", { sessionId, error: `JSON parse failed: ${e.message}` });
    return;
  }

  if (parsed.done) {
    session.coverage = computeCoverage(session.decisions, session.expectedAreas);
    if (parsed.pipeline) session.pipeline = parsed.pipeline;
    deps.broadcastWs("refinement:complete", { sessionId, coverage: session.coverage, decisions: session.decisions, pipeline: session.pipeline });
    return;
  }

  if (!parsed.question || !parsed.options) {
    deps.broadcastWs("refinement:error", { sessionId, error: "invalid question format" });
    return;
  }

  session.currentQuestion = parsed;
  deps.broadcastWs("refinement:question", {
    sessionId,
    round: session.decisions.length + 1,
    question: parsed.question,
    options: parsed.options,
    area: parsed.area,
    coverage,
  });
}

async function handleRefinementAnswer(sessionId, answer) {
  const session = refinementSessions.get(sessionId);
  if (!session) return;

  session.decisions.push({
    area: answer.area || session.currentQuestion?.area || "기타",
    question: answer.questionText || session.currentQuestion?.question || "",
    answer: answer.value,
    reason: answer.reason || "",
  });
  session.currentQuestion = null;

  await generateNextQuestion(sessionId);
}

function buildAutopilotPrompt(session) {
  return buildAutopilotRefinementPrompt(session);
}

async function runAutopilotRefinement(sessionId) {
  const session = refinementSessions.get(sessionId);
  if (!session) return;

  const config = deps.config();
  const cfg = config || DEFAULT_CONFIG;
  const maxRounds = 15;

  for (let round = 0; round < maxRounds; round++) {
    if (!refinementSessions.has(sessionId)) return;
    if (session.mode !== "autopilot") return;

    const coverage = computeCoverage(session.decisions, session.expectedAreas);
    session.coverage = coverage;

    if (isFullyCovered(coverage)) {
      deps.broadcastWs("refinement:complete", { sessionId, coverage, decisions: session.decisions });
      return;
    }

    deps.broadcastWs("refinement:status", { sessionId, status: `자동 분석 중... (${round + 1}단계)` });

    const prompt = buildAutopilotPrompt(session);
    const result = await deps.spawnAgent(prompt, {
      cwd: session.projectPath || undefined,
      provider: cfg.provider || DEFAULT_CONFIG.provider,
      model: "sonnet",
      timeoutMs: 120000,
      taskId: "_refinement",
      stage: `refinement-auto-${round + 1}`,
    });
    deps.daemonState().stats.totalSpawns++;
    deps.markStateDirty();

    if (result.status !== "done") {
      deps.broadcastWs("refinement:error", { sessionId, error: `autopilot round ${round + 1} failed` });
      return;
    }

    let parsed;
    try {
      parsed = extractJsonFromText(result.stdout || "");
    } catch (e) {
      deps.broadcastWs("refinement:error", { sessionId, error: `JSON parse failed at round ${round + 1}` });
      return;
    }

    if (parsed.done) {
      session.coverage = computeCoverage(session.decisions, session.expectedAreas);
      if (parsed.pipeline) session.pipeline = parsed.pipeline;
      deps.broadcastWs("refinement:complete", { sessionId, coverage: session.coverage, decisions: session.decisions, pipeline: session.pipeline });
      return;
    }

    if (!parsed.question || !parsed.answer || !parsed.area) {
      continue;
    }

    const decision = {
      area: parsed.area,
      question: parsed.question,
      answer: parsed.answer,
      reason: parsed.reason || "",
      requirement: parsed.requirement || "",
    };
    session.decisions.push(decision);

    const updatedCoverage = computeCoverage(session.decisions, session.expectedAreas);
    session.coverage = updatedCoverage;

    deps.broadcastWs("refinement:progress", {
      sessionId,
      round: round + 1,
      decision,
      coverage: updatedCoverage,
    });
  }

  session.coverage = computeCoverage(session.decisions, session.expectedAreas);
  deps.broadcastWs("refinement:complete", { sessionId, coverage: session.coverage, decisions: session.decisions });
}

async function startRefinement(params) {
  const { title, description, project, pipeline, mode } = params;
  const sessionId = crypto.randomBytes(8).toString("hex");
  const isBrownfield = !!project;
  const projectPath = project ? path.resolve(expandHome(project)) : null;

  const session = {
    sessionId,
    mode: mode || "interactive",
    projectPath,
    isBrownfield,
    expectedAreas: isBrownfield ? REFINEMENT_BROWNFIELD : REFINEMENT_GREENFIELD,
    decisions: [],
    coverage: {},
    repoContext: null,
    title: title || "",
    description: description || "",
    pipeline: pipeline || undefined,
    currentQuestion: null,
  };

  refinementSessions.set(sessionId, session);
  deps.log(`refinement started: ${sessionId} (mode=${session.mode}, brownfield=${isBrownfield})`);

  deps.broadcastWs("refinement:started", { sessionId, mode: session.mode });

  const runRefinement = async () => {
    if (isBrownfield) {
      try {
        deps.broadcastWs("refinement:status", { sessionId, status: "코드베이스 분석 중..." });
        session.repoContext = await scanRepoContext(projectPath);
      } catch (e) {
        deps.log(`refinement scan error: ${e.message}`);
      }
    }

    if (session.mode === "interactive") {
      await generateNextQuestion(sessionId);
    } else {
      await runAutopilotRefinement(sessionId);
    }
  };

  runRefinement().catch((e) => {
    deps.log(`refinement error: ${e.message}`);
    deps.broadcastWs("refinement:error", { sessionId, error: e.message });
  });

  return { sessionId };
}

async function switchToAutopilot(sessionId) {
  const session = refinementSessions.get(sessionId);
  if (!session) throw new Error("session not found");

  session.mode = "autopilot";
  session.currentQuestion = null;

  const waiter = refinementWaiters.get(sessionId);
  if (waiter) {
    waiter.resolve(null);
    refinementWaiters.delete(sessionId);
  }

  deps.broadcastWs("refinement:mode_changed", { sessionId, mode: "autopilot" });

  runAutopilotRefinement(sessionId).catch((e) => {
    deps.log(`refinement autopilot error: ${e.message}`);
    deps.broadcastWs("refinement:error", { sessionId, error: e.message });
  });
}

async function finalizeRefinement(sessionId) {
  const session = refinementSessions.get(sessionId);
  if (!session) throw new Error("session not found");

  const formatted = formatRefinedRequirements(session.decisions);
  const body = (session.description ? session.description + "\n\n" : "") + formatted;

  const result = await deps.submitTask(session.title, body, {
    project: session.projectPath,
    pipeline: session.pipeline,
  });

  const taskPath = path.join(TASKS_DIR, "pending", `${result.id}.md`);
  try {
    const content = await readFile(taskPath, "utf-8");
    const { meta, body: taskBody } = parseTaskFile(content);
    meta.refined = true;
    await writeFile(taskPath, serializeTaskFile(meta, taskBody));
  } catch (e) {
    deps.log(`refinement: failed to set refined flag: ${e.message}`);
  }

  refinementSessions.delete(sessionId);
  deps.log(`refinement finalized: ${sessionId} → task ${result.id}`);
  deps.broadcastWs("refinement:finalized", { sessionId, taskId: result.id });
  return { taskId: result.id };
}

function cancelRefinement(sessionId) {
  const session = refinementSessions.get(sessionId);
  if (!session) throw new Error("session not found");

  const waiter = refinementWaiters.get(sessionId);
  if (waiter) {
    waiter.resolve(null);
    refinementWaiters.delete(sessionId);
  }

  refinementSessions.delete(sessionId);
  deps.log(`refinement cancelled: ${sessionId}`);
  deps.broadcastWs("refinement:cancelled", { sessionId });
  return { sessionId, status: "cancelled" };
}

module.exports = {
  setDeps,
  resolveRefinementAnswer,
  startRefinement,
  handleRefinementAnswer,
  switchToAutopilot,
  finalizeRefinement,
  cancelRefinement,
};
