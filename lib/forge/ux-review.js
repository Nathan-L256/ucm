const fs = require("fs");
const path = require("path");
const { spawnAgent } = require("../core/agent");
const { loadArtifact, saveArtifact } = require("../core/worktree");
const { STAGE_MODELS, STAGE_TIMEOUTS, TEMPLATES_DIR } = require("../core/constants");
const { extractJson } = require("../core/llm");
const { detectFrontend, startDevServer, launchBrowser, killBrowser } = require("../core/browser");

function loadTemplate() {
  return fs.readFileSync(path.join(TEMPLATES_DIR, "ucm-ux-review.md"), "utf-8");
}

function parseUxReview(output) {
  try {
    const review = extractJson(output);
    return {
      score: typeof review.score === "number" ? review.score : 0,
      summary: review.summary || "",
      canUserAccomplishGoal: review.canUserAccomplishGoal || { goal: "", result: "no", blockers: [] },
      usabilityIssues: Array.isArray(review.usabilityIssues) ? review.usabilityIssues : [],
      confusingElements: Array.isArray(review.confusingElements) ? review.confusingElements : [],
      positives: Array.isArray(review.positives) ? review.positives : [],
      mobile: review.mobile || { usable: true, issues: [] },
    };
  } catch {
    return {
      score: 0,
      summary: "Failed to parse UX review output",
      canUserAccomplishGoal: { goal: "", result: "no", blockers: ["Review output was not valid JSON"] },
      usabilityIssues: [{ severity: "critical", description: "Review output was not valid JSON", where: "", fix: "Re-run the review" }],
      confusingElements: [],
      positives: [],
      mobile: { usable: true, issues: [] },
    };
  }
}

function formatUxFeedback(review) {
  const parts = [];

  const critical = review.usabilityIssues.filter((i) => i.severity === "critical");
  if (critical.length > 0) {
    parts.push("## Critical Usability Issues\n");
    for (const issue of critical) {
      parts.push(`- ${issue.description} (${issue.where})`);
      if (issue.fix) parts.push(`  Fix: ${issue.fix}`);
    }
  }

  const major = review.usabilityIssues.filter((i) => i.severity === "major");
  if (major.length > 0) {
    parts.push("\n## Major Usability Issues\n");
    for (const issue of major) {
      parts.push(`- ${issue.description} (${issue.where})`);
      if (issue.fix) parts.push(`  Fix: ${issue.fix}`);
    }
  }

  if (review.canUserAccomplishGoal && review.canUserAccomplishGoal.result !== "yes") {
    parts.push("\n## User Goal Not Met\n");
    parts.push(`Goal: ${review.canUserAccomplishGoal.goal}`);
    parts.push(`Result: ${review.canUserAccomplishGoal.result}`);
    for (const b of review.canUserAccomplishGoal.blockers || []) {
      parts.push(`- ${b}`);
    }
  }

  return parts.join("\n");
}

async function run({ taskId, dag, project, subtask, timeouts, onLog = () => {} } = {}) {
  const model = STAGE_MODELS["ux-review"];
  const effectiveTimeouts = timeouts || STAGE_TIMEOUTS["ux-review"];
  const artifactSuffix = subtask ? `-${subtask.id}` : "";

  // 1. Frontend detection
  const frontendConfig = await detectFrontend(project);
  if (!frontendConfig) {
    onLog("[ux-review] not a frontend project, skipping");
    return { passed: true, skipped: true, tokenUsage: { input: 0, output: 0 } };
  }

  // Static-only projects without a dev command are also skipped
  if (frontendConfig.staticOnly && !frontendConfig.devCommand) {
    onLog("[ux-review] static project without dev server, skipping");
    return { passed: true, skipped: true, tokenUsage: { input: 0, output: 0 } };
  }

  onLog("[ux-review] frontend project detected, starting review...");

  // 2. Start dev server
  let devServer = null;
  try {
    devServer = await startDevServer(project, frontendConfig);
  } catch (error) {
    onLog(`[ux-review] dev server failed to start: ${error.message}, skipping`);
    return { passed: true, skipped: true, tokenUsage: { input: 0, output: 0 } };
  }

  if (!devServer) {
    onLog("[ux-review] dev server not available, skipping");
    return { passed: true, skipped: true, tokenUsage: { input: 0, output: 0 } };
  }

  // 3. Launch headless Chrome
  let browser = null;
  try {
    browser = await launchBrowser(taskId);
  } catch (error) {
    onLog(`[ux-review] Chrome launch failed: ${error.message}, skipping`);
    devServer.kill();
    return { passed: true, skipped: true, tokenUsage: { input: 0, output: 0 } };
  }

  if (!browser) {
    onLog("[ux-review] Chrome not available, skipping");
    devServer.kill();
    return { passed: true, skipped: true, tokenUsage: { input: 0, output: 0 } };
  }

  try {
    // 4. Load artifacts
    let spec = "";
    try { spec = await loadArtifact(taskId, "spec.md"); } catch {
      try { spec = await loadArtifact(taskId, "task.md"); } catch {}
    }

    let design = "";
    try { design = await loadArtifact(taskId, `design${artifactSuffix}.md`); } catch {
      try { design = await loadArtifact(taskId, "design.md"); } catch {}
    }

    // 5. Build prompt
    const template = loadTemplate();
    const prompt = template
      .replace("{{SPEC}}", spec)
      .replace("{{DESIGN}}", design)
      .replace("{{DEV_URL}}", devServer.url);

    onLog(`[ux-review] spawning UX review agent (dev: ${devServer.url}, chrome: port ${browser.port})`);

    // 6. Spawn UX expert agent
    const result = await spawnAgent(prompt, {
      cwd: project,
      model,
      idleTimeoutMs: effectiveTimeouts.idle,
      hardTimeoutMs: effectiveTimeouts.hard,
      taskId,
      stage: `ux-review${artifactSuffix}`,
      onLog,
    });

    // 7. Parse result
    const review = parseUxReview(result.stdout);
    await saveArtifact(taskId, `ux-review${artifactSuffix}.json`, JSON.stringify(review, null, 2));

    // 8. Pass/fail decision
    const criticalCount = review.usabilityIssues.filter((i) => i.severity === "critical").length;
    const passed = review.score >= 6 && criticalCount === 0;
    const feedback = passed ? null : formatUxFeedback(review);

    onLog(`[ux-review] result: ${passed ? "PASS" : "FAIL"} (score: ${review.score}/10, critical: ${criticalCount})`);

    return { passed, feedback, report: review, tokenUsage: result.tokenUsage || { input: 0, output: 0 } };
  } finally {
    killBrowser(browser);
    devServer.kill();
  }
}

module.exports = { run, parseUxReview, formatUxFeedback, detectFrontend, loadTemplate };
