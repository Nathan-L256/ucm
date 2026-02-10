const { readFile, writeFile, readdir, unlink } = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const {
  PROPOSALS_DIR, TASKS_DIR, ARTIFACTS_DIR, LESSONS_DIR, TEMPLATES_DIR,
  SNAPSHOTS_DIR, DEFAULT_CONFIG, SOURCE_ROOT, PROPOSAL_STATUSES,
  VALID_CATEGORIES, VALID_RISKS,
} = require("./ucmd-constants.js");

const { parseTaskFile, serializeTaskFile, normalizeProjects } = require("./ucmd-task.js");

const {
  generateProposalId, computeDedupHash, serializeProposal, parseProposalFile,
  saveProposal, loadProposal, moveProposal, listProposals,
  saveSnapshot, loadLatestSnapshot, loadAllSnapshots, compareSnapshots,
  findProposalByTaskId,
} = require("./ucmd-proposal.js");

const { loadTemplate } = require("./ucmd-prompt.js");
const {
  scanProjectStructure, formatProjectStructureMetrics,
  analyzeCommitHistory, emptyCommitMetrics, formatCommitHistory,
  scanDocumentation, formatDocumentation,
} = require("./ucmd-structure.js");

let log = () => {};
let deps = {};

function setLog(fn) { log = fn; }
function setDeps(d) { deps = d; }

let observerState = {
  cycle: 0,
  lastRunAt: null,
  taskCountAtLastRun: 0,
};

async function getExistingDedupHashes() {
  const hashes = new Set();
  for (const status of PROPOSAL_STATUSES) {
    const dir = path.join(PROPOSALS_DIR, status);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(dir, file), "utf-8");
        const { meta } = parseTaskFile(content);
        if (meta.dedupHash) hashes.add(meta.dedupHash);
      } catch {}
    }
  }
  return hashes;
}

async function collectObservationData() {
  const config = deps.config();
  const observerConfig = config?.observer || DEFAULT_CONFIG.observer;
  const windowMs = observerConfig.dataWindowDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  // collect recent completed/failed tasks
  const taskSummaries = [];
  for (const state of ["done", "failed"]) {
    const stateDir = path.join(TASKS_DIR, state);
    let files;
    try { files = await readdir(stateDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(stateDir, file), "utf-8");
        const { meta } = parseTaskFile(content);
        if (meta.completedAt && meta.completedAt >= cutoff) {
          const taskId = file.replace(".md", "");
          let memory = null;
          try {
            memory = JSON.parse(await readFile(path.join(ARTIFACTS_DIR, taskId, "memory.json"), "utf-8"));
          } catch {}
          const projects = normalizeProjects(meta);
          const projectName = projects[0]?.name || "unknown";
          const projectPath = projects[0]?.path || meta.project || null;
          taskSummaries.push({
            id: taskId,
            title: meta.title,
            state,
            completedAt: meta.completedAt,
            selfTarget: meta.selfTarget || false,
            pipeline: meta.pipeline,
            project: projectName,
            projectPath,
            timeline: memory?.timeline || [],
          });
        }
      } catch {}
    }
  }

  // collect recent lessons
  const lessons = [];
  try {
    const projectDirs = await readdir(LESSONS_DIR);
    for (const projectDir of projectDirs) {
      const lessonsPath = path.join(LESSONS_DIR, projectDir);
      let files;
      try { files = await readdir(lessonsPath); } catch { continue; }
      for (const file of files) {
        if (!file.startsWith("lesson-") || !file.endsWith(".md")) continue;
        try {
          const content = await readFile(path.join(lessonsPath, file), "utf-8");
          const firstLines = content.split("\n").slice(0, 10).join("\n");
          lessons.push({ project: projectDir, file, summary: firstLines });
        } catch {}
      }
    }
  } catch {}

  // collect template info
  const templates = [];
  try {
    const templateFiles = await readdir(TEMPLATES_DIR);
    for (const file of templateFiles) {
      if (!file.startsWith("ucm-") || !file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(TEMPLATES_DIR, file), "utf-8");
        const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
        templates.push({ name: file, hash, lines: content.split("\n").length });
      } catch {}
    }
  } catch {}

  // build metrics snapshot
  const metrics = captureMetricsSnapshot(taskSummaries);

  // get existing proposals for dedup
  const existingProposals = await listProposals();

  // scan code structure for each unique project
  const codeStructure = {};
  const uniqueProjectPaths = new Set();
  for (const task of taskSummaries) {
    if (task.projectPath) uniqueProjectPaths.add(task.projectPath);
  }
  for (const projectPath of uniqueProjectPaths) {
    try {
      const metrics2 = await scanProjectStructure(projectPath);
      codeStructure[path.basename(projectPath)] = { path: projectPath, ...metrics2 };
    } catch {
      codeStructure[path.basename(projectPath)] = { path: projectPath, error: "inaccessible" };
    }
  }

  const commitHistory = {};
  const docCoverage = {};
  for (const projectPath of uniqueProjectPaths) {
    const name = path.basename(projectPath);
    try {
      commitHistory[name] = analyzeCommitHistory(projectPath, { windowDays: observerConfig.dataWindowDays });
    } catch {
      commitHistory[name] = emptyCommitMetrics();
    }
    try {
      const docInfo = await scanDocumentation(projectPath);
      docCoverage[name] = { ...docInfo, sourceFileCount: codeStructure[name]?.totalFiles || 0 };
    } catch {
      docCoverage[name] = { hasReadme: false, hasDocsDir: false, docFileCount: 0, sourceFileCount: 0 };
    }
  }

  return { taskSummaries, lessons, templates, metrics, existingProposals, codeStructure, commitHistory, docCoverage };
}

function captureMetricsSnapshot(taskSummaries) {
  const total = taskSummaries.length;
  const done = taskSummaries.filter((t) => t.state === "done").length;
  const successRate = total > 0 ? done / total : 0;

  const stageMetrics = {};
  let totalDurationMs = 0;
  let totalIterations = 0;
  let firstPassCount = 0;
  let loopTaskCount = 0;

  for (const task of taskSummaries) {
    let taskDuration = 0;
    const gateResults = {};
    let iterations = 0;

    for (const entry of task.timeline) {
      taskDuration += entry.durationMs || 0;
      const stage = entry.stage.replace(/-\d+$/, "");
      if (!stageMetrics[stage]) stageMetrics[stage] = { totalMs: 0, count: 0, failCount: 0, gatePassCount: 0, gateTotal: 0 };
      stageMetrics[stage].totalMs += entry.durationMs || 0;
      stageMetrics[stage].count++;
      if (entry.status === "failed" || entry.status === "timeout") stageMetrics[stage].failCount++;

      if (entry.iteration) iterations = Math.max(iterations, entry.iteration);
    }

    if (iterations > 0) {
      totalIterations += iterations;
      loopTaskCount++;
      if (iterations === 1) firstPassCount++;
    }

    totalDurationMs += taskDuration;
  }

  const avgPipelineDurationMs = total > 0 ? Math.round(totalDurationMs / total) : 0;
  const avgIterations = loopTaskCount > 0 ? Math.round((totalIterations / loopTaskCount) * 10) / 10 : 0;
  const firstPassRate = loopTaskCount > 0 ? Math.round((firstPassCount / loopTaskCount) * 100) / 100 : 0;

  const formattedStageMetrics = {};
  for (const [stage, m] of Object.entries(stageMetrics)) {
    formattedStageMetrics[stage] = {
      avgDurationMs: m.count > 0 ? Math.round(m.totalMs / m.count) : 0,
      failRate: m.count > 0 ? Math.round((m.failCount / m.count) * 100) / 100 : 0,
    };
  }

  // per-project breakdown
  const projectGroups = {};
  for (const task of taskSummaries) {
    const proj = task.project || "unknown";
    if (!projectGroups[proj]) projectGroups[proj] = [];
    projectGroups[proj].push(task);
  }
  const projectMetrics = {};
  for (const [proj, tasks] of Object.entries(projectGroups)) {
    const projTotal = tasks.length;
    const projDone = tasks.filter((t) => t.state === "done").length;
    projectMetrics[proj] = {
      taskCount: projTotal,
      successRate: projTotal > 0 ? Math.round((projDone / projTotal) * 100) / 100 : 0,
    };
  }

  return {
    taskCount: total,
    successRate: Math.round(successRate * 100) / 100,
    avgPipelineDurationMs,
    stageMetrics: formattedStageMetrics,
    loopMetrics: { avgIterations, firstPassRate },
    projectMetrics,
    timestamp: new Date().toISOString(),
  };
}

async function runObserver() {
  const config = deps.config();
  const daemonState = deps.daemonState();
  observerState.cycle++;
  const cycle = observerState.cycle;
  observerState.lastRunAt = new Date().toISOString();
  log(`[observer] cycle ${cycle} starting`);
  deps.broadcastWs("observer:started", { cycle, timestamp: observerState.lastRunAt });

  try {
    const data = await collectObservationData();
    const observerConfig = config?.observer || DEFAULT_CONFIG.observer;

    // build prompt from template
    let template = await loadTemplate("observe");
    template = template.split("{{METRICS_SNAPSHOT}}").join(JSON.stringify(data.metrics, null, 2));
    template = template.split("{{TASK_SUMMARY}}").join(
      data.taskSummaries.length > 0
        ? data.taskSummaries.map((t) => {
          const timelineStr = t.timeline.map((e) => `${e.stage}:${e.status}(${e.durationMs}ms)`).join(", ");
          return `- [${t.state}] ${t.id} (${t.project}): ${t.title} — ${timelineStr}`;
        }).join("\n")
        : "(no recent tasks)"
    );
    template = template.split("{{LESSONS_SUMMARY}}").join(
      data.lessons.length > 0
        ? data.lessons.map((l) => `### ${l.project}/${l.file}\n${l.summary}`).join("\n\n")
        : "(no recent lessons)"
    );
    template = template.split("{{TEMPLATES_INFO}}").join(
      data.templates.map((t) => `- ${t.name} (${t.lines} lines, hash: ${t.hash})`).join("\n")
    );
    template = template.split("{{EXISTING_PROPOSALS}}").join(
      data.existingProposals.length > 0
        ? data.existingProposals.map((p) => `- [${p.status}] ${p.id}: ${p.title} (${p.category}/${p.risk})`).join("\n")
        : "(none)"
    );
    template = template.split("{{CODE_STRUCTURE}}").join(
      Object.keys(data.codeStructure).length > 0
        ? Object.entries(data.codeStructure).map(([name, info]) => {
          if (info.error) return `### ${name} (${info.path})\n\n(${info.error})`;
          return formatProjectStructureMetrics(name, info.path, info);
        }).join("\n\n")
        : "(no project structure data)"
    );
    template = template.split("{{COMMIT_HISTORY}}").join(
      Object.keys(data.commitHistory).length > 0
        ? Object.entries(data.commitHistory).map(([name, metrics]) =>
            formatCommitHistory(name, metrics)).join("\n\n")
        : "(no commit history data)"
    );
    template = template.split("{{DOC_COVERAGE_SUMMARY}}").join(
      Object.keys(data.docCoverage).length > 0
        ? Object.entries(data.docCoverage).map(([name, info]) =>
            formatDocumentation(name, info, info.sourceFileCount)).join("\n\n")
        : "(no documentation data)"
    );

    const result = await deps.spawnAgent(template, {
      cwd: SOURCE_ROOT,
      provider: config.provider || DEFAULT_CONFIG.provider,
      model: config.model || DEFAULT_CONFIG.model,
      timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
      taskId: "_observer",
      stage: `observe-cycle-${cycle}`,
    });
    daemonState.stats.totalSpawns++;
    deps.markStateDirty();

    if (result.status !== "done") {
      log(`[observer] cycle ${cycle} failed: ${result.status}`);
      deps.broadcastWs("observer:completed", { cycle, proposalCount: 0, error: result.status });
      return { cycle, proposalCount: 0 };
    }

    const proposals = parseObserverOutput(result.stdout || "", cycle, data.metrics);
    const existingHashes = await getExistingDedupHashes();
    const savedProposals = [];

    for (const proposal of proposals) {
      if (existingHashes.has(proposal.dedupHash)) {
        log(`[observer] skipping duplicate: ${proposal.title}`);
        continue;
      }
      await saveProposal(proposal);
      existingHashes.add(proposal.dedupHash);
      savedProposals.push(proposal);
      deps.broadcastWs("proposal:created", { id: proposal.id, title: proposal.title, category: proposal.category, risk: proposal.risk });
      log(`[observer] proposal created: ${proposal.id} — ${proposal.title}`);
    }

    // 스냅샷 저장 (평가 비교용)
    try {
      await saveSnapshot(data.metrics);
      log(`[observer] snapshot saved for cycle ${cycle}`);
    } catch (e2) {
      log(`[observer] snapshot save failed: ${e2.message}`);
    }

    log(`[observer] cycle ${cycle} completed: ${savedProposals.length} proposals`);
    deps.broadcastWs("observer:completed", { cycle, proposalCount: savedProposals.length });
    return { cycle, proposalCount: savedProposals.length };
  } catch (e) {
    log(`[observer] cycle ${cycle} error: ${e.message}`);
    deps.broadcastWs("observer:completed", { cycle, proposalCount: 0, error: e.message });
    return { cycle, proposalCount: 0, error: e.message };
  }
}

function parseObserverOutput(output, cycle, baselineSnapshot) {
  const proposals = [];
  try {
    const fenced = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const raw = fenced ? fenced[1].trim() : output.trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    for (const item of parsed) {
      if (!item.title || !item.category || !item.change) continue;
      if (!VALID_CATEGORIES.has(item.category)) continue;
      if (item.risk && !VALID_RISKS.has(item.risk)) item.risk = "medium";

      const id = generateProposalId();
      proposals.push({
        id,
        title: item.title,
        status: "proposed",
        category: item.category,
        risk: item.risk || "medium",
        priority: 0,
        created: new Date().toISOString(),
        observationCycle: cycle,
        baselineSnapshot: baselineSnapshot || null,
        project: item.project || null,
        relatedTasks: Array.isArray(item.relatedTasks) ? item.relatedTasks : [],
        dedupHash: computeDedupHash(item.title, item.category, item.change),
        implementedBy: null,
        problem: item.problem || "",
        change: item.change || "",
        expectedImpact: item.expectedImpact || "",
      });
    }
  } catch (e) {
    log(`[observer] output parse error: ${e.message}`);
  }
  return proposals;
}

async function promoteProposal(proposalId) {
  const config = deps.config();
  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  if (proposal.status !== "approved") throw new Error(`proposal is not approved: ${proposal.status}`);

  // create a task from the proposal
  const body = [
    `## Background`,
    ``,
    `This task was generated from self-improvement proposal ${proposalId}.`,
    ``,
    `## Problem`,
    ``,
    proposal.problem,
    ``,
    `## Change`,
    ``,
    proposal.change,
    ``,
    `## Expected Impact`,
    ``,
    proposal.expectedImpact,
  ].join("\n");

  const targetProject = proposal.project || SOURCE_ROOT;
  const result = await deps.submitTask(proposal.title, body, {
    project: targetProject,
    pipeline: config.defaultPipeline || DEFAULT_CONFIG.defaultPipeline,
  });

  // move proposal to implemented
  await moveProposal(proposalId, "approved", "implemented");
  const filePath = path.join(PROPOSALS_DIR, "implemented", `${proposalId}.md`);
  try {
    const content = await readFile(filePath, "utf-8");
    const p = parseProposalFile(content);
    p.implementedBy = result.id;
    p.status = "implemented";
    await writeFile(filePath, serializeProposal(p));
  } catch {}

  deps.broadcastWs("proposal:promoted", { proposalId, taskId: result.id });
  log(`proposal promoted: ${proposalId} → task ${result.id}`);
  return { proposalId, taskId: result.id };
}

async function handleObserve() {
  return runObserver();
}

async function handleObserveStatus() {
  const config = deps.config();
  const latestSnapshot = await loadLatestSnapshot();
  return {
    cycle: observerState.cycle,
    lastRunAt: observerState.lastRunAt,
    taskCountAtLastRun: observerState.taskCountAtLastRun,
    observerConfig: config?.observer || DEFAULT_CONFIG.observer,
    latestSnapshot: latestSnapshot ? { timestamp: latestSnapshot.timestamp, ...latestSnapshot.metrics } : null,
  };
}

async function handleProposals(params) {
  return listProposals(params?.status);
}

async function handleProposalApprove(params) {
  const { proposalId } = params;
  if (!proposalId) throw new Error("proposalId required");

  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  if (proposal.status !== "proposed") throw new Error(`proposal is not in proposed state: ${proposal.status}`);

  await moveProposal(proposalId, "proposed", "approved");
  deps.broadcastWs("proposal:updated", { id: proposalId, status: "approved" });
  log(`proposal approved: ${proposalId}`);

  // auto-promote: create task immediately
  const promoteResult = await promoteProposal(proposalId);
  return { proposalId, status: "approved", taskId: promoteResult.taskId };
}

async function handleProposalReject(params) {
  const { proposalId } = params;
  if (!proposalId) throw new Error("proposalId required");

  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  if (proposal.status !== "proposed") throw new Error(`proposal is not in proposed state: ${proposal.status}`);

  await moveProposal(proposalId, "proposed", "rejected");
  deps.broadcastWs("proposal:updated", { id: proposalId, status: "rejected" });
  log(`proposal rejected: ${proposalId}`);
  return { proposalId, status: "rejected" };
}

async function handleProposalPriority(params) {
  const { proposalId, delta } = params;
  if (!proposalId) throw new Error("proposalId required");

  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);

  const newPriority = (proposal.priority || 0) + (delta || 0);
  const filePath = proposal._filePath;
  const content = await readFile(filePath, "utf-8");
  const parsed = parseProposalFile(content);
  parsed.priority = newPriority;
  parsed.status = proposal.status;
  await writeFile(filePath, serializeProposal(parsed));

  return { proposalId, priority: newPriority };
}

async function handleProposalEvaluate(params) {
  const { proposalId } = params;
  if (!proposalId) throw new Error("proposalId required");

  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);

  return {
    proposalId,
    status: proposal.status,
    evaluation: proposal.evaluation || null,
    baselineSnapshot: proposal.baselineSnapshot || null,
  };
}

async function handleSnapshots() {
  const snapshots = await loadAllSnapshots();
  return snapshots.map((s) => ({
    timestamp: s.timestamp,
    taskCount: s.metrics?.taskCount,
    successRate: s.metrics?.successRate,
    firstPassRate: s.metrics?.loopMetrics?.firstPassRate,
  }));
}

function maybeRunObserver() {
  const config = deps.config();
  const daemonState = deps.daemonState();
  const observerConfig = config?.observer || DEFAULT_CONFIG.observer;
  if (!observerConfig.enabled) return;

  const tasksCompleted = daemonState.stats.tasksCompleted || 0;
  const taskTrigger = tasksCompleted > 0 &&
    tasksCompleted !== observerState.taskCountAtLastRun &&
    tasksCompleted % observerConfig.taskCountTrigger === 0;

  if (taskTrigger) {
    observerState.taskCountAtLastRun = tasksCompleted;
    runObserver().catch((e) => log(`[observer] error: ${e.message}`));
  }
}

async function cleanupOldProposals() {
  const config = deps.config();
  const observerConfig = config?.observer || DEFAULT_CONFIG.observer;
  const retentionMs = observerConfig.proposalRetentionDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  const rejectedDir = path.join(PROPOSALS_DIR, "rejected");
  let files;
  try { files = await readdir(rejectedDir); } catch { return; }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await readFile(path.join(rejectedDir, file), "utf-8");
      const { meta } = parseTaskFile(content);
      if (meta.created && new Date(meta.created).getTime() < cutoff) {
        await unlink(path.join(rejectedDir, file));
        log(`[observer] cleaned old rejected proposal: ${file}`);
      }
    } catch {}
  }
}

async function evaluateProposal(taskId) {
  const proposal = await findProposalByTaskId(taskId);
  if (!proposal) return null;

  log(`[evaluate] evaluating proposal ${proposal.id} (task: ${taskId})`);

  const baseline = proposal.baselineSnapshot;
  if (!baseline) {
    log(`[evaluate] no baseline snapshot for proposal ${proposal.id}, skipping`);
    return null;
  }

  // capture current metrics
  const data = await collectObservationData();
  const current = data.metrics;

  // save current snapshot
  await saveSnapshot(current);

  const evaluation = compareSnapshots(baseline, current);
  evaluation.evaluatedAt = new Date().toISOString();
  evaluation.baselineTaskCount = baseline.taskCount;
  evaluation.currentTaskCount = current.taskCount;

  // update proposal file with evaluation
  const filePath = proposal._filePath;
  const content = await readFile(filePath, "utf-8");
  const parsed = parseProposalFile(content);
  parsed.status = "implemented";
  const evaluationSection = [
    "",
    "## Evaluation",
    "",
    `- **Verdict**: ${evaluation.verdict}`,
    `- **Score**: ${evaluation.score}`,
    `- **Evaluated**: ${evaluation.evaluatedAt}`,
    `- **Baseline tasks**: ${evaluation.baselineTaskCount}, **Current tasks**: ${evaluation.currentTaskCount}`,
    "",
    "### Deltas",
    "",
    `- successRate: ${evaluation.delta.successRate > 0 ? "+" : ""}${evaluation.delta.successRate}`,
    `- avgPipelineDurationMs: ${evaluation.delta.avgPipelineDurationMs > 0 ? "+" : ""}${evaluation.delta.avgPipelineDurationMs}`,
    evaluation.delta.firstPassRate !== undefined ? `- firstPassRate: ${evaluation.delta.firstPassRate > 0 ? "+" : ""}${evaluation.delta.firstPassRate}` : null,
    evaluation.delta.avgIterations !== undefined ? `- avgIterations: ${evaluation.delta.avgIterations > 0 ? "+" : ""}${evaluation.delta.avgIterations}` : null,
  ].filter(Boolean).join("\n");

  const updatedContent = content.trimEnd() + "\n" + evaluationSection + "\n";
  await writeFile(filePath, updatedContent);

  deps.broadcastWs("proposal:evaluated", {
    proposalId: proposal.id,
    taskId,
    verdict: evaluation.verdict,
    score: evaluation.score,
    delta: evaluation.delta,
  });

  log(`[evaluate] proposal ${proposal.id}: verdict=${evaluation.verdict} score=${evaluation.score}`);
  return { proposalId: proposal.id, ...evaluation };
}

module.exports = {
  setLog, setDeps,
  getExistingDedupHashes, collectObservationData, captureMetricsSnapshot,
  runObserver, parseObserverOutput, promoteProposal,
  handleObserve, handleObserveStatus, handleProposals,
  handleProposalApprove, handleProposalReject, handleProposalPriority,
  handleProposalEvaluate, handleSnapshots,
  maybeRunObserver, cleanupOldProposals, evaluateProposal,
};
