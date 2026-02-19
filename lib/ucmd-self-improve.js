const crypto = require("crypto");
const path = require("path");

const { DEFAULT_CONFIG, SOURCE_ROOT, TEMPLATES_DIR } = require("./ucmd-constants.js");

let deps = {};
let log = () => {};

function setDeps(d) { deps = d; }
function setLog(fn) { log = fn; }

// ── Session Storage ──

const sessions = new Map();
let activeSessionId = null;

const STATUSES = [
  "idle", "preparing", "forging", "testing",
  "awaiting_review", "releasing", "iterating",
  "completed", "rolled_back", "failed",
];

function generateSessionId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.T]/g, "-").slice(0, 15);
  return `si_${ts}`;
}

function getConfig() {
  const config = deps.config();
  return {
    ...DEFAULT_CONFIG.selfImprove,
    ...(config.selfImprove || {}),
  };
}

function broadcast(event, data) {
  deps.broadcastWs(`self_improve:${event}`, data);
}

// ── Session Management ──

function createSession(proposal) {
  if (activeSessionId) {
    const existing = sessions.get(activeSessionId);
    if (existing && !["completed", "rolled_back", "failed"].includes(existing.status)) {
      throw new Error(`session already active: ${activeSessionId}`);
    }
  }

  const id = generateSessionId();
  const siConfig = getConfig();

  const session = {
    id,
    status: "idle",
    proposal: {
      id: proposal.proposalId || proposal.id || null,
      title: proposal.title || proposal.change || "unknown",
      description: proposal.description || proposal.change || "",
      risk: proposal.risk || "low",
    },
    branch: null,
    stableTag: null,
    previousBranch: null,
    iteration: 0,
    maxIterations: siConfig.maxIterations || 5,
    testResults: [],
    iterationLog: [],
    feedback: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    log: [],
  };

  sessions.set(id, session);
  activeSessionId = id;
  return session;
}

function addLog(session, message, type = "info") {
  const entry = { timestamp: new Date().toISOString(), message, type };
  session.log.push(entry);
  if (session.log.length > 200) session.log = session.log.slice(-150);
  session.lastActivityAt = entry.timestamp;
  log(`[self-improve:${session.id}] ${message}`);
}

function setStatus(session, status) {
  session.status = status;
  broadcast("status_changed", {
    sessionId: session.id,
    status,
    iteration: session.iteration,
    proposal: session.proposal.title,
  });
}

// ── Core Workflow ──

async function startSession(proposal) {
  const sandbox = require("./ucmd-sandbox.js");
  const session = createSession(proposal);

  addLog(session, `starting session for: ${session.proposal.title}`);
  setStatus(session, "preparing");

  try {
    // 1. Baseline test
    addLog(session, "running baseline tests...");
    const baseline = await sandbox.runAllTests(`si-baseline-${session.id}`);
    if (!baseline.passed) {
      addLog(session, `baseline tests failed at: ${baseline.failedAt || "unknown"}`, "error");
      setStatus(session, "failed");
      return { ok: false, error: "baseline tests failed", session };
    }
    addLog(session, "baseline tests passed");

    // 2. Tag stable version
    session.previousBranch = sandbox.getCurrentBranch();
    if (getConfig().backupBranch) {
      try {
        const pkg = require(path.join(SOURCE_ROOT, "package.json"));
        const version = `v${pkg.version}`;
        session.stableTag = sandbox.tagStableVersion(version);
        addLog(session, `tagged stable: ${session.stableTag}`);
      } catch (e) {
        addLog(session, `tagging skipped: ${e.message}`, "warn");
      }
    }

    // 3. Create dev branch
    const timestamp = new Date().toISOString().replace(/[:.T]/g, "-").slice(0, 15);
    session.branch = `ucm-self-improve-${timestamp}`;
    sandbox.createDevBranch(session.branch);
    addLog(session, `created branch: ${session.branch}`);

    // 4. Start forge + test loop
    await runImproveLoop(session);

    return { ok: true, session };
  } catch (e) {
    addLog(session, `session error: ${e.message}`, "error");
    setStatus(session, "failed");
    return { ok: false, error: e.message, session };
  }
}

async function runImproveLoop(session) {
  const sandbox = require("./ucmd-sandbox.js");
  const siConfig = getConfig();

  while (session.iteration < session.maxIterations) {
    if (session.status === "paused") {
      addLog(session, "session paused, waiting...");
      while (session.status === "paused") {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (["rolled_back", "failed", "completed"].includes(session.status)) return;
    }

    session.iteration++;
    addLog(session, `iteration ${session.iteration}/${session.maxIterations}`);

    // Forge phase
    setStatus(session, "forging");
    try {
      await runForge(session);
    } catch (e) {
      addLog(session, `forge error: ${e.message}`, "error");
      session.iterationLog.push({
        iteration: session.iteration,
        forge: "error",
        error: e.message,
      });
      continue;
    }

    // Test phase
    setStatus(session, "testing");
    const testResult = await sandbox.runAllTests(`si-iter-${session.id}-${session.iteration}`, {
      timeoutMs: siConfig.testTimeoutMs || 300000,
    });

    session.testResults = testResult.results || [];

    const iterLog = {
      iteration: session.iteration,
      results: (testResult.results || []).map((r) => ({
        name: r.name, passed: r.passed, passing: r.passing, total: r.total,
      })),
    };
    session.iterationLog.push(iterLog);

    broadcast("test_result", {
      sessionId: session.id,
      iteration: session.iteration,
      results: testResult.results,
      passed: testResult.passed,
    });

    if (testResult.passed) {
      addLog(session, "all tests passed!");
      if (siConfig.requireHumanApproval) {
        setStatus(session, "awaiting_review");
        addLog(session, "waiting for human review...");
        return; // wait for approve/reject
      }
      // Auto-merge
      await releaseImprovement(session);
      return;
    }

    // Tests failed
    addLog(session, `tests failed at: ${testResult.failedAt || "unknown"}`, "warn");
    if (session.iteration >= session.maxIterations) {
      addLog(session, "max iterations reached, rolling back", "error");
      await rollbackImprovement(session);
      return;
    }

    // Generate feedback for next iteration
    setStatus(session, "iterating");
    const failedLayers = (testResult.results || []).filter((r) => !r.passed);
    session.feedback = `Tests failed in: ${failedLayers.map((r) => `${r.name} (${r.failing} failures)`).join(", ")}. ${session.feedback || ""}`.trim();

    broadcast("iteration", {
      sessionId: session.id,
      iteration: session.iteration,
      feedback: session.feedback,
    });
  }
}

async function runForge(session) {
  const config = deps.config();
  const description = session.proposal.description;
  const feedback = session.feedback || "";

  const prompt = [
    `You are modifying the UCM codebase (${SOURCE_ROOT}).`,
    `Task: ${description}`,
    feedback ? `Previous iteration feedback: ${feedback}` : "",
    `This is iteration ${session.iteration}. Make the necessary code changes.`,
    `After changes, the full test suite will run automatically.`,
  ].filter(Boolean).join("\n\n");

  const result = await deps.spawnAgent(prompt, {
    cwd: SOURCE_ROOT,
    provider: config.provider || DEFAULT_CONFIG.provider,
    model: config.model || DEFAULT_CONFIG.model,
    timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
    taskId: `_si_forge_${session.id}_${session.iteration}`,
    stage: "implement",
  });

  if (result.status !== "done") {
    throw new Error(`forge failed: ${result.status}`);
  }

  addLog(session, `forge completed (iteration ${session.iteration})`);
}

// ── Release & Rollback ──

async function releaseImprovement(session) {
  const sandbox = require("./ucmd-sandbox.js");
  setStatus(session, "releasing");
  addLog(session, "releasing improvement...");

  try {
    sandbox.mergeDevBranch(session.branch);

    // Final verification test
    const finalTest = await sandbox.runAllTests(`si-final-${session.id}`);
    if (!finalTest.passed) {
      addLog(session, "final verification failed, rolling back!", "error");
      sandbox.rollbackToTag(session.stableTag || "HEAD~1");
      setStatus(session, "rolled_back");
      return;
    }

    // Tag new version
    try {
      const pkg = require(path.join(SOURCE_ROOT, "package.json"));
      sandbox.tagStableVersion(`v${pkg.version}`);
    } catch {}

    sandbox.deleteDevBranch(session.branch);
    addLog(session, "release complete!");
    setStatus(session, "completed");

    broadcast("released", { sessionId: session.id });
  } catch (e) {
    addLog(session, `release failed: ${e.message}`, "error");
    try {
      await rollbackImprovement(session);
    } catch (rollbackError) {
      addLog(session, `rollback also failed: ${rollbackError.message}`, "error");
      setStatus(session, "failed");
    }
  }
}

async function rollbackImprovement(session) {
  const sandbox = require("./ucmd-sandbox.js");
  addLog(session, "rolling back...");

  try {
    const currentBranch = sandbox.getCurrentBranch();
    if (currentBranch !== "main") {
      sandbox.checkoutBranch("main");
    }
    if (session.branch) {
      sandbox.deleteDevBranch(session.branch);
    }
  } catch (e) {
    addLog(session, `rollback warning: ${e.message}`, "warn");
  }

  setStatus(session, "rolled_back");
  broadcast("rolled_back", { sessionId: session.id });
}

// ── Human Intervention Handlers ──

async function handleStart(params) {
  const proposal = params || {};
  if (!proposal.title && !proposal.change && !proposal.proposalId) {
    throw new Error("proposal title or change description required");
  }
  const result = await startSession(proposal);
  return {
    sessionId: result.session.id,
    status: result.session.status,
    ok: result.ok,
    error: result.error,
  };
}

function handlePause() {
  const session = getActiveSession();
  if (!session) throw new Error("no active session");
  if (["completed", "rolled_back", "failed"].includes(session.status)) {
    throw new Error(`session already ${session.status}`);
  }
  session.pausedPhase = session.status;
  setStatus(session, "paused");
  addLog(session, "paused by user");
  return { sessionId: session.id, status: "paused" };
}

function handleResume() {
  const session = getActiveSession();
  if (!session) throw new Error("no active session");
  if (session.status !== "paused") throw new Error("session not paused");

  const previousPhase = session.pausedPhase || "iterating";
  session.pausedPhase = null;
  setStatus(session, previousPhase);
  addLog(session, `resumed (→ ${previousPhase})`);
  return { sessionId: session.id, status: previousPhase };
}

async function handleFeedback(params) {
  const session = getActiveSession();
  if (!session) throw new Error("no active session");

  const feedbackText = params?.feedback || params?.text || "";
  if (!feedbackText) throw new Error("feedback text required");

  session.feedback = feedbackText;
  addLog(session, `feedback received: ${feedbackText.slice(0, 100)}`);

  // If awaiting review, go back to iterating
  if (session.status === "awaiting_review" || session.status === "paused") {
    setStatus(session, "iterating");
    // Restart the improve loop
    runImproveLoop(session).catch((e) => {
      addLog(session, `loop error after feedback: ${e.message}`, "error");
      setStatus(session, "failed");
    });
  }

  return { sessionId: session.id, status: session.status };
}

async function handleApprove() {
  const session = getActiveSession();
  if (!session) throw new Error("no active session");
  if (session.status !== "awaiting_review") {
    throw new Error(`cannot approve in status: ${session.status}`);
  }

  addLog(session, "approved by user");
  await releaseImprovement(session);
  return { sessionId: session.id, status: session.status };
}

async function handleReject() {
  const session = getActiveSession();
  if (!session) throw new Error("no active session");

  addLog(session, "rejected by user");
  await rollbackImprovement(session);
  return { sessionId: session.id, status: session.status };
}

function handleSkip() {
  const session = getActiveSession();
  if (!session) throw new Error("no active session");

  addLog(session, "skipped by user");
  rollbackImprovement(session).catch(() => {});
  return { sessionId: session.id, status: "rolled_back" };
}

function handleStatus() {
  const session = getActiveSession();
  const allSessions = Array.from(sessions.values()).map((s) => ({
    id: s.id,
    status: s.status,
    proposal: s.proposal,
    branch: s.branch,
    stableTag: s.stableTag,
    iteration: s.iteration,
    maxIterations: s.maxIterations,
    testResults: s.testResults,
    iterationLog: s.iterationLog,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    log: s.log.slice(-20),
  }));

  return {
    activeSessionId,
    active: session ? {
      id: session.id,
      status: session.status,
      proposal: session.proposal,
      branch: session.branch,
      stableTag: session.stableTag,
      iteration: session.iteration,
      maxIterations: session.maxIterations,
      testResults: session.testResults,
      iterationLog: session.iterationLog,
    } : null,
    sessions: allSessions,
  };
}

// ── Helpers ──

function getActiveSession() {
  if (!activeSessionId) return null;
  return sessions.get(activeSessionId) || null;
}

module.exports = {
  setDeps,
  setLog,
  handleStart,
  handlePause,
  handleResume,
  handleFeedback,
  handleApprove,
  handleReject,
  handleSkip,
  handleStatus,
  // For testing
  sessions,
  getActiveSession,
};
