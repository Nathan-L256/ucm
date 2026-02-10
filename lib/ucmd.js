#!/usr/bin/env node
const { spawn, execFileSync } = require("child_process");
const {
  readFile, writeFile, mkdir, access, readdir, unlink, rename, stat, rm,
} = require("fs/promises");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");

const ucmdConstants = require("./ucmd-constants.js");
const ucmdTask = require("./ucmd-task.js");
const ucmdPipeline = require("./ucmd-pipeline.js");
const ucmdWorktree = require("./ucmd-worktree.js");
const ucmdProposal = require("./ucmd-proposal.js");
const ucmdPrompt = require("./ucmd-prompt.js");
const ucmdObserver = require("./ucmd-observer.js");
const ucmdStructure = require("./ucmd-structure.js");
const ucmdAgent = require("./ucmd-agent.js");
const ucmdRefinement = require("./ucmd-refinement.js");
const ucmdHandlers = require("./ucmd-handlers.js");
const ucmdServer = require("./ucmd-server.js");

const { analyzeChangedFiles, getChangedFiles, analyzeDocCoverage } = ucmdStructure;

const {
  UCM_DIR, TASKS_DIR, WORKTREES_DIR, WORKSPACES_DIR, ARTIFACTS_DIR, LOGS_DIR, DAEMON_DIR,
  LESSONS_DIR, PROPOSALS_DIR, SNAPSHOTS_DIR, CONFIG_PATH,
  SOCK_PATH, PID_PATH, LOG_PATH, STATE_PATH,
  TASK_STATES, META_KEYS,
  STATE_DEBOUNCE_MS, MAX_LOG_BYTES, MAX_SOCKET_REQUEST_BYTES,
  SOCKET_READY_TIMEOUT_MS, SOCKET_POLL_INTERVAL_MS, CLIENT_TIMEOUT_MS, SHUTDOWN_WAIT_MS,
  QUOTA_PROBE_INITIAL_MS, QUOTA_PROBE_MAX_MS,
  TEMPLATES_DIR, USAGE,
  GATE_STEPS, PROPOSAL_STATUSES, VALID_CATEGORIES, VALID_RISKS,
  DATA_VERSION, SOURCE_ROOT,
  DEFAULT_CONFIG,
  MAX_SNAPSHOTS, RATE_LIMIT_RE,
} = ucmdConstants;

const {
  parseArgs, ensureDirectories,
  parseTaskFile, serializeTaskFile, extractMeta, generateTaskId,
  expandHome, normalizeProjects,
  git, isGitRepo, validateGitProjects,
  readPid, isProcessAlive, cleanStaleFiles,
  defaultState,
  checkResources,
} = ucmdTask;

const {
  resolvePipeline, normalizeStep, findResumeStepIndex,
  parseGateResult, extractCriticalIssues, isGateStep,
  buildStageResultsSummary, resolveMaxIterations,
} = ucmdPipeline;

const {
  createWorktrees, loadWorkspace, mergeWorktrees, removeWorktrees,
  getWorktreeDiff, getWorktreeDiffStat,
  loadWorkspaceSync, getWorktreeCwd,
  initArtifacts, saveArtifact, loadArtifact, updateMemory,
} = ucmdWorktree;

const {
  generateProposalId, computeDedupHash, serializeProposal, parseProposalFile,
  saveProposal, loadProposal, moveProposal, listProposals,
  saveSnapshot, loadLatestSnapshot, loadAllSnapshots, cleanupOldSnapshots,
  compareSnapshots, findProposalByTaskId,
} = ucmdProposal;

const { loadTemplate, buildStagePrompt } = ucmdPrompt;

const {
  getExistingDedupHashes, collectObservationData, captureMetricsSnapshot,
  runObserver, parseObserverOutput, promoteProposal,
  handleObserve, handleObserveStatus, handleProposals,
  handleProposalApprove, handleProposalReject, handleProposalPriority,
  handleProposalEvaluate, handleSnapshots,
  maybeRunObserver, cleanupOldProposals, evaluateProposal,
} = ucmdObserver;

const { buildCommand, spawnAgent } = ucmdAgent;

const {
  resolveRefinementAnswer, startRefinement,
  handleRefinementAnswer, switchToAutopilot,
  finalizeRefinement, cancelRefinement,
} = ucmdRefinement;

const {
  submitTask, moveTask, scanPendingTasks, loadTask, recoverRunningTasks,
  handleSubmit, handleList, handleStatus,
  handleApprove, handleReject, handleCancel,
  handleRetry, handleDelete, handleDiff, handleLogs,
  handlePause, handleResume, handleStats,
} = ucmdHandlers;

const { broadcastWs, startSocketServer, socketSubscribers } = ucmdServer;

// ── Config ──

let config = null;

async function loadConfig() {
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {
    config = { ...DEFAULT_CONFIG };
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  }
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (config[key] === undefined) config[key] = value;
  }
  return config;
}


async function createTempWorkspace(taskId) {
  const workspacePath = path.join(WORKSPACES_DIR, taskId);
  await mkdir(workspacePath, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspacePath, stdio: "pipe" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init workspace"], { cwd: workspacePath, stdio: "pipe" });
  return workspacePath;
}

async function updateTaskProject(taskId, projectPath) {
  for (const state of TASK_STATES) {
    const taskPath = path.join(TASKS_DIR, state, `${taskId}.md`);
    try {
      const content = await readFile(taskPath, "utf-8");
      const { meta, body } = parseTaskFile(content);
      meta.project = projectPath;
      await writeFile(taskPath, serializeTaskFile(meta, body));
      return;
    } catch {}
  }
}


// ── Logging ──

let logStream = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (logStream) {
    logStream.write(line);
  } else {
    process.stderr.write(line);
  }
}

ucmdWorktree.setLog(log);
ucmdProposal.setLog(log);
ucmdObserver.setLog(log);

async function truncateLogIfNeeded() {
  try {
    const stats = await stat(LOG_PATH);
    if (stats.size > MAX_LOG_BYTES) {
      const content = await readFile(LOG_PATH, "utf-8");
      const allLines = content.split("\n");
      const keepLines = allLines.slice(Math.floor(allLines.length / 2));
      await writeFile(LOG_PATH, keepLines.join("\n"));
    }
  } catch {}
}

// ── Daemon State ──

let daemonState = null;
let stateDirty = false;
let stateTimer = null;


async function loadState() {
  try {
    daemonState = JSON.parse(await readFile(STATE_PATH, "utf-8"));
    daemonState.stats = defaultState().stats;
    if (!daemonState.activeTasks) daemonState.activeTasks = [];
    if (!daemonState.suspendedTasks) daemonState.suspendedTasks = [];
    if (!daemonState.daemonStatus) daemonState.daemonStatus = "running";
  } catch {
    daemonState = defaultState();
  }

  const stateVersion = daemonState.dataVersion || 0;
  if (stateVersion < DATA_VERSION) {
    log(`migrating state: v${stateVersion} → v${DATA_VERSION}`);
    if (stateVersion < 1) {
      delete daemonState.restartPending;
    }
    daemonState.dataVersion = DATA_VERSION;
    await flushState();
  }
}

async function flushState() {
  if (!daemonState) return;
  const tmpPath = STATE_PATH + ".tmp";
  await writeFile(tmpPath, JSON.stringify(daemonState, null, 2));
  await rename(tmpPath, STATE_PATH);
  stateDirty = false;
}

function markStateDirty() {
  stateDirty = true;
  if (!stateTimer) {
    stateTimer = setTimeout(async () => {
      stateTimer = null;
      if (stateDirty) {
        try { await flushState(); } catch (e) { log(`state flush error: ${e.message}`); }
      }
    }, STATE_DEBOUNCE_MS);
  }
}




function getResourcePressure(resources) {
  const rc = config?.resources || DEFAULT_CONFIG.resources;
  if (resources.diskFreeGb !== null && resources.diskFreeGb < rc.diskMinFreeGb) return "critical";
  if (resources.cpuLoad > rc.cpuThreshold) return "pressure";
  if (resources.memoryFreeMb < rc.memoryMinFreeMb) return "pressure";
  return "normal";
}

// ── Cleanup ──

async function findOrphanWorktrees() {
  const orphans = [];
  try {
    const entries = await readdir(WORKTREES_DIR);
    for (const entry of entries) {
      const found = await loadTask(entry);
      if (!found) orphans.push(entry);
    }
  } catch {}
  return orphans;
}

async function performCleanup(options = {}) {
  const retentionDays = options.retentionDays ?? (config?.cleanup || DEFAULT_CONFIG.cleanup).retentionDays;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const state of ["done", "failed"]) {
    const stateDir = path.join(TASKS_DIR, state);
    let files;
    try { files = await readdir(stateDir); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const taskId = file.replace(".md", "");
      try {
        const content = await readFile(path.join(stateDir, file), "utf-8");
        const { meta } = parseTaskFile(content);
        const completed = meta.completedAt ? new Date(meta.completedAt).getTime() : 0;
        if (completed && completed < cutoff) {
          const projects = normalizeProjects(meta);
          await removeWorktrees(taskId, projects);
          try { await rm(path.join(ARTIFACTS_DIR, taskId), { recursive: true }); } catch {}
          try { await unlink(path.join(LOGS_DIR, `${taskId}.log`)); } catch {}
          try { await rm(path.join(WORKSPACES_DIR, taskId), { recursive: true }); } catch {}
          cleaned++;
          log(`cleaned up task: ${taskId}`);
        }
      } catch (e) {
        log(`cleanup error for ${taskId}: ${e.message}`);
      }
    }
  }

  // orphan worktrees
  const orphans = await findOrphanWorktrees();
  for (const orphanId of orphans) {
    try {
      await rm(path.join(WORKTREES_DIR, orphanId), { recursive: true });
      cleaned++;
      log(`removed orphan worktree: ${orphanId}`);
    } catch {}
  }

  return { cleaned, orphans: orphans.length };
}


// ── Infra Queue ──

const infraQueue = [];
const infraActive = new Set();

function acquireInfraLock(taskId) {
  const infraConfig = config?.infra || DEFAULT_CONFIG.infra;
  const maxSlots = infraConfig.slots || 1;
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (infraActive.size < maxSlots) {
        infraActive.add(taskId);
        resolve();
      } else {
        infraQueue.push({ taskId, resolve: tryAcquire });
      }
    };
    tryAcquire();
  });
}

function releaseInfraLock(taskId) {
  infraActive.delete(taskId);
  // try to wake next in queue
  if (infraQueue.length > 0) {
    const next = infraQueue.shift();
    next.resolve();
  }
}

function dockerComposeUp(projectPath) {
  const infraConfig = config?.infra || DEFAULT_CONFIG.infra;
  const composeFile = infraConfig.composeFile || "docker-compose.test.yml";
  const composePath = path.join(projectPath, composeFile);

  try {
    fs.accessSync(composePath);
  } catch {
    return false; // no compose file, skip
  }

  try {
    execFileSync("docker", ["compose", "-f", composePath, "up", "-d"], {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: infraConfig.upTimeoutMs || 60000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    log(`docker compose up: ${composePath}`);
    return true;
  } catch (e) {
    log(`docker compose up failed: ${e.message}`);
    return false;
  }
}

function dockerComposeDown(projectPath) {
  const infraConfig = config?.infra || DEFAULT_CONFIG.infra;
  const composeFile = infraConfig.composeFile || "docker-compose.test.yml";
  const composePath = path.join(projectPath, composeFile);

  try {
    execFileSync("docker", ["compose", "-f", composePath, "down"], {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    log(`docker compose down: ${composePath}`);
  } catch (e) {
    log(`docker compose down failed: ${e.message}`);
  }
}

async function loadProjectPreferences(projectPath) {
  try {
    const ucmConfig = JSON.parse(await readFile(path.join(projectPath, ".ucm.json"), "utf-8"));
    const prefs = ucmConfig.preferences;
    if (!prefs) return "";
    if (Array.isArray(prefs)) return prefs.map((p) => `- ${p}`).join("\n");
    return String(prefs);
  } catch {
    return "";
  }
}

// ── Dev Environment (for visual-check) ──

const activeDevEnvironments = new Map();

async function startDevEnvironment(projectPath, taskId) {
  // read .ucm.json or config for devCommand and devPort
  let devCommand = "npm run dev";
  let devPort = 3000;

  try {
    const ucmConfig = JSON.parse(await readFile(path.join(projectPath, ".ucm.json"), "utf-8"));
    if (ucmConfig.devCommand) devCommand = ucmConfig.devCommand;
    if (ucmConfig.devPort) devPort = ucmConfig.devPort;
  } catch {
    // try package.json scripts
    try {
      const pkg = JSON.parse(await readFile(path.join(projectPath, "package.json"), "utf-8"));
      if (pkg.scripts?.dev) devCommand = "npm run dev";
      else if (pkg.scripts?.start) devCommand = "npm start";
    } catch {}
  }

  const [cmd, ...args] = devCommand.split(" ");
  const child = spawn(cmd, args, {
    cwd: projectPath,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(devPort) },
    detached: true,
  });
  child.unref();

  activeDevEnvironments.set(taskId, { child, port: devPort, projectPath });
  log(`[${taskId}] dev server started: ${devCommand} (port ${devPort})`);

  // wait for server to be ready (poll)
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${devPort}`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      log(`[${taskId}] dev server ready on port ${devPort}`);
      return { port: devPort, url: `http://localhost:${devPort}` };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  log(`[${taskId}] dev server did not become ready`);
  return { port: devPort, url: `http://localhost:${devPort}` };
}

function stopDevEnvironment(taskId) {
  const env = activeDevEnvironments.get(taskId);
  if (!env) return;
  try {
    process.kill(-env.child.pid, "SIGTERM");
  } catch {
    try { env.child.kill("SIGTERM"); } catch {}
  }
  activeDevEnvironments.delete(taskId);
  log(`[${taskId}] dev server stopped`);
}

// ── Pipeline Engine ──

const inflightTasks = new Set();
const activeChildren = new Map(); // taskId → child process

async function executeStageStep(stage, pipelineContext) {
  const { taskId, task, stageResults, cwd, workspaceInfo, config: cfg } = pipelineContext;

  // quota pre-check
  const quota = checkQuotaViaCcusage();
  if (quota && quota.hardLimitExceeded) {
    log(`[${taskId}] hard quota limit exceeded (${quota.usagePercent}%) — pausing at stage: ${stage}`);
    return { action: "abort_rate_limited" };
  }
  if (quota && quota.softLimitExceeded) {
    log(`[${taskId}] soft quota limit exceeded (${quota.usagePercent}%) — no new tasks after this`);
  }

  log(`[${taskId}] starting stage: ${stage}`);
  broadcastWs("task:updated", { taskId, stage, status: "running" });

  // infra lifecycle: acquire lock + docker compose up for test stages
  let infraAcquired = false;
  if (stage === "test") {
    await acquireInfraLock(taskId);
    infraAcquired = true;
    dockerComposeUp(cwd);
  }

  // dev environment lifecycle: start dev server for visual-check
  let devEnv = null;
  if (stage === "visual-check") {
    try {
      devEnv = await startDevEnvironment(cwd, taskId);
    } catch (e) {
      log(`[${taskId}] failed to start dev environment: ${e.message}`);
    }
  }

  try {
    let structureMetrics = "";
    let docCoverage = "";
    if (stage === "self-review") {
      try {
        const workspace = loadWorkspaceSync(taskId);
        const wsProjects = workspace?.projects || [];
        const structureParts = [];
        const docParts = [];
        for (const project of wsProjects) {
          const analysis = await analyzeChangedFiles(project.path, project.baseCommit);
          if (analysis.files.length > 0) {
            structureParts.push(wsProjects.length > 1
              ? `### ${project.name}\n\n${analysis.summary}`
              : analysis.summary);
          }
          const docAnalysis = analyzeDocCoverage(
            getChangedFiles(project.path, project.baseCommit),
          );
          if (docAnalysis.summary) {
            docParts.push(wsProjects.length > 1
              ? `### ${project.name}\n\n${docAnalysis.summary}`
              : docAnalysis.summary);
          }
        }
        structureMetrics = structureParts.join("\n\n");
        docCoverage = docParts.join("\n\n");
      } catch {}
    }

    const context = {
      title: task.title,
      description: task.body || "",
      workspace: workspaceInfo,
      analyzeResult: stageResults.analyze || "",
      feedback: task.feedback || "",
      spec: stageResults.spec || "",
      testFeedback: stageResults.testFeedback || "",
      gatherResult: stageResults.gatherResult || "",
      lessons: pipelineContext.lessons || "",
      preferences: pipelineContext.preferences || "",
      structureMetrics,
      docCoverage,
    };

    const prompt = await buildStagePrompt(stage, context);

    const result = await spawnAgent(prompt, {
      cwd,
      provider: cfg.provider || DEFAULT_CONFIG.provider,
      model: cfg.model || DEFAULT_CONFIG.model,
      timeoutMs: cfg.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
      taskId,
      stage,
    });

    daemonState.stats.totalSpawns++;
    markStateDirty();

    const iteration = pipelineContext.loopIteration;
    const artifactName = iteration ? `${stage}-${iteration}.md` : `${stage}.md`;
    await saveArtifact(taskId, artifactName, result.stdout || "(no output)");
    await updateMemory(taskId, {
      timelineEntry: {
        stage,
        iteration: iteration || undefined,
        status: result.status,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timestamp: new Date().toISOString(),
      },
    });

    stageResults[stage] = result.stdout || "";

    if (isGateStep(stage)) {
      stageResults[`${stage}:gate`] = parseGateResult(result.stdout) || "unknown";
    }

    if (result.status === "rate_limited") {
      log(`[${taskId}] rate limited at stage: ${stage}`);
      return { action: "abort_rate_limited" };
    }

    if (result.status === "timeout" || result.status === "failed") {
      log(`[${taskId}] ${result.status} at stage: ${stage} (exit=${result.exitCode})`);
      return { action: "abort_failed", stage, result };
    }

    log(`[${taskId}] stage ${stage} completed (${result.durationMs}ms)`);
    broadcastWs("task:updated", { taskId, stage, status: "done" });
    return { action: "continue" };
  } finally {
    // cleanup infra and dev environments (always, even on error)
    if (infraAcquired) {
      const infraConfig = cfg.infra || DEFAULT_CONFIG.infra;
      if (infraConfig.downAfterTest) dockerComposeDown(cwd);
      releaseInfraLock(taskId);
    }
    if (devEnv) stopDevEnvironment(taskId);
  }
}

async function executeLoopStep(normalizedStep, pipelineContext) {
  const { taskId, stageResults } = pipelineContext;
  const maxIter = resolveMaxIterations(normalizedStep.maxIterations, stageResults);
  const loopSteps = normalizedStep.steps;

  // find the last gate step in the loop — only its pass exits the loop
  let lastGateIndex = -1;
  for (let i = loopSteps.length - 1; i >= 0; i--) {
    const n = normalizeStep(loopSteps[i]);
    if (n.stage && isGateStep(n.stage)) { lastGateIndex = i; break; }
  }

  log(`[${taskId}] loop: up to ${maxIter} iterations, ${loopSteps.length} steps`);

  for (let iteration = 1; iteration <= maxIter; iteration++) {
    log(`[${taskId}] loop iteration ${iteration}/${maxIter}`);
    let gateFailed = false;

    for (let si = 0; si < loopSteps.length; si++) {
      const innerNormalized = normalizeStep(loopSteps[si]);
      pipelineContext.loopIteration = iteration;
      const result = await executeStep(innerNormalized, pipelineContext);
      pipelineContext.loopIteration = null;

      if (result.action !== "continue") return result;

      // check gate result for the step we just ran
      const stepStage = innerNormalized.stage;
      if (stepStage && isGateStep(stepStage)) {
        const gateResult = stageResults[`${stepStage}:gate`];
        if (gateResult === "pass" && si === lastGateIndex) {
          // last gate passed — exit loop successfully
          log(`[${taskId}] loop: all gates passed at iteration ${iteration}`);
          return { action: "continue" };
        }
        if (gateResult === "fail") {
          log(`[${taskId}] loop gate failed at iteration ${iteration}: ${stepStage}`);
          // inject feedback for next iteration (stage-specific key)
          const feedbackKey = stepStage === "test" ? "testFeedback" : "testFeedback";
          const stageOutput = stageResults[stepStage] || "(no output)";
          const critical = extractCriticalIssues(stageOutput);
          stageResults[feedbackKey] = `\n## ${stepStage} Failure (iteration ${iteration})\n\n${critical || stageOutput}`;
          gateFailed = true;
          break; // break inner loop, retry from first step
        }
        // gate pass but not last gate — continue to next step in this iteration
      }
    }

    if (!gateFailed) {
      // all steps completed with no gate failure — treat as pass
      return { action: "continue" };
    }
  }

  // maxIterations exceeded with gate still failing
  log(`[${taskId}] loop exhausted ${maxIter} iterations — gate still failing`);
  return { action: "continue" }; // let pipeline proceed to review
}

async function executeRsaStep(normalizedStep, pipelineContext) {
  const { taskId, task, stageResults, cwd, workspaceInfo, config: cfg } = pipelineContext;
  const { stage, count, strategy } = normalizedStep;
  log(`[${taskId}] rsa: ${count} agents, strategy=${strategy}, stage=${stage}`);

  // build the stage prompt once
  const context = {
    title: task.title,
    description: task.body || "",
    workspace: workspaceInfo,
    analyzeResult: stageResults.analyze || "",
    feedback: task.feedback || "",
    spec: stageResults.spec || "",
    testFeedback: stageResults.testFeedback || "",
    gatherResult: stageResults.gatherResult || "",
    lessons: pipelineContext.lessons || "",
    preferences: pipelineContext.preferences || "",
  };
  let prompt;
  try {
    prompt = await buildStagePrompt(stage, context);
  } catch {
    // no template for this stage — build a generic prompt
    log(`[${taskId}] rsa: no template for stage "${stage}", using generic prompt`);
    prompt = [
      `You are a senior software engineer working on the following task.`,
      ``,
      `## Task: ${context.title}`,
      ``,
      context.description,
      ``,
      `## Workspace`,
      ``,
      context.workspace,
      context.analyzeResult ? `\n## Previous Analysis\n\n${context.analyzeResult}` : "",
    ].filter(Boolean).join("\n");
  }

  // spawn N agents in parallel
  const agentPromises = [];
  for (let i = 0; i < count; i++) {
    agentPromises.push(
      spawnAgent(prompt, {
        cwd,
        provider: cfg.provider || DEFAULT_CONFIG.provider,
        model: cfg.model || DEFAULT_CONFIG.model,
        timeoutMs: cfg.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
        taskId,
        stage: `${stage}-rsa-agent-${i + 1}`,
      }),
    );
  }
  const results = await Promise.all(agentPromises);
  daemonState.stats.totalSpawns += count;
  markStateDirty();

  // save individual agent outputs
  const agentOutputs = [];
  for (let i = 0; i < results.length; i++) {
    const output = results[i].stdout || "(no output)";
    await saveArtifact(taskId, `${stage}-rsa-agent-${i + 1}.md`, output);
    agentOutputs.push(output);

    await updateMemory(taskId, {
      timelineEntry: {
        stage: `${stage}-rsa-agent-${i + 1}`,
        status: results[i].status,
        durationMs: results[i].durationMs,
        exitCode: results[i].exitCode,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // check for failures — if all agents failed, abort
  const successCount = results.filter((r) => r.status === "done").length;
  if (successCount === 0) {
    log(`[${taskId}] rsa: all ${count} agents failed`);
    return { action: "abort_failed", stage, result: results[0] };
  }

  // check for rate limiting
  if (results.some((r) => r.status === "rate_limited")) {
    log(`[${taskId}] rsa: rate limited`);
    return { action: "abort_rate_limited" };
  }

  // aggregate: build prompt with all agent results
  const agentResultsText = agentOutputs
    .map((output, i) => `## Agent ${i + 1}\n\n${output}`)
    .join("\n\n---\n\n");

  const templateName = strategy === "diverge" ? "rsa-diverge" : "rsa-converge";
  let aggregateTemplate;
  try {
    aggregateTemplate = await loadTemplate(templateName);
  } catch {
    aggregateTemplate = await loadTemplate("rsa-converge");
  }
  aggregateTemplate = aggregateTemplate.split("{{TASK_TITLE}}").join(task.title || "");
  aggregateTemplate = aggregateTemplate.split("{{AGENT_RESULTS}}").join(agentResultsText);

  const aggregateResult = await spawnAgent(aggregateTemplate, {
    cwd,
    provider: cfg.provider || DEFAULT_CONFIG.provider,
    model: cfg.model || DEFAULT_CONFIG.model,
    timeoutMs: cfg.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
    taskId,
    stage: `${stage}-rsa-aggregate`,
  });
  daemonState.stats.totalSpawns++;
  markStateDirty();

  const aggregatedOutput = aggregateResult.stdout || "(no output)";
  await saveArtifact(taskId, `${stage}-rsa-aggregate.md`, aggregatedOutput);
  await updateMemory(taskId, {
    timelineEntry: {
      stage: `${stage}-rsa-aggregate`,
      status: aggregateResult.status,
      durationMs: aggregateResult.durationMs,
      exitCode: aggregateResult.exitCode,
      timestamp: new Date().toISOString(),
    },
  });

  stageResults[stage] = aggregatedOutput;

  if (aggregateResult.status === "rate_limited") {
    return { action: "abort_rate_limited" };
  }
  if (aggregateResult.status !== "done") {
    // fallback: use the first successful agent output instead
    const firstSuccess = agentOutputs[results.findIndex((r) => r.status === "done")];
    stageResults[stage] = firstSuccess || aggregatedOutput;
    log(`[${taskId}] rsa aggregate failed, using first successful agent output`);
  }

  log(`[${taskId}] rsa completed: ${successCount}/${count} agents succeeded`);
  broadcastWs("task:updated", { taskId, stage, status: "done" });
  return { action: "continue" };
}

async function executeGatherStep(normalizedStep, pipelineContext) {
  const { taskId, task, stageResults } = pipelineContext;

  if (task.refined) {
    log(`[${taskId}] skipping gather — task was pre-refined`);
    const refinedMatch = (task.body || "").match(/## Refined Requirements\n+([\s\S]*)/);
    stageResults.gatherResult = refinedMatch ? refinedMatch[1] : task.body || "";
    return { action: "continue" };
  }

  if (normalizedStep.mode === "interactive") {
    // interactive mode: broadcast question request and wait for answers via WebSocket
    return executeGatherInteractive(normalizedStep, pipelineContext);
  }
  // autonomous mode: run gather as a regular stage
  log(`[${taskId}] gather (autonomous)`);
  const result = await executeStageStep("gather", pipelineContext);
  if (result.action === "continue") {
    stageResults.gatherResult = stageResults.gather || "";
  }
  return result;
}

// gather interactive: pending answer resolvers keyed by taskId
const gatherWaiters = new Map();

function resolveGatherAnswer(taskId, answers) {
  const waiter = gatherWaiters.get(taskId);
  if (waiter) waiter.resolve(answers);
}

// project path: pending answer resolvers keyed by taskId
const projectWaiters = new Map();

function resolveProjectAnswer(taskId, projectPath) {
  const waiter = projectWaiters.get(taskId);
  if (waiter) waiter.resolve(projectPath);
}

function askForProjectPath(taskId) {
  broadcastWs("project:ask", { taskId });
  log(`[${taskId}] asking user for project path`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (projectWaiters.has(taskId)) {
        projectWaiters.delete(taskId);
        resolve(null);
      }
    }, 5 * 60 * 1000);
    projectWaiters.set(taskId, {
      resolve: (value) => {
        clearTimeout(timer);
        if (!value) { resolve(null); return; }
        const resolved = path.resolve(expandHome(value));
        try {
          git(["rev-parse", "--show-toplevel"], resolved);
          resolve(resolved);
        } catch {
          log(`[${taskId}] provided path is not a git repo: ${resolved}`);
          resolve(null);
        }
      },
    });
  }).finally(() => {
    projectWaiters.delete(taskId);
  });
}

async function resolveProjectForTask(taskId, task) {
  const projects = normalizeProjects(task);
  if (projects.length > 0) {
    validateGitProjects(projects);
    return projects;
  }

  // check if pipeline has interactive gather step
  const cfg = config || DEFAULT_CONFIG;
  const { steps } = resolvePipeline(task, cfg);
  const hasInteractive = steps.some((s) =>
    typeof s === "object" && s !== null && s.gather === "interactive"
  );

  let projectPath = null;
  if (hasInteractive) {
    projectPath = await askForProjectPath(taskId);
  }

  if (!projectPath) {
    projectPath = await createTempWorkspace(taskId);
    log(`[${taskId}] using temp workspace: ${projectPath}`);
  } else {
    log(`[${taskId}] user provided project path: ${projectPath}`);
  }

  await updateTaskProject(taskId, projectPath);
  return [{ path: projectPath, name: path.basename(projectPath), role: "primary" }];
}

async function executeGatherInteractive(normalizedStep, pipelineContext) {
  const { taskId, task, stageResults, cwd, workspaceInfo, config: cfg } = pipelineContext;
  log(`[${taskId}] gather (interactive)`);

  const collectedAnswers = [];
  const maxRounds = 5;

  for (let round = 1; round <= maxRounds; round++) {
    // build a prompt that generates questions based on task + previous answers
    const prevQA = collectedAnswers.length > 0
      ? collectedAnswers.map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`).join("\n\n")
      : "(no previous Q&A)";

    const questionPrompt = [
      `You are gathering requirements for the following task.`,
      `Task: ${task.title}`,
      `Description: ${task.body || "(none)"}`,
      `Workspace: ${workspaceInfo}`,
      `Previous Q&A:\n${prevQA}`,
      ``,
      `Generate 1-3 clarifying questions that would help refine the requirements.`,
      `If you have enough information, respond with exactly: GATHER_DONE`,
      `Otherwise output questions as a JSON array of strings, e.g.: ["Question 1?", "Question 2?"]`,
    ].join("\n");

    const questionResult = await spawnAgent(questionPrompt, {
      cwd,
      provider: cfg.provider || DEFAULT_CONFIG.provider,
      model: cfg.model || DEFAULT_CONFIG.model,
      timeoutMs: 120000,
      taskId,
      stage: `gather-questions-${round}`,
    });

    daemonState.stats.totalSpawns++;
    markStateDirty();

    if (questionResult.status !== "done") {
      log(`[${taskId}] gather question generation failed, falling back to autonomous`);
      return executeGatherStep({ ...normalizedStep, mode: "autonomous" }, pipelineContext);
    }

    const stdout = (questionResult.stdout || "").trim();
    if (stdout.includes("GATHER_DONE")) {
      log(`[${taskId}] gather interactive: agent says done after round ${round}`);
      break;
    }

    // parse questions from stdout
    let questions;
    try {
      const jsonMatch = stdout.match(/\[[\s\S]*\]/);
      questions = jsonMatch ? JSON.parse(jsonMatch[0]) : [stdout];
    } catch {
      questions = [stdout];
    }

    // broadcast questions to dashboard
    broadcastWs("gather:question", { taskId, round, questions });
    log(`[${taskId}] gather interactive: sent ${questions.length} questions (round ${round}), waiting for answers`);

    // wait for answers from WebSocket
    const answers = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (gatherWaiters.has(taskId)) {
          gatherWaiters.delete(taskId);
          resolve(null);
        }
      }, 10 * 60 * 1000);
      gatherWaiters.set(taskId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
      });
    });
    gatherWaiters.delete(taskId);

    if (!answers) {
      log(`[${taskId}] gather interactive: timeout waiting for answers, falling back to autonomous`);
      return executeGatherStep({ ...normalizedStep, mode: "autonomous" }, pipelineContext);
    }

    // collect Q&A pairs
    for (let i = 0; i < questions.length; i++) {
      collectedAnswers.push({
        question: questions[i],
        answer: answers[i] || "(no answer)",
      });
    }
  }

  // synthesize gathered requirements from Q&A
  const qaText = collectedAnswers.length > 0
    ? collectedAnswers.map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`).join("\n\n")
    : "(no Q&A collected)";

  const gatherOutput = [
    `# Gathered Requirements`,
    ``,
    `## Task: ${task.title}`,
    ``,
    `## Q&A`,
    ``,
    qaText,
    ``,
    `## Original Description`,
    ``,
    task.body || "(none)",
  ].join("\n");

  await saveArtifact(taskId, "gather.md", gatherOutput);
  stageResults.gather = gatherOutput;
  stageResults.gatherResult = gatherOutput;

  broadcastWs("gather:done", { taskId });
  log(`[${taskId}] gather interactive completed (${collectedAnswers.length} Q&A pairs)`);
  return { action: "continue" };
}

async function executeStep(normalizedStep, pipelineContext) {
  switch (normalizedStep.type) {
    case "stage":
      return executeStageStep(normalizedStep.stage, pipelineContext);
    case "loop":
      return executeLoopStep(normalizedStep, pipelineContext);
    case "rsa":
      return executeRsaStep(normalizedStep, pipelineContext);
    case "gather":
      return executeGatherStep(normalizedStep, pipelineContext);
    default:
      throw new Error(`unknown step type: ${normalizedStep.type}`);
  }
}

async function extractLessons(taskId, task) {
  try {
    const memory = JSON.parse(await loadArtifact(taskId, "memory.json"));
    const hasFailures = memory.timeline.some((e) => e.status === "failed" || e.status === "timeout");
    const hasFeedback = !!task.feedback;
    if (!hasFailures && !hasFeedback) return;

    const summary = await loadArtifact(taskId, "summary.md").catch(() => "");
    const timeline = JSON.stringify(memory.timeline, null, 2);

    let template = await loadTemplate("lessons");
    template = template.split("{{TASK_TITLE}}").join(task.title || "");
    template = template.split("{{TIMELINE}}").join(timeline);
    template = template.split("{{SUMMARY}}").join(summary);

    const projects = normalizeProjects(task);
    const projectName = projects[0]?.name || "global";

    const result = await spawnAgent(template, {
      cwd: os.homedir(),
      provider: config.provider || DEFAULT_CONFIG.provider,
      model: config.model || DEFAULT_CONFIG.model,
      timeoutMs: 120000,
      taskId,
      stage: "lessons",
    });

    if (result.status === "done" && result.stdout) {
      const lessonsDir = path.join(LESSONS_DIR, projectName);
      await mkdir(lessonsDir, { recursive: true });
      const lessonPath = path.join(lessonsDir, `lesson-${taskId}.md`);
      await writeFile(lessonPath, result.stdout);
      log(`[${taskId}] lessons extracted → ${lessonPath}`);
    }
  } catch (e) {
    log(`[${taskId}] lessons extraction failed: ${e.message}`);
  }
}

async function collectRelevantLessons(projectName) {
  const dirs = [path.join(LESSONS_DIR, projectName), path.join(LESSONS_DIR, "global")];
  const files = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(dir, entry);
        const fileStat = await stat(filePath);
        files.push({ path: filePath, mtime: fileStat.mtimeMs });
      }
    } catch {
      // directory may not exist
    }
  }
  if (files.length === 0) return "(no relevant lessons)";

  // sort by mtime descending, take top 10
  files.sort((a, b) => b.mtime - a.mtime);
  const selected = files.slice(0, 10);

  // prioritize severity:high — read first 30 lines of each
  const lessons = [];
  for (const file of selected) {
    try {
      const content = await readFile(file.path, "utf-8");
      const lines = content.split("\n").slice(0, 30);
      const snippet = lines.join("\n");
      const isHigh = /severity:\s*high/i.test(snippet);
      lessons.push({ snippet, isHigh });
    } catch {
      // skip unreadable files
    }
  }

  // high severity first
  lessons.sort((a, b) => (b.isHigh ? 1 : 0) - (a.isHigh ? 1 : 0));
  return lessons.map((l) => l.snippet).join("\n\n---\n\n");
}

async function buildStructuredSummary(taskId, task, pipeline, projects) {
  const lines = [`# ${task.title}`, ""];

  // summary extract from analyze
  try {
    const analyzeOutput = await loadArtifact(taskId, "analyze.md");
    const firstLines = analyzeOutput.split("\n").filter((l) => l.trim()).slice(0, 5).join("\n");
    lines.push("## 요약", "", firstLines, "");
  } catch {}

  // changed files from diff stat
  try {
    const diffStats = getWorktreeDiffStat(taskId, projects);
    lines.push("## 변경 파일", "");
    for (const ds of diffStats) {
      if (projects.length > 1) lines.push(`### ${ds.project}`);
      lines.push("```", ds.stat, "```", "");
    }
  } catch {}

  // difficulty from analyze
  try {
    const analyzeOutput = await loadArtifact(taskId, "analyze.md");
    const difficultyMatch = analyzeOutput.match(/(?:difficulty|난이도)[:\s]*(trivial|easy|medium|hard|complex)/i);
    if (difficultyMatch) {
      lines.push(`## 난이도`, "", difficultyMatch[1], "");
    }
  } catch {}

  // pipeline execution table
  try {
    const memory = JSON.parse(await loadArtifact(taskId, "memory.json"));
    lines.push("## 파이프라인 실행", "");
    lines.push("| stage | 상태 | 소요시간 |", "|-------|------|----------|");
    for (const entry of memory.timeline) {
      const duration = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : "-";
      lines.push(`| ${entry.stage} | ${entry.status} | ${duration} |`);
    }
    lines.push("");
  } catch {}

  // limitations from implement output
  try {
    const implementOutput = await loadArtifact(taskId, "implement.md");
    const limitMatch = implementOutput.match(/(?:limitation|제한|blocker|issue)[s]?[:\s]*\n([\s\S]*?)(?:\n##|\n$)/i);
    if (limitMatch) {
      lines.push("## 제한사항", "", limitMatch[1].trim(), "");
    }
  } catch {}

  return lines.join("\n");
}

async function suspendTask(taskId, stepIndex, suspendedStage, stageResults) {
  const taskPath = path.join(TASKS_DIR, "running", `${taskId}.md`);
  try {
    const content = await readFile(taskPath, "utf-8");
    const { meta, body } = parseTaskFile(content);
    meta.suspended = true;
    meta.suspendedStage = suspendedStage;
    meta.suspendedStepIndex = stepIndex;
    await writeFile(taskPath, serializeTaskFile(meta, body));
  } catch (e) {
    log(`[${taskId}] suspend error: ${e.message}`);
  }
  // persist stageResults so resume can restore previous outputs
  if (stageResults && Object.keys(stageResults).length > 0) {
    try {
      const artifactDir = path.join(ARTIFACTS_DIR, taskId);
      await writeFile(
        path.join(artifactDir, "stage-results.json"),
        JSON.stringify(stageResults, null, 2) + "\n",
      );
    } catch (e) {
      log(`[${taskId}] failed to save stage results: ${e.message}`);
    }
  }
  if (!daemonState.suspendedTasks) daemonState.suspendedTasks = [];
  if (!daemonState.suspendedTasks.includes(taskId)) {
    daemonState.suspendedTasks.push(taskId);
  }
  log(`[${taskId}] suspended at step ${stepIndex} (${suspendedStage})`);
  broadcastWs("task:updated", { taskId, state: "suspended" });
}

async function resumeSuspendedTasks() {
  if (!daemonState.suspendedTasks || daemonState.suspendedTasks.length === 0) return;

  const tasksToResume = [...daemonState.suspendedTasks];
  daemonState.suspendedTasks = [];
  markStateDirty();

  for (const taskId of tasksToResume) {
    const task = await loadTask(taskId);
    if (!task || task.state !== "running") continue;

    const stepIndex = task.suspendedStepIndex || 0;

    // clear suspended meta
    const taskPath = path.join(TASKS_DIR, "running", `${taskId}.md`);
    try {
      const content = await readFile(taskPath, "utf-8");
      const { meta, body } = parseTaskFile(content);
      delete meta.suspended;
      delete meta.suspendedStage;
      delete meta.suspendedStepIndex;
      await writeFile(taskPath, serializeTaskFile(meta, body));
    } catch {}

    log(`[${taskId}] resuming from step ${stepIndex}`);
    inflightTasks.add(taskId);
    runPipeline(taskId, { resumeFromStep: stepIndex, skipSetup: true }).catch((e) => {
      log(`resume pipeline error for ${taskId}: ${e.message}`);
    }).finally(() => {
      inflightTasks.delete(taskId);
    });
  }
}

async function runPipeline(taskId, options = {}) {
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const projects = await resolveProjectForTask(taskId, task);
  if (projects.length === 0) throw new Error(`no projects specified for task: ${taskId}`);

  if (!options.skipSetup) {
    await moveTask(taskId, "pending", "running");
  }

  if (!daemonState.activeTasks.includes(taskId)) {
    daemonState.activeTasks.push(taskId);
  }
  markStateDirty();

  try {
    let workspace;
    if (options.skipSetup) {
      workspace = await loadWorkspace(taskId);
      log(`resuming pipeline for ${taskId}`);
    } else {
      workspace = await createWorktrees(taskId, projects);
      log(`worktrees created for ${taskId}: ${projects.map((p) => p.name).join(", ")}`);

      const taskMeta = extractMeta(task);
      await initArtifacts(taskId, serializeTaskFile(taskMeta, task.body));
    }

    const cwd = getWorktreeCwd(taskId, projects);
    const wsProjects = workspace?.projects || projects.map((p) => ({
      name: p.name, role: p.role || "primary", path: path.join(WORKTREES_DIR, taskId, p.name),
    }));
    const workspaceInfo = projects.length === 1
      ? `Project: ${projects[0].name}\nPath: ${path.join(WORKTREES_DIR, taskId, projects[0].name)}`
      : `Workspace root: ${path.join(WORKTREES_DIR, taskId)}\nProjects:\n${
        wsProjects.map((p) => `  - ${p.name} (${p.role}): ${p.path}`).join("\n")
      }\n\nSee workspace.json in the workspace root for full details.`;

    const { name: pipelineName, steps: pipelineSteps } = resolvePipeline(task, config);
    log(`[${taskId}] pipeline: ${pipelineName} (${pipelineSteps.length} steps)`);
    // restore stageResults from previous run if resuming
    let stageResults = {};
    if (options.resumeFromStep > 0) {
      try {
        const savedResults = await readFile(
          path.join(ARTIFACTS_DIR, taskId, "stage-results.json"),
          "utf-8",
        );
        stageResults = JSON.parse(savedResults);
        log(`[${taskId}] restored ${Object.keys(stageResults).length} stage results from previous run`);
      } catch {
        log(`[${taskId}] no saved stage results found, starting fresh`);
      }
    }
    const projectName = projects[0]?.name || "global";
    const lessons = await collectRelevantLessons(projectName);
    const preferences = await loadProjectPreferences(cwd);
    const pipelineContext = { taskId, task, stageResults, cwd, workspaceInfo, config, lessons, preferences };

    const resumeFrom = options.resumeFromStep || 0;
    for (let stepIndex = resumeFrom; stepIndex < pipelineSteps.length; stepIndex++) {
      const step = pipelineSteps[stepIndex];
      const normalized = normalizeStep(step);
      const result = await executeStep(normalized, pipelineContext);
      if (result.action === "abort_rate_limited") {
        // suspend: keep in running/ with suspended meta
        const suspendedStage = normalized.stage || `step-${stepIndex}`;
        await suspendTask(taskId, stepIndex, suspendedStage, stageResults);
        daemonState.activeTasks = daemonState.activeTasks.filter((t) => t !== taskId);
        markStateDirty();
        handleQuotaExceeded();
        return;
      }
      if (result.action === "abort_failed") {
        await moveTask(taskId, "running", "failed");
        daemonState.activeTasks = daemonState.activeTasks.filter((t) => t !== taskId);
        daemonState.stats.tasksFailed++;
        await updateMemory(taskId, { metrics: { result: result.result?.status || "failed" } });
        markStateDirty();
        return;
      }
    }

    // all steps completed — build structured summary
    const stageNames = pipelineSteps.filter((s) => typeof s === "string");
    const summary = await buildStructuredSummary(taskId, task, stageNames, projects);
    await saveArtifact(taskId, "summary.md", summary);
    await updateMemory(taskId, { metrics: { result: "review" } });

    // persist stageResults so reject+feedback can resume without re-running analyze
    if (stageResults && Object.keys(stageResults).length > 0) {
      try {
        await writeFile(
          path.join(ARTIFACTS_DIR, taskId, "stage-results.json"),
          JSON.stringify(stageResults, null, 2) + "\n",
        );
      } catch (e) {
        log(`[${taskId}] failed to save stage results before review: ${e.message}`);
      }
    }

    await moveTask(taskId, "running", "review");
    broadcastWs("task:updated", { taskId, state: "review" });
    daemonState.activeTasks = daemonState.activeTasks.filter((t) => t !== taskId);
    daemonState.stats.tasksCompleted++;
    markStateDirty();

    // extract lessons asynchronously (non-blocking)
    extractLessons(taskId, task).catch((e) => log(`[${taskId}] lessons extraction error: ${e.message}`));

    log(`[${taskId}] pipeline completed → review`);
  } catch (e) {
    log(`[${taskId}] pipeline error: ${e.message}`);
    try { await moveTask(taskId, "running", "failed"); } catch {}
    daemonState.activeTasks = daemonState.activeTasks.filter((t) => t !== taskId);
    daemonState.stats.tasksFailed++;
    markStateDirty();
  }
}

// ── Scan + Processing Loop ──

const taskQueue = [];
let shutdownRequested = false;

async function scanAndEnqueue() {
  if (daemonState.daemonStatus === "paused") return;

  const pending = await scanPendingTasks();
  let enqueued = 0;
  for (const task of pending) {
    if (inflightTasks.has(task.id)) continue;
    if (taskQueue.some((t) => t.id === task.id)) continue;
    taskQueue.push(task);
    enqueued++;
  }
  if (enqueued > 0) {
    // re-sort entire queue so late high-priority tasks preempt earlier low-priority ones
    taskQueue.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return (a.created || "").localeCompare(b.created || "");
    });
    log(`scan: enqueued ${enqueued} task(s) (queue: ${taskQueue.length})`);
  }
}

async function processLoop() {
  while (!shutdownRequested) {
    if (daemonState.daemonStatus !== "paused" && taskQueue.length > 0) {
      const resources = checkResources();
      const pressure = getResourcePressure(resources);

      if (pressure === "critical") {
        const cc = config?.cleanup || DEFAULT_CONFIG.cleanup;
        if (cc.autoCleanOnDiskPressure) {
          log("disk critical — triggering auto cleanup");
          try { await performCleanup({ retentionDays: 1 }); } catch (e) { log(`auto cleanup error: ${e.message}`); }
        }
      }

      if (pressure !== "critical") {
        const activeCount = inflightTasks.size;
        const maxConcurrency = config.concurrency || 1;

        if (activeCount < maxConcurrency) {
          const task = taskQueue.shift();
          if (task && !inflightTasks.has(task.id)) {
            inflightTasks.add(task.id);
            runPipeline(task.id).catch((e) => {
              log(`pipeline error for ${task.id}: ${e.message}`);
            }).finally(() => {
              inflightTasks.delete(task.id);
            });
          }
        }
      } else {
        log("resource critical — skipping task pickup");
      }
    }

    await new Promise((r) => setTimeout(r, taskQueue.length > 0 ? 1000 : 5000));
  }
}

// ── ccusage Quota Check ──

function checkQuotaViaCcusage() {
  try {
    const output = execFileSync("ccusage", ["blocks", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(output);
    const qc = config?.quota || DEFAULT_CONFIG.quota;
    const mode = qc.modes[qc.mode] || qc.modes.work;
    const usagePercent = data.usagePercent ?? data.usage_percent ?? null;
    const budgetPercent = mode.windowBudgetPercent;
    if (usagePercent === null) return null;
    return {
      available: usagePercent < qc.hardLimitPercent,
      usagePercent,
      budgetPercent,
      softLimitExceeded: usagePercent >= qc.softLimitPercent,
      hardLimitExceeded: usagePercent >= qc.hardLimitPercent,
    };
  } catch {
    return null;
  }
}

// ── Quota Management ──

let probeTimer = null;
let probeIntervalMs = QUOTA_PROBE_INITIAL_MS;

function handleQuotaExceeded() {
  if (daemonState.daemonStatus === "paused") return;

  daemonState.daemonStatus = "paused";
  daemonState.pausedAt = new Date().toISOString();
  daemonState.pauseReason = "quota_exceeded";
  markStateDirty();
  log("quota exceeded — daemon paused, starting probe timer");

  probeIntervalMs = QUOTA_PROBE_INITIAL_MS;
  scheduleProbe();
}

function scheduleProbe() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(probeQuota, probeIntervalMs);
  log(`next quota probe in ${Math.round(probeIntervalMs / 1000)}s`);
}

async function probeQuota() {
  probeTimer = null;
  log("probing quota...");

  const result = await spawnAgent("Reply with exactly: OK", {
    cwd: os.homedir(),
    provider: config.provider || DEFAULT_CONFIG.provider,
    model: config.model || DEFAULT_CONFIG.model,
    timeoutMs: 60000,
    taskId: "_probe",
    stage: "probe",
  });

  if (result.status === "done") {
    log("quota recovered — resuming daemon");
    daemonState.daemonStatus = "running";
    daemonState.pausedAt = null;
    daemonState.pauseReason = null;
    probeIntervalMs = QUOTA_PROBE_INITIAL_MS;
    markStateDirty();
    // resume suspended tasks
    resumeSuspendedTasks().catch((e) => log(`resume suspended error: ${e.message}`));
  } else {
    probeIntervalMs = Math.min(probeIntervalMs * 2, QUOTA_PROBE_MAX_MS);
    log(`quota still exceeded, backing off to ${Math.round(probeIntervalMs / 1000)}s`);
    scheduleProbe();
  }
}

// ── Daemon Lifecycle ──

let intervals = [];

async function startDaemon(foreground, devMode) {
  await ensureDirectories();
  await cleanStaleFiles();

  if (!foreground) {
    await truncateLogIfNeeded();
    const logFd = fs.openSync(LOG_PATH, "a");
    const spawnArgs = [__filename, "start", "--foreground"];
    if (devMode) spawnArgs.push("--dev");
    const child = spawn(process.execPath, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);

    await writeFile(PID_PATH, String(child.pid));
    console.log(`ucmd started (pid: ${child.pid})`);
    process.exit(0);
  }

  // foreground mode
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

  await writeFile(PID_PATH, String(process.pid));
  await loadConfig();
  await loadState();

  // reset activeTasks from previous run
  daemonState.activeTasks = [];
  markStateDirty();

  // ── Wire module dependencies ──
  ucmdAgent.setDeps({
    activeChildren,
    broadcastWs,
  });

  ucmdObserver.setDeps({
    config: () => config,
    daemonState: () => daemonState,
    spawnAgent,
    broadcastWs,
    submitTask,
    markStateDirty,
  });

  ucmdRefinement.setDeps({
    config: () => config,
    daemonState: () => daemonState,
    spawnAgent,
    broadcastWs,
    submitTask,
    markStateDirty,
    log,
  });

  ucmdHandlers.setDeps({
    config: () => config,
    daemonState: () => daemonState,
    log,
    broadcastWs,
    markStateDirty,
    inflightTasks,
    taskQueue,
    runPipeline,
    getResourcePressure,
    resumeSuspendedTasks,
    probeTimer,
    probeIntervalMs,
    QUOTA_PROBE_INITIAL_MS,
  });

  ucmdServer.setDeps({
    config: () => config,
    daemonState: () => daemonState,
    log,
    handlers: () => ({
      handleSubmit, handleList, handleStatus,
      handleApprove, handleReject, handleCancel,
      handleRetry, handleDelete, handleDiff, handleLogs,
      handlePause, handleResume, handleStats,
      startRefinement, finalizeRefinement, cancelRefinement,
      handleRefinementAnswer, switchToAutopilot,
      resolveGatherAnswer, resolveProjectAnswer,
      handleObserve, handleObserveStatus,
      handleProposals, handleProposalApprove, handleProposalReject,
      handleProposalPriority, handleProposalEvaluate,
      handleSnapshots,
      performCleanup,
    }),
    gracefulShutdown,
  });

  log("daemon starting...");

  // recover orphaned running tasks from previous daemon crash
  const recovered = await recoverRunningTasks();
  if (recovered > 0) log(`recovered ${recovered} orphaned task(s)`);

  await startSocketServer();
  log(`socket listening: ${SOCK_PATH}`);

  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  const scanTimer = setInterval(async () => {
    try { await scanAndEnqueue(); } catch (e) { log(`scan error: ${e.message}`); }
  }, config.scanIntervalMs || DEFAULT_CONFIG.scanIntervalMs);
  intervals.push(scanTimer);

  const rc = config.resources || DEFAULT_CONFIG.resources;
  const resourceTimer = setInterval(() => {
    try {
      const resources = checkResources();
      const pressure = getResourcePressure(resources);
      if (pressure !== "normal") log(`resource pressure: ${pressure} (cpu=${resources.cpuLoad.toFixed(2)}, mem=${Math.round(resources.memoryFreeMb)}MB, disk=${resources.diskFreeGb !== null ? resources.diskFreeGb.toFixed(1) + "GB" : "n/a"})`);
      broadcastWs("stats:updated", handleStats());
    } catch (e) { log(`resource check error: ${e.message}`); }
  }, rc.checkIntervalMs);
  intervals.push(resourceTimer);

  // observer timer
  const observerConfig = config.observer || DEFAULT_CONFIG.observer;
  if (observerConfig.enabled) {
    const observerTimer = setInterval(() => {
      maybeRunObserver();
    }, observerConfig.intervalMs);
    intervals.push(observerTimer);
    log(`observer enabled (interval: ${observerConfig.intervalMs}ms, taskTrigger: ${observerConfig.taskCountTrigger})`);
  }

  // proposal cleanup (daily)
  const proposalCleanupTimer = setInterval(() => {
    cleanupOldProposals().catch((e) => log(`proposal cleanup error: ${e.message}`));
  }, 24 * 60 * 60 * 1000);
  intervals.push(proposalCleanupTimer);

  try { await scanAndEnqueue(); } catch (e) { log(`initial scan error: ${e.message}`); }

  log(`daemon ready (${taskQueue.length} task(s) queued)`);

  processLoop();
}

async function gracefulShutdown() {
  log("shutting down...");
  shutdownRequested = true;

  for (const timer of intervals) clearInterval(timer);
  intervals = [];
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }

  // kill in-flight agent processes
  if (activeChildren.size > 0) {
    log(`killing ${activeChildren.size} in-flight agent(s)...`);
    for (const [taskId, child] of activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
      log(`sent SIGTERM to agent for ${taskId} (pid: ${child.pid})`);
    }
    // wait briefly for processes to exit
    const deadline = Date.now() + 5000;
    while (activeChildren.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // force kill remaining
    for (const [taskId, child] of activeChildren) {
      try { child.kill("SIGKILL"); } catch {}
      log(`sent SIGKILL to agent for ${taskId}`);
    }
  }

  if (stateDirty) {
    try { await flushState(); } catch {}
  }

  const { socketSubscribers: ss, socketServer: getSock } = ucmdServer;

  for (const conn of ss) {
    try { conn.end(); } catch {}
  }
  ss.clear();

  const currentSock = getSock();
  if (currentSock) {
    currentSock.close();
    try { await unlink(SOCK_PATH); } catch {}
  }

  try { await unlink(PID_PATH); } catch {}

  log("daemon stopped");
  if (logStream) logStream.end();
  process.exit(0);
}

async function stopDaemon() {
  const pid = await readPid();
  if (!pid) {
    console.log("ucmd is not running");
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log("ucmd is not running (stale PID)");
    await cleanStaleFiles();
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log(`ucmd stopped (pid: ${pid})`);
}

// ── Main ──

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.command && opts.foreground) {
    await startDaemon(true, opts.dev);
    return;
  }

  if (!opts.command) {
    console.log(USAGE);
    process.exit(1);
  }

  await ensureDirectories();

  switch (opts.command) {
    case "start":
      await startDaemon(opts.foreground, opts.dev);
      break;
    case "stop":
      await stopDaemon();
      break;
    default:
      console.error(`알 수 없는 커맨드: ${opts.command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

module.exports = {
  ...ucmdConstants,
  ...ucmdTask,
  ...ucmdPipeline,
  ...ucmdWorktree,
  ...ucmdProposal,
  ...ucmdPrompt,
  ...ucmdObserver,
  ...ucmdStructure,
  createTempWorkspace, updateTaskProject, resolveProjectForTask,
  loadConfig, getResourcePressure,
  broadcastWs,
  collectRelevantLessons, loadProjectPreferences,
  acquireInfraLock, releaseInfraLock, dockerComposeUp, dockerComposeDown,
  main,
};

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
