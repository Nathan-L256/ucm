const net = require("net");
const fs = require("fs");

const {
  SOCK_PATH, MAX_SOCKET_REQUEST_BYTES,
} = require("./ucmd-constants.js");

let deps = {};

function setDeps(d) { deps = d; }

function broadcastWs(event, data) {
  if (socketSubscribers.size > 0) {
    const line = JSON.stringify({ event, data }) + "\n";
    for (const conn of socketSubscribers) {
      try { conn.write(line); } catch { socketSubscribers.delete(conn); }
    }
  }
}

// ── Socket Server ──

let socketServer = null;
const socketSubscribers = new Set();

function startSocketServer() {
  return new Promise((resolve, reject) => {
    socketServer = net.createServer((conn) => {
      let data = "";
      conn.on("data", (chunk) => {
        data += chunk;
        if (data.length > MAX_SOCKET_REQUEST_BYTES) {
          conn.end(JSON.stringify({ id: null, ok: false, error: "request too large" }) + "\n");
          return;
        }
        let newlineIndex;
        while ((newlineIndex = data.indexOf("\n")) !== -1) {
          const requestLine = data.slice(0, newlineIndex);
          data = data.slice(newlineIndex + 1);
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
  const h = deps.handlers();
  const socketHandlers = {
    submit: h.handleSubmit,
    list: h.handleList,
    status: h.handleStatus,
    approve: h.handleApprove,
    reject: h.handleReject,
    cancel: h.handleCancel,
    retry: h.handleRetry,
    delete: h.handleDelete,
    diff: h.handleDiff,
    logs: h.handleLogs,
    pause: () => h.handlePause(),
    resume: (p) => {
      if (p && p.taskId) {
        // forge resume: 중단된 forge 태스크 재실행
        const { ForgePipeline, wireEvents } = require("./forge/index");
        const { TaskDag } = require("./core/task");
        return TaskDag.load(p.taskId).then((existingDag) => {
          const fp = new ForgePipeline({
            taskId: p.taskId,
            project: p.project,
            pipeline: existingDag.pipeline,
            autopilot: p.autopilot,
            tokenBudget: p.tokenBudget,
            resumeFrom: p.fromStage || null,
          });
          wireEvents(fp, (event, data) => broadcastWs(event, data));
          fp.run().catch(() => {});
          return { ok: true, taskId: p.taskId };
        }).catch((e) => {
          throw new Error(`resume failed: ${e.message}`);
        });
      }
      // daemon resume (unpause)
      return h.handleResume();
    },
    stats: () => h.handleStats(),
    cleanup: (p) => h.performCleanup(p),
    observe: () => h.handleObserve(),
    observe_status: () => h.handleObserveStatus(),
    proposals: (p) => h.handleProposals(p),
    proposal_approve: (p) => h.handleProposalApprove(p),
    proposal_reject: (p) => h.handleProposalReject(p),
    proposal_priority: (p) => h.handleProposalPriority(p),
    proposal_evaluate: (p) => h.handleProposalEvaluate(p),
    snapshots: () => h.handleSnapshots(),
    analyze_project: (p) => h.handleAnalyzeProject(p),
    research_project: (p) => h.handleResearchProject(p),
    start_refinement: (p) => h.startRefinement(p),
    finalize_refinement: (p) => h.finalizeRefinement(p.sessionId),
    cancel_refinement: (p) => h.cancelRefinement(p.sessionId),
    gather_answer: (p) => { h.resolveGatherAnswer(p.taskId, p.answers || []); return { ok: true }; },
    project_answer: (p) => { h.resolveProjectAnswer(p.taskId, p.projectPath || ""); return { ok: true }; },
    refinement_answer: (p) => h.handleRefinementAnswer(p.sessionId, p.answer || {}),
    refinement_autopilot: (p) => h.switchToAutopilot(p.sessionId),
    autopilot_start: (p) => h.handleAutopilotStart(p),
    autopilot_pause: (p) => h.handleAutopilotPause(p),
    autopilot_resume: (p) => h.handleAutopilotResume(p),
    autopilot_stop: (p) => h.handleAutopilotStop(p),
    autopilot_status: () => h.handleAutopilotStatus(),
    autopilot_session: (p) => h.handleAutopilotSession(p),
    autopilot_approve_item: (p) => h.handleAutopilotApproveItem(p),
    autopilot_reject_item: (p) => h.handleAutopilotRejectItem(p),
    autopilot_feedback_item: (p) => h.handleAutopilotFeedbackItem(p),
    autopilot_releases: (p) => h.handleAutopilotReleases(p),
    autopilot_directive_add: (p) => h.handleAutopilotDirectiveAdd(p),
    autopilot_directive_edit: (p) => h.handleAutopilotDirectiveEdit(p),
    autopilot_directive_delete: (p) => h.handleAutopilotDirectiveDelete(p),
    autopilot_directive_list: (p) => h.handleAutopilotDirectiveList(p),
    forge: async (p) => {
      const { ForgePipeline, wireEvents } = require("./forge/index");
      const fp = new ForgePipeline({
        input: p.input,
        project: p.project,
        pipeline: p.pipeline,
        autopilot: p.autopilot,
        tokenBudget: p.tokenBudget,
      });
      wireEvents(fp, (event, data) => broadcastWs(event, data));
      fp.run().catch(() => {});
      return { ok: true, taskId: fp.taskId };
    },
    shutdown: null,
  };

  if (method === "subscribe") {
    conn.write(JSON.stringify({ id, ok: true }) + "\n");
    const daemonState = deps.daemonState();
    conn.write(JSON.stringify({ event: "daemon:status", data: { status: daemonState?.daemonStatus || "running" } }) + "\n");
    socketSubscribers.add(conn);
    conn.on("close", () => socketSubscribers.delete(conn));
    conn.on("error", () => socketSubscribers.delete(conn));
    return;
  }

  if (method === "shutdown") {
    conn.end(JSON.stringify({ id, ok: true }) + "\n");
    deps.gracefulShutdown();
    return;
  }

  const handler = socketHandlers[method];
  if (!handler) {
    conn.end(JSON.stringify({ id, ok: false, error: `unknown method: ${method}` }) + "\n");
    return;
  }

  try {
    const result = await handler(params || {});
    conn.end(JSON.stringify({ id, ok: true, data: result }) + "\n");
  } catch (e) {
    deps.log(`[socket] ${method} error: ${e.message}`);
    conn.end(JSON.stringify({ id, ok: false, error: e.message }) + "\n");
  }
}

module.exports = {
  setDeps,
  broadcastWs,
  startSocketServer,
  socketSubscribers,
  socketServer: () => socketServer,
};
