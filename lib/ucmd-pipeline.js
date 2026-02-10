const { DEFAULT_CONFIG, GATE_STEPS } = require("./ucmd-constants.js");

// ── Pipeline Pure Functions ──

function resolvePipeline(task, config) {
  const pipelineName = task.pipeline || config.defaultPipeline || DEFAULT_CONFIG.defaultPipeline;
  const pipelines = config.pipelines || DEFAULT_CONFIG.pipelines;
  if (pipelines[pipelineName]) {
    return { name: pipelineName, steps: pipelines[pipelineName] };
  }
  // fallback to legacy config.pipeline
  const legacySteps = config.pipeline || DEFAULT_CONFIG.pipeline;
  return { name: "legacy", steps: legacySteps };
}

function normalizeStep(step) {
  if (typeof step === "string") {
    return { type: "stage", stage: step };
  }
  if (typeof step === "object" && step !== null) {
    if (Array.isArray(step.loop)) {
      return { type: "loop", steps: step.loop, maxIterations: step.maxIterations ?? 3 };
    }
    if (step.rsa) {
      return { type: "rsa", stage: step.rsa, count: step.count || 3, strategy: step.strategy || "converge" };
    }
    if (step.gather) {
      return { type: "gather", mode: step.gather };
    }
  }
  throw new Error(`unsupported pipeline step: ${JSON.stringify(step)}`);
}

// Find the first step index after initial setup stages (analyze, gather, spec).
// Used by reject+feedback to skip already-completed analysis and resume from implementation.
function findResumeStepIndex(steps) {
  let resumeFrom = 0;
  for (let i = 0; i < steps.length; i++) {
    const n = normalizeStep(steps[i]);
    if ((n.type === "stage" && (n.stage === "analyze" || n.stage === "gather" || n.stage === "spec")) || n.type === "gather") {
      resumeFrom = i + 1;
    } else {
      break;
    }
  }
  return resumeFrom;
}

function parseGateResult(stdout) {
  if (!stdout) return null;
  const lines = stdout.split("\n").slice(-20);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^GATE:\s*(PASS|FAIL)/i);
    if (match) return match[1].toLowerCase() === "pass" ? "pass" : "fail";
  }
  return null;
}

function extractCriticalIssues(stdout) {
  if (!stdout) return "";
  const marker = /\*\*P1\s*[—–-]\s*CRITICAL/i;
  const lines = stdout.split("\n");
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (marker.test(lines[i])) { startIndex = i; break; }
  }
  if (startIndex === -1) return "";
  // collect lines until next P2/P3 section or ### or GATE:
  const result = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/\*\*P[23]\s*[—–-]/i.test(lines[i]) || /^###\s/.test(lines[i]) || /^GATE:/i.test(lines[i])) break;
    result.push(lines[i]);
  }
  const text = result.join("\n").trim();
  return text;
}

function isGateStep(stageName) {
  return GATE_STEPS.has(stageName);
}

function buildStageResultsSummary(stageResults) {
  const lines = [];
  for (const [key, value] of Object.entries(stageResults)) {
    if (key.endsWith(":gate")) continue;
    const truncated = value && value.length > 2000 ? value.slice(0, 2000) + "\n...(truncated)" : value;
    lines.push(`### ${key}\n\n${truncated || "(empty)"}`);
  }
  return lines.join("\n\n");
}

function resolveMaxIterations(maxIterations, stageResults) {
  if (typeof maxIterations === "number") return maxIterations;
  if (maxIterations === "auto") {
    const analyzeOutput = stageResults.analyze || "";
    const match = analyzeOutput.match(/(?:difficulty|난이도)[:\s]*(trivial|easy|medium|hard|complex)/i);
    if (match) {
      const level = match[1].toLowerCase();
      if (level === "trivial" || level === "easy") return 1;
      if (level === "medium") return 3;
      return 5; // hard, complex
    }
    return 3; // default when difficulty not found
  }
  return 3; // fallback
}

module.exports = {
  resolvePipeline, normalizeStep, findResumeStepIndex,
  parseGateResult, extractCriticalIssues, isGateStep,
  buildStageResultsSummary, resolveMaxIterations,
};
