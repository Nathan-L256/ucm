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

const OBSERVER_PERSPECTIVES = {
  functionality: {
    label: "Functionality & Bug Fixes",
    priorityBoost: 10,
    focus: `기능 완결성과 버그를 최우선으로 분석하세요:
- 최근 실패한 태스크에서 반복되는 에러 패턴이 있는가
- 구현된 기능 중 불완전하거나 엣지 케이스가 누락된 것이 있는가
- 사용자에게 영향을 미치는 버그가 있는가
- 기능 간 통합이 제대로 작동하는가
- 에러 핸들링이 누락된 critical path가 있는가
반드시 bugfix 카테고리를 우선 사용하세요.`,
  },
  ux_usability: {
    label: "UX & Usability",
    priorityBoost: 0,
    focus: `사용자 경험과 사용성을 분석하세요:
- CLI/API 인터페이스가 직관적인가
- 에러 메시지가 사용자에게 유용한가
- 설정이 합리적인 기본값을 가지는가
- 사용자 워크플로우에 불필요한 마찰이 있는가
- 출력 포맷이 읽기 쉬운가
ux 또는 config 카테고리를 사용하세요.`,
  },
  architecture: {
    label: "Architecture & Modularity",
    priorityBoost: 0,
    focus: `아키텍처, 모듈화, 유지보수성을 분석하세요:
- 모듈 간 결합도가 높은 곳이 있는가
- 관심사 분리가 잘 되어 있는가
- 순환 의존성이 있는가
- 파일이 너무 크거나 책임이 많은 모듈이 있는가
- 공통 패턴을 추출할 수 있는 중복이 있는가
architecture 또는 core 카테고리를 사용하세요.`,
  },
  quality: {
    label: "Code Quality, Performance & Testing",
    priorityBoost: 0,
    focus: `코드 품질, 성능, 테스트 가능성을 분석하세요:
- 성능 병목이 될 수 있는 코드가 있는가
- 테스트 커버리지가 부족한 중요 경로가 있는가
- 비효율적인 알고리즘이나 불필요한 I/O가 있는가
- 메모리 누수 가능성이 있는가
- 벤치마크가 필요한 부분이 있는가
test, performance, 또는 core 카테고리를 사용하세요.`,
  },
  docs_vision: {
    label: "Documentation & Vision Alignment",
    priorityBoost: 0,
    focus: `문서화와 프로젝트 비전 얼라인먼트를 분석하세요:
- README가 현재 기능을 정확히 반영하는가
- API 문서가 최신인가
- 코드 변경에 비해 문서가 부족한가
- 프로젝트의 장기 비전과 최근 변경이 일치하는가
- 사용자 가이드나 예제가 필요한가
docs 또는 template 카테고리를 사용하세요.`,
  },
};

let observerState = {
  cycle: 0,
  lastRunAt: null,
  taskCountAtLastRun: 0,
  lastProposalCount: 0,
  adaptiveIntervalMs: null,
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

  // query hivemind for relevant past experience
  let hivemindKnowledge = "";
  try {
    const store = require("./hivemind/store");
    const indexer = require("./hivemind/indexer");
    store.ensureDirectories();
    indexer.loadFromDisk();
    const results = indexer.search("forge pipeline improvement failure success", { limit: 10 });
    if (results.length > 0) {
      hivemindKnowledge = results.map((r) => {
        const zettel = store.loadZettel(r.id);
        return zettel ? `### ${zettel.title}\n${zettel.body.slice(0, 300)}` : "";
      }).filter(Boolean).join("\n\n");
    }
  } catch {}

  // collect evaluation history from implemented proposals
  const evaluationHistory = [];
  const implementedDir = path.join(PROPOSALS_DIR, "implemented");
  let implFiles;
  try { implFiles = await readdir(implementedDir); } catch { implFiles = []; }
  for (const file of implFiles) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await readFile(path.join(implementedDir, file), "utf-8");
      const parsed = parseProposalFile(content);
      const verdictMatch = content.match(/\*\*Verdict\*\*:\s*(\w+)/);
      const scoreMatch = content.match(/\*\*Score\*\*:\s*([\d.]+)/);
      if (verdictMatch) {
        evaluationHistory.push({
          id: parsed.id || file.replace(".md", ""),
          title: parsed.title,
          category: parsed.category,
          risk: parsed.risk,
          verdict: verdictMatch[1],
          score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
        });
      }
    } catch {}
  }

  return { taskSummaries, lessons, templates, metrics, existingProposals, codeStructure, commitHistory, docCoverage, evaluationHistory, hivemindKnowledge };
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

async function regulateProposal(proposal, existingProposals) {
  const config = deps.config();
  const regulatorConfig = config?.regulator || DEFAULT_CONFIG.regulator;
  if (!regulatorConfig.enabled) return { allowed: true };

  // Rule 1: high-risk + core 카테고리 차단
  if (regulatorConfig.blockHighRiskCore && proposal.risk === "high" && proposal.category === "core") {
    return { allowed: false, reason: "high-risk core change blocked by regulator" };
  }

  // Rule 2: 최근 실패한 proposal과 유사하면 차단
  if (regulatorConfig.blockRecentlyFailed) {
    const windowMs = regulatorConfig.recentFailedWindowDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const rejectedDir = path.join(PROPOSALS_DIR, "rejected");
    let rejectedFiles;
    try { rejectedFiles = await readdir(rejectedDir); } catch { rejectedFiles = []; }

    for (const file of rejectedFiles) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(rejectedDir, file), "utf-8");
        const { meta } = parseTaskFile(content);
        if (!meta.created || new Date(meta.created).getTime() < cutoff) continue;
        if (meta.dedupHash === proposal.dedupHash) {
          return { allowed: false, reason: `similar to recently rejected proposal: ${file}` };
        }
      } catch {}
    }

    // 실패한 implemented proposals도 체크
    const implementedDir = path.join(PROPOSALS_DIR, "implemented");
    let implementedFiles;
    try { implementedFiles = await readdir(implementedDir); } catch { implementedFiles = []; }

    for (const file of implementedFiles) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(implementedDir, file), "utf-8");
        if (!content.includes("Verdict**: negative")) continue;
        const { meta } = parseTaskFile(content);
        if (!meta.created || new Date(meta.created).getTime() < cutoff) continue;
        if (meta.category === proposal.category && meta.title && proposal.title &&
            meta.title.toLowerCase().includes(proposal.title.toLowerCase().split(" ")[0])) {
          return { allowed: false, reason: `similar to failed implementation: ${file}` };
        }
      } catch {}
    }
  }

  return { allowed: true };
}

function buildObserverDataSection(data) {
  const sections = {};
  sections.METRICS_SNAPSHOT = JSON.stringify(data.metrics, null, 2);
  sections.TASK_SUMMARY = data.taskSummaries.length > 0
    ? data.taskSummaries.map((t) => {
      const timelineStr = t.timeline.map((e) => `${e.stage}:${e.status}(${e.durationMs}ms)`).join(", ");
      return `- [${t.state}] ${t.id} (${t.project}): ${t.title} — ${timelineStr}`;
    }).join("\n")
    : "(no recent tasks)";
  sections.LESSONS_SUMMARY = data.lessons.length > 0
    ? data.lessons.map((l) => `### ${l.project}/${l.file}\n${l.summary}`).join("\n\n")
    : "(no recent lessons)";
  sections.TEMPLATES_INFO = data.templates.map((t) => `- ${t.name} (${t.lines} lines, hash: ${t.hash})`).join("\n");
  sections.EXISTING_PROPOSALS = data.existingProposals.length > 0
    ? data.existingProposals.map((p) => `- [${p.status}] ${p.id}: ${p.title} (${p.category}/${p.risk})`).join("\n")
    : "(none)";
  sections.CODE_STRUCTURE = Object.keys(data.codeStructure).length > 0
    ? Object.entries(data.codeStructure).map(([name, info]) => {
      if (info.error) return `### ${name} (${info.path})\n\n(${info.error})`;
      return formatProjectStructureMetrics(name, info.path, info);
    }).join("\n\n")
    : "(no project structure data)";
  sections.COMMIT_HISTORY = Object.keys(data.commitHistory).length > 0
    ? Object.entries(data.commitHistory).map(([name, metrics]) =>
        formatCommitHistory(name, metrics)).join("\n\n")
    : "(no commit history data)";
  sections.DOC_COVERAGE_SUMMARY = Object.keys(data.docCoverage).length > 0
    ? Object.entries(data.docCoverage).map(([name, info]) =>
        formatDocumentation(name, info, info.sourceFileCount)).join("\n\n")
    : "(no documentation data)";
  sections.EVALUATION_HISTORY = data.evaluationHistory && data.evaluationHistory.length > 0
    ? data.evaluationHistory.map((e) =>
        `- [${e.verdict}] ${e.id}: ${e.title} (${e.category}/${e.risk}, score: ${e.score})`
      ).join("\n")
    : "(no evaluation history)";
  sections.HIVEMIND_KNOWLEDGE = data.hivemindKnowledge || "(no hivemind data)";
  return sections;
}

function applyTemplateSections(template, sections) {
  let result = template;
  for (const [key, value] of Object.entries(sections)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
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
    const dataSections = buildObserverDataSection(data);

    // determine which perspectives to run
    const perspectiveNames = observerConfig.perspectives || DEFAULT_CONFIG.observer.perspectives;
    const activePerspectives = perspectiveNames
      .filter((name) => OBSERVER_PERSPECTIVES[name])
      .map((name) => ({ name, ...OBSERVER_PERSPECTIVES[name] }));

    // load base template once
    const baseTemplate = await loadTemplate("observe");

    // spawn one agent per perspective in parallel
    const spawnPromises = activePerspectives.map(async (perspective) => {
      try {
        let prompt = applyTemplateSections(baseTemplate, dataSections);
        prompt = prompt.split("{{PERSPECTIVE_FOCUS}}").join(perspective.focus);

        const result = await deps.spawnAgent(prompt, {
          cwd: SOURCE_ROOT,
          provider: config.provider || DEFAULT_CONFIG.provider,
          model: config.model || DEFAULT_CONFIG.model,
          timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
          taskId: "_observer",
          stage: `observe-cycle-${cycle}-${perspective.name}`,
        });
        daemonState.stats.totalSpawns++;
        deps.markStateDirty();

        if (result.status !== "done") {
          log(`[observer] perspective ${perspective.name} failed: ${result.status}`);
          return { perspective, proposals: [] };
        }

        const proposals = parseObserverOutput(result.stdout || "", cycle, data.metrics);
        // apply priorityBoost from perspective
        for (const proposal of proposals) {
          proposal.priority = (proposal.priority || 0) + (perspective.priorityBoost || 0);
        }
        return { perspective, proposals };
      } catch (e) {
        log(`[observer] perspective ${perspective.name} error: ${e.message}`, "warn");
        return { perspective, proposals: [] };
      }
    });

    const perspectiveResults = await Promise.all(spawnPromises);

    // merge all proposals from all perspectives
    const allProposals = [];
    for (const { proposals } of perspectiveResults) {
      allProposals.push(...proposals);
    }

    // dedup + regulate
    const existingHashes = await getExistingDedupHashes();
    const savedProposals = [];

    for (const proposal of allProposals) {
      if (existingHashes.has(proposal.dedupHash)) {
        log(`[observer] skipping duplicate: ${proposal.title}`);
        continue;
      }
      const regulation = await regulateProposal(proposal, data.existingProposals);
      if (!regulation.allowed) {
        log(`[observer] blocked by regulator: ${proposal.title} — ${regulation.reason}`);
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

    // Adaptive scheduling: proposal 수에 따라 다음 주기 조절
    observerState.lastProposalCount = savedProposals.length;
    const baseInterval = observerConfig.intervalMs;
    const minInterval = 30 * 60 * 1000;   // 30분
    const maxInterval = 24 * 60 * 60 * 1000; // 24시간
    if (savedProposals.length >= 3) {
      observerState.adaptiveIntervalMs = Math.max(minInterval, Math.floor(baseInterval / 2));
    } else if (savedProposals.length === 0) {
      observerState.adaptiveIntervalMs = Math.min(maxInterval, baseInterval * 2);
    } else {
      observerState.adaptiveIntervalMs = baseInterval;
    }

    log(`[observer] cycle ${cycle} completed: ${savedProposals.length} proposals (next interval: ${Math.round(observerState.adaptiveIntervalMs / 60000)}min)`);
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

  // Task count trigger
  const tasksCompleted = daemonState.stats.tasksCompleted || 0;
  const taskTrigger = tasksCompleted > 0 &&
    tasksCompleted !== observerState.taskCountAtLastRun &&
    tasksCompleted % observerConfig.taskCountTrigger === 0;

  if (taskTrigger) {
    observerState.taskCountAtLastRun = tasksCompleted;
    runObserver().catch((e) => log(`[observer] error: ${e.message}`));
    return;
  }

  // Adaptive interval trigger
  if (observerState.adaptiveIntervalMs && observerState.lastRunAt) {
    const elapsed = Date.now() - new Date(observerState.lastRunAt).getTime();
    if (elapsed >= observerState.adaptiveIntervalMs) {
      runObserver().catch((e) => log(`[observer] error: ${e.message}`));
    }
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

async function analyzeProject(projectPath, projectName) {
  const config = deps.config();
  log(`[analyze] starting analysis for ${projectName}`);

  try {
    // 1. 프로젝트 특화 데이터 수집
    const observerConfig = config?.observer || DEFAULT_CONFIG.observer;
    const windowMs = observerConfig.dataWindowDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    // scan project structure
    const codeStructure = {};
    try {
      const metrics = await scanProjectStructure(projectPath);
      codeStructure[projectName] = { path: projectPath, ...metrics };
    } catch {
      codeStructure[projectName] = { path: projectPath, error: "inaccessible" };
    }

    // commit history
    const commitHistory = {};
    try {
      commitHistory[projectName] = analyzeCommitHistory(projectPath, { windowDays: observerConfig.dataWindowDays });
    } catch {
      commitHistory[projectName] = emptyCommitMetrics();
    }

    // documentation coverage
    const docCoverage = {};
    try {
      const docInfo = await scanDocumentation(projectPath);
      docCoverage[projectName] = { ...docInfo, sourceFileCount: codeStructure[projectName]?.totalFiles || 0 };
    } catch {
      docCoverage[projectName] = { hasReadme: false, hasDocsDir: false, docFileCount: 0, sourceFileCount: 0 };
    }

    // tasks filtered to this project
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
            const projects = normalizeProjects(meta);
            const taskProjectName = projects[0]?.name || "unknown";
            if (taskProjectName !== projectName) continue;
            const taskId = file.replace(".md", "");
            let memory = null;
            try {
              memory = JSON.parse(await readFile(path.join(ARTIFACTS_DIR, taskId, "memory.json"), "utf-8"));
            } catch {}
            taskSummaries.push({
              id: taskId, title: meta.title, state,
              completedAt: meta.completedAt, selfTarget: meta.selfTarget || false,
              pipeline: meta.pipeline, project: taskProjectName,
              projectPath: projects[0]?.path || meta.project || null,
              timeline: memory?.timeline || [],
            });
          }
        } catch {}
      }
    }

    // lessons filtered to this project
    const lessons = [];
    try {
      const lessonsPath = path.join(LESSONS_DIR, projectName);
      let files;
      try { files = await readdir(lessonsPath); } catch { files = []; }
      for (const file of files) {
        if (!file.startsWith("lesson-") || !file.endsWith(".md")) continue;
        try {
          const content = await readFile(path.join(lessonsPath, file), "utf-8");
          const firstLines = content.split("\n").slice(0, 10).join("\n");
          lessons.push({ project: projectName, file, summary: firstLines });
        } catch {}
      }
    } catch {}

    // templates
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

    const metrics = captureMetricsSnapshot(taskSummaries);
    const existingProposals = await listProposals();

    // hivemind knowledge
    let hivemindKnowledge = "";
    try {
      const store = require("./hivemind/store");
      const indexer = require("./hivemind/indexer");
      store.ensureDirectories();
      indexer.loadFromDisk();
      const results = indexer.search(`${projectName} improvement`, { limit: 10 });
      if (results.length > 0) {
        hivemindKnowledge = results.map((r) => {
          const zettel = store.loadZettel(r.id);
          return zettel ? `### ${zettel.title}\n${zettel.body.slice(0, 300)}` : "";
        }).filter(Boolean).join("\n\n");
      }
    } catch {}

    // evaluation history
    const evaluationHistory = [];
    const implementedDir = path.join(PROPOSALS_DIR, "implemented");
    let implFiles;
    try { implFiles = await readdir(implementedDir); } catch { implFiles = []; }
    for (const file of implFiles) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(implementedDir, file), "utf-8");
        const parsed = parseProposalFile(content);
        const verdictMatch = content.match(/\*\*Verdict\*\*:\s*(\w+)/);
        const scoreMatch = content.match(/\*\*Score\*\*:\s*([\d.]+)/);
        if (verdictMatch) {
          evaluationHistory.push({
            id: parsed.id || file.replace(".md", ""),
            title: parsed.title, category: parsed.category, risk: parsed.risk,
            verdict: verdictMatch[1],
            score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
          });
        }
      } catch {}
    }

    const data = { taskSummaries, lessons, templates, metrics, existingProposals, codeStructure, commitHistory, docCoverage, evaluationHistory, hivemindKnowledge };

    // 2. build template data sections
    const dataSections = buildObserverDataSection(data);

    // 3. determine perspectives and spawn agents in parallel
    const perspectiveNames = observerConfig.perspectives || DEFAULT_CONFIG.observer.perspectives;
    const activePerspectives = perspectiveNames
      .filter((name) => OBSERVER_PERSPECTIVES[name])
      .map((name) => ({ name, ...OBSERVER_PERSPECTIVES[name] }));

    const baseTemplate = await loadTemplate("observe");

    const spawnPromises = activePerspectives.map(async (perspective) => {
      try {
        let prompt = applyTemplateSections(baseTemplate, dataSections);
        prompt = prompt.split("{{PERSPECTIVE_FOCUS}}").join(perspective.focus);

        const result = await deps.spawnAgent(prompt, {
          cwd: projectPath,
          provider: config.provider || DEFAULT_CONFIG.provider,
          model: config.model || DEFAULT_CONFIG.model,
          timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
          taskId: "_analyze",
          stage: `analyze-${projectName}-${perspective.name}`,
        });

        if (result.status !== "done") {
          log(`[analyze] perspective ${perspective.name} failed: ${result.status}`);
          return { perspective, proposals: [] };
        }

        const proposals = parseObserverOutput(result.stdout || "", observerState.cycle, metrics);
        for (const proposal of proposals) {
          proposal.priority = (proposal.priority || 0) + (perspective.priorityBoost || 0);
          if (!proposal.project) proposal.project = projectPath;
        }
        return { perspective, proposals };
      } catch (e) {
        log(`[analyze] perspective ${perspective.name} error: ${e.message}`, "warn");
        return { perspective, proposals: [] };
      }
    });

    const perspectiveResults = await Promise.all(spawnPromises);

    // 4. merge proposals
    const allProposals = [];
    for (const { proposals } of perspectiveResults) {
      allProposals.push(...proposals);
    }

    // 5. dedup + regulate → save
    const existingHashes = await getExistingDedupHashes();
    const savedProposals = [];

    for (const proposal of allProposals) {
      if (existingHashes.has(proposal.dedupHash)) {
        log(`[analyze] skipping duplicate: ${proposal.title}`);
        continue;
      }
      const regulation = await regulateProposal(proposal, data.existingProposals);
      if (!regulation.allowed) {
        log(`[analyze] blocked by regulator: ${proposal.title} — ${regulation.reason}`);
        continue;
      }
      await saveProposal(proposal);
      existingHashes.add(proposal.dedupHash);
      savedProposals.push(proposal);
      deps.broadcastWs("proposal:created", { id: proposal.id, title: proposal.title, category: proposal.category, risk: proposal.risk });
      log(`[analyze] proposal created: ${proposal.id} — ${proposal.title}`);
    }

    log(`[analyze] completed for ${projectName}: ${savedProposals.length} proposals`);
    return { project: projectName, proposalCount: savedProposals.length, proposals: savedProposals.map((p) => ({ id: p.id, title: p.title, category: p.category, risk: p.risk })) };
  } catch (e) {
    log(`[analyze] error for ${projectName}: ${e.message}`);
    return { project: projectName, proposalCount: 0, error: e.message };
  }
}

async function handleAnalyzeProject(params) {
  const { project } = params;
  if (!project) throw new Error("project required");
  const projectPath = path.resolve(project);
  const projectName = path.basename(projectPath);
  return analyzeProject(projectPath, projectName);
}

async function handleResearchProject(params) {
  const { project } = params;
  if (!project) throw new Error("project required");
  const projectPath = path.resolve(project);
  const projectName = path.basename(projectPath);
  return runResearch(projectPath, projectName);
}

async function runResearch(projectPath, projectName) {
  const config = deps.config();
  log(`[research] starting research for ${projectName}`);

  try {
    let template = await loadTemplate("observe-research");

    // collect data for the project
    const codeStructure = {};
    try {
      const metrics = await scanProjectStructure(projectPath);
      codeStructure[projectName] = { path: projectPath, ...metrics };
    } catch {
      codeStructure[projectName] = { path: projectPath, error: "inaccessible" };
    }

    let docCoverageSummary = "(no documentation data)";
    try {
      const docInfo = await scanDocumentation(projectPath);
      const sourceFileCount = codeStructure[projectName]?.totalFiles || 0;
      docCoverageSummary = formatDocumentation(projectName, docInfo, sourceFileCount);
    } catch {}

    template = template.split("{{PROJECT}}").join(projectPath);
    template = template.split("{{PROJECT_NAME}}").join(projectName);
    template = template.split("{{CODE_STRUCTURE}}").join(
      Object.entries(codeStructure).map(([name, info]) => {
        if (info.error) return `### ${name} (${info.path})\n\n(${info.error})`;
        return formatProjectStructureMetrics(name, info.path, info);
      }).join("\n\n")
    );
    template = template.split("{{DOC_COVERAGE_SUMMARY}}").join(docCoverageSummary);
    template = template.split("{{RECENT_RELEASES}}").join("(see autopilot session)");

    const result = await deps.spawnAgent(template, {
      cwd: projectPath,
      provider: config.provider || DEFAULT_CONFIG.provider,
      model: config.model || DEFAULT_CONFIG.model,
      timeoutMs: config.stageTimeoutMs || DEFAULT_CONFIG.stageTimeoutMs,
      taskId: "_research",
      stage: "research",
    });

    if (result.status !== "done") {
      log(`[research] failed: ${result.status}`);
      return { proposalCount: 0 };
    }

    const proposals = parseObserverOutput(result.stdout || "", observerState.cycle, null);
    const existingHashes = await getExistingDedupHashes();
    let savedCount = 0;

    for (const proposal of proposals) {
      if (existingHashes.has(proposal.dedupHash)) continue;
      await saveProposal(proposal);
      existingHashes.add(proposal.dedupHash);
      savedCount++;
      deps.broadcastWs("proposal:created", { id: proposal.id, title: proposal.title, category: proposal.category, risk: proposal.risk });
      log(`[research] proposal created: ${proposal.id} — ${proposal.title}`);
    }

    log(`[research] completed: ${savedCount} proposals`);
    return { proposalCount: savedCount };
  } catch (e) {
    log(`[research] error: ${e.message}`);
    return { proposalCount: 0, error: e.message };
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
  OBSERVER_PERSPECTIVES, buildObserverDataSection, applyTemplateSections,
  getExistingDedupHashes, collectObservationData, captureMetricsSnapshot,
  runObserver, parseObserverOutput, promoteProposal, regulateProposal,
  runResearch, analyzeProject,
  handleObserve, handleObserveStatus, handleProposals,
  handleProposalApprove, handleProposalReject, handleProposalPriority,
  handleProposalEvaluate, handleSnapshots,
  handleAnalyzeProject, handleResearchProject,
  maybeRunObserver, cleanupOldProposals, evaluateProposal,
};
