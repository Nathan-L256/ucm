const net = require("net");
const fs = require("fs");
const { mkdir } = require("fs/promises");
const path = require("path");
const { SOCK_PATH, DAEMON_DIR, PID_PATH, FORGE_DIR, LOGS_DIR, MAX_CONCURRENT_TASKS } = require("../core/constants");
const { TaskDag } = require("../core/task");

const MAX_REQUEST_BYTES = 1024 * 1024;
const TASK_ID_RE = /^forge-\d{8}-[a-f0-9]{4,}$/;
const socketSubscribers = new Set();
const activePipelines = new Map(); // taskId → ForgePipeline

function validateTaskId(taskId) {
  if (!taskId || !TASK_ID_RE.test(taskId)) {
    throw new Error(`invalid taskId format: ${taskId}`);
  }
}

function broadcastEvent(event, data) {
  if (socketSubscribers.size === 0) return;
  const line = JSON.stringify({ event, data }) + "\n";
  for (const conn of socketSubscribers) {
    try { conn.write(line); } catch { socketSubscribers.delete(conn); }
  }
}

function createForgeEventHandler() {
  return function onEvent(event, data) {
    broadcastEvent(event, data);
  };
}

async function handleRequest(method, params) {
  switch (method) {
    case "forge": {
      if (activePipelines.size >= MAX_CONCURRENT_TASKS) {
        throw new Error(`concurrent task limit reached (${MAX_CONCURRENT_TASKS}). Wait for a task to finish or increase UCM_MAX_CONCURRENT.`);
      }
      const { ForgePipeline, wireEvents } = require("../forge/index");
      const fp = new ForgePipeline({
        input: params.input,
        project: params.project,
        pipeline: params.pipeline,
        autopilot: params.autopilot,
        tokenBudget: params.tokenBudget,
      });
      activePipelines.set(fp.taskId, fp);
      wireEvents(fp, createForgeEventHandler());
      fp.run()
        .catch((e) => broadcastEvent("pipeline:error", { taskId: fp.taskId, error: e.message }))
        .finally(() => activePipelines.delete(fp.taskId));
      return { ok: true, taskId: fp.taskId };
    }

    case "resume": {
      if (!params.taskId) throw new Error("resume requires taskId");
      validateTaskId(params.taskId);
      if (!params.project) throw new Error("resume requires project");
      if (activePipelines.has(params.taskId)) {
        throw new Error(`task ${params.taskId} is already running`);
      }
      const { ForgePipeline, wireEvents } = require("../forge/index");
      const { TaskDag: ResumeDag } = require("../core/task");
      const existingDag = await ResumeDag.load(params.taskId);

      const fp = new ForgePipeline({
        taskId: params.taskId,
        project: params.project,
        pipeline: existingDag.pipeline,
        autopilot: params.autopilot,
        tokenBudget: params.tokenBudget,
        resumeFrom: params.fromStage || null,
      });
      activePipelines.set(fp.taskId, fp);
      wireEvents(fp, createForgeEventHandler());
      fp.run()
        .catch((e) => broadcastEvent("pipeline:error", { taskId: fp.taskId, error: e.message }))
        .finally(() => activePipelines.delete(fp.taskId));
      return { ok: true, taskId: params.taskId };
    }

    case "list": {
      const tasks = await TaskDag.list();
      const filtered = params.status
        ? tasks.filter((t) => t.status === params.status)
        : tasks;
      return filtered.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        pipeline: t.pipeline,
        currentStage: t.currentStage,
        createdAt: t.createdAt,
        warnings: t.warnings,
        tokenUsage: t.tokenUsage,
      }));
    }

    case "status": {
      if (params.taskId) validateTaskId(params.taskId);
      if (!params.taskId) {
        return {
          pid: process.pid,
          uptime: Math.floor(process.uptime()),
          status: "running",
        };
      }
      const dag = await TaskDag.load(params.taskId);
      return dag.toJSON();
    }

    case "approve": {
      validateTaskId(params.taskId);
      const { approve } = require("../forge/deliver");
      return approve(params.taskId);
    }

    case "reject": {
      validateTaskId(params.taskId);
      const { reject } = require("../forge/deliver");
      return reject(params.taskId, params.feedback);
    }

    case "abort": {
      validateTaskId(params.taskId);
      const dag = await TaskDag.load(params.taskId);
      if (dag.status !== "in_progress") {
        throw new Error(`cannot abort task in status: ${dag.status}`);
      }
      // 실행 중인 파이프라인이 있으면 abort 호출 (worktree 정리 + lock 해제 포함)
      const running = activePipelines.get(params.taskId);
      if (running) {
        await running.abort();
      } else {
        // 파이프라인 없이 DAG만 남아있는 경우 직접 정리
        const { removeWorktrees, loadWorkspace } = require("../core/worktree");
        try {
          const workspace = await loadWorkspace(params.taskId);
          if (workspace) await removeWorktrees(params.taskId, workspace.projects);
        } catch {}
        dag.status = "aborted";
        dag.warnings.push("aborted via daemon");
        await dag.save();
      }
      return { status: "aborted" };
    }

    case "gc": {
      const { gcTasks } = require("../core/worktree");
      const cleaned = await gcTasks({ maxAgeDays: params.days || 30 });
      return { cleaned };
    }

    case "logs": {
      validateTaskId(params.taskId);
      const logPath = path.join(LOGS_DIR, `${params.taskId}.log`);
      try {
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.split("\n");
        const limit = params.lines || 100;
        return lines.slice(-limit).join("\n");
      } catch {
        return "(no logs)";
      }
    }

    case "diff": {
      validateTaskId(params.taskId);
      const { getWorktreeDiff, loadWorkspace } = require("../core/worktree");
      const workspace = await loadWorkspace(params.taskId);
      if (!workspace) return [{ project: "unknown", diff: "(no workspace)" }];
      return getWorktreeDiff(params.taskId, workspace.projects);
    }

    case "stats": {
      const tasks = await TaskDag.list();
      const done = tasks.filter((t) => t.status === "done").length;
      const failed = tasks.filter((t) => t.status === "failed").length;
      const inProgress = tasks.filter((t) => t.status === "in_progress").length;
      return {
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        status: "running",
        totalTasks: tasks.length,
        done,
        failed,
        inProgress,
        activePipelines: activePipelines.size,
        maxConcurrent: MAX_CONCURRENT_TASKS,
      };
    }

    default:
      throw new Error(`unknown method: ${method}`);
  }
}

let socketServer = null;

async function detectOrphanTasks() {
  try {
    const tasks = await TaskDag.list();
    for (const task of tasks) {
      if (task.status === "in_progress") {
        task.status = "failed";
        task.warnings.push("orphaned: found in_progress on daemon restart");
        await task.save();
      }
    }
  } catch {}
}

async function startServer() {
  await mkdir(DAEMON_DIR, { recursive: true });
  await mkdir(FORGE_DIR, { recursive: true });

  await detectOrphanTasks();

  try { fs.unlinkSync(SOCK_PATH); } catch {}

  return new Promise((resolve, reject) => {
    socketServer = net.createServer((conn) => {
      let data = "";
      let handled = false;
      conn.on("data", function onData(chunk) {
        if (handled) return;
        data += chunk;
        if (data.length > MAX_REQUEST_BYTES) {
          handled = true;
          conn.end(JSON.stringify({ id: null, ok: false, error: "request too large" }) + "\n");
          return;
        }
        const newlineIndex = data.indexOf("\n");
        if (newlineIndex !== -1) {
          handled = true;
          const requestLine = data.slice(0, newlineIndex);
          handleSocketRequest(requestLine, conn);
        }
      });
      conn.on("error", () => {});
    });

    socketServer.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        try { fs.unlinkSync(SOCK_PATH); } catch {}
        socketServer.listen(SOCK_PATH, () => resolve());
      } else {
        reject(e);
      }
    });

    socketServer.listen(SOCK_PATH, () => resolve());
  });
}

async function handleSocketRequest(line, conn) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    conn.end(JSON.stringify({ id: null, ok: false, error: "invalid JSON" }) + "\n");
    return;
  }

  const { id, method, params } = request;

  if (method === "subscribe") {
    conn.write(JSON.stringify({ id, ok: true }) + "\n");
    socketSubscribers.add(conn);
    conn.on("close", () => socketSubscribers.delete(conn));
    conn.on("error", () => socketSubscribers.delete(conn));
    return;
  }

  if (method === "shutdown") {
    conn.end(JSON.stringify({ id, ok: true }) + "\n");
    stopServer();
    process.exit(0);
    return;
  }

  try {
    const result = await handleRequest(method, params || {});
    conn.end(JSON.stringify({ id, ok: true, data: result }) + "\n");
  } catch (e) {
    conn.end(JSON.stringify({ id, ok: false, error: e.message }) + "\n");
  }
}

function stopServer() {
  if (socketServer) {
    socketServer.close();
    socketServer = null;
  }
  for (const conn of socketSubscribers) {
    try { conn.destroy(); } catch {}
  }
  socketSubscribers.clear();
  try { fs.unlinkSync(SOCK_PATH); } catch {}
}

module.exports = {
  startServer,
  stopServer,
  broadcastEvent,
  createForgeEventHandler,
};
