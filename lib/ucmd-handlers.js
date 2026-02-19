const { readFile, writeFile, readdir, unlink, rm } = require("fs/promises");
const path = require("path");

const {
  TASKS_DIR, ARTIFACTS_DIR, LOGS_DIR, WORKSPACES_DIR,
  TASK_STATES, DEFAULT_CONFIG,
} = require("./ucmd-constants.js");

const {
  parseTaskFile, serializeTaskFile, generateTaskId,
  expandHome, normalizeProjects, extractMeta,
} = require("./ucmd-task.js");

const { resolvePipeline, findResumeStepIndex } = require("./ucmd-pipeline.js");

const {
  removeWorktrees, mergeWorktrees, getWorktreeDiff,
  loadArtifact, updateMemory,
} = require("./ucmd-worktree.js");

const { evaluateProposal } = require("./ucmd-observer.js");
const { isSelfTarget, selfSafetyGate } = require("./ucmd-sandbox.js");

let deps = {};

function setDeps(d) { deps = d; }

// ── Task File Management ──

async function submitTask(title, body, options = {}) {
  const taskId = generateTaskId();
  const meta = {
    id: taskId,
    title,
    state: "pending",
    priority: options.priority || 0,
    created: new Date().toISOString(),
  };

  if (options.project) {
    meta.project = path.resolve(expandHome(options.project));
  }
  if (options.projects) {
    meta.projects = options.projects;
  }
  if (options.pipeline) {
    meta.pipeline = options.pipeline;
  }
  if (options.autopilotSession) {
    meta.autopilotSession = options.autopilotSession;
  }

  const taskContent = serializeTaskFile(meta, body);
  const taskPath = path.join(TASKS_DIR, "pending", `${taskId}.md`);
  await writeFile(taskPath, taskContent);

  deps.log(`task submitted: ${taskId} — ${title}`);
  const result = { id: taskId, ...meta };
  deps.broadcastWs("task:created", result);
  return result;
}

async function moveTask(taskId, from, to) {
  const srcPath = path.join(TASKS_DIR, from, `${taskId}.md`);
  const dstPath = path.join(TASKS_DIR, to, `${taskId}.md`);

  const content = await readFile(srcPath, "utf-8");
  const { meta, body } = parseTaskFile(content);
  meta.state = to;
  if (to === "running" && !meta.startedAt) meta.startedAt = new Date().toISOString();
  if (to === "review" || to === "done" || to === "failed") meta.completedAt = new Date().toISOString();

  await writeFile(dstPath, serializeTaskFile(meta, body));
  await unlink(srcPath);
  deps.broadcastWs("task:updated", { taskId, state: to });
}

async function scanPendingTasks() {
  const pendingDir = path.join(TASKS_DIR, "pending");
  let files;
  try {
    files = await readdir(pendingDir);
  } catch {
    return [];
  }

  const tasks = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await readFile(path.join(pendingDir, file), "utf-8");
      const { meta, body } = parseTaskFile(content);
      tasks.push({ ...meta, body });
    } catch {}
  }

  // sort by priority (desc) then created (asc)
  tasks.sort((a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    return (a.created || "").localeCompare(b.created || "");
  });

  return tasks;
}

async function loadTask(taskId) {
  for (const state of TASK_STATES) {
    const taskPath = path.join(TASKS_DIR, state, `${taskId}.md`);
    try {
      const content = await readFile(taskPath, "utf-8");
      const { meta, body } = parseTaskFile(content);
      return { ...meta, body, state };
    } catch {}
  }
  return null;
}

async function recoverRunningTasks() {
  const runningDir = path.join(TASKS_DIR, "running");
  let files;
  try {
    files = await readdir(runningDir);
  } catch {
    return 0;
  }

  const daemonState = deps.daemonState();
  let recovered = 0;
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const taskId = file.replace(".md", "");

    // if no pipeline is actively running for this task, check if suspended
    if (!deps.inflightTasks.has(taskId)) {
      try {
        const content = await readFile(path.join(runningDir, file), "utf-8");
        const { meta } = parseTaskFile(content);
        if (meta.suspended) {
          // keep suspended tasks in running/ — add to suspended list for later resume
          if (!daemonState.suspendedTasks) daemonState.suspendedTasks = [];
          if (!daemonState.suspendedTasks.includes(taskId)) {
            daemonState.suspendedTasks.push(taskId);
          }
          deps.log(`preserved suspended task: ${taskId} (stage: ${meta.suspendedStage || "unknown"})`);
          continue;
        }
      } catch {}
      try {
        // clean up existing worktrees before re-queuing
        const content = await readFile(path.join(runningDir, file), "utf-8");
        const { meta } = parseTaskFile(content);
        const projects = normalizeProjects(meta);
        await removeWorktrees(taskId, projects);
        await moveTask(taskId, "running", "pending");
        deps.log(`recovered orphaned task: ${taskId} (running → pending, worktrees cleaned)`);
        recovered++;
      } catch (e) {
        deps.log(`failed to recover task ${taskId}: ${e.message}`);
      }
    }
  }

  return recovered;
}

// ── Socket Method Handlers ──

async function handleSubmit(params) {
  const { title, body, project, projects, priority, pipeline, taskFile } = params;

  if (taskFile) {
    const { meta, body: fileBody } = parseTaskFile(taskFile);
    return submitTask(
      meta.title || "untitled",
      fileBody,
      { project: meta.project, projects: meta.projects, priority: meta.priority, pipeline: meta.pipeline },
    );
  }

  if (!title) throw new Error("title required");
  return submitTask(title, body || "", { project, projects, priority, pipeline });
}

async function handleList(params) {
  const statusFilter = params.status;
  const projectFilter = params.project ? path.resolve(params.project) : null;
  const tasks = [];

  const states = statusFilter ? [statusFilter] : TASK_STATES;
  for (const state of states) {
    const stateDir = path.join(TASKS_DIR, state);
    let files;
    try { files = await readdir(stateDir); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(stateDir, file), "utf-8");
        const { meta } = parseTaskFile(content);

        if (projectFilter) {
          const taskProjects = normalizeProjects(meta);
          if (!taskProjects.some((p) => path.resolve(p.path) === projectFilter)) continue;
        }

        tasks.push({ ...meta, state });
      } catch {}
    }
  }

  return tasks;
}

async function countTasksByState() {
  const counts = {};
  for (const state of TASK_STATES) {
    const stateDir = path.join(TASKS_DIR, state);
    try {
      const files = await readdir(stateDir);
      counts[state] = files.filter((f) => f.endsWith(".md")).length;
    } catch {
      counts[state] = 0;
    }
  }
  return counts;
}

async function handleStatus(params) {
  const daemonState = deps.daemonState();
  if (params.taskId) {
    const task = await loadTask(params.taskId);
    if (!task) throw new Error(`task not found: ${params.taskId}`);
    return task;
  }
  const counts = await countTasksByState();
  return {
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    daemonStatus: daemonState.daemonStatus,
    pausedAt: daemonState.pausedAt,
    pauseReason: daemonState.pauseReason,
    activeTasks: daemonState.activeTasks,
    queueLength: deps.taskQueue.length,
    tasksCompleted: counts.done,
    tasksFailed: counts.failed,
    totalSpawns: daemonState.stats.totalSpawns,
  };
}

async function handleApprove(params) {
  const { taskId, score } = params;
  if (!taskId) throw new Error("taskId required");

  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state !== "review") throw new Error(`task is not in review state: ${task.state}`);

  const daemonState = deps.daemonState();
  const projects = normalizeProjects(task);

  // Self-modification safety gate
  const config = deps.config();
  const selfConfig = config?.selfImprove || {};
  if (selfConfig.enabled && projects.some((p) => isSelfTarget(p.path))) {
    if (selfConfig.requirePassingTests !== false) {
      const gate = await selfSafetyGate(taskId, projects[0].path);
      if (!gate.safe) {
        throw new Error(`self-modification safety gate failed: ${gate.reason}`);
      }
      deps.log(`[${taskId}] self-modification safety gate passed (backup: ${gate.backupBranch})`);
    }
  }

  await mergeWorktrees(taskId, projects);

  if (score !== undefined) {
    await updateMemory(taskId, { metrics: { score } });
  }

  daemonState.activeTasks = daemonState.activeTasks.filter((t) => t !== taskId);
  if (daemonState.suspendedTasks) {
    daemonState.suspendedTasks = daemonState.suspendedTasks.filter((t) => t !== taskId);
  }
  deps.markStateDirty();

  await moveTask(taskId, "review", "done");
  deps.log(`task approved: ${taskId}`);

  // 제안 기반 태스크면 평가 실행
  evaluateProposal(taskId).catch((e) => deps.log(`[evaluate] ${taskId}: ${e.message}`));

  return { id: taskId, status: "done" };
}

async function handleReject(params) {
  const { taskId, feedback } = params;
  if (!taskId) throw new Error("taskId required");

  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state !== "review") throw new Error(`task is not in review state: ${task.state}`);

  const projects = normalizeProjects(task);
  const config = deps.config();

  if (feedback) {
    // resubmit with feedback — keep worktree, resume from implement step
    const taskPath = path.join(TASKS_DIR, "review", `${taskId}.md`);
    const content = await readFile(taskPath, "utf-8");
    const { meta, body } = parseTaskFile(content);
    meta.feedback = feedback;
    meta.state = "running";
    delete meta.completedAt;

    await writeFile(path.join(TASKS_DIR, "running", `${taskId}.md`), serializeTaskFile(meta, body));
    await unlink(taskPath);
    deps.broadcastWs("task:updated", { taskId, state: "running" });

    const { steps } = resolvePipeline({ ...meta, body }, config || DEFAULT_CONFIG);
    const resumeFrom = findResumeStepIndex(steps);

    deps.inflightTasks.add(taskId);
    deps.runPipeline(taskId, { skipSetup: true, resumeFromStep: resumeFrom }).catch((e) => {
      deps.log(`reject-feedback pipeline error for ${taskId}: ${e.message}`);
    }).finally(() => {
      deps.inflightTasks.delete(taskId);
    });

    deps.log(`task rejected with feedback, resuming from step ${resumeFrom}: ${taskId}`);
    return { id: taskId, status: "running" };
  }

  // reject without feedback — discard
  await removeWorktrees(taskId, projects);
  await moveTask(taskId, "review", "failed");

  deps.log(`task rejected: ${taskId}`);
  return { id: taskId, status: "failed" };
}

async function handleCancel(params) {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId required");

  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const daemonState = deps.daemonState();
  const projects = normalizeProjects(task);
  await removeWorktrees(taskId, projects);

  if (task.state !== "done" && task.state !== "failed") {
    await moveTask(taskId, task.state, "failed");
  }

  // clean up from active/suspended lists
  daemonState.activeTasks = daemonState.activeTasks.filter((t) => t !== taskId);
  if (daemonState.suspendedTasks) {
    daemonState.suspendedTasks = daemonState.suspendedTasks.filter((t) => t !== taskId);
  }
  deps.markStateDirty();

  deps.log(`task cancelled: ${taskId}`);
  return { id: taskId, status: "failed" };
}

async function handleRetry(params) {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId required");
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state !== "failed") throw new Error(`task is not failed: ${task.state}`);

  const projects = normalizeProjects(task);
  await removeWorktrees(taskId, projects);

  await moveTask(taskId, "failed", "pending");
  deps.log(`task retried: ${taskId}`);
  deps.broadcastWs("task:updated", { taskId, state: "pending" });
  return { id: taskId, status: "pending" };
}

async function handleDelete(params) {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId required");
  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.state !== "failed" && task.state !== "done") {
    throw new Error(`can only delete done/failed tasks: ${task.state}`);
  }

  const projects = normalizeProjects(task);
  await removeWorktrees(taskId, projects);

  // remove task file
  const taskPath = path.join(TASKS_DIR, task.state, `${taskId}.md`);
  try { await unlink(taskPath); } catch {}

  // remove logs and artifacts
  try { await unlink(path.join(LOGS_DIR, `${taskId}.log`)); } catch {}
  try { await rm(path.join(ARTIFACTS_DIR, taskId), { recursive: true }); } catch {}

  deps.log(`task deleted: ${taskId}`);
  deps.broadcastWs("task:deleted", { taskId });
  return { id: taskId, status: "deleted" };
}

async function handleDiff(params) {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId required");

  const task = await loadTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const projects = normalizeProjects(task);
  return getWorktreeDiff(taskId, projects);
}

async function handleLogs(params) {
  const { taskId, lines } = params;
  if (!taskId) throw new Error("taskId required");

  const logPath = path.join(LOGS_DIR, `${taskId}.log`);
  try {
    const content = await readFile(logPath, "utf-8");
    const allLines = content.split("\n");
    const count = lines || 100;
    return allLines.slice(-count).join("\n");
  } catch {
    return "(no logs)";
  }
}

function handlePause() {
  const daemonState = deps.daemonState();
  daemonState.daemonStatus = "paused";
  daemonState.pausedAt = new Date().toISOString();
  daemonState.pauseReason = "manual";
  deps.markStateDirty();
  deps.log("daemon paused (manual)");
  deps.broadcastWs("daemon:status", { status: "paused" });
  return { status: "paused" };
}

function handleResume() {
  const daemonState = deps.daemonState();
  if (deps.probeTimer) { clearTimeout(deps.probeTimer); deps.probeTimer = null; }
  daemonState.daemonStatus = "running";
  daemonState.pausedAt = null;
  daemonState.pauseReason = null;
  deps.probeIntervalMs = deps.QUOTA_PROBE_INITIAL_MS;
  deps.markStateDirty();
  deps.log("daemon resumed");
  deps.broadcastWs("daemon:status", { status: "running" });
  // resume suspended tasks
  deps.resumeSuspendedTasks().catch((e) => deps.log(`resume suspended error: ${e.message}`));
  return { status: "running" };
}

async function handleStats() {
  const daemonState = deps.daemonState();
  const config = deps.config();
  const { checkResources } = require("./ucmd-task.js");
  const resources = checkResources();
  const pipelines = config.pipelines || DEFAULT_CONFIG.pipelines;
  const counts = await countTasksByState();
  return {
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    daemonStatus: daemonState.daemonStatus,
    activeTasks: daemonState.activeTasks,
    suspendedTasks: daemonState.suspendedTasks || [],
    queueLength: deps.taskQueue.length,
    resources,
    resourcePressure: deps.getResourcePressure(resources),
    pipelines: Object.keys(pipelines),
    defaultPipeline: config.defaultPipeline || DEFAULT_CONFIG.defaultPipeline,
    tasksCompleted: counts.done,
    tasksFailed: counts.failed,
    totalSpawns: daemonState.stats.totalSpawns,
  };
}

module.exports = {
  setDeps,
  submitTask, moveTask, scanPendingTasks, loadTask, recoverRunningTasks,
  handleSubmit, handleList, handleStatus,
  handleApprove, handleReject, handleCancel,
  handleRetry, handleDelete, handleDiff, handleLogs,
  handlePause, handleResume, handleStats,
};
