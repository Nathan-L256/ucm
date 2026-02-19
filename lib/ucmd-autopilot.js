const crypto = require("crypto");
const path = require("path");
const { readFile, writeFile, readdir, mkdir, rename, unlink } = require("fs/promises");

const { TEMPLATES_DIR, DEFAULT_CONFIG, SOURCE_ROOT, AUTOPILOT_DIR } = require("./ucmd-constants.js");
const { expandHome } = require("./ucmd-task.js");
const { loadTemplate } = require("./ucmd-prompt.js");
const { isGitRepo, tagStableVersion, listStableTags } = require("./ucmd-sandbox.js");
const { generateProjectContext, formatProjectContext } = require("./ucmd-structure.js");

let deps = {};
let log = () => {};

function setDeps(d) { deps = d; }
function setLog(fn) { log = fn; }

// ── Session Storage ──

const sessions = new Map();
const projectSessionMap = new Map();

function generateSessionId() {
  return "ap_" + crypto.randomBytes(6).toString("hex");
}

function generateDirectiveId() {
  return "d_" + crypto.randomBytes(4).toString("hex");
}

function createSession(project, options = {}) {
  const resolved = path.resolve(expandHome(project));
  if (projectSessionMap.has(resolved)) {
    throw new Error(`autopilot already running for project: ${resolved}`);
  }

  const id = generateSessionId();
  const config = deps.config();
  const apConfig = config.autopilot || DEFAULT_CONFIG.autopilot;

  const session = {
    id,
    status: "planning",
    pausedAt: null,
    pausedPhase: null,
    project: resolved,
    projectName: path.basename(resolved),
    pipeline: options.pipeline || config.defaultPipeline || "implement",
    roadmap: [],
    currentItem: 0,
    currentTaskId: null,
    iteration: 0,
    releases: [],
    stats: {
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      totalReleases: 0,
    },
    consecutiveFailures: 0,
    totalItemsProcessed: 0,
    maxItems: options.maxItems || apConfig.maxItemsPerSession,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    log: [],

    directives: [],
    projectContext: null,

    // Forge state
    stableTag: null,
    currentItemIteration: 0,
    currentTestResults: [],
    currentItemLog: [],
    _reviewResolve: null,
    _reviewTimer: null,
  };

  sessions.set(id, session);
  projectSessionMap.set(resolved, id);
  return session;
}

// ── Session Persistence ──

async function saveSession(session) {
  const dir = AUTOPILOT_DIR;
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  const tmpPath = filePath + ".tmp";
  const { _reviewResolve, _reviewTimer, _savePending, _saveTimer, ...serializable } = session;
  await writeFile(tmpPath, JSON.stringify(serializable, null, 2));
  await rename(tmpPath, filePath);
}

function debouncedSave(session) {
  if (session._savePending) return;
  session._savePending = true;
  if (session._saveTimer) clearTimeout(session._saveTimer);
  session._saveTimer = setTimeout(() => {
    session._savePending = false;
    session._saveTimer = null;
    saveSession(session).catch((e) => log(`[autopilot:${session.id}] save error: ${e.message}`));
  }, 2000);
}

async function loadSession(sessionId) {
  const filePath = path.join(AUTOPILOT_DIR, `${sessionId}.json`);
  const data = JSON.parse(await readFile(filePath, "utf-8"));
  data._reviewResolve = null;
  data._reviewTimer = null;
  return data;
}

async function recoverSessions() {
  try {
    const files = await readdir(AUTOPILOT_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const session = await loadSession(file.replace(".json", ""));
      if (session.status === "stopped" || session.status === "completed") continue;
      session.status = "paused";
      session.pausedPhase = "running";
      session.pausedAt = new Date().toISOString();
      sessions.set(session.id, session);
      projectSessionMap.set(session.project, session.id);
      log(`[autopilot] recovered session: ${session.id} (paused)`);
    }
  } catch {}
}

async function deleteSessionFile(sessionId) {
  try { await unlink(path.join(AUTOPILOT_DIR, `${sessionId}.json`)); } catch {}
}

// ── Logging ──

function addLog(session, message, type = "info") {
  const entry = { timestamp: new Date().toISOString(), message, type };
  session.log.push(entry);
  if (session.log.length > 200) session.log = session.log.slice(-150);
  session.lastActivityAt = entry.timestamp;
  log(`[autopilot:${session.id}] ${message}`);
  debouncedSave(session);
}

// ── Pause/Resume Helpers ──

async function waitIfPaused(session) {
  while (session.status === "paused") {
    await new Promise((r) => setTimeout(r, 2000));
  }
  return session.status !== "stopped";
}

function checkDaemonPaused() {
  const daemonState = deps.daemonState();
  return daemonState && daemonState.daemonStatus === "paused";
}

async function waitIfDaemonPaused(session) {
  while (checkDaemonPaused()) {
    addLog(session, "daemon paused, waiting...", "warn");
    await new Promise((r) => setTimeout(r, 5000));
    if (session.status === "stopped") return false;
  }
  return true;
}

// ── Roadmap Planning ──

async function planRoadmap(session) {
  session.status = "planning";
  deps.broadcastWs("autopilot:planning", { sessionId: session.id });
  addLog(session, `planning iteration ${session.iteration + 1}`);

  const config = deps.config();
  const apConfig = config.autopilot || DEFAULT_CONFIG.autopilot;

  let template;
  try {
    template = await loadTemplate("autopilot-plan");
  } catch {
    template = await readFile(path.join(TEMPLATES_DIR, "ucm-autopilot-plan.md"), "utf-8");
  }

  const previousReleases = session.releases
    .map((r) => `- ${r.version}: ${r.changelog}`)
    .join("\n") || "(none)";

  const failedItems = session.roadmap
    .filter((item) => item.status === "failed")
    .map((item) => `- [${item.type}] ${item.title}`)
    .join("\n") || "(none)";

  const remainingBudget = session.maxItems - session.totalItemsProcessed;

  // Load approved proposals from observer
  let approvedSection = "(none)";
  try {
    const { listProposals } = require("./ucmd-observer.js");
    let approvedProposals = await listProposals("approved");
    approvedProposals = approvedProposals.filter(
      (p) => !p.project || p.project === session.projectName || p.project === session.project
    );
    if (approvedProposals.length > 0) {
      approvedSection = approvedProposals
        .map((p) => `- [${p.category}/${p.risk}] ${p.title}: ${p.change || ""}`)
        .join("\n");
    }
  } catch {}

  // Consume pending human directives
  let directivesSection = "(none)";
  const pendingDirectives = (session.directives || []).filter(d => d.status === "pending");
  if (pendingDirectives.length > 0) {
    directivesSection = pendingDirectives.map(d => `- ${d.text}`).join("\n");
    for (const d of pendingDirectives) {
      d.status = "consumed";
      d.updatedAt = new Date().toISOString();
      d.consumedInIteration = session.iteration + 1;
    }
    deps.broadcastWs("autopilot:directives_consumed", {
      sessionId: session.id,
      count: pendingDirectives.length,
      iteration: session.iteration + 1,
    });
  }

  // Generate project context
  let projectContextSection = "(not available)";
  try {
    const contextResult = await generateProjectContext(session.project);
    session.projectContext = formatProjectContext(contextResult);
    projectContextSection = session.projectContext;
  } catch (e) {
    addLog(session, `project context generation failed: ${e.message}`, "warn");
  }

  const prompt = template
    .replace(/\{\{PROJECT\}\}/g, session.project)
    .replace(/\{\{PROJECT_NAME\}\}/g, session.projectName)
    .replace(/\{\{ITERATION\}\}/g, String(session.iteration + 1))
    .replace(/\{\{PREVIOUS_RELEASES\}\}/g, previousReleases)
    .replace(/\{\{FAILED_ITEMS\}\}/g, failedItems)
    .replace(/\{\{REMAINING_BUDGET\}\}/g, String(remainingBudget))
    .replace(/\{\{RELEASE_EVERY\}\}/g, String(apConfig.releaseEvery))
    .replace(/\{\{ITEM_MIX\}\}/g, JSON.stringify(apConfig.itemMix))
    .replace(/\{\{APPROVED_PROPOSALS\}\}/g, approvedSection)
    .replace(/\{\{HUMAN_DIRECTIVES\}\}/g, directivesSection)
    .replace(/\{\{PROJECT_CONTEXT\}\}/g, projectContextSection);

  const result = await deps.spawnAgent(prompt, {
    cwd: session.project,
    provider: config.provider || DEFAULT_CONFIG.provider,
    model: config.model || DEFAULT_CONFIG.model,
    timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
    taskId: `_autopilot_${session.id}`,
    stage: "plan",
  });

  if (result.status !== "done" || !result.stdout) {
    throw new Error(`planning failed: ${result.status}`);
  }

  const roadmap = parseRoadmapOutput(result.stdout, session.iteration + 1);
  if (roadmap.length === 0) {
    throw new Error("planning returned empty roadmap");
  }

  session.roadmap = roadmap;
  session.currentItem = 0;
  session.stats.totalItems = roadmap.length;
  session.stats.completedItems = 0;
  session.stats.failedItems = 0;
  session.stats.skippedItems = 0;
  session.iteration++;

  deps.broadcastWs("autopilot:planned", {
    sessionId: session.id,
    roadmap: roadmap.map((item) => ({ title: item.title, type: item.type, status: item.status })),
    iteration: session.iteration,
  });
  addLog(session, `planned ${roadmap.length} items for iteration ${session.iteration}`);
}

function parseRoadmapOutput(stdout, iteration) {
  const jsonMatch = stdout.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const items = JSON.parse(jsonMatch[0]);
    return items.map((item) => ({
      title: item.title || "Untitled",
      type: item.type || "feature",
      description: item.description || "",
      status: "pending",
      taskId: null,
      iteration,
    }));
  } catch {
    return [];
  }
}

// ── Preparation ──

async function prepareSession(session) {
  // Tag current state as stable
  try {
    const pkg = JSON.parse(await readFile(path.join(session.project, "package.json"), "utf-8"));
    session.stableTag = tagStableVersion(`v${pkg.version}`, session.project);
    addLog(session, `tagged stable: ${session.stableTag}`);
  } catch {
    try {
      const ts = new Date().toISOString().replace(/[:.T]/g, "-").slice(0, 15);
      session.stableTag = tagStableVersion(`v0.0.0-${ts}`, session.project);
      addLog(session, `tagged stable: ${session.stableTag}`);
    } catch (e) {
      addLog(session, `stable tagging skipped: ${e.message}`, "warn");
    }
  }
}

// ── Per-Item Execution via ForgePipeline ──

async function executeItem(session, item) {
  const config = deps.config();
  const apConfig = config.autopilot || DEFAULT_CONFIG.autopilot;
  const requireHumanApproval = apConfig.requireHumanApproval !== undefined
    ? apConfig.requireHumanApproval : DEFAULT_CONFIG.autopilot.requireHumanApproval;

  item.status = "running";
  session.currentItemIteration = 0;
  session.currentTestResults = [];
  session.currentItemLog = [];

  addLog(session, `executing: [${item.type}] ${item.title}`);
  deps.broadcastWs("autopilot:executing", {
    sessionId: session.id,
    item: { title: item.title, type: item.type },
  });

  const { ForgePipeline, wireEvents } = require("./forge/index");

  const forgePipeline = apConfig.forgePipeline || DEFAULT_CONFIG.autopilot.forgePipeline || "small";
  const inputParts = [
    `## Task: ${item.title}`,
    ``,
    item.description || "",
  ];
  if (session.projectContext) {
    inputParts.push("", "## Project Documentation Context", "", session.projectContext);
  }
  const input = inputParts.join("\n");

  const pipeline = new ForgePipeline({
    input,
    project: session.project,
    pipeline: forgePipeline,
    autopilot: !requireHumanApproval,
  });

  wireEvents(pipeline, (event, data) => {
    deps.broadcastWs(`autopilot:forge:${event}`, {
      sessionId: session.id,
      ...data,
    });
    if (event === "stage:complete" && data.stage === "verify") {
      session.currentItemLog.push({ stage: data.stage, status: data.status });
    }
  });

  try {
    const dag = await pipeline.run();
    item.taskId = dag.id;

    if (dag.status === "done" || dag.status === "auto_merged") {
      if (requireHumanApproval && dag.status !== "auto_merged") {
        return await waitForHumanApprovalOnForge(session, item, pipeline);
      }
      addLog(session, `completed: ${item.title} (${dag.status})`);
      return "done";
    } else if (dag.status === "review") {
      return await waitForHumanApprovalOnForge(session, item, pipeline);
    } else {
      addLog(session, `forge failed: ${dag.status}`, "error");
      return "failed";
    }
  } catch (e) {
    addLog(session, `forge error: ${e.message}`, "error");
    try { await pipeline.abort(); } catch {}
    return "failed";
  }
}

async function waitForHumanApprovalOnForge(session, item, pipeline) {
  session.status = "awaiting_review";
  addLog(session, "awaiting human review...");
  deps.broadcastWs("autopilot:awaiting_review", {
    sessionId: session.id,
    item: { title: item.title, type: item.type },
    taskId: item.taskId,
  });

  const config = deps.config();
  const apConfig = config.autopilot || DEFAULT_CONFIG.autopilot;
  const reviewTimeoutMs = apConfig.reviewTimeoutMs || DEFAULT_CONFIG.autopilot.reviewTimeoutMs;
  const decision = await waitForDecision(session, reviewTimeoutMs);

  if (session.status === "stopped") return "stopped";
  if (session.status === "paused") {
    const ok = await waitIfPaused(session);
    if (!ok) return "stopped";
  }

  if (decision.action === "approve") {
    try {
      const { mergeWorktrees, removeWorktrees, loadWorkspace } = require("./core/worktree");
      const workspace = await loadWorkspace(item.taskId);
      if (workspace) {
        await mergeWorktrees(item.taskId, workspace.projects, { log: (m) => addLog(session, m) });
        await removeWorktrees(item.taskId, workspace.projects);
      }
    } catch (e) {
      addLog(session, `merge failed: ${e.message}`, "error");
      return "failed";
    }
    addLog(session, `approved and merged: ${item.title}`);
    return "done";
  } else if (decision.action === "reject") {
    try { await pipeline.abort(); } catch {}
    addLog(session, `rejected: ${item.title}`);
    return "failed";
  } else if (decision.action === "feedback") {
    addLog(session, `feedback received, but forge pipeline does not support mid-run feedback yet`);
    return "failed";
  }

  return "failed";
}

function waitForDecision(session, timeoutMs) {
  return new Promise((resolve) => {
    session._reviewTimer = setTimeout(() => {
      if (session._reviewResolve) {
        session._reviewResolve = null;
        session._reviewTimer = null;
        const mins = Math.round(timeoutMs / 60000);
        addLog(session, `review timed out after ${mins} minutes, auto-approving`, "warn");
        resolve({ action: "approve" });
      }
    }, timeoutMs);
    session._reviewResolve = (decision) => {
      clearTimeout(session._reviewTimer);
      session._reviewTimer = null;
      resolve(decision);
    };
  });
}

// ── Release ──

async function performRelease(session) {
  session.status = "releasing";
  addLog(session, "performing release");

  const completedItems = session.roadmap.filter((item) => item.status === "done" && !isItemReleased(session, item));
  const taskIds = completedItems.map((item) => item.taskId).filter(Boolean);
  const itemTitles = completedItems.map((item) => item.title);

  if (completedItems.length === 0) {
    addLog(session, "no completed items, skipping release", "warn");
    return;
  }

  const hasFeature = completedItems.some((item) => item.type === "feature");
  const lastVersion = session.releases.length > 0
    ? session.releases[session.releases.length - 1].version
    : "0.0.0";
  const version = bumpVersion(lastVersion, hasFeature ? "minor" : "patch");

  deps.broadcastWs("autopilot:releasing", { sessionId: session.id, version });

  const completedList = completedItems.map((item) => `- [${item.type}] ${item.title}`).join("\n");

  let tag = `v${version}`;
  try {
    tag = tagStableVersion(`v${version}`, session.project);
    addLog(session, `tagged stable: ${tag}`);
  } catch (e) {
    addLog(session, `stable tag failed: ${e.message}`, "warn");
  }

  const changelog = `## ${version}\n\n${completedList}`;
  const releaseNotes = `Release ${version}`;

  const release = {
    version,
    changelog,
    releaseNotes,
    taskIds,
    itemTitles,
    timestamp: new Date().toISOString(),
    tag,
  };

  session.releases.push(release);
  session.stats.totalReleases++;

  deps.broadcastWs("autopilot:released", {
    sessionId: session.id,
    version,
    changelog,
    releaseNotes,
    tag,
  });
  addLog(session, `released ${version} (${completedItems.length} items)`);

  // LLM documentation update
  try {
    let releaseTemplate;
    try {
      releaseTemplate = await loadTemplate("autopilot-release");
    } catch {
      releaseTemplate = await readFile(path.join(TEMPLATES_DIR, "ucm-autopilot-release.md"), "utf-8");
    }

    let projectContextSection = session.projectContext || "(not available)";
    try {
      const contextResult = await generateProjectContext(session.project);
      projectContextSection = formatProjectContext(contextResult);
    } catch {}

    const previousVersion = session.releases.length > 1
      ? session.releases[session.releases.length - 2].version
      : "0.0.0";

    const releasePrompt = releaseTemplate
      .replace(/\{\{PROJECT\}\}/g, session.project)
      .replace(/\{\{PROJECT_NAME\}\}/g, session.projectName)
      .replace(/\{\{VERSION\}\}/g, version)
      .replace(/\{\{PREVIOUS_VERSION\}\}/g, previousVersion)
      .replace(/\{\{ITERATION\}\}/g, String(session.iteration))
      .replace(/\{\{COMPLETED_ITEMS\}\}/g, completedList)
      .replace(/\{\{PROJECT_CONTEXT\}\}/g, projectContextSection);

    const config = deps.config();
    await deps.spawnAgent(releasePrompt, {
      cwd: session.project,
      provider: config.provider || DEFAULT_CONFIG.provider,
      model: config.model || DEFAULT_CONFIG.model,
      timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
      taskId: `_autopilot_release_${session.id}`,
      stage: "release-docs",
    });
    addLog(session, "documentation updated by release agent");
  } catch (e) {
    addLog(session, `release doc update failed: ${e.message}`, "warn");
  }
}

function parseReleaseOutput(stdout) {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

function bumpVersion(version, type) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3) return "0.1.0";

  if (type === "major") return `${parts[0] + 1}.0.0`;
  if (type === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

// ── Main Loop ──

async function runAutopilotLoop(session) {
  try {
    await prepareSession(session);

    while (session.status !== "stopped") {
      if (session.totalItemsProcessed >= session.maxItems) {
        addLog(session, `reached max items limit (${session.maxItems}), completed`);
        session.status = "completed";
        break;
      }

      if (session.status === "paused") {
        const shouldContinue = await waitIfPaused(session);
        if (!shouldContinue) break;
      }

      const daemonOk = await waitIfDaemonPaused(session);
      if (!daemonOk) break;

      await planRoadmap(session);

      const config = deps.config();
      const apConfig = config.autopilot || DEFAULT_CONFIG.autopilot;

      for (let i = 0; i < session.roadmap.length; i++) {
        session.currentItem = i;
        const item = session.roadmap[i];

        if (item.status !== "pending") continue;
        if (session.status === "stopped") break;

        if (session.status === "paused") {
          const shouldContinue = await waitIfPaused(session);
          if (!shouldContinue) break;
        }

        const daemonOk2 = await waitIfDaemonPaused(session);
        if (!daemonOk2) break;

        const itemResult = await executeItem(session, item);
        session.totalItemsProcessed++;

        if (itemResult === "stopped") break;

        if (itemResult === "done") {
          item.status = "done";
          session.stats.completedItems++;
          session.consecutiveFailures = 0;
        } else {
          item.status = "failed";
          session.stats.failedItems++;
          session.consecutiveFailures++;
          addLog(session, `item failed: ${item.title}`, "error");
        }

        // Consecutive failures guard
        if (session.consecutiveFailures >= apConfig.maxConsecutiveFailures) {
          addLog(session, `${session.consecutiveFailures} consecutive failures, auto-pausing`, "error");
          session.status = "paused";
          session.pausedAt = new Date().toISOString();
          session.pausedPhase = "executing";
          deps.broadcastWs("autopilot:paused", {
            sessionId: session.id,
            reason: "consecutive_failures",
            phase: "executing",
          });
          const shouldContinue = await waitIfPaused(session);
          if (!shouldContinue) break;
          session.consecutiveFailures = 0;
        }

        deps.broadcastWs("autopilot:progress", {
          sessionId: session.id,
          stats: { ...session.stats },
        });

        const unreleasedCount = session.roadmap.filter((it) => it.status === "done" && !isItemReleased(session, it)).length;
        if (unreleasedCount >= apConfig.releaseEvery) {
          if (session.status !== "stopped" && session.status !== "paused") {
            await performRelease(session);
          }
        }
      }

      if (session.status === "stopped") break;

      const unreleased = session.roadmap.filter((item) => item.status === "done" && !isItemReleased(session, item));
      if (unreleased.length > 0 && session.status !== "stopped" && session.status !== "paused") {
        await performRelease(session);
      }

      if (session.totalItemsProcessed >= session.maxItems) {
        addLog(session, `reached max items limit (${session.maxItems}), completed`);
        session.status = "completed";
        break;
      }

      // Regenerate project context after iteration
      try {
        const contextResult = await generateProjectContext(session.project);
        session.projectContext = formatProjectContext(contextResult);
        addLog(session, "project context regenerated");
      } catch (e) {
        addLog(session, `project context regeneration failed: ${e.message}`, "warn");
      }

      // Trigger observer
      try {
        const { runObserver } = require("./ucmd-observer");
        addLog(session, "triggering observer after iteration");
        await runObserver();
      } catch (e) {
        addLog(session, `observer trigger failed: ${e.message}`, "warn");
      }

      // Trigger post-release research (every N releases)
      const observerConfig = config?.observer || DEFAULT_CONFIG.observer;
      if (observerConfig.researchEnabled &&
          session.stats.totalReleases > 0 &&
          session.stats.totalReleases % (observerConfig.researchAfterReleases || 2) === 0) {
        try {
          const { runResearch } = require("./ucmd-observer");
          addLog(session, "triggering post-release research");
          await runResearch(session.project, session.projectName);
        } catch (e) {
          addLog(session, `research failed: ${e.message}`, "warn");
        }
      }

      deps.broadcastWs("autopilot:replan", {
        sessionId: session.id,
        reason: "iteration_complete",
        iteration: session.iteration,
      });
      addLog(session, `iteration ${session.iteration} complete, re-planning`);
    }
  } catch (e) {
    addLog(session, `loop error: ${e.message}`, "error");
    deps.broadcastWs("autopilot:error", {
      sessionId: session.id,
      error: e.message,
    });
  } finally {
    if (session.status !== "stopped") {
      const wasCompleted = session.status === "completed";
      session.status = "stopped";
      projectSessionMap.delete(session.project);
      deps.broadcastWs("autopilot:stopped", { sessionId: session.id });
      addLog(session, wasCompleted ? "autopilot completed all items" : "autopilot loop ended");
    }
    // Keep session file for completed/stopped; cleanup after 10 minutes
    debouncedSave(session);
    setTimeout(() => {
      sessions.delete(session.id);
      deleteSessionFile(session.id);
    }, 10 * 60 * 1000);
  }
}

function isItemReleased(session, item) {
  return session.releases.some((r) =>
    (item.taskId && r.taskIds.includes(item.taskId)) ||
    (r.itemTitles && r.itemTitles.includes(item.title))
  );
}

// ── Handlers ──

async function handleAutopilotStart(params = {}) {
  const { project, pipeline, maxItems } = params;
  if (!project) throw new Error("project path is required");

  const resolved = path.resolve(expandHome(project));
  if (!isGitRepo(resolved)) {
    throw new Error("autopilot은 git 저장소에서만 사용할 수 있습니다. 먼저 git init을 실행하세요.");
  }

  const session = createSession(project, { pipeline, maxItems });

  deps.broadcastWs("autopilot:started", {
    sessionId: session.id,
    project: session.project,
    projectName: session.projectName,
  });
  addLog(session, `started for project: ${session.projectName}`);

  runAutopilotLoop(session).catch((e) => {
    log(`[autopilot:${session.id}] fatal loop error: ${e.message}`);
  });

  return {
    sessionId: session.id,
    project: session.project,
    projectName: session.projectName,
    status: session.status,
  };
}

function handleAutopilotPause(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status === "stopped") throw new Error("session already stopped");
  if (session.status === "paused") throw new Error("session already paused");

  session.pausedPhase = session.status;
  session.status = "paused";
  session.pausedAt = new Date().toISOString();

  if (session._reviewTimer) {
    clearTimeout(session._reviewTimer);
    session._reviewTimer = null;
  }

  deps.broadcastWs("autopilot:paused", {
    sessionId: session.id,
    reason: "user",
    phase: session.pausedPhase,
  });
  addLog(session, `paused (was: ${session.pausedPhase})`);

  return { sessionId: session.id, status: "paused", pausedPhase: session.pausedPhase };
}

function handleAutopilotResume(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== "paused") throw new Error("session is not paused");

  const previousPhase = session.pausedPhase || "running";
  session.status = previousPhase;
  session.pausedAt = null;
  session.pausedPhase = null;

  deps.broadcastWs("autopilot:resumed", {
    sessionId: session.id,
    phase: previousPhase,
  });
  addLog(session, `resumed (phase: ${previousPhase})`);

  return { sessionId: session.id, status: session.status };
}

function handleAutopilotStop(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status === "stopped") throw new Error("session already stopped");

  session.status = "stopped";
  projectSessionMap.delete(session.project);

  if (session._reviewResolve) {
    session._reviewResolve({ action: "reject" });
    session._reviewResolve = null;
  }
  if (session._reviewTimer) {
    clearTimeout(session._reviewTimer);
    session._reviewTimer = null;
  }

  deps.broadcastWs("autopilot:stopped", { sessionId: session.id });
  addLog(session, "stopped by user");

  setTimeout(() => {
    sessions.delete(sessionId);
    deleteSessionFile(sessionId);
  }, 10 * 60 * 1000);

  return { sessionId: session.id, status: "stopped" };
}

function handleAutopilotStatus() {
  const result = [];
  for (const [id, session] of sessions) {
    result.push({
      id: session.id,
      status: session.status,
      project: session.project,
      projectName: session.projectName,
      iteration: session.iteration,
      stats: { ...session.stats },
      currentItem: session.currentItem,
      currentTaskId: session.currentTaskId,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      totalItemsProcessed: session.totalItemsProcessed,
      maxItems: session.maxItems,
      releasesCount: session.releases.length,
      pendingDirectives: (session.directives || []).filter(d => d.status === "pending").length,
    });
  }
  return result;
}

function handleAutopilotSession(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  return {
    id: session.id,
    status: session.status,
    pausedPhase: session.pausedPhase,
    project: session.project,
    projectName: session.projectName,
    pipeline: session.pipeline,
    roadmap: session.roadmap,
    currentItem: session.currentItem,
    currentTaskId: session.currentTaskId,
    iteration: session.iteration,
    releases: session.releases,
    stats: { ...session.stats },
    consecutiveFailures: session.consecutiveFailures,
    totalItemsProcessed: session.totalItemsProcessed,
    maxItems: session.maxItems,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    log: session.log.slice(-100),
    stableTag: session.stableTag,
    currentItemIteration: session.currentItemIteration,
    currentTestResults: session.currentTestResults,
    currentItemLog: session.currentItemLog,
    directives: session.directives || [],
    projectContext: session.projectContext || null,
  };
}

// ── Human Review Handlers ──

function handleAutopilotApproveItem(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== "awaiting_review") throw new Error(`not awaiting review: ${session.status}`);
  if (!session._reviewResolve) throw new Error("no pending review");

  session._reviewResolve({ action: "approve" });
  session._reviewResolve = null;
  addLog(session, "item approved by user");
  return { sessionId: session.id, action: "approved" };
}

function handleAutopilotRejectItem(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== "awaiting_review") throw new Error(`not awaiting review: ${session.status}`);
  if (!session._reviewResolve) throw new Error("no pending review");

  session._reviewResolve({ action: "reject" });
  session._reviewResolve = null;
  addLog(session, "item rejected by user");
  return { sessionId: session.id, action: "rejected" };
}

function handleAutopilotFeedbackItem(params = {}) {
  const { sessionId, feedback } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (!feedback) throw new Error("feedback text required");

  if (session.status === "awaiting_review" && session._reviewResolve) {
    session._reviewResolve({ action: "feedback", feedback });
    session._reviewResolve = null;
  }
  addLog(session, `feedback: ${feedback.slice(0, 100)}`);
  return { sessionId: session.id, action: "feedback" };
}

function handleAutopilotReleases(params = {}) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  return {
    sessionId: session.id,
    releases: session.releases,
    stableTags: listStableTags(session.project),
  };
}

// ── Human Directive Handlers ──

function handleAutopilotDirectiveAdd(params = {}) {
  const { sessionId, text } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status === "stopped") throw new Error("session is stopped");
  if (!text || !text.trim()) throw new Error("directive text is required");

  const directive = {
    id: generateDirectiveId(),
    text: text.trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "pending",
    consumedInIteration: null,
  };

  if (!session.directives) session.directives = [];
  session.directives.push(directive);
  debouncedSave(session);

  deps.broadcastWs("autopilot:directive_added", {
    sessionId: session.id,
    directive,
  });
  addLog(session, `directive added: ${text.trim().slice(0, 80)}`);

  return { sessionId: session.id, directive };
}

function handleAutopilotDirectiveEdit(params = {}) {
  const { sessionId, directiveId, text } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (!text || !text.trim()) throw new Error("directive text is required");

  const directive = (session.directives || []).find(d => d.id === directiveId);
  if (!directive) throw new Error(`directive not found: ${directiveId}`);
  if (directive.status === "consumed") throw new Error("cannot edit consumed directive");

  directive.text = text.trim();
  directive.updatedAt = new Date().toISOString();
  debouncedSave(session);

  deps.broadcastWs("autopilot:directive_updated", {
    sessionId: session.id,
    directive,
  });

  return { sessionId: session.id, directive };
}

function handleAutopilotDirectiveDelete(params = {}) {
  const { sessionId, directiveId } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const index = (session.directives || []).findIndex(d => d.id === directiveId);
  if (index === -1) throw new Error(`directive not found: ${directiveId}`);
  if (session.directives[index].status === "consumed") throw new Error("cannot delete consumed directive");

  session.directives.splice(index, 1);
  debouncedSave(session);

  deps.broadcastWs("autopilot:directive_deleted", {
    sessionId: session.id,
    directiveId,
  });

  return { sessionId: session.id, directiveId };
}

function handleAutopilotDirectiveList(params = {}) {
  const { sessionId, status } = params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  let directives = session.directives || [];
  if (status) {
    directives = directives.filter(d => d.status === status);
  }

  return { sessionId: session.id, directives };
}

// ── Exports ──

module.exports = {
  setDeps,
  setLog,
  sessions,
  projectSessionMap,
  handleAutopilotStart,
  handleAutopilotPause,
  handleAutopilotResume,
  handleAutopilotStop,
  handleAutopilotStatus,
  handleAutopilotSession,
  handleAutopilotApproveItem,
  handleAutopilotRejectItem,
  handleAutopilotFeedbackItem,
  handleAutopilotReleases,
  handleAutopilotDirectiveAdd,
  handleAutopilotDirectiveEdit,
  handleAutopilotDirectiveDelete,
  handleAutopilotDirectiveList,
  recoverSessions,
  // Exposed for testing
  createSession,
  generateSessionId,
  generateDirectiveId,
  parseRoadmapOutput,
  bumpVersion,
  saveSession,
  loadSession,
  deleteSessionFile,
};
