#!/usr/bin/env node
const { execFileSync, spawn } = require("child_process");
const {
  readFile, writeFile, mkdir, rm, readdir, access, stat,
} = require("fs/promises");
const fs = require("fs");
const net = require("net");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { startSuiteTimer } = require("./harness");
const { trackPid, cleanupAll } = require("./helpers/cleanup");

// isolate test daemon from production
const TEST_UCM_DIR = path.join(os.tmpdir(), `ucm-test-${process.pid}`);
process.env.UCM_DIR = TEST_UCM_DIR;
const {
  UCM_DIR, TASKS_DIR, WORKTREES_DIR, WORKSPACES_DIR, ARTIFACTS_DIR, LOGS_DIR, DAEMON_DIR, LESSONS_DIR,
  PROPOSALS_DIR, SNAPSHOTS_DIR, PROPOSAL_STATUSES, VALID_CATEGORIES, VALID_RISKS,
  SOCK_PATH, PID_PATH, LOG_PATH, CONFIG_PATH, STATE_PATH,
  SOCKET_READY_TIMEOUT_MS, SOCKET_POLL_INTERVAL_MS, CLIENT_TIMEOUT_MS,
  DEFAULT_CONFIG, TASK_STATES, GATE_STEPS, META_KEYS,
  DATA_VERSION, SOURCE_ROOT,
  parseTaskFile, serializeTaskFile, extractMeta, generateTaskId, normalizeProjects,
  createTempWorkspace, updateTaskProject, resolveProjectForTask,
  cleanStaleFiles, readPid, isProcessAlive, ensureDirectories,
  checkResources, getResourcePressure,
  broadcastWs,
  resolvePipeline, normalizeStep, findResumeStepIndex, parseGateResult, extractCriticalIssues, isGateStep, buildStageResultsSummary, resolveMaxIterations, collectRelevantLessons, loadProjectPreferences,
  acquireInfraLock, releaseInfraLock,
  defaultState,
  generateProposalId, computeDedupHash, serializeProposal, parseProposalFile,
  saveProposal, loadProposal, listProposals,
  OBSERVER_PERSPECTIVES,
  captureMetricsSnapshot, parseObserverOutput,
  getLanguageFamily, countFunctions, getSizeCategory, analyzeFile, getChangedFiles,
  formatChangedFilesMetrics, formatProjectStructureMetrics,
  isGitRepo, validateGitProjects,
  analyzeCommitHistory, emptyCommitMetrics, formatCommitHistory, LARGE_COMMIT_THRESHOLD,
  DOC_EXTENSIONS, DOC_DIRS, scanDocumentation, formatDocumentation, analyzeDocCoverage,
  generateProjectContext, formatProjectContext,
  saveSnapshot, loadLatestSnapshot, loadAllSnapshots, cleanupOldSnapshots,
  compareSnapshots, findProposalByTaskId, evaluateProposal,
  analyzeProject, handleAnalyzeProject, handleResearchProject,
} = require("../lib/ucmd.js");

const ucmdAutopilot = require("../lib/ucmd-autopilot.js");
const ucmdSandbox = require("../lib/ucmd-sandbox.js");
const {
  EXPECTED_GREENFIELD, EXPECTED_BROWNFIELD,
  REFINEMENT_GREENFIELD, REFINEMENT_BROWNFIELD,
  computeCoverage, isFullyCovered,
  buildQuestionPrompt, formatDecisions, parseDecisionsFile,
  buildRefinementPrompt, buildAutopilotRefinementPrompt, formatRefinedRequirements,
} = require("../lib/qna-core.js");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    process.stdout.write(".");
  } else {
    failed++;
    failures.push(message);
    process.stdout.write("F");
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    process.stdout.write(".");
  } else {
    failed++;
    failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.stdout.write("F");
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    process.stdout.write(".");
  } else {
    failed++;
    failures.push(`${message}:\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    process.stdout.write("F");
  }
}

// ── Unit Tests: parseTaskFile ──

function testParseTaskFileBasic() {
  const content = `---
id: abc12345
title: Fix the bug
status: pending
priority: 3
---

This is the body.
Second line.`;

  const { meta, body } = parseTaskFile(content);
  assertEqual(meta.id, "abc12345", "parse: id");
  assertEqual(meta.title, "Fix the bug", "parse: title");
  assertEqual(meta.status, "pending", "parse: status");
  assertEqual(meta.priority, 3, "parse: priority is number");
  assertEqual(body, "This is the body.\nSecond line.", "parse: body");
}

function testParseTaskFileQuotedValues() {
  const content = `---
title: "Hello World"
name: 'Single Quotes'
---

Body here.`;

  const { meta } = parseTaskFile(content);
  assertEqual(meta.title, "Hello World", "parse: double quotes stripped");
  assertEqual(meta.name, "Single Quotes", "parse: single quotes stripped");
}

function testParseTaskFileArrays() {
  const content = `---
tags: [frontend, backend, api]
---

Body.`;

  const { meta } = parseTaskFile(content);
  assertDeepEqual(meta.tags, ["frontend", "backend", "api"], "parse: array values");
}

function testParseTaskFileBooleans() {
  const content = `---
enabled: true
disabled: false
---`;

  const { meta } = parseTaskFile(content);
  assertEqual(meta.enabled, true, "parse: true boolean");
  assertEqual(meta.disabled, false, "parse: false boolean");
}

function testParseTaskFileNoFrontmatter() {
  const content = "Just plain text\nNo frontmatter.";
  const { meta, body } = parseTaskFile(content);
  assertDeepEqual(meta, {}, "parse: no frontmatter meta empty");
  assertEqual(body, content, "parse: no frontmatter body is full content");
}

function testParseTaskFileColonInValue() {
  const content = `---
title: Fix: the bug
url: https://example.com
---`;

  const { meta } = parseTaskFile(content);
  assertEqual(meta.title, "Fix: the bug", "parse: colon in value preserved");
  assertEqual(meta.url, "https://example.com", "parse: url preserved");
}

// ── Unit Tests: serializeTaskFile ──

function testSerializeTaskFile() {
  const meta = { id: "abc", title: "Test", status: "pending", priority: 0 };
  const body = "This is the body.";
  const result = serializeTaskFile(meta, body);

  assert(result.startsWith("---\n"), "serialize: starts with ---");
  assert(result.includes("id: abc"), "serialize: contains id");
  assert(result.includes("title: Test"), "serialize: contains title");
  assert(result.endsWith("This is the body.\n"), "serialize: ends with body");
}

function testSerializeRoundtrip() {
  const meta = { id: "abc", title: "Test Task", priority: 5, status: "pending" };
  const body = "Multi-line\nbody\ncontent.";
  const serialized = serializeTaskFile(meta, body);
  const { meta: parsed, body: parsedBody } = parseTaskFile(serialized);

  assertEqual(parsed.id, meta.id, "roundtrip: id");
  assertEqual(parsed.title, meta.title, "roundtrip: title");
  assertEqual(parsed.priority, meta.priority, "roundtrip: priority");
  assertEqual(parsedBody, body, "roundtrip: body");
}

// ── Unit Tests: extractMeta ──

function testExtractMeta() {
  const task = {
    id: "abc", title: "Test", status: "pending", priority: 0,
    body: "should be excluded", state: "running", filename: "abc.md",
    project: "/some/path",
  };
  const meta = extractMeta(task);
  assertEqual(meta.id, "abc", "extractMeta: id included");
  assertEqual(meta.project, "/some/path", "extractMeta: project included");
  assertEqual(meta.body, undefined, "extractMeta: body excluded");
  assertEqual(meta.state, undefined, "extractMeta: state excluded");
  assertEqual(meta.filename, undefined, "extractMeta: filename excluded");
}

// ── Unit Tests: normalizeProjects ──

function testNormalizeProjectsSingle() {
  const projects = normalizeProjects({ project: "/Users/test/my-repo" });
  assertEqual(projects.length, 1, "normalize: single project count");
  assertEqual(projects[0].name, "my-repo", "normalize: name from basename");
  assertEqual(projects[0].role, "primary", "normalize: default role");
  assert(projects[0].path.endsWith("my-repo"), "normalize: path ends with name");
}

function testNormalizeProjectsArray() {
  const input = [
    { path: "/a", name: "a", role: "primary" },
    { path: "/b", name: "b", role: "secondary" },
  ];
  const projects = normalizeProjects({ projects: input });
  assertEqual(projects.length, 2, "normalize: array count");
  assertEqual(projects[0].name, "a", "normalize: array first name");
}

function testNormalizeProjectsEmpty() {
  const projects = normalizeProjects({});
  assertEqual(projects.length, 0, "normalize: empty returns []");
}

// ── Unit Tests: createTempWorkspace / updateTaskProject / resolveProjectForTask ──

async function testCreateTempWorkspace() {
  const taskId = "tw" + generateTaskId();
  const workspacePath = await createTempWorkspace(taskId);
  assertEqual(workspacePath, path.join(WORKSPACES_DIR, taskId), "createTempWorkspace: correct path");
  const s = await stat(workspacePath);
  assert(s.isDirectory(), "createTempWorkspace: directory exists");
  // verify it's a git repo
  const gitDir = await stat(path.join(workspacePath, ".git"));
  assert(gitDir.isDirectory(), "createTempWorkspace: .git dir exists");
  // cleanup
  await rm(workspacePath, { recursive: true });
}

async function testUpdateTaskProject() {
  const taskId = generateTaskId();
  const taskPath = path.join(TASKS_DIR, "pending", `${taskId}.md`);
  await writeFile(taskPath, serializeTaskFile({ id: taskId, title: "test", status: "pending" }, "body"));
  await updateTaskProject(taskId, "/tmp/my-project");
  const content = await readFile(taskPath, "utf-8");
  const { meta } = parseTaskFile(content);
  assertEqual(meta.project, "/tmp/my-project", "updateTaskProject: project field updated");
  await rm(taskPath);
}

async function testResolveProjectForTaskWithProject() {
  const task = { project: SOURCE_ROOT };
  const projects = await resolveProjectForTask("dummyid", task);
  assertEqual(projects.length, 1, "resolveProjectForTask: returns existing project");
  assertEqual(projects[0].path, path.resolve(SOURCE_ROOT), "resolveProjectForTask: correct path");
}

async function testResolveProjectForTaskWithoutProject() {
  const taskId = generateTaskId();
  const taskPath = path.join(TASKS_DIR, "pending", `${taskId}.md`);
  await writeFile(taskPath, serializeTaskFile({ id: taskId, title: "test", status: "pending" }, "body"));

  const task = { id: taskId };
  const projects = await resolveProjectForTask(taskId, task);
  assertEqual(projects.length, 1, "resolveProjectForTask no project: returns 1 project");
  const expectedPath = path.join(WORKSPACES_DIR, taskId);
  assertEqual(projects[0].path, expectedPath, "resolveProjectForTask no project: temp workspace path");
  // verify workspace was created
  const s = await stat(expectedPath);
  assert(s.isDirectory(), "resolveProjectForTask no project: workspace dir exists");
  // verify task file was updated
  const content = await readFile(taskPath, "utf-8");
  const { meta } = parseTaskFile(content);
  assertEqual(meta.project, expectedPath, "resolveProjectForTask no project: task file updated");
  // cleanup
  await rm(expectedPath, { recursive: true });
  await rm(taskPath);
}

// ── Unit Tests: generateTaskId ──

function testGenerateTaskId() {
  const id1 = generateTaskId();
  const id2 = generateTaskId();
  assertEqual(id1.length, 8, "taskId: 8 hex chars");
  assert(/^[0-9a-f]{8}$/.test(id1), "taskId: valid hex");
  assert(id1 !== id2, "taskId: unique");
}

// ── Unit Tests: Pipeline Engine ──

function testResolvePipeline() {
  // frontmatter에서 pipeline 지정
  const config = { ...DEFAULT_CONFIG };
  const task1 = { pipeline: "implement" };
  const result1 = resolvePipeline(task1, config);
  assertEqual(result1.name, "implement", "resolvePipeline: frontmatter pipeline name");
  assertEqual(result1.steps.length, 2, "resolvePipeline: implement has 2 steps (analyze + loop)");

  // frontmatter에 없으면 defaultPipeline 사용
  const task2 = {};
  const result2 = resolvePipeline(task2, config);
  assertEqual(result2.name, "quick", "resolvePipeline: default pipeline name");
  assertDeepEqual(result2.steps, ["analyze", "implement"], "resolvePipeline: quick steps");

  // 존재하지 않는 pipeline이면 legacy fallback
  const task3 = { pipeline: "nonexistent" };
  const result3 = resolvePipeline(task3, config);
  assertEqual(result3.name, "legacy", "resolvePipeline: unknown falls back to legacy");
  assertDeepEqual(result3.steps, ["analyze", "implement"], "resolvePipeline: legacy steps");
}

function testNormalizeStep() {
  // string → stage
  const s1 = normalizeStep("analyze");
  assertEqual(s1.type, "stage", "normalizeStep: string type");
  assertEqual(s1.stage, "analyze", "normalizeStep: string stage");

  // loop object
  const s2 = normalizeStep({ loop: ["implement", "test"], maxIterations: 5 });
  assertEqual(s2.type, "loop", "normalizeStep: loop type");
  assertDeepEqual(s2.steps, ["implement", "test"], "normalizeStep: loop steps");
  assertEqual(s2.maxIterations, 5, "normalizeStep: loop maxIterations");

  // rsa object
  const s3 = normalizeStep({ rsa: "research", count: 3, strategy: "converge" });
  assertEqual(s3.type, "rsa", "normalizeStep: rsa type");
  assertEqual(s3.stage, "research", "normalizeStep: rsa stage");

  // gather object
  const s4 = normalizeStep({ gather: "autonomous" });
  assertEqual(s4.type, "gather", "normalizeStep: gather type");
  assertEqual(s4.mode, "autonomous", "normalizeStep: gather mode");

  // unknown → throw
  let threw = false;
  try { normalizeStep({ unknown: true }); } catch { threw = true; }
  assert(threw, "normalizeStep: unknown throws");
}

function testFindResumeStepIndex() {
  // analyze + loop → resume from index 1
  const steps1 = ["analyze", { loop: ["implement", "test", "self-review"], maxIterations: 3 }];
  assertEqual(findResumeStepIndex(steps1), 1, "findResumeStepIndex: skips analyze");

  // analyze + gather + loop → resume from index 2
  const steps2 = ["analyze", { gather: "autonomous" }, { loop: ["implement", "test"] }];
  assertEqual(findResumeStepIndex(steps2), 2, "findResumeStepIndex: skips analyze+gather");

  // spec + analyze + implement → resume from index 2 (spec and analyze skipped)
  const steps3 = ["spec", "analyze", "implement"];
  assertEqual(findResumeStepIndex(steps3), 2, "findResumeStepIndex: skips spec+analyze");

  // no setup stages → resume from 0
  const steps4 = ["implement", "test"];
  assertEqual(findResumeStepIndex(steps4), 0, "findResumeStepIndex: no setup stages");

  // only analyze → resume from 1
  const steps5 = ["analyze"];
  assertEqual(findResumeStepIndex(steps5), 1, "findResumeStepIndex: only analyze");
}

function testParseGateResult() {
  assertEqual(parseGateResult("some output\nGATE: PASS\n"), "pass", "parseGateResult: pass");
  assertEqual(parseGateResult("some output\nGATE: FAIL\n"), "fail", "parseGateResult: fail");
  assertEqual(parseGateResult("no gate output\n"), null, "parseGateResult: none");
  assertEqual(parseGateResult("some output\ngate: pass\n"), "pass", "parseGateResult: case-insensitive");
  assertEqual(parseGateResult("some output\nGATE: Pass\n"), "pass", "parseGateResult: mixed case");
  assertEqual(parseGateResult(null), null, "parseGateResult: null input");
}

function testExtractCriticalIssues() {
  // P1 present
  const withP1 = `### Issues\n\n**P1 — CRITICAL (must fix):**\n- [ ] Missing null check — add guard\n- [ ] SQL injection — use parameterized query\n\n**P2 — IMPORTANT (should fix):**\n- [ ] Naming inconsistency\n\nGATE: FAIL`;
  const p1Result = extractCriticalIssues(withP1);
  assert(p1Result.includes("Missing null check"), "extractCriticalIssues: contains P1 item 1");
  assert(p1Result.includes("SQL injection"), "extractCriticalIssues: contains P1 item 2");
  assert(!p1Result.includes("Naming inconsistency"), "extractCriticalIssues: excludes P2");
  assert(!p1Result.includes("GATE:"), "extractCriticalIssues: excludes GATE");

  // no P1
  const noP1 = `### Issues\n\n**P2 — IMPORTANT (should fix):**\n- [ ] Some issue\n\nGATE: PASS`;
  assertEqual(extractCriticalIssues(noP1), "", "extractCriticalIssues: no P1 returns empty");

  // empty/null input
  assertEqual(extractCriticalIssues(""), "", "extractCriticalIssues: empty string");
  assertEqual(extractCriticalIssues(null), "", "extractCriticalIssues: null input");
}

function testIsGateStep() {
  assert(isGateStep("test"), "isGateStep: test is gate");
  assert(isGateStep("self-review"), "isGateStep: self-review is gate");
  assert(isGateStep("visual-check"), "isGateStep: visual-check is gate");
  assert(!isGateStep("analyze"), "isGateStep: analyze is not gate");
  assert(!isGateStep("implement"), "isGateStep: implement is not gate");
}

function testBuildStageResultsSummary() {
  // empty
  assertEqual(buildStageResultsSummary({}), "", "buildSummary: empty");

  // multiple stages
  const result = buildStageResultsSummary({ analyze: "analysis output", implement: "impl output" });
  assert(result.includes("### analyze"), "buildSummary: has analyze header");
  assert(result.includes("### implement"), "buildSummary: has implement header");
  assert(result.includes("analysis output"), "buildSummary: has analyze content");

  // gate keys excluded
  const withGate = buildStageResultsSummary({ test: "test out", "test:gate": "pass" });
  assert(!withGate.includes("### test:gate"), "buildSummary: gate key excluded");
  assert(withGate.includes("### test"), "buildSummary: test key included");

  // truncation
  const longValue = "x".repeat(3000);
  const truncated = buildStageResultsSummary({ long: longValue });
  assert(truncated.includes("...(truncated)"), "buildSummary: long value truncated");
}

function testPipelineInMetaKeys() {
  const task = { id: "abc", title: "Test", pipeline: "implement", body: "should be excluded" };
  const meta = extractMeta(task);
  assertEqual(meta.pipeline, "implement", "extractMeta: pipeline included");
}

function testResolveMaxIterations() {
  // numeric value
  assertEqual(resolveMaxIterations(5, {}), 5, "resolveMaxIter: numeric");

  // auto with trivial difficulty
  assertEqual(resolveMaxIterations("auto", { analyze: "Difficulty: trivial\nsome text" }), 1, "resolveMaxIter: auto trivial");

  // auto with easy difficulty
  assertEqual(resolveMaxIterations("auto", { analyze: "difficulty: easy" }), 1, "resolveMaxIter: auto easy");

  // auto with medium difficulty
  assertEqual(resolveMaxIterations("auto", { analyze: "Difficulty: medium" }), 3, "resolveMaxIter: auto medium");

  // auto with hard difficulty
  assertEqual(resolveMaxIterations("auto", { analyze: "난이도: hard" }), 5, "resolveMaxIter: auto hard");

  // auto with complex difficulty
  assertEqual(resolveMaxIterations("auto", { analyze: "Difficulty: complex" }), 5, "resolveMaxIter: auto complex");

  // auto with no difficulty found
  assertEqual(resolveMaxIterations("auto", { analyze: "no difficulty info" }), 3, "resolveMaxIter: auto no match");

  // auto with empty stageResults
  assertEqual(resolveMaxIterations("auto", {}), 3, "resolveMaxIter: auto empty");

  // fallback for unknown value
  assertEqual(resolveMaxIterations(undefined, {}), 3, "resolveMaxIter: undefined fallback");
}

function testNormalizeStepMaxIterationsAuto() {
  const step = { loop: ["implement", "test"], maxIterations: "auto" };
  const normalized = normalizeStep(step);
  assertEqual(normalized.maxIterations, "auto", "normalizeStep: maxIterations auto preserved");
}

function testNormalizeStepLoopDefaults() {
  const step = { loop: ["implement", "test"] };
  const normalized = normalizeStep(step);
  assertEqual(normalized.maxIterations, 3, "normalizeStep: loop default maxIterations is 3");
}

function testTestTemplateExists() {
  try {
    fs.accessSync(path.join(__dirname, "..", "templates", "ucm-test.md"));
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("test template: ucm-test.md missing");
    process.stdout.write("F");
  }
}

function testImplementTemplateHasTestFeedback() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-implement.md"), "utf-8");
  assert(content.includes("{{TEST_FEEDBACK}}"), "implement template: has TEST_FEEDBACK placeholder");
}

function testSelfReviewTemplateExists() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-self-review.md"), "utf-8");
  assert(content.includes("{{ANALYZE_RESULT}}"), "self-review template: has ANALYZE_RESULT");
  assert(content.includes("GATE: PASS"), "self-review template: has GATE: PASS");
  assert(content.includes("GATE: FAIL"), "self-review template: has GATE: FAIL");
}

function testGatherTemplateExists() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-gather.md"), "utf-8");
  assert(content.includes("{{TASK_TITLE}}"), "gather template: has TASK_TITLE");
  assert(content.includes("{{TASK_DESCRIPTION}}"), "gather template: has TASK_DESCRIPTION");
  assert(content.includes("{{WORKSPACE}}"), "gather template: has WORKSPACE");
}

function testSpecTemplateExists() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-spec.md"), "utf-8");
  assert(content.includes("{{GATHER_RESULT}}"), "spec template: has GATHER_RESULT");
  assert(content.includes("Acceptance Criteria"), "spec template: has acceptance criteria");
}

function testRsaTemplatesExist() {
  const converge = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-rsa-converge.md"), "utf-8");
  assert(converge.includes("{{AGENT_RESULTS}}"), "rsa-converge template: has AGENT_RESULTS");
  assert(converge.includes("{{TASK_TITLE}}"), "rsa-converge template: has TASK_TITLE");

  const diverge = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-rsa-diverge.md"), "utf-8");
  assert(diverge.includes("{{AGENT_RESULTS}}"), "rsa-diverge template: has AGENT_RESULTS");

  const rsaSelfReview = fs.readFileSync(path.join(__dirname, "..", "templates", "rsa-self-review.md"), "utf-8");
  assert(rsaSelfReview.includes("GATE: PASS"), "rsa-self-review template: has GATE: PASS");
  assert(rsaSelfReview.includes("GATE: FAIL"), "rsa-self-review template: has GATE: FAIL");
  assert(rsaSelfReview.includes("P1"), "rsa-self-review template: has P1 priority");
}

function testVisualCheckTemplateExists() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-visual-check.md"), "utf-8");
  assert(content.includes("GATE: PASS"), "visual-check template: has GATE: PASS");
  assert(content.includes("{{SPEC}}"), "visual-check template: has SPEC");
}

function testDefaultConfigInfra() {
  assert(DEFAULT_CONFIG.infra !== undefined, "config: infra section exists");
  assertEqual(DEFAULT_CONFIG.infra.slots, 1, "config: infra.slots default 1");
  assertEqual(DEFAULT_CONFIG.infra.browserSlots, 1, "config: infra.browserSlots default 1");
  assert(typeof DEFAULT_CONFIG.infra.upTimeoutMs === "number", "config: infra.upTimeoutMs is number");
}

function testDefaultConfigPipelines() {
  assert(DEFAULT_CONFIG.pipelines !== undefined, "config: pipelines section exists");
  assert(DEFAULT_CONFIG.pipelines.quick !== undefined, "config: quick pipeline exists");
  assert(DEFAULT_CONFIG.pipelines.implement !== undefined, "config: implement pipeline exists");
  assert(DEFAULT_CONFIG.pipelines.research !== undefined, "config: research pipeline exists");
  assert(DEFAULT_CONFIG.pipelines.thorough !== undefined, "config: thorough pipeline exists");
  assertEqual(DEFAULT_CONFIG.defaultPipeline, "quick", "config: defaultPipeline is quick");
}

function testThoroughPipelineResolve() {
  const task = { pipeline: "thorough" };
  const cfg = { pipelines: DEFAULT_CONFIG.pipelines, defaultPipeline: "quick" };
  const result = resolvePipeline(task, cfg);
  assertEqual(result.name, "thorough", "resolvePipeline: thorough name");
  assertEqual(result.steps.length, 2, "resolvePipeline: thorough has 2 steps");
  assertEqual(result.steps[0], "analyze", "resolvePipeline: thorough step 1 is analyze");
  const loopStep = normalizeStep(result.steps[1]);
  assertEqual(loopStep.type, "loop", "resolvePipeline: thorough step 2 is loop");
  assertEqual(loopStep.steps.length, 3, "resolvePipeline: thorough loop has 3 inner steps");
  const rsaStep = normalizeStep(loopStep.steps[2]);
  assertEqual(rsaStep.type, "rsa", "resolvePipeline: thorough loop contains rsa step");
  assertEqual(rsaStep.stage, "self-review", "resolvePipeline: thorough rsa stage is self-review");
  assertEqual(rsaStep.count, 3, "resolvePipeline: thorough rsa count is 3");
  assertEqual(rsaStep.strategy, "converge", "resolvePipeline: thorough rsa strategy is converge");
}

function testSuspendedMetaKeys() {
  assert(META_KEYS.has("suspended"), "META_KEYS: has suspended");
  assert(META_KEYS.has("suspendedStage"), "META_KEYS: has suspendedStage");
  assert(META_KEYS.has("suspendedStepIndex"), "META_KEYS: has suspendedStepIndex");
}

async function testInfraLockAcquireRelease() {
  // should acquire immediately when no contention
  let acquired = false;
  const lockPromise = acquireInfraLock("test-infra-1");
  lockPromise.then(() => { acquired = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert(acquired, "infraLock: acquired immediately");
  releaseInfraLock("test-infra-1");
}

// ── Integration Tests: Directory Setup ──

async function testEnsureDirectories() {
  await ensureDirectories();
  for (const state of TASK_STATES) {
    try {
      await access(path.join(TASKS_DIR, state));
      passed++;
      process.stdout.write(".");
    } catch {
      failed++;
      failures.push(`ensureDirectories: ${state} dir missing`);
      process.stdout.write("F");
    }
  }
  try {
    await access(WORKTREES_DIR);
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("ensureDirectories: worktrees dir missing");
    process.stdout.write("F");
  }
}

// ── Integration Tests: Worktree Management ──

let testRepoPath;

async function setupTestRepo() {
  testRepoPath = path.join(os.tmpdir(), `ucm-test-${Date.now()}`);
  await mkdir(testRepoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: testRepoPath });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: testRepoPath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: testRepoPath });
  await writeFile(path.join(testRepoPath, "README.md"), "# Test Repo\n");
  execFileSync("git", ["add", "-A"], { cwd: testRepoPath });
  execFileSync("git", ["commit", "-m", "init"], { cwd: testRepoPath });
  return testRepoPath;
}

async function cleanupTestRepo() {
  if (testRepoPath) {
    try { await rm(testRepoPath, { recursive: true }); } catch {}
  }
}

async function testWorktreeCreateAndDiff() {
  const repoPath = await setupTestRepo();
  const taskId = "test0001";
  const projects = [{ path: repoPath, name: "test-repo", role: "primary" }];

  // import these dynamically to avoid circular module issues
  // We'll test the git operations directly
  const worktreeDir = path.join(WORKTREES_DIR, taskId);

  try {
    // get base commit
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath, encoding: "utf-8",
    }).trim();

    // create branch + worktree
    execFileSync("git", ["branch", `ucm/${taskId}`], { cwd: repoPath });
    await mkdir(worktreeDir, { recursive: true });
    const worktreePath = path.join(worktreeDir, "test-repo");
    execFileSync("git", ["worktree", "add", worktreePath, `ucm/${taskId}`], { cwd: repoPath });

    // write workspace.json
    await writeFile(path.join(worktreeDir, "workspace.json"), JSON.stringify({
      taskId,
      projects: [{ name: "test-repo", path: worktreePath, origin: repoPath, role: "primary", baseCommit }],
    }, null, 2));

    // verify worktree exists
    const wtStat = await stat(worktreePath);
    assert(wtStat.isDirectory(), "worktree: directory created");

    // verify workspace.json
    const ws = JSON.parse(await readFile(path.join(worktreeDir, "workspace.json"), "utf-8"));
    assertEqual(ws.taskId, taskId, "worktree: workspace.json taskId");
    assertEqual(ws.projects[0].baseCommit, baseCommit, "worktree: baseCommit stored");

    // make a change in worktree
    await writeFile(path.join(worktreePath, "new-file.txt"), "hello\n");
    execFileSync("git", ["add", "new-file.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-m", "add new file"], { cwd: worktreePath });

    // verify diff uses baseCommit
    const diff = execFileSync("git", ["diff", baseCommit], {
      cwd: worktreePath, encoding: "utf-8",
    });
    assert(diff.includes("new-file.txt"), "worktree: diff shows new file");
    assert(diff.includes("+hello"), "worktree: diff shows content");

    // verify origin is untouched
    const originFiles = await readdir(repoPath);
    assert(!originFiles.includes("new-file.txt"), "worktree: origin untouched");

    // test merge
    execFileSync("git", ["merge", `ucm/${taskId}`, "--no-edit"], { cwd: repoPath });
    const mergedFiles = await readdir(repoPath);
    assert(mergedFiles.includes("new-file.txt"), "worktree: merge brings file to origin");

    // cleanup
    execFileSync("git", ["worktree", "remove", worktreePath], { cwd: repoPath });
    execFileSync("git", ["branch", "-d", `ucm/${taskId}`], { cwd: repoPath });
  } finally {
    try { await rm(worktreeDir, { recursive: true }); } catch {}
    await cleanupTestRepo();
  }
}

// ── Integration Tests: Daemon Socket Communication ──

async function testDaemonLifecycle() {
  await cleanStaleFiles();

  const ucmdPath = path.join(__dirname, "..", "lib", "ucmd.js");

  // start daemon in foreground as child process
  const logFd = fs.openSync(LOG_PATH, "a");
  const daemon = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  daemon.unref();
  trackPid(daemon.pid);
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(daemon.pid));

  // wait for socket
  let ready = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "stats", params: {} });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert(ready, "daemon: socket ready");

  if (!ready) {
    try { process.kill(daemon.pid, "SIGTERM"); } catch {}
    return;
  }

  // test stats method
  try {
    const stats = await socketRequest({ method: "stats", params: {} });
    assertEqual(stats.daemonStatus, "running", "daemon: status is running");
    assertEqual(stats.tasksCompleted, 0, "daemon: initial tasks completed is 0");
    assert(typeof stats.pid === "number", "daemon: pid is number");
  } catch (e) {
    failed++;
    failures.push(`daemon stats: ${e.message}`);
    process.stdout.write("F");
  }

  // test submit
  try {
    const repoPath = await setupTestRepo();
    const result = await socketRequest({
      method: "submit",
      params: { title: "Test Task", body: "Test body", project: repoPath },
    });
    assertEqual(typeof result.id, "string", "daemon: submit returns id");
    assertEqual(result.title, "Test Task", "daemon: submit returns title");

    // test list
    const tasks = await socketRequest({ method: "list", params: { status: "pending" } });
    assert(tasks.length >= 1, "daemon: list shows pending task");
    const found = tasks.find((t) => t.id === result.id);
    assert(!!found, "daemon: submitted task found in list");

    // test status
    const taskStatus = await socketRequest({ method: "status", params: { taskId: result.id } });
    assertEqual(taskStatus.title, "Test Task", "daemon: status shows title");
    assertEqual(taskStatus.state, "pending", "daemon: status shows pending");

    // test cancel
    const cancelResult = await socketRequest({ method: "cancel", params: { taskId: result.id } });
    assertEqual(cancelResult.status, "failed", "daemon: cancel moves to failed");

    // verify task moved to failed
    const failedTasks = await socketRequest({ method: "list", params: { status: "failed" } });
    assert(failedTasks.some((t) => t.id === result.id), "daemon: cancelled task in failed");

    // cleanup failed task
    try { await rm(path.join(TASKS_DIR, "failed", `${result.id}.md`)); } catch {}

    await cleanupTestRepo();
  } catch (e) {
    failed++;
    failures.push(`daemon submit/list/cancel: ${e.message}`);
    process.stdout.write("F");
  }

  // test pause/resume
  try {
    const pauseResult = await socketRequest({ method: "pause", params: {} });
    assertEqual(pauseResult.status, "paused", "daemon: pause returns paused");

    const statsAfterPause = await socketRequest({ method: "stats", params: {} });
    assertEqual(statsAfterPause.daemonStatus, "paused", "daemon: stats shows paused");

    const resumeResult = await socketRequest({ method: "resume", params: {} });
    assertEqual(resumeResult.status, "running", "daemon: resume returns running");

    const statsAfterResume = await socketRequest({ method: "stats", params: {} });
    assertEqual(statsAfterResume.daemonStatus, "running", "daemon: stats shows running");
  } catch (e) {
    failed++;
    failures.push(`daemon pause/resume: ${e.message}`);
    process.stdout.write("F");
  }

  // test submit via task file
  try {
    const taskFile = `---
title: Task from File
project: /tmp
priority: 5
---

Implement something from a file.`;

    const result = await socketRequest({
      method: "submit",
      params: { taskFile },
    });
    assertEqual(result.title, "Task from File", "daemon: task file title parsed");
    assertEqual(result.priority, 5, "daemon: task file priority parsed");

    // cancel and cleanup
    await socketRequest({ method: "cancel", params: { taskId: result.id } });
    try { await rm(path.join(TASKS_DIR, "failed", `${result.id}.md`)); } catch {}
  } catch (e) {
    failed++;
    failures.push(`daemon task file submit: ${e.message}`);
    process.stdout.write("F");
  }

  // test unknown method
  try {
    await socketRequest({ method: "nonexistent", params: {} });
    failed++;
    failures.push("daemon: unknown method should throw");
    process.stdout.write("F");
  } catch (e) {
    assert(e.message.includes("unknown method"), "daemon: unknown method returns error");
  }

  // test logs for non-existent task
  try {
    const logs = await socketRequest({ method: "logs", params: { taskId: "nonexistent" } });
    assertEqual(logs, "(no logs)", "daemon: no logs for non-existent task");
  } catch (e) {
    failed++;
    failures.push(`daemon logs: ${e.message}`);
    process.stdout.write("F");
  }

  // shutdown
  try {
    await socketRequest({ method: "shutdown", params: {} });
    // wait for process to exit
    await new Promise((r) => setTimeout(r, 2000));
    assert(!isProcessAlive(daemon.pid), "daemon: process stopped after shutdown");
  } catch {
    // shutdown closes connection, this is expected
    await new Promise((r) => setTimeout(r, 2000));
    assert(!isProcessAlive(daemon.pid), "daemon: process stopped after shutdown");
  }
}

function socketRequest(request) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK_PATH);
    let data = "";
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error("TIMEOUT"));
    }, CLIENT_TIMEOUT_MS);

    conn.on("connect", () => {
      conn.write(JSON.stringify({ id: "t1", ...request }) + "\n");
    });

    conn.on("data", (chunk) => {
      data += chunk;
      const newlineIndex = data.indexOf("\n");
      if (newlineIndex !== -1) {
        clearTimeout(timeout);
        const responseLine = data.slice(0, newlineIndex);
        try {
          const response = JSON.parse(responseLine);
          if (response.ok) {
            resolve(response.data);
          } else {
            reject(new Error(response.error || "unknown error"));
          }
        } catch (e) {
          reject(new Error(`response parse error: ${e.message}`));
        }
        conn.end();
      }
    });

    conn.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

// ── Integration Test: Full Worktree + Approve/Reject Flow ──

async function testApproveRejectFlow() {
  // start daemon
  await cleanStaleFiles();
  const ucmdPath = path.join(__dirname, "..", "lib", "ucmd.js");
  const logFd = fs.openSync(LOG_PATH, "a");
  const daemon = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  daemon.unref();
  trackPid(daemon.pid);
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(daemon.pid));

  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "stats", params: {} });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!ready) {
    failed++;
    failures.push("approve/reject: daemon not ready");
    process.stdout.write("F");
    try { process.kill(daemon.pid, "SIGTERM"); } catch {}
    return;
  }

  const repoPath = await setupTestRepo();
  const projectName = path.basename(repoPath);

  try {
    // submit task
    const submitResult = await socketRequest({
      method: "submit",
      params: { title: "Approve Test", body: "Add a file", project: repoPath },
    });
    const taskId = submitResult.id;

    // manually create worktree and move task to simulate pipeline completion
    const branchName = `ucm/${taskId}`;
    const worktreeDir = path.join(WORKTREES_DIR, taskId);
    await mkdir(worktreeDir, { recursive: true });

    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath, encoding: "utf-8",
    }).trim();

    execFileSync("git", ["branch", branchName], { cwd: repoPath });
    const worktreePath = path.join(worktreeDir, projectName);
    execFileSync("git", ["worktree", "add", worktreePath, branchName], { cwd: repoPath });

    await writeFile(path.join(worktreeDir, "workspace.json"), JSON.stringify({
      taskId,
      projects: [{ name: projectName, path: worktreePath, origin: repoPath, role: "primary", baseCommit }],
    }, null, 2));

    // make a change in worktree
    await writeFile(path.join(worktreePath, "approved-file.txt"), "approved\n");
    execFileSync("git", ["add", "approved-file.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-m", "add approved file"], { cwd: worktreePath });

    // move task to review (simulating pipeline completion)
    const pendingPath = path.join(TASKS_DIR, "pending", `${taskId}.md`);
    const reviewPath = path.join(TASKS_DIR, "review", `${taskId}.md`);
    const taskContent = await readFile(pendingPath, "utf-8");
    const { meta, body } = parseTaskFile(taskContent);
    meta.state = "review";
    await writeFile(reviewPath, serializeTaskFile(meta, body));
    try { await rm(pendingPath); } catch {}

    // test diff
    const diffs = await socketRequest({ method: "diff", params: { taskId } });
    assert(diffs.length === 1, "approve: diff has 1 project");
    assert(diffs[0].diff.includes("approved-file.txt"), "approve: diff shows new file");

    // test approve
    const approveResult = await socketRequest({ method: "approve", params: { taskId } });
    assertEqual(approveResult.status, "done", "approve: status is done");

    // verify file merged into origin
    const originFiles = await readdir(repoPath);
    assert(originFiles.includes("approved-file.txt"), "approve: file merged to origin");

    // verify worktree cleaned up
    try {
      await access(worktreeDir);
      failed++;
      failures.push("approve: worktree dir should be removed");
      process.stdout.write("F");
    } catch {
      passed++;
      process.stdout.write(".");
    }

    // verify origin git status is clean
    const gitStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoPath, encoding: "utf-8",
    }).trim();
    assertEqual(gitStatus, "", "approve: origin git status clean");

    // cleanup done task
    try { await rm(path.join(TASKS_DIR, "done", `${taskId}.md`)); } catch {}

  } catch (e) {
    failed++;
    failures.push(`approve flow: ${e.message}`);
    process.stdout.write("F");
  }

  // Test approve with dirty working directory
  try {
    const submitResult = await socketRequest({
      method: "submit",
      params: { title: "Dirty Approve Test", body: "Approve with dirty origin", project: repoPath },
    });
    const taskId = submitResult.id;

    const branchName = `ucm/${taskId}`;
    const worktreeDir = path.join(WORKTREES_DIR, taskId);
    await mkdir(worktreeDir, { recursive: true });

    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath, encoding: "utf-8",
    }).trim();

    execFileSync("git", ["branch", branchName], { cwd: repoPath });
    const worktreePath = path.join(worktreeDir, projectName);
    execFileSync("git", ["worktree", "add", worktreePath, branchName], { cwd: repoPath });

    await writeFile(path.join(worktreeDir, "workspace.json"), JSON.stringify({
      taskId,
      projects: [{ name: projectName, path: worktreePath, origin: repoPath, role: "primary", baseCommit }],
    }, null, 2));

    // make a change in worktree (new file)
    await writeFile(path.join(worktreePath, "dirty-approved.txt"), "from-branch\n");
    execFileSync("git", ["add", "dirty-approved.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-m", "add dirty-approved file"], { cwd: worktreePath });

    // make origin dirty (modify existing tracked file)
    await writeFile(path.join(repoPath, "README.md"), "local uncommitted change\n");

    // move task to review
    const pendingPath = path.join(TASKS_DIR, "pending", `${taskId}.md`);
    const reviewPath = path.join(TASKS_DIR, "review", `${taskId}.md`);
    const taskContent = await readFile(pendingPath, "utf-8");
    const { meta, body } = parseTaskFile(taskContent);
    meta.state = "review";
    await writeFile(reviewPath, serializeTaskFile(meta, body));
    try { await rm(pendingPath); } catch {}

    // approve should succeed despite dirty origin
    const approveResult = await socketRequest({ method: "approve", params: { taskId } });
    assertEqual(approveResult.status, "done", "dirty approve: status is done");

    // verify branch file merged
    const originFiles = await readdir(repoPath);
    assert(originFiles.includes("dirty-approved.txt"), "dirty approve: branch file merged");

    // verify local uncommitted change still exists (stash pop restored it)
    const localContent = await readFile(path.join(repoPath, "README.md"), "utf-8");
    assertEqual(localContent, "local uncommitted change\n", "dirty approve: local changes preserved");

    // cleanup
    try { await rm(path.join(TASKS_DIR, "done", `${taskId}.md`)); } catch {}
    execFileSync("git", ["checkout", "--", "README.md"], { cwd: repoPath });

  } catch (e) {
    failed++;
    failures.push(`dirty approve flow: ${e.message}`);
    process.stdout.write("F");
  }

  // Test reject with feedback
  try {
    const submitResult = await socketRequest({
      method: "submit",
      params: { title: "Reject Test", body: "Something to reject", project: repoPath },
    });
    const taskId = submitResult.id;

    // move to review
    const pendingPath = path.join(TASKS_DIR, "pending", `${taskId}.md`);
    const reviewPath = path.join(TASKS_DIR, "review", `${taskId}.md`);
    const taskContent = await readFile(pendingPath, "utf-8");
    const { meta, body } = parseTaskFile(taskContent);
    meta.state = "review";
    await writeFile(reviewPath, serializeTaskFile(meta, body));
    try { await rm(pendingPath); } catch {}

    // reject with feedback
    const rejectResult = await socketRequest({
      method: "reject",
      params: { taskId, feedback: "Fix the formatting" },
    });
    assertEqual(rejectResult.status, "running", "reject: resumes as running");

    // verify feedback is in the task file (pipeline may move it from running/ to failed/)
    let resubmittedContent;
    try {
      resubmittedContent = await readFile(path.join(TASKS_DIR, "running", `${taskId}.md`), "utf-8");
    } catch {
      resubmittedContent = await readFile(path.join(TASKS_DIR, "failed", `${taskId}.md`), "utf-8");
    }
    const { meta: resubMeta } = parseTaskFile(resubmittedContent);
    assertEqual(resubMeta.feedback, "Fix the formatting", "reject: feedback preserved");
    assert(resubMeta.state === "running" || resubMeta.state === "failed", "reject: state is running or failed");

    // cleanup
    await new Promise((r) => setTimeout(r, 500));
    try { await rm(path.join(TASKS_DIR, "failed", `${taskId}.md`)); } catch {}
    try { await rm(path.join(TASKS_DIR, "running", `${taskId}.md`)); } catch {}
  } catch (e) {
    failed++;
    failures.push(`reject flow: ${e.message}`);
    process.stdout.write("F");
  }

  await cleanupTestRepo();

  try {
    await socketRequest({ method: "shutdown", params: {} });
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}

// ── Integration Test: Config ──

async function testConfig() {
  await ensureDirectories();

  // delete existing config to test default creation
  try { await rm(CONFIG_PATH); } catch {}

  // test that config.json is created with defaults
  // We can't call loadConfig directly since it sets module-level state,
  // but we can verify the file operations
  try {
    await access(CONFIG_PATH);
    failed++;
    failures.push("config: should not exist before test");
    process.stdout.write("F");
  } catch {
    passed++;
    process.stdout.write(".");
  }
}

// ── Integration Test: Artifact Management ──

async function testArtifacts() {
  const taskId = `test-${Date.now()}`;
  const artifactDir = path.join(ARTIFACTS_DIR, taskId);

  try {
    await mkdir(artifactDir, { recursive: true });

    // write task.md
    await writeFile(path.join(artifactDir, "task.md"), "# Test Task\n");

    // write memory.json
    const memory = { timeline: [], metrics: { totalSpawns: 0, result: null } };
    await writeFile(path.join(artifactDir, "memory.json"), JSON.stringify(memory, null, 2));

    // init git
    execFileSync("git", ["init"], { cwd: artifactDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: artifactDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: artifactDir });
    execFileSync("git", ["add", "-A"], { cwd: artifactDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: artifactDir });

    // save artifact
    await writeFile(path.join(artifactDir, "analyze.md"), "# Analysis\n");
    execFileSync("git", ["add", "analyze.md"], { cwd: artifactDir });
    execFileSync("git", ["commit", "-m", "save: analyze.md"], { cwd: artifactDir });

    // verify git log
    const gitLog = execFileSync("git", ["log", "--oneline"], {
      cwd: artifactDir, encoding: "utf-8",
    }).trim();
    const commits = gitLog.split("\n");
    assert(commits.length >= 2, "artifacts: git has multiple commits");
    assert(gitLog.includes("save: analyze.md"), "artifacts: commit message correct");

    // verify file
    const content = await readFile(path.join(artifactDir, "analyze.md"), "utf-8");
    assertEqual(content, "# Analysis\n", "artifacts: file content correct");

  } finally {
    try { await rm(artifactDir, { recursive: true }); } catch {}
  }
}

// ── Unit Tests: Resource Monitor ──

function testCheckResources() {
  const resources = checkResources();
  assert(typeof resources.cpuLoad === "number", "resources: cpuLoad is number");
  assert(resources.cpuLoad >= 0, "resources: cpuLoad >= 0");
  assert(typeof resources.memoryFreeMb === "number", "resources: memoryFreeMb is number");
  assert(resources.memoryFreeMb > 0, "resources: memoryFreeMb > 0");
  assert(resources.diskFreeGb === null || typeof resources.diskFreeGb === "number", "resources: diskFreeGb is number or null");
}

function testGetResourcePressure() {
  assertEqual(getResourcePressure({ cpuLoad: 0.3, memoryFreeMb: 4096, diskFreeGb: 20 }), "normal", "pressure: normal");
  assertEqual(getResourcePressure({ cpuLoad: 0.9, memoryFreeMb: 4096, diskFreeGb: 20 }), "pressure", "pressure: high cpu");
  assertEqual(getResourcePressure({ cpuLoad: 0.3, memoryFreeMb: 500, diskFreeGb: 20 }), "pressure", "pressure: low memory");
  assertEqual(getResourcePressure({ cpuLoad: 0.3, memoryFreeMb: 4096, diskFreeGb: 2 }), "critical", "pressure: low disk");
  assertEqual(getResourcePressure({ cpuLoad: 0.3, memoryFreeMb: 4096, diskFreeGb: null }), "normal", "pressure: null disk is normal");
}

// ── Unit Tests: WebSocket (ws package) ──

function testBroadcastWsType() {
  assertEqual(typeof broadcastWs, "function", "broadcastWs is a function");
}

// ── Integration Tests: HTTP Server + WebSocket ──

async function testHttpServer() {
  // start daemon (socket-only, no HTTP)
  await cleanStaleFiles();
  const ucmdPath = path.join(__dirname, "..", "lib", "ucmd.js");
  const logFd = fs.openSync(LOG_PATH, "a");
  const daemon = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  daemon.unref();
  trackPid(daemon.pid);
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(daemon.pid));

  // wait for socket
  let ready = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "stats", params: {} });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (!ready) {
    failed++;
    failures.push("socket: daemon not ready");
    process.stdout.write("F");
    try { process.kill(daemon.pid, "SIGTERM"); } catch {}
    return;
  }

  // test stats via socket
  try {
    const data = await socketRequest({ method: "stats", params: {} });
    assert(typeof data.pid === "number", "socket: stats has pid");
    assert(data.resources !== undefined, "socket: stats has resources");
    assert(data.resources.cpuLoad !== undefined, "socket: stats has cpuLoad");
  } catch (e) {
    failed++;
    failures.push(`socket stats: ${e.message}`);
    process.stdout.write("F");
  }

  // test submit via socket
  try {
    const data = await socketRequest({ method: "submit", params: {
      title: "Socket Test Task",
      body: "Test via socket",
      project: "/tmp",
    }});
    assert(typeof data.id === "string", "socket: submit returns id");
    assertEqual(data.title, "Socket Test Task", "socket: submit returns title");

    // cleanup
    await socketRequest({ method: "cancel", params: { taskId: data.id } });
    try { await rm(path.join(TASKS_DIR, "failed", `${data.id}.md`)); } catch {}
  } catch (e) {
    failed++;
    failures.push(`socket submit: ${e.message}`);
    process.stdout.write("F");
  }

  // test cleanup socket method
  try {
    const result = await socketRequest({ method: "cleanup", params: {} });
    assert(typeof result.cleaned === "number", "cleanup: returns cleaned count");
    assert(typeof result.orphans === "number", "cleanup: returns orphans count");
  } catch (e) {
    failed++;
    failures.push(`cleanup method: ${e.message}`);
    process.stdout.write("F");
  }

  // test stats includes resources
  try {
    const stats = await socketRequest({ method: "stats", params: {} });
    assert(stats.resources !== undefined, "stats: has resources");
    assert(typeof stats.resources.cpuLoad === "number", "stats: resources.cpuLoad is number");
    assert(typeof stats.resources.memoryFreeMb === "number", "stats: resources.memoryFreeMb is number");
    assert(stats.resourcePressure !== undefined, "stats: has resourcePressure");
  } catch (e) {
    failed++;
    failures.push(`stats resources: ${e.message}`);
    process.stdout.write("F");
  }

  // shutdown
  try {
    await socketRequest({ method: "shutdown", params: {} });
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}

// ── Socket Proposals API Tests ──

async function testHttpProposalsApi() {
  // start daemon (socket-only)
  await cleanStaleFiles();
  const ucmdPath = path.join(__dirname, "..", "lib", "ucmd.js");
  const logFd = fs.openSync(LOG_PATH, "a");
  const daemon = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  daemon.unref();
  trackPid(daemon.pid);
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(daemon.pid));

  // wait for socket
  let ready = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "stats", params: {} });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!ready) {
    failed++;
    failures.push("proposals socket: daemon not ready");
    process.stdout.write("F");
    try { process.kill(daemon.pid, "SIGTERM"); } catch {}
    return;
  }

  // test proposals list via socket
  try {
    const data = await socketRequest({ method: "proposals", params: {} });
    assert(Array.isArray(data), "proposals socket: proposals returns array");
  } catch (e) {
    failed++;
    failures.push(`proposals socket list: ${e.message}`);
    process.stdout.write("F");
  }

  // test proposals filtered by status via socket
  try {
    const data = await socketRequest({ method: "proposals", params: { status: "proposed" } });
    assert(Array.isArray(data), "proposals socket: filtered proposals returns array");
  } catch (e) {
    failed++;
    failures.push(`proposals socket filtered list: ${e.message}`);
    process.stdout.write("F");
  }

  // create a proposal to test detail/priority/reject
  const proposalId = generateProposalId();
  await saveProposal({
    id: proposalId,
    title: "Test Socket Proposal",
    status: "proposed",
    category: "improvement",
    risk: "low",
    priority: 0,
    created: new Date().toISOString(),
    observationCycle: 1,
    dedupHash: computeDedupHash("Test Socket Proposal"),
    problem: "Test problem",
    change: "Test change",
    expectedImpact: "Test impact",
  });

  // test proposal evaluate via socket
  try {
    const data = await socketRequest({ method: "proposal_evaluate", params: { proposalId } });
    assertEqual(data.proposalId, proposalId, "proposals socket: proposal detail has correct id");
    assertEqual(data.status, "proposed", "proposals socket: proposal detail has correct status");
  } catch (e) {
    failed++;
    failures.push(`proposals socket evaluate: ${e.message}`);
    process.stdout.write("F");
  }

  // test proposal priority via socket
  try {
    const data = await socketRequest({ method: "proposal_priority", params: { proposalId, delta: 2 } });
    assertEqual(data.priority, 2, "proposals socket: priority updated to 2");
  } catch (e) {
    failed++;
    failures.push(`proposals socket priority: ${e.message}`);
    process.stdout.write("F");
  }

  // test proposal reject via socket
  const rejectId = generateProposalId();
  await saveProposal({
    id: rejectId,
    title: "Test Reject Proposal",
    status: "proposed",
    category: "bugfix",
    risk: "low",
    priority: 0,
    created: new Date().toISOString(),
    observationCycle: 1,
    dedupHash: computeDedupHash("Test Reject Proposal"),
    problem: "Bug",
    change: "Fix it",
    expectedImpact: "No more bug",
  });
  try {
    const data = await socketRequest({ method: "proposal_reject", params: { proposalId: rejectId } });
    assertEqual(data.status, "rejected", "proposals socket: reject sets status to rejected");
  } catch (e) {
    failed++;
    failures.push(`proposals socket reject: ${e.message}`);
    process.stdout.write("F");
  }

  // test observe status via socket
  try {
    const data = await socketRequest({ method: "observe_status", params: {} });
    assert(data.observerConfig !== undefined, "proposals socket: observe status has observerConfig");
  } catch (e) {
    failed++;
    failures.push(`proposals socket observe_status: ${e.message}`);
    process.stdout.write("F");
  }

  // shutdown
  try {
    await socketRequest({ method: "shutdown", params: {} });
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
}

// ── Integration Test: Lessons Directory ──

async function testLessonsDirectory() {
  await ensureDirectories();
  try {
    await access(LESSONS_DIR);
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("ensureDirectories: lessons dir missing");
    process.stdout.write("F");
  }
  try {
    await access(path.join(LESSONS_DIR, "global"));
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("ensureDirectories: lessons/global dir missing");
    process.stdout.write("F");
  }
}

async function testCollectRelevantLessons() {
  // empty directory — no lessons
  const emptyResult = await collectRelevantLessons("nonexistent-project");
  assertEqual(emptyResult, "(no relevant lessons)", "collectRelevantLessons: empty returns placeholder");

  // with lesson files
  const testProject = "test-lessons-project";
  const lessonsDir = path.join(LESSONS_DIR, testProject);
  await mkdir(lessonsDir, { recursive: true });
  await writeFile(path.join(lessonsDir, "lesson-001.md"), "---\nseverity: high\n---\n\n## Lesson 1: Test\n\n**Problem:** broken\n**Solution:** fix it");
  await writeFile(path.join(lessonsDir, "lesson-002.md"), "---\nseverity: low\n---\n\n## Lesson 2: Minor\n\n**Problem:** style\n**Solution:** reformat");

  const result = await collectRelevantLessons(testProject);
  assert(result.includes("Lesson 1"), "collectRelevantLessons: contains lesson 1");
  assert(result.includes("Lesson 2"), "collectRelevantLessons: contains lesson 2");
  // high severity should come first
  assert(result.indexOf("severity: high") < result.indexOf("severity: low"), "collectRelevantLessons: high severity first");

  // cleanup
  await rm(lessonsDir, { recursive: true });
}

async function testLoadProjectPreferences() {
  const testDir = path.join(os.tmpdir(), `ucm-pref-test-${process.pid}`);
  await mkdir(testDir, { recursive: true });

  // no file
  const noFile = await loadProjectPreferences(testDir);
  assertEqual(noFile, "", "loadProjectPreferences: no file returns empty");

  // string preferences
  await writeFile(path.join(testDir, ".ucm.json"), JSON.stringify({ devCommand: "npm run dev", preferences: "- 함수형 우선\n- vitest 사용" }));
  const strResult = await loadProjectPreferences(testDir);
  assert(strResult.includes("함수형 우선"), "loadProjectPreferences: string contains content");

  // array preferences
  await writeFile(path.join(testDir, ".ucm.json"), JSON.stringify({ preferences: ["함수형 스타일", "Result 패턴", "vitest"] }));
  const arrResult = await loadProjectPreferences(testDir);
  assert(arrResult.includes("- 함수형 스타일"), "loadProjectPreferences: array item 1");
  assert(arrResult.includes("- Result 패턴"), "loadProjectPreferences: array item 2");
  assert(arrResult.includes("- vitest"), "loadProjectPreferences: array item 3");

  // no preferences field
  await writeFile(path.join(testDir, ".ucm.json"), JSON.stringify({ devCommand: "npm run dev" }));
  const noPrefs = await loadProjectPreferences(testDir);
  assertEqual(noPrefs, "", "loadProjectPreferences: no field returns empty");

  await rm(testDir, { recursive: true });
}

// ── Self-Update Tests ──

function testDataVersion() {
  assert(typeof DATA_VERSION === "number", "DATA_VERSION: is number");
  assert(DATA_VERSION >= 1, "DATA_VERSION: >= 1");
}

function testDefaultStateDataVersion() {
  const state = defaultState();
  assertEqual(state.dataVersion, DATA_VERSION, "defaultState: dataVersion matches DATA_VERSION");
}

function testSourceRoot() {
  // SOURCE_ROOT should be an actual git repo
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: SOURCE_ROOT, encoding: "utf-8" }).trim();
    assert(toplevel.length > 0, "SOURCE_ROOT: is a git repo");
  } catch {
    failed++;
    failures.push("SOURCE_ROOT: not a git repo");
    process.stdout.write("F");
  }
}

// ── Unit Tests: Observer / Proposals ──

function testGenerateProposalId() {
  const id1 = generateProposalId();
  const id2 = generateProposalId();
  assert(id1.startsWith("p-"), "proposalId: starts with p-");
  assertEqual(id1.length, 10, "proposalId: 10 chars (p- + 8 hex)");
  assert(/^p-[0-9a-f]{8}$/.test(id1), "proposalId: valid format");
  assert(id1 !== id2, "proposalId: unique");
}

function testComputeDedupHash() {
  const hash1 = computeDedupHash("title", "template", "change");
  const hash2 = computeDedupHash("title", "template", "change");
  const hash3 = computeDedupHash("different", "core", "other");
  assertEqual(hash1, hash2, "dedupHash: same input same hash");
  assert(hash1 !== hash3, "dedupHash: different input different hash");
  assertEqual(hash1.length, 16, "dedupHash: 16 chars");

  // whitespace normalization
  const hash4 = computeDedupHash("  title  ", "template", "  change  ");
  const hash5 = computeDedupHash("title", "template", "change");
  assertEqual(hash4, hash5, "dedupHash: whitespace normalized");
}

function testSerializeAndParseProposal() {
  const proposal = {
    id: "p-abcd1234",
    title: "테스트 제안",
    status: "proposed",
    category: "template",
    risk: "low",
    priority: 10,
    created: "2026-02-09T12:00:00Z",
    observationCycle: 1,
    dedupHash: "abc123",
    implementedBy: null,
    relatedTasks: ["task1", "task2"],
    problem: "문제 설명",
    change: "변경 내용",
    expectedImpact: "예상 효과",
  };

  const serialized = serializeProposal(proposal);
  assert(serialized.startsWith("---\n"), "serializeProposal: starts with frontmatter");
  assert(serialized.includes("id: p-abcd1234"), "serializeProposal: contains id");
  assert(serialized.includes("category: template"), "serializeProposal: contains category");
  assert(serialized.includes("## Problem"), "serializeProposal: contains Problem section");
  assert(serialized.includes("## Proposed Change"), "serializeProposal: contains Change section");
  assert(serialized.includes("## Expected Impact"), "serializeProposal: contains Impact section");

  const parsed = parseProposalFile(serialized);
  assertEqual(parsed.id, "p-abcd1234", "parseProposal: id");
  assertEqual(parsed.title, "테스트 제안", "parseProposal: title");
  assertEqual(parsed.category, "template", "parseProposal: category");
  assertEqual(parsed.risk, "low", "parseProposal: risk");
  assertEqual(parsed.priority, 10, "parseProposal: priority");
  assert(parsed.problem.includes("문제 설명"), "parseProposal: problem");
  assert(parsed.change.includes("변경 내용"), "parseProposal: change");
  assert(parsed.expectedImpact.includes("예상 효과"), "parseProposal: expectedImpact");
}

async function testSaveAndLoadProposal() {
  await ensureDirectories();
  const proposal = {
    id: generateProposalId(),
    title: "테스트 저장",
    status: "proposed",
    category: "config",
    risk: "low",
    priority: 0,
    created: new Date().toISOString(),
    observationCycle: 1,
    dedupHash: computeDedupHash("테스트 저장", "config", "test change"),
    implementedBy: null,
    relatedTasks: [],
    problem: "problem",
    change: "test change",
    expectedImpact: "impact",
  };

  await saveProposal(proposal);

  const loaded = await loadProposal(proposal.id);
  assert(loaded !== null, "loadProposal: found");
  assertEqual(loaded.id, proposal.id, "loadProposal: id matches");
  assertEqual(loaded.title, "테스트 저장", "loadProposal: title matches");
  assertEqual(loaded.category, "config", "loadProposal: category matches");

  // cleanup
  try { await rm(path.join(PROPOSALS_DIR, "proposed", `${proposal.id}.md`)); } catch {}
}

async function testListProposals() {
  await ensureDirectories();
  const proposal1 = {
    id: generateProposalId(),
    title: "제안 A",
    status: "proposed",
    category: "template",
    risk: "low",
    priority: 10,
    created: new Date().toISOString(),
    observationCycle: 1,
    dedupHash: "hash_a",
    implementedBy: null,
    relatedTasks: [],
    problem: "p", change: "c", expectedImpact: "i",
  };
  const proposal2 = {
    id: generateProposalId(),
    title: "제안 B",
    status: "proposed",
    category: "core",
    risk: "medium",
    priority: 5,
    created: new Date().toISOString(),
    observationCycle: 1,
    dedupHash: "hash_b",
    implementedBy: null,
    relatedTasks: [],
    problem: "p", change: "c", expectedImpact: "i",
  };

  await saveProposal(proposal1);
  await saveProposal(proposal2);

  const all = await listProposals("proposed");
  assert(all.length >= 2, "listProposals: at least 2");
  // should be sorted by priority desc
  const found1 = all.find((p) => p.id === proposal1.id);
  const found2 = all.find((p) => p.id === proposal2.id);
  assert(!!found1, "listProposals: found proposal A");
  assert(!!found2, "listProposals: found proposal B");
  const idx1 = all.indexOf(found1);
  const idx2 = all.indexOf(found2);
  assert(idx1 < idx2, "listProposals: sorted by priority desc");

  // cleanup
  try { await rm(path.join(PROPOSALS_DIR, "proposed", `${proposal1.id}.md`)); } catch {}
  try { await rm(path.join(PROPOSALS_DIR, "proposed", `${proposal2.id}.md`)); } catch {}
}

function testCaptureMetricsSnapshot() {
  const tasks = [
    {
      id: "t1", title: "Task 1", state: "done", project: "my-app",
      timeline: [
        { stage: "analyze", status: "done", durationMs: 5000, timestamp: "2026-01-01" },
        { stage: "implement", status: "done", durationMs: 10000, timestamp: "2026-01-01", iteration: 1 },
        { stage: "test", status: "done", durationMs: 3000, timestamp: "2026-01-01", iteration: 1 },
      ],
    },
    {
      id: "t2", title: "Task 2", state: "failed", project: "other-app",
      timeline: [
        { stage: "analyze", status: "done", durationMs: 4000, timestamp: "2026-01-01" },
        { stage: "implement", status: "failed", durationMs: 15000, timestamp: "2026-01-01" },
      ],
    },
  ];

  const metrics = captureMetricsSnapshot(tasks);
  assertEqual(metrics.taskCount, 2, "metrics: taskCount");
  assertEqual(metrics.successRate, 0.5, "metrics: successRate");
  assert(metrics.avgPipelineDurationMs > 0, "metrics: avgPipelineDurationMs > 0");
  assert(metrics.stageMetrics.analyze !== undefined, "metrics: analyze stage exists");
  assert(metrics.stageMetrics.implement !== undefined, "metrics: implement stage exists");
  assert(typeof metrics.timestamp === "string", "metrics: has timestamp");

  // per-project metrics
  assert(metrics.projectMetrics !== undefined, "metrics: has projectMetrics");
  assert(metrics.projectMetrics["my-app"] !== undefined, "metrics: has my-app project");
  assertEqual(metrics.projectMetrics["my-app"].taskCount, 1, "metrics: my-app taskCount");
  assertEqual(metrics.projectMetrics["my-app"].successRate, 1, "metrics: my-app successRate");
  assertEqual(metrics.projectMetrics["other-app"].successRate, 0, "metrics: other-app successRate");
}

function testParseObserverOutput() {
  // valid output without project (UCM-level)
  const output = '```json\n[\n  {\n    "title": "Test Proposal",\n    "category": "template",\n    "risk": "low",\n    "problem": "Some problem",\n    "change": "Some change",\n    "expectedImpact": "Some impact",\n    "relatedTasks": ["t1"]\n  }\n]\n```';
  const proposals = parseObserverOutput(output, 1, { taskCount: 5 });
  assertEqual(proposals.length, 1, "parseObserverOutput: 1 proposal");
  assertEqual(proposals[0].title, "Test Proposal", "parseObserverOutput: title");
  assertEqual(proposals[0].category, "template", "parseObserverOutput: category");
  assertEqual(proposals[0].status, "proposed", "parseObserverOutput: status");
  assert(proposals[0].id.startsWith("p-"), "parseObserverOutput: valid id");
  assertEqual(proposals[0].observationCycle, 1, "parseObserverOutput: cycle");
  assertDeepEqual(proposals[0].relatedTasks, ["t1"], "parseObserverOutput: relatedTasks");
  assertEqual(proposals[0].project, null, "parseObserverOutput: null project for UCM-level");

  // valid output with project
  const outputWithProject = '```json\n[{"title":"Fix X","category":"config","change":"y","project":"/home/user/my-app"}]\n```';
  const projProposals = parseObserverOutput(outputWithProject, 2, {});
  assertEqual(projProposals.length, 1, "parseObserverOutput: project proposal count");
  assertEqual(projProposals[0].project, "/home/user/my-app", "parseObserverOutput: project path preserved");

  // invalid JSON
  const empty = parseObserverOutput("not json at all", 1, {});
  assertEqual(empty.length, 0, "parseObserverOutput: invalid JSON returns empty");

  // empty array
  const emptyArray = parseObserverOutput("```json\n[]\n```", 1, {});
  assertEqual(emptyArray.length, 0, "parseObserverOutput: empty array");

  // invalid category filtered out
  const invalidCat = parseObserverOutput('```json\n[{"title":"x","category":"invalid","change":"y"}]\n```', 1, {});
  assertEqual(invalidCat.length, 0, "parseObserverOutput: invalid category filtered");

  // missing required fields filtered out
  const missingFields = parseObserverOutput('```json\n[{"title":"x"}]\n```', 1, {});
  assertEqual(missingFields.length, 0, "parseObserverOutput: missing fields filtered");
}

function testDefaultConfigObserver() {
  assert(DEFAULT_CONFIG.observer !== undefined, "config: observer section exists");
  assertEqual(DEFAULT_CONFIG.observer.enabled, true, "config: observer.enabled default true");
  assertEqual(DEFAULT_CONFIG.observer.maxProposalsPerCycle, 5, "config: observer.maxProposalsPerCycle");
  assertEqual(DEFAULT_CONFIG.observer.taskCountTrigger, 10, "config: observer.taskCountTrigger");
  assertEqual(DEFAULT_CONFIG.observer.proposalRetentionDays, 30, "config: observer.proposalRetentionDays");
}

function testProposalConstants() {
  assertDeepEqual(PROPOSAL_STATUSES, ["proposed", "approved", "rejected", "implemented"], "PROPOSAL_STATUSES");
  assert(VALID_CATEGORIES.has("template"), "VALID_CATEGORIES: template");
  assert(VALID_CATEGORIES.has("core"), "VALID_CATEGORIES: core");
  assert(VALID_CATEGORIES.has("config"), "VALID_CATEGORIES: config");
  assert(VALID_CATEGORIES.has("test"), "VALID_CATEGORIES: test");
  assert(!VALID_CATEGORIES.has("invalid"), "VALID_CATEGORIES: no invalid");
  assert(VALID_RISKS.has("low"), "VALID_RISKS: low");
  assert(VALID_RISKS.has("medium"), "VALID_RISKS: medium");
  assert(VALID_RISKS.has("high"), "VALID_RISKS: high");
}

function testObserveTemplateExists() {
  try {
    fs.accessSync(path.join(__dirname, "..", "templates", "ucm-observe.md"));
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("observe template: ucm-observe.md missing");
    process.stdout.write("F");
  }
}

function testObserveTemplateHasPlaceholders() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-observe.md"), "utf-8");
  assert(content.includes("{{METRICS_SNAPSHOT}}"), "observe template: has METRICS_SNAPSHOT");
  assert(content.includes("{{TASK_SUMMARY}}"), "observe template: has TASK_SUMMARY");
  assert(content.includes("{{LESSONS_SUMMARY}}"), "observe template: has LESSONS_SUMMARY");
  assert(content.includes("{{TEMPLATES_INFO}}"), "observe template: has TEMPLATES_INFO");
  assert(content.includes("{{EXISTING_PROPOSALS}}"), "observe template: has EXISTING_PROPOSALS");
}

async function testProposalDirectories() {
  await ensureDirectories();
  for (const status of PROPOSAL_STATUSES) {
    try {
      await access(path.join(PROPOSALS_DIR, status));
      passed++;
      process.stdout.write(".");
    } catch {
      failed++;
      failures.push(`ensureDirectories: proposals/${status} dir missing`);
      process.stdout.write("F");
    }
  }
  try {
    await access(SNAPSHOTS_DIR);
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("ensureDirectories: snapshots dir missing");
    process.stdout.write("F");
  }
}

// ── Multi-Perspective Observer Tests ──

function testObserverPerspectivesDefined() {
  assert(OBSERVER_PERSPECTIVES !== undefined, "OBSERVER_PERSPECTIVES: exported");
  const names = Object.keys(OBSERVER_PERSPECTIVES);
  assert(names.length >= 5, "OBSERVER_PERSPECTIVES: at least 5 perspectives");
  for (const name of names) {
    const p = OBSERVER_PERSPECTIVES[name];
    assert(typeof p.label === "string" && p.label.length > 0, `OBSERVER_PERSPECTIVES.${name}: has label`);
    assert(typeof p.focus === "string" && p.focus.length > 0, `OBSERVER_PERSPECTIVES.${name}: has focus`);
    assert(typeof p.priorityBoost === "number", `OBSERVER_PERSPECTIVES.${name}: has priorityBoost`);
  }
  assert(OBSERVER_PERSPECTIVES.functionality.priorityBoost > 0, "OBSERVER_PERSPECTIVES: functionality has positive priorityBoost");
}

function testExpandedCategories() {
  const expected = ["template", "core", "config", "test", "bugfix", "ux", "architecture", "performance", "docs", "research"];
  for (const cat of expected) {
    assert(VALID_CATEGORIES.has(cat), `VALID_CATEGORIES: has ${cat}`);
  }
}

function testObserveTemplateHasPerspective() {
  const content = fs.readFileSync(path.join(__dirname, "..", "templates", "ucm-observe.md"), "utf-8");
  assert(content.includes("{{PERSPECTIVE_FOCUS}}"), "observe template: has PERSPECTIVE_FOCUS placeholder");
}

function testResearchTemplateExists() {
  try {
    fs.accessSync(path.join(__dirname, "..", "templates", "ucm-observe-research.md"));
    passed++;
    process.stdout.write(".");
  } catch {
    failed++;
    failures.push("research template: ucm-observe-research.md missing");
    process.stdout.write("F");
  }
}

function testParseObserverOutputExpandedCategories() {
  const categories = ["bugfix", "ux", "architecture", "performance", "docs", "research"];
  for (const cat of categories) {
    const output = `\`\`\`json\n[{"title":"Test ${cat}","category":"${cat}","change":"some change"}]\n\`\`\``;
    const proposals = parseObserverOutput(output, 1, {});
    assertEqual(proposals.length, 1, `parseObserverOutput: ${cat} category accepted`);
    assertEqual(proposals[0].category, cat, `parseObserverOutput: ${cat} category value`);
  }
}

function testBugfixPriorityBoost() {
  const boost = OBSERVER_PERSPECTIVES.functionality.priorityBoost;
  assert(boost > 0, "bugfix priorityBoost: functionality perspective has positive boost");
  // Simulate what runObserver does: parse output then apply boost
  const output = '```json\n[{"title":"Fix critical bug","category":"bugfix","change":"fix it"}]\n```';
  const proposals = parseObserverOutput(output, 1, {});
  assertEqual(proposals.length, 1, "bugfix priorityBoost: proposal parsed");
  // Apply boost as runObserver would
  proposals[0].priority = (proposals[0].priority || 0) + boost;
  assert(proposals[0].priority >= boost, `bugfix priorityBoost: priority is at least ${boost}`);
}

// ── On-Demand Analysis / Research Tests ──

function testAnalyzeProjectExported() {
  assertEqual(typeof analyzeProject, "function", "analyzeProject: exported as function");
}

function testHandleAnalyzeProjectExported() {
  assertEqual(typeof handleAnalyzeProject, "function", "handleAnalyzeProject: exported as function");
}

function testHandleResearchProjectExported() {
  assertEqual(typeof handleResearchProject, "function", "handleResearchProject: exported as function");
}

async function testMkdirApi() {
  const testDir = path.join(TEST_UCM_DIR, "mkdir-test", "new-project");
  try { await rm(testDir, { recursive: true }); } catch {}
  await mkdir(testDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
  const s = await stat(testDir);
  assert(s.isDirectory(), "mkdir: created directory exists");
  const gitDir = await stat(path.join(testDir, ".git"));
  assert(gitDir.isDirectory(), "mkdir: git init created .git directory");
  await rm(testDir, { recursive: true });
}

function testUiModalNotClosedBeforeSuccess() {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "ucm-ui.js"), "utf-8");

  // submitTask: hideModal must be inside try block (after res.ok check), not before fetch
  const submitFn = src.match(/async function submitTask\(\)[\s\S]*?^}/m);
  assert(submitFn, "uiModal: submitTask function found");
  if (submitFn) {
    const body = submitFn[0];
    const hideIdx = body.indexOf("hideModal()");
    const fetchIdx = body.indexOf("fetch(");
    const resOkIdx = body.indexOf("res.ok");
    assert(hideIdx > fetchIdx, "uiModal: submitTask hideModal after fetch");
    assert(hideIdx > resOkIdx, "uiModal: submitTask hideModal after res.ok check");
  }

  // startRefinement: hideModal must be after fetch succeeds
  const refineFn = src.match(/async function startRefinement\(mode\)[\s\S]*?^}/m);
  assert(refineFn, "uiModal: startRefinement function found");
  if (refineFn) {
    const body = refineFn[0];
    const hideIdx = body.indexOf("hideModal()");
    const fetchIdx = body.indexOf("fetch(");
    assert(hideIdx > fetchIdx, "uiModal: startRefinement hideModal after fetch");
    // refinementSession should be set only after API success
    const sessionAssign = body.indexOf("refinementSession = {");
    assert(sessionAssign > fetchIdx, "uiModal: refinementSession set after fetch");
  }
}

function testUiRightPanelRefinementGuard() {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "ucm-ui.js"), "utf-8");
  // renderAll should not hide .right when refinementSession is active
  assert(src.includes("tasks.length === 0 && !refinementSession"), "uiPanel: renderAll guards .right with refinementSession");
  // switchPanel should not overwrite detailView when refinementSession is active
  const switchFn = src.match(/function switchPanel\(panel\)[\s\S]*?^}/m);
  assert(switchFn, "uiPanel: switchPanel function found");
  if (switchFn) {
    assert(switchFn[0].includes("!refinementSession"), "uiPanel: switchPanel guards detailView with refinementSession");
  }
  // loadInitial should preserve refinementPanel instead of calling switchPanel
  const loadFn = src.match(/async function loadInitial\(\)[\s\S]*?^}/m);
  assert(loadFn, "uiPanel: loadInitial function found");
  if (loadFn) {
    assert(loadFn[0].includes("refinementSession"), "uiPanel: loadInitial guards switchPanel with refinementSession");
  }
}

function testUiHtmlJsSyntax() {
  const { buildHtml } = require("../lib/ucm-ui.js");
  const html = buildHtml(9999);
  const start = html.lastIndexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert(start > 0 && end > start, "uiHtml: script block found");
  const script = html.substring(start + 8, end);
  try {
    new Function(script);
    assert(true, "uiHtml: JS syntax is valid");
  } catch (e) {
    assert(false, "uiHtml: JS syntax error: " + e.message);
  }
}

function testUiServerAnalyzeRoute() {
  const { PROXY_ROUTES } = require("../lib/ucm-ui-server.js");
  const found = PROXY_ROUTES.some(r => r.method === "analyze_project" && r.post === true);
  assert(found, "uiServer: PROXY_ROUTES has analyze_project POST route");
}

function testUiServerResearchRoute() {
  const { PROXY_ROUTES } = require("../lib/ucm-ui-server.js");
  const found = PROXY_ROUTES.some(r => r.method === "research_project" && r.post === true);
  assert(found, "uiServer: PROXY_ROUTES has research_project POST route");
}

function testSocketHandlerMappings() {
  const ucmdServer = require("../lib/ucmd-server.js");
  // set up minimal deps to verify socket handlers contain our new methods
  let capturedHandlers = null;
  ucmdServer.setDeps({
    config: () => ({}),
    daemonState: () => ({ daemonStatus: "running" }),
    log: () => {},
    handlers: () => {
      const h = {
        handleAnalyzeProject: () => {},
        handleResearchProject: () => {},
      };
      capturedHandlers = h;
      return h;
    },
    gracefulShutdown: () => {},
  });
  // The socket handler map is defined inside handleSocketRequest which we can't
  // directly inspect. Instead, verify that the handler registry in ucmd.js
  // includes our new handlers by checking the module exports.
  const ucmd = require("../lib/ucmd.js");
  assertEqual(typeof ucmd.handleAnalyzeProject, "function", "socketMapping: handleAnalyzeProject in ucmd exports");
  assertEqual(typeof ucmd.handleResearchProject, "function", "socketMapping: handleResearchProject in ucmd exports");
}

// ── Phase 2: Snapshot/Evaluation Tests ──

async function testSaveAndLoadSnapshot() {
  const metrics = {
    taskCount: 10,
    successRate: 0.8,
    avgPipelineDurationMs: 5000,
    loopMetrics: { avgIterations: 1.5, firstPassRate: 0.6 },
  };
  await saveSnapshot(metrics);

  const latest = await loadLatestSnapshot();
  assert(latest !== null, "saveSnapshot: latest not null");
  assertEqual(latest.metrics.taskCount, 10, "saveSnapshot: taskCount");
  assertEqual(latest.metrics.successRate, 0.8, "saveSnapshot: successRate");
  assert(latest.timestamp, "saveSnapshot: has timestamp");

  const all = await loadAllSnapshots();
  assert(all.length >= 1, "loadAllSnapshots: at least 1");
}

async function testCleanupOldSnapshots() {
  // 32개 생성 → cleanup → 30개 이하
  for (let i = 0; i < 32; i++) {
    await saveSnapshot({ taskCount: i, successRate: 0.5 });
  }
  await cleanupOldSnapshots();
  const all = await loadAllSnapshots();
  assert(all.length <= 30, `cleanupOldSnapshots: ${all.length} <= 30`);
}

function testCompareSnapshotsImproved() {
  const baseline = {
    taskCount: 10, successRate: 0.7, avgPipelineDurationMs: 10000,
    loopMetrics: { avgIterations: 2, firstPassRate: 0.4 },
  };
  const current = {
    taskCount: 15, successRate: 0.85, avgPipelineDurationMs: 4000,
    loopMetrics: { avgIterations: 1.2, firstPassRate: 0.55 },
  };
  const result = compareSnapshots(baseline, current);
  assertEqual(result.verdict, "improved", "compareSnapshots improved: verdict");
  assert(result.score > 0, "compareSnapshots improved: score > 0");
  assert(result.delta.successRate > 0, "compareSnapshots improved: successRate delta > 0");
  assert(result.delta.avgPipelineDurationMs < 0, "compareSnapshots improved: avgPipelineDurationMs delta < 0");
}

function testCompareSnapshotsRegressed() {
  const baseline = {
    taskCount: 10, successRate: 0.9, avgPipelineDurationMs: 3000,
    loopMetrics: { avgIterations: 1, firstPassRate: 0.8 },
  };
  const current = {
    taskCount: 12, successRate: 0.5, avgPipelineDurationMs: 20000,
    loopMetrics: { avgIterations: 3, firstPassRate: 0.2 },
  };
  const result = compareSnapshots(baseline, current);
  assertEqual(result.verdict, "regressed", "compareSnapshots regressed: verdict");
  assert(result.score < 0, "compareSnapshots regressed: score < 0");
}

function testCompareSnapshotsNeutral() {
  const baseline = {
    taskCount: 10, successRate: 0.8, avgPipelineDurationMs: 5000,
    loopMetrics: { avgIterations: 1.5, firstPassRate: 0.6 },
  };
  const current = {
    taskCount: 11, successRate: 0.82, avgPipelineDurationMs: 5100,
    loopMetrics: { avgIterations: 1.4, firstPassRate: 0.62 },
  };
  const result = compareSnapshots(baseline, current);
  assertEqual(result.verdict, "neutral", "compareSnapshots neutral: verdict");
}

async function testFindProposalByTaskId() {
  // 준비: implementedBy가 설정된 제안 생성
  const proposal = {
    id: generateProposalId(),
    title: "test find by taskId",
    category: "template",
    risk: "low",
    status: "implemented",
    priority: 0,
    created: new Date().toISOString(),
    observationCycle: 1,
    baselineSnapshot: { taskCount: 5, successRate: 0.7 },
    relatedTasks: [],
    dedupHash: computeDedupHash("test find by taskId", "template", "change xyz"),
    implementedBy: "task-find-test-123",
    problem: "test problem",
    change: "change xyz",
    expectedImpact: "test impact",
  };
  await saveProposal(proposal);

  const found = await findProposalByTaskId("task-find-test-123");
  assert(found !== null, "findProposalByTaskId: found");
  assertEqual(found.id, proposal.id, "findProposalByTaskId: correct id");

  const notFound = await findProposalByTaskId("nonexistent-task");
  assertEqual(notFound, null, "findProposalByTaskId: null for unknown");
}

function testCompareSnapshotsExported() {
  assert(typeof compareSnapshots === "function", "compareSnapshots exported");
  assert(typeof saveSnapshot === "function", "saveSnapshot exported");
  assert(typeof loadLatestSnapshot === "function", "loadLatestSnapshot exported");
  assert(typeof loadAllSnapshots === "function", "loadAllSnapshots exported");
  assert(typeof cleanupOldSnapshots === "function", "cleanupOldSnapshots exported");
  assert(typeof findProposalByTaskId === "function", "findProposalByTaskId exported");
  assert(typeof evaluateProposal === "function", "evaluateProposal exported");
}

// ── QnA Core Tests ──

function testExpectedConstants() {
  // EXPECTED_GREENFIELD
  assert(typeof EXPECTED_GREENFIELD === "object", "EXPECTED_GREENFIELD is object");
  assertEqual(Object.keys(EXPECTED_GREENFIELD).length, 4, "EXPECTED_GREENFIELD has 4 areas");
  assertEqual(EXPECTED_GREENFIELD["제품 정의"], 4, "EXPECTED_GREENFIELD 제품 정의 count");
  assertEqual(EXPECTED_GREENFIELD["핵심 기능"], 2, "EXPECTED_GREENFIELD 핵심 기능 count");
  assertEqual(EXPECTED_GREENFIELD["기술 스택"], 1, "EXPECTED_GREENFIELD 기술 스택 count");
  assertEqual(EXPECTED_GREENFIELD["설계 결정"], 2, "EXPECTED_GREENFIELD 설계 결정 count");

  // EXPECTED_BROWNFIELD
  assert(typeof EXPECTED_BROWNFIELD === "object", "EXPECTED_BROWNFIELD is object");
  assertEqual(Object.keys(EXPECTED_BROWNFIELD).length, 3, "EXPECTED_BROWNFIELD has 3 areas");
  assertEqual(EXPECTED_BROWNFIELD["작업 목표"], 2, "EXPECTED_BROWNFIELD 작업 목표 count");
  assertEqual(EXPECTED_BROWNFIELD["변경 범위"], 2, "EXPECTED_BROWNFIELD 변경 범위 count");
  assertEqual(EXPECTED_BROWNFIELD["설계 결정"], 2, "EXPECTED_BROWNFIELD 설계 결정 count");

  // REFINEMENT_GREENFIELD
  assert(typeof REFINEMENT_GREENFIELD === "object", "REFINEMENT_GREENFIELD is object");
  assertEqual(Object.keys(REFINEMENT_GREENFIELD).length, 6, "REFINEMENT_GREENFIELD has 6 areas");
  assertEqual(REFINEMENT_GREENFIELD["기능 요구사항"], 6, "REFINEMENT_GREENFIELD 기능 요구사항");
  assertEqual(REFINEMENT_GREENFIELD["수용 조건"], 4, "REFINEMENT_GREENFIELD 수용 조건");
  assertEqual(REFINEMENT_GREENFIELD["기술 제약"], 3, "REFINEMENT_GREENFIELD 기술 제약");
  assertEqual(REFINEMENT_GREENFIELD["범위"], 3, "REFINEMENT_GREENFIELD 범위");
  assertEqual(REFINEMENT_GREENFIELD["에지 케이스"], 3, "REFINEMENT_GREENFIELD 에지 케이스");
  assertEqual(REFINEMENT_GREENFIELD["UX/인터페이스"], 3, "REFINEMENT_GREENFIELD UX/인터페이스");

  // REFINEMENT_BROWNFIELD
  assert(typeof REFINEMENT_BROWNFIELD === "object", "REFINEMENT_BROWNFIELD is object");
  assertEqual(Object.keys(REFINEMENT_BROWNFIELD).length, 6, "REFINEMENT_BROWNFIELD has 6 areas");
  assertEqual(REFINEMENT_BROWNFIELD["변경 대상"], 3, "REFINEMENT_BROWNFIELD 변경 대상");
  assertEqual(REFINEMENT_BROWNFIELD["기능 요구사항"], 5, "REFINEMENT_BROWNFIELD 기능 요구사항");
  assertEqual(REFINEMENT_BROWNFIELD["영향 범위"], 3, "REFINEMENT_BROWNFIELD 영향 범위");
}

function testComputeCoverageGreenfield() {
  // empty decisions → all 0
  const coverage = computeCoverage([], EXPECTED_GREENFIELD);
  assertEqual(Object.keys(coverage).length, 4, "computeCoverage greenfield has 4 areas");
  assertEqual(coverage["제품 정의"], 0, "computeCoverage empty: 제품 정의 = 0");
  assertEqual(coverage["핵심 기능"], 0, "computeCoverage empty: 핵심 기능 = 0");
  assertEqual(coverage["기술 스택"], 0, "computeCoverage empty: 기술 스택 = 0");
  assertEqual(coverage["설계 결정"], 0, "computeCoverage empty: 설계 결정 = 0");
}

function testComputeCoveragePartial() {
  const decisions = [
    { area: "제품 정의", question: "q1", answer: "a1" },
    { area: "제품 정의", question: "q2", answer: "a2" },
    { area: "기술 스택", question: "q3", answer: "a3" },
  ];
  const coverage = computeCoverage(decisions, EXPECTED_GREENFIELD);
  assertEqual(coverage["제품 정의"], 0.5, "computeCoverage partial: 제품 정의 = 2/4 = 0.5");
  assertEqual(coverage["핵심 기능"], 0, "computeCoverage partial: 핵심 기능 = 0");
  assertEqual(coverage["기술 스택"], 1.0, "computeCoverage partial: 기술 스택 = 1/1 = 1.0");
  assertEqual(coverage["설계 결정"], 0, "computeCoverage partial: 설계 결정 = 0");
}

function testComputeCoverageOverflow() {
  // more decisions than expected → capped at 1.0
  const decisions = [
    { area: "기술 스택", question: "q1", answer: "a1" },
    { area: "기술 스택", question: "q2", answer: "a2" },
    { area: "기술 스택", question: "q3", answer: "a3" },
  ];
  const coverage = computeCoverage(decisions, EXPECTED_GREENFIELD);
  assertEqual(coverage["기술 스택"], 1.0, "computeCoverage overflow capped at 1.0");
}

function testComputeCoverageBrownfield() {
  const decisions = [
    { area: "작업 목표", question: "q1", answer: "a1" },
    { area: "작업 목표", question: "q2", answer: "a2" },
    { area: "변경 범위", question: "q3", answer: "a3" },
    { area: "설계 결정", question: "q4", answer: "a4" },
    { area: "설계 결정", question: "q5", answer: "a5" },
  ];
  const coverage = computeCoverage(decisions, EXPECTED_BROWNFIELD);
  assertEqual(coverage["작업 목표"], 1.0, "computeCoverage brownfield: 작업 목표 full");
  assertEqual(coverage["변경 범위"], 0.5, "computeCoverage brownfield: 변경 범위 half");
  assertEqual(coverage["설계 결정"], 1.0, "computeCoverage brownfield: 설계 결정 full");
}

function testComputeCoverageBooleanFlag() {
  // passing `true` as 2nd arg → brownfield
  const coverage = computeCoverage([], true);
  assert("작업 목표" in coverage, "computeCoverage(true) uses brownfield areas");
  assert(!("제품 정의" in coverage), "computeCoverage(true) does not have greenfield areas");

  // passing `false` → greenfield
  const coverageGf = computeCoverage([], false);
  assert("제품 정의" in coverageGf, "computeCoverage(false) uses greenfield areas");
  assert(!("작업 목표" in coverageGf), "computeCoverage(false) does not have brownfield areas");
}

function testComputeCoverageRefinement() {
  const decisions = [
    { area: "기능 요구사항", question: "q1", answer: "a1" },
    { area: "기능 요구사항", question: "q2", answer: "a2" },
    { area: "기능 요구사항", question: "q3", answer: "a3" },
  ];
  const coverage = computeCoverage(decisions, REFINEMENT_GREENFIELD);
  assertEqual(coverage["기능 요구사항"], 0.5, "computeCoverage refinement: 3/6 = 0.5");
  assertEqual(coverage["수용 조건"], 0, "computeCoverage refinement: 수용 조건 = 0");
  assertEqual(Object.keys(coverage).length, 6, "computeCoverage refinement: 6 areas");
}

function testIsFullyCovered() {
  assert(isFullyCovered({ a: 1.0, b: 1.0, c: 1.0 }), "isFullyCovered all 1.0");
  assert(!isFullyCovered({ a: 1.0, b: 0.5, c: 1.0 }), "isFullyCovered not all 1.0");
  assert(!isFullyCovered({ a: 0 }), "isFullyCovered single 0");
  assert(isFullyCovered({}), "isFullyCovered empty object");
  assert(isFullyCovered({ x: 1.5 }), "isFullyCovered > 1.0 counts as covered");
}

function testParseDecisionsFileBasic() {
  const content = `### 제품 정의

- **Q:** 어떤 제품을 만드나요?
  - **A:** 웹 앱
  - **이유:** 접근성이 좋음

### 기술 스택

- **Q:** 어떤 언어를 쓰나요?
  - **A:** TypeScript
`;
  const decisions = parseDecisionsFile(content);
  assertEqual(decisions.length, 2, "parseDecisionsFile: 2 decisions");
  assertEqual(decisions[0].area, "제품 정의", "parseDecisionsFile: first area");
  assertEqual(decisions[0].question, "어떤 제품을 만드나요?", "parseDecisionsFile: first question");
  assertEqual(decisions[0].answer, "웹 앱", "parseDecisionsFile: first answer");
  assertEqual(decisions[0].reason, "접근성이 좋음", "parseDecisionsFile: first reason");
  assertEqual(decisions[1].area, "기술 스택", "parseDecisionsFile: second area");
  assertEqual(decisions[1].answer, "TypeScript", "parseDecisionsFile: second answer");
}

function testParseDecisionsFileEmpty() {
  const decisions = parseDecisionsFile("");
  assertEqual(decisions.length, 0, "parseDecisionsFile empty: 0 decisions");
}

function testParseDecisionsFileNoReason() {
  const content = `### 범위

- **Q:** 프로젝트 범위는?
  - **A:** MVP
`;
  const decisions = parseDecisionsFile(content);
  assertEqual(decisions.length, 1, "parseDecisionsFile no reason: 1 decision");
  assertEqual(decisions[0].reason, "", "parseDecisionsFile no reason: empty reason");
}

function testParseDecisionsFileMultipleInArea() {
  const content = `### 설계 결정

- **Q:** 첫번째 질문?
  - **A:** 답1
  - **이유:** 이유1
- **Q:** 두번째 질문?
  - **A:** 답2
`;
  const decisions = parseDecisionsFile(content);
  assertEqual(decisions.length, 2, "parseDecisionsFile multi: 2 decisions");
  assertEqual(decisions[0].question, "첫번째 질문?", "parseDecisionsFile multi: q1");
  assertEqual(decisions[1].question, "두번째 질문?", "parseDecisionsFile multi: q2");
  assertEqual(decisions[0].area, "설계 결정", "parseDecisionsFile multi: same area");
  assertEqual(decisions[1].area, "설계 결정", "parseDecisionsFile multi: same area 2");
}

function testFormatDecisionsBasic() {
  const decisions = [
    { area: "제품 정의", question: "q1?", answer: "a1", reason: "r1" },
    { area: "기술 스택", question: "q2?", answer: "a2", reason: "" },
  ];
  const coverage = { "제품 정의": 0.5, "기술 스택": 1.0 };
  const md = formatDecisions(decisions, coverage);

  assert(md.includes("# 설계 결정"), "formatDecisions: has title");
  assert(md.includes("## 커버리지"), "formatDecisions: has coverage section");
  assert(md.includes("제품 정의"), "formatDecisions: has 제품 정의");
  assert(md.includes("50%"), "formatDecisions: has 50%");
  assert(md.includes("100%"), "formatDecisions: has 100%");
  assert(md.includes("## 결정 사항"), "formatDecisions: has decisions section");
  assert(md.includes("### 제품 정의"), "formatDecisions: area heading");
  assert(md.includes("**Q:** q1?"), "formatDecisions: question");
  assert(md.includes("**A:** a1"), "formatDecisions: answer");
  assert(md.includes("**이유:** r1"), "formatDecisions: reason present");
  assert(!md.includes("**이유:** \n"), "formatDecisions: empty reason omitted");
}

function testFormatDecisionsNoCoverage() {
  const decisions = [
    { area: "범위", question: "q?", answer: "a", reason: "" },
  ];
  const md = formatDecisions(decisions, null);
  assert(!md.includes("## 커버리지"), "formatDecisions no coverage: skips section");
  assert(md.includes("### 범위"), "formatDecisions no coverage: has area");
}

function testFormatDecisionsEmpty() {
  const md = formatDecisions([], {});
  assert(md.includes("# 설계 결정"), "formatDecisions empty: has title");
  assert(md.includes("## 결정 사항"), "formatDecisions empty: has decisions section");
}

function testFormatDecisionsRoundtrip() {
  const original = [
    { area: "제품 정의", question: "어떤 제품?", answer: "웹 앱", reason: "접근성" },
    { area: "제품 정의", question: "규모는?", answer: "MVP", reason: "" },
    { area: "기술 스택", question: "언어는?", answer: "JS", reason: "생태계" },
  ];
  const md = formatDecisions(original, null);
  const parsed = parseDecisionsFile(md);

  assertEqual(parsed.length, 3, "roundtrip: same count");
  assertEqual(parsed[0].area, "제품 정의", "roundtrip: area 0");
  assertEqual(parsed[0].question, "어떤 제품?", "roundtrip: question 0");
  assertEqual(parsed[0].answer, "웹 앱", "roundtrip: answer 0");
  assertEqual(parsed[0].reason, "접근성", "roundtrip: reason 0");
  assertEqual(parsed[2].area, "기술 스택", "roundtrip: area 2");
}

function testBuildQuestionPromptGreenfield() {
  const coverage = computeCoverage([], false);
  const prompt = buildQuestionPrompt(null, [], null, {
    isResume: false,
    isBrownfield: false,
    coverage,
    repoContext: null,
  });

  assert(typeof prompt === "string", "buildQuestionPrompt returns string");
  assert(prompt.includes("인터뷰어"), "buildQuestionPrompt: has interviewer role");
  assert(prompt.includes("제품 정의"), "buildQuestionPrompt greenfield: has 제품 정의");
  assert(prompt.includes("핵심 기능"), "buildQuestionPrompt greenfield: has 핵심 기능");
  assert(prompt.includes("기술 스택"), "buildQuestionPrompt greenfield: has 기술 스택");
  assert(prompt.includes("설계 결정"), "buildQuestionPrompt greenfield: has 설계 결정");
  assert(prompt.includes("0%"), "buildQuestionPrompt: has 0% coverage");
  assert(!prompt.includes("브라운필드"), "buildQuestionPrompt greenfield: no brownfield");
  assert(prompt.includes("JSON만 출력"), "buildQuestionPrompt: has JSON instruction");
}

function testBuildQuestionPromptBrownfield() {
  const coverage = computeCoverage([], true);
  const prompt = buildQuestionPrompt(null, [], null, {
    isResume: false,
    isBrownfield: true,
    coverage,
    repoContext: "파일 구조: src/ lib/ test/",
  });

  assert(prompt.includes("브라운필드"), "buildQuestionPrompt brownfield: has brownfield section");
  assert(prompt.includes("작업 목표"), "buildQuestionPrompt brownfield: has 작업 목표");
  assert(prompt.includes("변경 범위"), "buildQuestionPrompt brownfield: has 변경 범위");
  assert(prompt.includes("스캔 요약"), "buildQuestionPrompt brownfield: has scan summary");
  assert(prompt.includes("파일 구조: src/ lib/ test/"), "buildQuestionPrompt brownfield: has repoContext");
  assert(!prompt.includes("코드 스캔 (필수)"), "buildQuestionPrompt with context: skips scan instruction");
}

function testBuildQuestionPromptBrownfieldNoContext() {
  const coverage = computeCoverage([], true);
  const prompt = buildQuestionPrompt(null, [], null, {
    isResume: false,
    isBrownfield: true,
    coverage,
    repoContext: null,
  });

  assert(prompt.includes("코드 스캔 (필수)"), "buildQuestionPrompt brownfield no context: has scan instruction");
  assert(!prompt.includes("스캔 요약"), "buildQuestionPrompt brownfield no context: no scan summary");
}

function testBuildQuestionPromptWithDecisions() {
  const decisions = [
    { area: "제품 정의", question: "무엇을 만드나요?", answer: "CLI 도구" },
  ];
  const coverage = computeCoverage(decisions, false);
  const prompt = buildQuestionPrompt(null, decisions, null, {
    isResume: false,
    isBrownfield: false,
    coverage,
    repoContext: null,
  });

  assert(prompt.includes("지금까지 수집된 결정"), "buildQuestionPrompt with decisions: has collected section");
  assert(prompt.includes("[제품 정의]"), "buildQuestionPrompt with decisions: has area");
  assert(prompt.includes("CLI 도구"), "buildQuestionPrompt with decisions: has answer");
  assert(prompt.includes("25%"), "buildQuestionPrompt with decisions: 1/4 = 25%");
}

function testBuildQuestionPromptWithTemplate() {
  const template = "## 커스텀 템플릿\n\n질문 가이드라인";
  const coverage = computeCoverage([], false);
  const prompt = buildQuestionPrompt(template, [], null, {
    isResume: false,
    isBrownfield: false,
    coverage,
    repoContext: null,
  });

  assert(prompt.includes("커스텀 템플릿"), "buildQuestionPrompt with template: includes template");
  assert(prompt.includes("질문 가이드라인"), "buildQuestionPrompt with template: includes content");
  assert(!prompt.includes("템플릿 없음"), "buildQuestionPrompt with template: no fallback");
}

function testBuildQuestionPromptNoTemplate() {
  const coverage = computeCoverage([], false);
  const prompt = buildQuestionPrompt(null, [], null, {
    isResume: false,
    isBrownfield: false,
    coverage,
    repoContext: null,
  });

  assert(prompt.includes("템플릿 없음"), "buildQuestionPrompt no template: has fallback");
}

function testBuildQuestionPromptWithFeedback() {
  const coverage = computeCoverage([], false);
  const prompt = buildQuestionPrompt(null, [], "사용자가 React를 선호합니다", {
    isResume: false,
    isBrownfield: false,
    coverage,
    repoContext: null,
  });

  assert(prompt.includes("추가 컨텍스트"), "buildQuestionPrompt with feedback: has context section");
  assert(prompt.includes("React를 선호"), "buildQuestionPrompt with feedback: has feedback content");
}

function testBuildRefinementPromptGreenfield() {
  const coverage = computeCoverage([], REFINEMENT_GREENFIELD);
  const prompt = buildRefinementPrompt([], "로그인 기능 구현", {
    coverage,
    repoContext: null,
    isBrownfield: false,
  });

  assert(typeof prompt === "string", "buildRefinementPrompt returns string");
  assert(prompt.includes("태스크 요구사항을 구체화"), "buildRefinementPrompt: has role");
  assert(prompt.includes("기능 요구사항"), "buildRefinementPrompt greenfield: has 기능 요구사항");
  assert(prompt.includes("수용 조건"), "buildRefinementPrompt greenfield: has 수용 조건");
  assert(prompt.includes("기술 제약"), "buildRefinementPrompt greenfield: has 기술 제약");
  assert(prompt.includes("에지 케이스"), "buildRefinementPrompt greenfield: has 에지 케이스");
  assert(prompt.includes("UX/인터페이스"), "buildRefinementPrompt greenfield: has UX/인터페이스");
  assert(prompt.includes("로그인 기능 구현"), "buildRefinementPrompt: has task description");
  assert(!prompt.includes("브라운필드"), "buildRefinementPrompt greenfield: no brownfield");
}

function testBuildRefinementPromptBrownfield() {
  const coverage = computeCoverage([], REFINEMENT_BROWNFIELD);
  const prompt = buildRefinementPrompt([], "버그 수정", {
    coverage,
    repoContext: "main.js, utils.js",
    isBrownfield: true,
  });

  assert(prompt.includes("브라운필드"), "buildRefinementPrompt brownfield: has brownfield");
  assert(prompt.includes("변경 대상"), "buildRefinementPrompt brownfield: has 변경 대상");
  assert(prompt.includes("영향 범위"), "buildRefinementPrompt brownfield: has 영향 범위");
  assert(prompt.includes("main.js, utils.js"), "buildRefinementPrompt brownfield: has repoContext");
  assert(prompt.includes("버그 수정"), "buildRefinementPrompt brownfield: has description");
}

function testBuildRefinementPromptWithDecisions() {
  const decisions = [
    { area: "기능 요구사항", question: "어떤 기능?", answer: "이메일 로그인" },
  ];
  const coverage = computeCoverage(decisions, REFINEMENT_GREENFIELD);
  const prompt = buildRefinementPrompt(decisions, "로그인", {
    coverage,
    repoContext: null,
    isBrownfield: false,
  });

  assert(prompt.includes("지금까지 수집된 결정"), "buildRefinementPrompt with decisions: has section");
  assert(prompt.includes("이메일 로그인"), "buildRefinementPrompt with decisions: has answer");
}

function testBuildAutopilotRefinementPrompt() {
  const session = {
    title: "검색 기능 추가",
    description: "전문 검색 구현",
    isBrownfield: false,
    decisions: [],
    repoContext: null,
  };

  const prompt = buildAutopilotRefinementPrompt(session);

  assert(typeof prompt === "string", "buildAutopilotRefinementPrompt returns string");
  assert(prompt.includes("자동으로 구체화"), "buildAutopilotRefinementPrompt: has role");
  assert(prompt.includes("검색 기능 추가"), "buildAutopilotRefinementPrompt: has title");
  assert(prompt.includes("전문 검색 구현"), "buildAutopilotRefinementPrompt: has description");
  assert(prompt.includes("기능 요구사항"), "buildAutopilotRefinementPrompt: has greenfield areas");
  assert(prompt.includes("0%"), "buildAutopilotRefinementPrompt: coverage at 0");
  assert(prompt.includes("컨텍스트 없음"), "buildAutopilotRefinementPrompt: no context fallback");
  assert(prompt.includes("requirement"), "buildAutopilotRefinementPrompt: has requirement field");
}

function testBuildAutopilotRefinementPromptBrownfield() {
  const session = {
    title: "리팩토링",
    description: "",
    isBrownfield: true,
    decisions: [
      { area: "변경 대상", question: "어디를?", answer: "utils.js" },
    ],
    repoContext: "utils.js: 200줄, helpers 함수 모음",
  };

  const prompt = buildAutopilotRefinementPrompt(session);

  assert(prompt.includes("변경 대상"), "buildAutopilotRefinementPrompt brownfield: has area");
  assert(prompt.includes("utils.js"), "buildAutopilotRefinementPrompt brownfield: has decision");
  assert(prompt.includes("코드베이스 컨텍스트"), "buildAutopilotRefinementPrompt brownfield: has context section");
  assert(prompt.includes("200줄"), "buildAutopilotRefinementPrompt brownfield: has context content");
}

function testBuildAutopilotRefinementPromptNoDescription() {
  const session = {
    title: "테스트",
    description: "",
    isBrownfield: false,
    decisions: [],
    repoContext: null,
  };

  const prompt = buildAutopilotRefinementPrompt(session);
  assert(prompt.includes("(없음)"), "buildAutopilotRefinementPrompt no desc: shows (없음)");
}

function testFormatRefinedRequirementsBasic() {
  const decisions = [
    { area: "기능 요구사항", question: "q1", answer: "로그인 폼", requirement: "이메일/비밀번호 로그인 폼을 제공한다" },
    { area: "기능 요구사항", question: "q2", answer: "소셜 로그인", requirement: "Google OAuth 로그인을 지원한다" },
    { area: "수용 조건", question: "q3", answer: "성공 시 리다이렉트", requirement: "로그인 성공 시 대시보드로 이동" },
    { area: "기술 제약", question: "q4", answer: "Node 18+", requirement: "Node.js 18 이상 필수" },
    { area: "에지 케이스", question: "q5", answer: "잘못된 비밀번호", requirement: "5회 실패 시 계정 잠금" },
    { area: "UX/인터페이스", question: "q6", answer: "반응형", requirement: "모바일에서도 사용 가능" },
  ];

  const md = formatRefinedRequirements(decisions);

  assert(md.includes("## Refined Requirements"), "formatRefinedRequirements: has title");
  assert(md.includes("### Functional Requirements"), "formatRefinedRequirements: has functional");
  assert(md.includes("### Acceptance Criteria"), "formatRefinedRequirements: has acceptance");
  assert(md.includes("### Technical Constraints"), "formatRefinedRequirements: has constraints");
  assert(md.includes("### Edge Cases"), "formatRefinedRequirements: has edge cases");
  assert(md.includes("### UX / Interface"), "formatRefinedRequirements: has UX");
  assert(md.includes("1. 이메일/비밀번호 로그인 폼을 제공한다"), "formatRefinedRequirements: functional numbered");
  assert(md.includes("2. Google OAuth 로그인을 지원한다"), "formatRefinedRequirements: functional numbered 2");
  assert(md.includes("- 로그인 성공 시 대시보드로 이동"), "formatRefinedRequirements: acceptance bulleted");
  assert(md.includes("- 5회 실패 시 계정 잠금"), "formatRefinedRequirements: edge case bulleted");
}

function testFormatRefinedRequirementsFallbackToAnswer() {
  const decisions = [
    { area: "기능 요구사항", question: "q?", answer: "직접 답변 텍스트" },
  ];
  const md = formatRefinedRequirements(decisions);
  assert(md.includes("직접 답변 텍스트"), "formatRefinedRequirements: falls back to answer when no requirement");
}

function testFormatRefinedRequirementsBrownfield() {
  const decisions = [
    { area: "변경 대상", question: "q?", answer: "utils.js", requirement: "utils.js 리팩토링" },
    { area: "영향 범위", question: "q?", answer: "테스트 업데이트 필요", requirement: "관련 테스트 수정" },
    { area: "제약", question: "q?", answer: "하위호환", requirement: "기존 API 유지" },
  ];
  const md = formatRefinedRequirements(decisions);
  assert(md.includes("### Implementation Hints"), "formatRefinedRequirements brownfield: has impl hints");
  assert(md.includes("### Impact Scope"), "formatRefinedRequirements brownfield: has impact");
  assert(md.includes("### Technical Constraints"), "formatRefinedRequirements brownfield: 제약 maps to constraints");
  assert(md.includes("utils.js 리팩토링"), "formatRefinedRequirements brownfield: content");
}

function testFormatRefinedRequirementsEmpty() {
  const md = formatRefinedRequirements([]);
  assertEqual(md, "## Refined Requirements\n\n", "formatRefinedRequirements empty: only title");
}

function testFormatRefinedRequirementsUnknownArea() {
  const decisions = [
    { area: "알 수 없는 영역", question: "q?", answer: "a", requirement: "무언가" },
  ];
  const md = formatRefinedRequirements(decisions);
  assert(md.includes("### Functional Requirements"), "formatRefinedRequirements unknown area: falls back to functional");
  assert(md.includes("무언가"), "formatRefinedRequirements unknown area: content present");
}

function testFormatRefinedRequirementsSectionOrder() {
  const decisions = [
    { area: "에지 케이스", question: "q?", answer: "a", requirement: "edge" },
    { area: "기능 요구사항", question: "q?", answer: "a", requirement: "func" },
    { area: "범위", question: "q?", answer: "a", requirement: "scope" },
  ];
  const md = formatRefinedRequirements(decisions);
  const funcIdx = md.indexOf("### Functional Requirements");
  const edgeIdx = md.indexOf("### Edge Cases");
  const scopeIdx = md.indexOf("### Scope");
  assert(funcIdx < edgeIdx, "formatRefinedRequirements: functional before edge cases");
  assert(edgeIdx < scopeIdx, "formatRefinedRequirements: edge cases before scope");
}

function testComputeCoverageWithRefinementBrownfield() {
  const decisions = [
    { area: "변경 대상", question: "q1", answer: "a1" },
    { area: "변경 대상", question: "q2", answer: "a2" },
    { area: "변경 대상", question: "q3", answer: "a3" },
    { area: "기능 요구사항", question: "q4", answer: "a4" },
  ];
  const coverage = computeCoverage(decisions, REFINEMENT_BROWNFIELD);
  assertEqual(coverage["변경 대상"], 1.0, "refinement brownfield coverage: 변경 대상 full");
  assertEqual(coverage["기능 요구사항"], 0.2, "refinement brownfield coverage: 1/5 = 0.2");
  assertEqual(coverage["수용 조건"], 0, "refinement brownfield coverage: 수용 조건 = 0");
}

// ── (Chat tests removed — PTY bridge) ──

// ── Structure Analysis Tests ──

function testGetLanguageFamily() {
  assertEqual(getLanguageFamily(".js"), "js", "getLanguageFamily .js");
  assertEqual(getLanguageFamily(".ts"), "js", "getLanguageFamily .ts");
  assertEqual(getLanguageFamily(".tsx"), "js", "getLanguageFamily .tsx");
  assertEqual(getLanguageFamily(".py"), "py", "getLanguageFamily .py");
  assertEqual(getLanguageFamily(".go"), "go", "getLanguageFamily .go");
  assertEqual(getLanguageFamily(".java"), "java", "getLanguageFamily .java");
  assertEqual(getLanguageFamily(".rb"), "rb", "getLanguageFamily .rb");
  assertEqual(getLanguageFamily(".rs"), "rs", "getLanguageFamily .rs");
  assertEqual(getLanguageFamily(".txt"), null, "getLanguageFamily .txt");
  assertEqual(getLanguageFamily(".css"), null, "getLanguageFamily .css");
}

function testCountFunctions() {
  const jsCode = `
function foo() {}
async function bar() {}
doSomething() {
  return 1;
}
const x = 42;
`;
  assertEqual(countFunctions(jsCode, ".js"), 3, "countFunctions js");

  const pyCode = `
def hello():
    pass

async def world():
    pass

class Foo:
    pass
`;
  assertEqual(countFunctions(pyCode, ".py"), 2, "countFunctions py");

  assertEqual(countFunctions("some text", ".txt"), 0, "countFunctions unknown ext");

  const goCode = `
func main() {
}
func (s *Server) Handle() {
}
`;
  assertEqual(countFunctions(goCode, ".go"), 2, "countFunctions go");
}

function testGetSizeCategory() {
  assertEqual(getSizeCategory(50), "small", "getSizeCategory 50");
  assertEqual(getSizeCategory(100), "small", "getSizeCategory 100");
  assertEqual(getSizeCategory(200), "ok", "getSizeCategory 200");
  assertEqual(getSizeCategory(300), "ok", "getSizeCategory 300");
  assertEqual(getSizeCategory(400), "large", "getSizeCategory 400");
  assertEqual(getSizeCategory(500), "large", "getSizeCategory 500");
  assertEqual(getSizeCategory(501), "very large", "getSizeCategory 501");
  assertEqual(getSizeCategory(1000), "very large", "getSizeCategory 1000");
}

async function testAnalyzeFile() {
  const tmpFile = path.join(TEST_UCM_DIR, "test-analyze.js");
  const content = `function a() {}
function b() {}
const x = 1;
`;
  await mkdir(TEST_UCM_DIR, { recursive: true });
  await writeFile(tmpFile, content);
  const result = await analyzeFile(tmpFile);
  assertEqual(result.lines, 4, "analyzeFile lines");
  assertEqual(result.functions, 2, "analyzeFile functions");
  assertEqual(result.sizeCategory, "small", "analyzeFile sizeCategory");
}

function testGetChangedFiles() {
  // test with a non-existent path — should return empty array
  const files = getChangedFiles("/nonexistent/path", "HEAD~1");
  assertDeepEqual(files, [], "getChangedFiles nonexistent path");
}

function testFormatChangedFilesMetrics() {
  const files = [
    { path: "lib/big.js", lines: 600, functions: 20, sizeCategory: "very large" },
    { path: "lib/ok.js", lines: 150, functions: 5, sizeCategory: "ok" },
    { path: "lib/gone.js", lines: 0, functions: 0, sizeCategory: "deleted" },
  ];
  const result = formatChangedFilesMetrics(files);
  assert(result.includes("| File | Lines | Functions | Status |"), "formatChangedFiles header");
  assert(result.includes("| lib/big.js | 600 | 20 | \u26a0 very large |"), "formatChangedFiles very large");
  assert(result.includes("| lib/ok.js | 150 | 5 | ok |"), "formatChangedFiles ok");
  assert(result.includes("| lib/gone.js | 0 | 0 | deleted |"), "formatChangedFiles deleted");

  // empty input
  assertEqual(formatChangedFilesMetrics([]), "", "formatChangedFiles empty");
}

function testFormatProjectStructureMetrics() {
  const metrics = {
    totalFiles: 10,
    avgLines: 200,
    largeFileCount: 2,
    topFiles: [
      { path: "lib/main.js", lines: 500, functions: 15 },
      { path: "lib/utils.js", lines: 100, functions: 5 },
    ],
  };
  const result = formatProjectStructureMetrics("myproject", "/path/to/myproject", metrics);
  assert(result.includes("### myproject (/path/to/myproject)"), "formatProject header");
  assert(result.includes("Total: 10 files"), "formatProject total");
  assert(result.includes("Avg: 200 lines"), "formatProject avg");
  assert(result.includes(">300 lines: 2 files"), "formatProject large count");
  assert(result.includes("| lib/main.js | 500 | 15 |"), "formatProject top file");
}

// ── Git Validation Tests ──

function testIsGitRepo() {
  assert(isGitRepo(SOURCE_ROOT) === true, "isGitRepo on SOURCE_ROOT");
  assert(isGitRepo(os.tmpdir()) === false, "isGitRepo on tmpdir");
  assert(isGitRepo("/nonexistent/path/xyz") === false, "isGitRepo on nonexistent");
}

function testValidateGitProjectsValid() {
  // should not throw for valid git repo
  try {
    validateGitProjects([{ path: SOURCE_ROOT, name: "ucm" }]);
    passed++;
    process.stdout.write(".");
  } catch (e) {
    failed++;
    failures.push(`validateGitProjects valid: unexpected error: ${e.message}`);
    process.stdout.write("F");
  }
}

function testValidateGitProjectsInvalid() {
  try {
    validateGitProjects([{ path: os.tmpdir(), name: "tmp" }]);
    failed++;
    failures.push("validateGitProjects invalid: expected error");
    process.stdout.write("F");
  } catch (e) {
    assert(e.message.includes("Git validation failed"), "validateGitProjects error message");
    assert(e.message.includes("tmp"), "validateGitProjects error includes project name");
  }
}

// ── Commit History Tests ──

function testAnalyzeCommitHistory() {
  const result = analyzeCommitHistory(SOURCE_ROOT, { windowDays: 365 });
  assert(typeof result.commitCount === "number", "commitHistory has commitCount");
  assert(typeof result.avgDiffLines === "number", "commitHistory has avgDiffLines");
  assert(typeof result.maxDiffLines === "number", "commitHistory has maxDiffLines");
  assert(typeof result.largeCommitCount === "number", "commitHistory has largeCommitCount");
  assert(typeof result.commitsPerDay === "number", "commitHistory has commitsPerDay");
  assert(typeof result.avgMessageLength === "number", "commitHistory has avgMessageLength");
  assert(result.windowDays === 365, "commitHistory windowDays");
  assert(typeof result.activeDays === "number", "commitHistory has activeDays");
}

function testAnalyzeCommitHistoryNonexistent() {
  const result = analyzeCommitHistory("/nonexistent/path");
  assertEqual(result.commitCount, 0, "commitHistory nonexistent commitCount");
  assertEqual(result.avgDiffLines, 0, "commitHistory nonexistent avgDiffLines");
}

function testEmptyCommitMetrics() {
  const result = emptyCommitMetrics(14);
  assertEqual(result.commitCount, 0, "emptyCommitMetrics commitCount");
  assertEqual(result.windowDays, 14, "emptyCommitMetrics windowDays");
  assertEqual(result.activeDays, 0, "emptyCommitMetrics activeDays");
}

function testFormatCommitHistory() {
  const metrics = {
    commitCount: 10, avgDiffLines: 50, maxDiffLines: 200,
    largeCommitCount: 1, commitsPerDay: 2.5, avgMessageLength: 40,
    windowDays: 7, activeDays: 4,
  };
  const result = formatCommitHistory("myproject", metrics);
  assert(result.includes("### myproject"), "formatCommitHistory header");
  assert(result.includes("Commits: 10"), "formatCommitHistory commits");
  assert(result.includes("2.5/day"), "formatCommitHistory per day");
  assert(result.includes("Avg diff: 50 lines"), "formatCommitHistory avg diff");
  assert(result.includes("Max: 200 lines"), "formatCommitHistory max diff");
  assert(result.includes("Large commits"), "formatCommitHistory large");
}

function testFormatCommitHistoryEmpty() {
  const metrics = emptyCommitMetrics(7);
  const result = formatCommitHistory("myproject", metrics);
  assert(result.includes("No commits"), "formatCommitHistory empty");
}

// ── Documentation Coverage Tests ──

async function testScanDocumentation() {
  const result = await scanDocumentation(SOURCE_ROOT);
  assert(typeof result.hasReadme === "boolean", "scanDoc hasReadme");
  assert(typeof result.hasDocsDir === "boolean", "scanDoc hasDocsDir");
  assert(typeof result.docFileCount === "number", "scanDoc docFileCount");
  // UCM project has a README.md
  assert(result.hasReadme === true, "scanDoc SOURCE_ROOT has README");
}

async function testScanDocumentationNonexistent() {
  const result = await scanDocumentation("/nonexistent/path/xyz");
  assertEqual(result.hasReadme, false, "scanDoc nonexistent hasReadme");
  assertEqual(result.docFileCount, 0, "scanDoc nonexistent docFileCount");
}

function testFormatDocumentation() {
  const info = { hasReadme: true, hasDocsDir: true, docFileCount: 5 };
  const result = formatDocumentation("myproject", info, 20);
  assert(result.includes("### myproject"), "formatDoc header");
  assert(result.includes("README: present"), "formatDoc readme");
  assert(result.includes("docs/ directory: present"), "formatDoc docs dir");
  assert(result.includes("Doc files: 5"), "formatDoc count");
  assert(result.includes("25%"), "formatDoc ratio");
}

function testFormatDocumentationMissing() {
  const info = { hasReadme: false, hasDocsDir: false, docFileCount: 0 };
  const result = formatDocumentation("myproject", info, 10);
  assert(result.includes("MISSING"), "formatDoc missing readme");
  assert(result.includes("absent"), "formatDoc absent docs dir");
}

function testAnalyzeDocCoverage() {
  const result = analyzeDocCoverage([]);
  assertEqual(result.sourceChanged, 0, "docCoverage empty sourceChanged");
  assertEqual(result.docsChanged, 0, "docCoverage empty docsChanged");
  assertEqual(result.summary, "", "docCoverage empty summary");
}

function testAnalyzeDocCoverageWithFiles() {
  const result = analyzeDocCoverage(["lib/main.js", "lib/utils.ts", "README.md", "docs/guide.txt"]);
  assertEqual(result.sourceChanged, 2, "docCoverage sourceChanged");
  assertEqual(result.docsChanged, 2, "docCoverage docsChanged");
  assert(!result.summary.includes("Warning"), "docCoverage no warning when docs changed");

  const result2 = analyzeDocCoverage(["lib/main.js", "lib/utils.ts"]);
  assertEqual(result2.sourceChanged, 2, "docCoverage sourceOnly sourceChanged");
  assertEqual(result2.docsChanged, 0, "docCoverage sourceOnly docsChanged");
  assert(result2.summary.includes("Warning"), "docCoverage warning when no docs changed");
}

// ── Project Context Tests ──

async function testGenerateProjectContext() {
  const result = await generateProjectContext(SOURCE_ROOT);
  assert(result.files.length > 0, "generateProjectContext finds doc files");
  assert(result.hasReadme, "generateProjectContext detects README.md");
  assert(result.docFileCount > 0, "generateProjectContext docFileCount > 0");
  const readmeFile = result.files.find((f) => f.path === "README.md");
  assert(readmeFile !== undefined, "generateProjectContext includes README.md");
  assert(readmeFile.lines > 0, "README.md has lines");
  assert(readmeFile.preview.length > 0, "README.md has preview");
}

function testFormatProjectContext() {
  const context = {
    files: [
      { path: "README.md", lines: 45, preview: "# My Project — A tool for..." },
      { path: "docs/manual.md", lines: 120, preview: "# User Manual — How to..." },
    ],
    hasReadme: true,
    hasDocsDir: true,
    docFileCount: 2,
  };
  const formatted = formatProjectContext(context);
  assert(formatted.includes("### Documentation Files"), "formatProjectContext has header");
  assert(formatted.includes("| Path | Lines | Preview |"), "formatProjectContext has table header");
  assert(formatted.includes("README.md"), "formatProjectContext includes README.md");
  assert(formatted.includes("docs/manual.md"), "formatProjectContext includes docs/manual.md");
  assert(formatted.includes("Summary:"), "formatProjectContext has Summary");
  assert(formatted.includes("2 doc files"), "formatProjectContext shows file count");

  const emptyFormatted = formatProjectContext({ files: [], hasReadme: false, hasDocsDir: false, docFileCount: 0 });
  assert(emptyFormatted.includes("No documentation"), "formatProjectContext handles empty");
}

function testAutopilotPlanTemplateHasProjectContext() {
  const template = fs.readFileSync(path.join(SOURCE_ROOT, "templates/ucm-autopilot-plan.md"), "utf-8");
  assert(template.includes("{{PROJECT_CONTEXT}}"), "plan template has PROJECT_CONTEXT placeholder");
  assert(template.includes("Project Documentation State"), "plan template has documentation state section");
}

function testAutopilotReleaseTemplateUpdated() {
  const template = fs.readFileSync(path.join(SOURCE_ROOT, "templates/ucm-autopilot-release.md"), "utf-8");
  assert(template.includes("{{PROJECT_CONTEXT}}"), "release template has PROJECT_CONTEXT placeholder");
  assert(template.includes("README.md"), "release template has README.md instruction");
  assert(template.includes("CHANGELOG.md"), "release template has CHANGELOG.md instruction");
  assert(template.includes("docs/"), "release template has docs/ instruction");
  assert(!template.includes("Respond with ONLY a JSON"), "release template is no longer JSON output format");
}

// ── Template Placeholder Tests ──

function testObserveTemplateHasCommitHistory() {
  const fs2 = require("fs");
  const template = fs2.readFileSync(path.join(SOURCE_ROOT, "templates/ucm-observe.md"), "utf-8");
  assert(template.includes("{{COMMIT_HISTORY}}"), "observe template has COMMIT_HISTORY");
  assert(template.includes("{{DOC_COVERAGE_SUMMARY}}"), "observe template has DOC_COVERAGE_SUMMARY");
}

function testSelfReviewTemplateHasDocCoverage() {
  const fs2 = require("fs");
  const template = fs2.readFileSync(path.join(SOURCE_ROOT, "templates/ucm-self-review.md"), "utf-8");
  assert(template.includes("{{DOC_COVERAGE}}"), "self-review template has DOC_COVERAGE");
}

function testLargeCommitThreshold() {
  assertEqual(LARGE_COMMIT_THRESHOLD, 500, "LARGE_COMMIT_THRESHOLD is 500");
}

function testDocExtensionsAndDirs() {
  assert(DOC_EXTENSIONS.has(".md"), "DOC_EXTENSIONS has .md");
  assert(DOC_EXTENSIONS.has(".txt"), "DOC_EXTENSIONS has .txt");
  assert(DOC_EXTENSIONS.has(".rst"), "DOC_EXTENSIONS has .rst");
  assert(DOC_EXTENSIONS.has(".adoc"), "DOC_EXTENSIONS has .adoc");
  assert(DOC_DIRS.has("docs"), "DOC_DIRS has docs");
  assert(DOC_DIRS.has("doc"), "DOC_DIRS has doc");
  assert(DOC_DIRS.has("documentation"), "DOC_DIRS has documentation");
}

// ── Forge V2 Tests ──

function testSanitizeEnv() {
  const { sanitizeEnv } = require("../lib/core/llm");

  const origEnv = { ...process.env };
  process.env.PATH = "/usr/bin";
  process.env.HOME = "/home/test";
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  process.env.NODE_ENV = "test";
  process.env.GIT_AUTHOR_NAME = "tester";
  process.env.UCM_DIR = "/tmp/ucm";
  process.env.CLAUDE_CODE_SESSION = "secret123";
  process.env.CLAUDECODE = "1";
  process.env.SOME_RANDOM_VAR = "should_be_blocked";

  const env = sanitizeEnv();
  assert(env.PATH === "/usr/bin", "sanitizeEnv: PATH allowed");
  assert(env.HOME === "/home/test", "sanitizeEnv: HOME allowed");
  assert(env.ANTHROPIC_API_KEY === "sk-test-key", "sanitizeEnv: ANTHROPIC_API_KEY allowed");
  assert(env.NODE_ENV === "test", "sanitizeEnv: NODE_ prefix allowed");
  assert(env.GIT_AUTHOR_NAME === "tester", "sanitizeEnv: GIT_ prefix allowed");
  assert(env.UCM_DIR === "/tmp/ucm", "sanitizeEnv: UCM_ prefix allowed");
  assert(!env.CLAUDE_CODE_SESSION, "sanitizeEnv: CLAUDE_CODE_ blocked");
  assert(!env.CLAUDECODE, "sanitizeEnv: CLAUDECODE blocked");
  assert(!env.SOME_RANDOM_VAR, "sanitizeEnv: unknown var blocked");

  // restore
  Object.assign(process.env, origEnv);
  for (const key of ["CLAUDE_CODE_SESSION", "CLAUDECODE", "SOME_RANDOM_VAR"]) {
    delete process.env[key];
  }
}

function testExtractJsonVariants() {
  const { extractJson } = require("../lib/core/llm");

  // code block
  const r1 = extractJson('Some text\n```json\n{"a":1}\n```\nMore text');
  assertDeepEqual(r1, { a: 1 }, "extractJson: code block");

  // bare JSON object
  const r2 = extractJson('{"b":2}');
  assertDeepEqual(r2, { b: 2 }, "extractJson: bare object");

  // bare JSON array
  const r3 = extractJson('[1,2,3]');
  assertDeepEqual(r3, [1, 2, 3], "extractJson: bare array");

  // mixed text with JSON
  const r4 = extractJson('Here is the result: {"c":3} end');
  assertDeepEqual(r4, { c: 3 }, "extractJson: mixed text");

  // invalid JSON throws
  let threw = false;
  try { extractJson("no json here"); } catch { threw = true; }
  assert(threw, "extractJson: throws on invalid");
}

function testBuildCommandProviders() {
  const { buildCommand } = require("../lib/core/llm");

  // claude provider
  const claude = buildCommand({ provider: "claude", model: "sonnet", outputFormat: "stream-json" });
  assertEqual(claude.cmd, "claude", "buildCommand: claude cmd");
  assert(claude.args.includes("--model"), "buildCommand: claude has --model");
  assert(claude.args.includes("stream-json"), "buildCommand: claude has output format");

  // codex provider
  const codex = buildCommand({ provider: "codex", model: "opus", cwd: "/tmp" });
  assertEqual(codex.cmd, "codex", "buildCommand: codex cmd");
  assert(codex.args.includes("exec"), "buildCommand: codex has exec");

  // unknown provider throws
  let threw = false;
  try { buildCommand({ provider: "unknown" }); } catch { threw = true; }
  assert(threw, "buildCommand: unknown provider throws");
}

function testStageModelsProxy() {
  const { STAGE_MODELS } = require("../lib/core/constants");

  assertEqual(STAGE_MODELS.intake, "sonnet", "STAGE_MODELS: intake default");
  assertEqual(STAGE_MODELS.implement, "opus", "STAGE_MODELS: implement default");
  assertEqual(typeof STAGE_MODELS.specify, "object", "STAGE_MODELS: specify is object");
  assertEqual(STAGE_MODELS.specify.worker, "sonnet", "STAGE_MODELS: specify.worker default");
  assertEqual(STAGE_MODELS.specify.converge, "opus", "STAGE_MODELS: specify.converge default");
  assertEqual(STAGE_MODELS.nonexistent, undefined, "STAGE_MODELS: nonexistent returns undefined");

  // env override
  process.env.UCM_MODEL_DESIGN = "haiku";
  // Note: STAGE_MODELS proxy reads env at access time for string types
  assertEqual(STAGE_MODELS.design, "haiku", "STAGE_MODELS: env override works");
  delete process.env.UCM_MODEL_DESIGN;
}

function testCheckRequiredArtifactsLogic() {
  const { STAGE_ARTIFACTS } = require("../lib/core/constants");

  // stages with no requirements should pass
  assert(STAGE_ARTIFACTS.deliver.requires.length === 0, "STAGE_ARTIFACTS: deliver requires empty");
  assert(STAGE_ARTIFACTS.verify.requires.length === 0, "STAGE_ARTIFACTS: verify requires empty");
  assert(STAGE_ARTIFACTS.integrate.requires.length === 0, "STAGE_ARTIFACTS: integrate requires empty");

  // stages with requirements
  assert(STAGE_ARTIFACTS.clarify.requires.includes("task.md"), "STAGE_ARTIFACTS: clarify requires task.md");
  assert(STAGE_ARTIFACTS.specify.requires.includes("decisions.json"), "STAGE_ARTIFACTS: specify requires decisions.json");
  assert(STAGE_ARTIFACTS.design.requires.includes("task.md"), "STAGE_ARTIFACTS: design requires task.md");
  assert(STAGE_ARTIFACTS.implement.requires.includes("design.md"), "STAGE_ARTIFACTS: implement requires design.md");
}

function testCustomPipelineParsing() {
  const { FORGE_PIPELINES, STAGE_ARTIFACTS } = require("../lib/core/constants");

  // standard pipelines include deliver
  assert(FORGE_PIPELINES.trivial.includes("deliver"), "pipeline: trivial has deliver");
  assert(FORGE_PIPELINES.small.includes("deliver"), "pipeline: small has deliver");
  assert(FORGE_PIPELINES.large.includes("deliver"), "pipeline: large has deliver");

  // custom pipeline parsing
  const custom = "design,implement,verify";
  const stages = custom.split(",").map((s) => s.trim());
  assert(stages.length === 3, "custom pipeline: correct count");
  assertEqual(stages[0], "design", "custom pipeline: first stage");

  // validate stages against STAGE_ARTIFACTS
  const validStages = new Set(Object.keys(STAGE_ARTIFACTS));
  const invalid = stages.filter((s) => !validStages.has(s));
  assertEqual(invalid.length, 0, "custom pipeline: all stages valid");

  // invalid stage detection
  const badStages = "design,foobar,implement".split(",");
  const badInvalid = badStages.filter((s) => !validStages.has(s));
  assertEqual(badInvalid.length, 1, "custom pipeline: detects invalid stage");
  assertEqual(badInvalid[0], "foobar", "custom pipeline: identifies foobar");
}

function testSanitizeContentPatterns() {
  const { sanitizeContent } = require("../lib/core/worktree");

  // API key patterns
  const apiKey = "api_key=sk-1234567890abcdef1234567890abcdef";
  const sanitized1 = sanitizeContent(apiKey);
  assert(sanitized1.includes("[REDACTED]"), "sanitize: API key redacted");
  assert(!sanitized1.includes("1234567890abcdef"), "sanitize: API key value hidden");

  // Bearer token
  const bearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
  const sanitized2 = sanitizeContent(bearer);
  assert(sanitized2.includes("[REDACTED]"), "sanitize: Bearer token redacted");

  // GitHub token
  const ghToken = "token: ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const sanitized3 = sanitizeContent(ghToken);
  assert(sanitized3.includes("[REDACTED]"), "sanitize: GitHub token redacted");

  // Normal text passes through
  const normal = "This is normal text without secrets";
  assertEqual(sanitizeContent(normal), normal, "sanitize: normal text unchanged");

  // null/undefined handling
  assertEqual(sanitizeContent(null), null, "sanitize: null passthrough");
  assertEqual(sanitizeContent(""), "", "sanitize: empty string passthrough");
}

function testParseArgsCli() {
  // simulate parseArgs by extracting and testing the logic
  function testParse(argv) {
    const args = argv;
    const opts = {};
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--project") { opts.project = args[++i]; }
      else if (args[i] === "--pipeline") { opts.pipeline = args[++i]; }
      else if (args[i] === "--autopilot") { opts.autopilot = true; }
      else if (args[i] === "--file") { opts.file = args[++i]; }
      else if (args[i] === "--budget") { opts.budget = parseInt(args[++i]) || 0; }
      else if (args[i] === "--from") { opts.from = args[++i]; }
      else if (args[i] === "--background" || args[i] === "--bg") { opts.background = true; }
      else if (args[i] === "--verbose" || args[i] === "-v") { opts.verbose = true; }
      else if (!args[i].startsWith("-")) { positional.push(args[i]); }
    }
    opts.command = positional[0];
    opts.positional = positional.slice(1);
    return opts;
  }

  const r1 = testParse(["forge", "test task", "--project", "/tmp", "--pipeline", "small"]);
  assertEqual(r1.command, "forge", "parseArgs: command");
  assertEqual(r1.project, "/tmp", "parseArgs: project");
  assertEqual(r1.pipeline, "small", "parseArgs: pipeline");
  assertEqual(r1.positional[0], "test task", "parseArgs: positional");

  const r2 = testParse(["resume", "forge-001", "--from", "design", "--bg"]);
  assertEqual(r2.command, "resume", "parseArgs: resume command");
  assertEqual(r2.from, "design", "parseArgs: from");
  assert(r2.background, "parseArgs: background flag");

  const r3 = testParse(["forge", "task", "--autopilot", "--verbose", "--budget", "500000"]);
  assert(r3.autopilot, "parseArgs: autopilot flag");
  assert(r3.verbose, "parseArgs: verbose flag");
  assertEqual(r3.budget, 500000, "parseArgs: budget value");
}

function testGetNextAction() {
  // Test the logic of getNextAction
  function getNextAction(dag) {
    switch (dag.status) {
      case "review": return `ucm approve ${dag.id}  또는  ucm reject ${dag.id} --feedback "..."`;
      case "rejected": return `ucm resume ${dag.id}`;
      case "failed": return `ucm resume ${dag.id} --from ${dag.currentStage || "implement"}`;
      case "in_progress": return `ucm logs ${dag.id}  (진행 중)`;
      default: return null;
    }
  }

  const review = getNextAction({ id: "forge-001", status: "review" });
  assert(review.includes("approve"), "getNextAction: review suggests approve");
  assert(review.includes("reject"), "getNextAction: review suggests reject");

  const rejected = getNextAction({ id: "forge-001", status: "rejected" });
  assert(rejected.includes("resume"), "getNextAction: rejected suggests resume");

  const failed = getNextAction({ id: "forge-001", status: "failed", currentStage: "verify" });
  assert(failed.includes("--from verify"), "getNextAction: failed suggests from stage");

  const inProgress = getNextAction({ id: "forge-001", status: "in_progress" });
  assert(inProgress.includes("logs"), "getNextAction: in_progress suggests logs");

  const done = getNextAction({ id: "forge-001", status: "done" });
  assertEqual(done, null, "getNextAction: done returns null");

  const aborted = getNextAction({ id: "forge-001", status: "aborted" });
  assertEqual(aborted, null, "getNextAction: aborted returns null");
}

function testDetectOrphanLogic() {
  // Test the orphan detection logic (without actual TaskDag I/O)
  const tasks = [
    { id: "forge-001", status: "done" },
    { id: "forge-002", status: "in_progress" },
    { id: "forge-003", status: "failed" },
    { id: "forge-004", status: "in_progress" },
  ];

  const orphans = tasks.filter((t) => t.status === "in_progress");
  assertEqual(orphans.length, 2, "orphan detect: finds 2 in_progress");
  assertEqual(orphans[0].id, "forge-002", "orphan detect: first orphan");
  assertEqual(orphans[1].id, "forge-004", "orphan detect: second orphan");

  // no orphans when no in_progress
  const clean = [
    { id: "forge-001", status: "done" },
    { id: "forge-003", status: "failed" },
  ];
  const noOrphans = clean.filter((t) => t.status === "in_progress");
  assertEqual(noOrphans.length, 0, "orphan detect: no orphans when clean");
}

function testTaskDagSaveChaining() {
  // save()가 promise chaining으로 직렬화되는지 확인
  const { TaskDag } = require("../lib/core/task");
  const dag = new TaskDag({ id: "forge-99990101-test", status: "pending" });

  // save의 _saving 프로퍼티가 체이닝 패턴인지 확인
  assertEqual(dag._saving, undefined, "save chaining: initial _saving is undefined");

  // save 메서드가 존재하고 함수인지
  assertEqual(typeof dag.save, "function", "save chaining: save is a function");
  assertEqual(typeof dag._doSave, "function", "save chaining: _doSave is a function");
}

function testDeliverAutoMergeFailureSetsReview() {
  // deliver에서 auto-merge 실패 시 status가 review가 되는지 확인
  // deliver.js의 코드 구조를 검증
  const deliverSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "deliver.js"), "utf-8"
  );
  // auto_merged가 catch 블록 전에 설정되고, catch에서 review로 변경
  const autoMergedBeforeCatch = deliverSource.indexOf('dag.status = "auto_merged"');
  const reviewInCatch = deliverSource.indexOf('dag.status = "review"');
  assert(autoMergedBeforeCatch !== -1, "deliver: auto_merged status exists");
  assert(reviewInCatch !== -1, "deliver: review fallback exists");
  assert(autoMergedBeforeCatch < reviewInCatch, "deliver: auto_merged before review (success then failure)");
}

function testAgentSkipPermissions() {
  // agent.js가 buildCommand에 skipPermissions를 전달하는지 확인
  const agentSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "core", "agent.js"), "utf-8"
  );
  assert(agentSource.includes("skipPermissions: true"), "agent: passes skipPermissions");
  assert(agentSource.includes("sessionPersistence: false"), "agent: passes sessionPersistence");
}

function testRsaClassifySkipPermissions() {
  // rsa.js classify가 skipPermissions를 전달하는지 확인
  const rsaSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "core", "rsa.js"), "utf-8"
  );
  assert(rsaSource.includes("skipPermissions: true"), "rsa classify: passes skipPermissions");
  assert(rsaSource.includes("sessionPersistence: false"), "rsa classify: passes sessionPersistence");
}

function testServerTaskIdValidation() {
  // server/index.js에 taskId 검증이 있는지 확인
  const serverSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "server", "index.js"), "utf-8"
  );
  assert(serverSource.includes("validateTaskId"), "server: has validateTaskId function");
  assert(serverSource.includes("TASK_ID_RE"), "server: has TASK_ID_RE regex");
  // path traversal 방지: logs, diff, abort, approve, reject에 모두 적용
  const validateCalls = (serverSource.match(/validateTaskId/g) || []).length;
  assert(validateCalls >= 7, `server: validateTaskId called ${validateCalls} times (expect >=7)`);
}

function testWireEventsIncludesAbort() {
  // wireEvents에 pipeline:abort가 포함되는지 확인
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  assert(forgeSource.includes('"pipeline:abort"'), "wireEvents: includes pipeline:abort");
}

function testSubtasksRunSequentially() {
  // subtask가 순차 실행되는지 확인 (Promise.all 미사용)
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  // runSubtaskStages에서 Promise.all이 없어야 함
  const subtaskSection = forgeSource.slice(
    forgeSource.indexOf("async runSubtaskStages"),
    forgeSource.indexOf("async runImplementVerifyLoop")
  );
  assert(!subtaskSection.includes("Promise.all"), "subtasks: no Promise.all (sequential execution)");
  assert(subtaskSection.includes("같은 worktree를 공유"), "subtasks: has worktree conflict comment");
}

function testParallelTokenUsage() {
  // parallel.js가 tokenUsage를 집계하는지 확인
  const parallelSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "core", "parallel.js"), "utf-8"
  );
  assert(parallelSource.includes("results.tokenUsage.input"), "parallel: tracks input tokens");
  assert(parallelSource.includes("results.tokenUsage.output"), "parallel: tracks output tokens");
}

function testVerifyUsesExtractJson() {
  // verify.js가 extractJson을 사용하는지 확인
  const verifySource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "verify.js"), "utf-8"
  );
  assert(verifySource.includes("extractJson"), "verify: uses extractJson for robust parsing");
  assert(!verifySource.includes("JSON.parse(testResult"), "verify: no raw JSON.parse on agent output");
}

function testSubtaskMissingContinues() {
  // subtask not found 시 continue(계속)인지 확인
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  const section = forgeSource.slice(
    forgeSource.indexOf("subtask not found"),
    forgeSource.indexOf("subtask not found") + 100
  );
  assert(section.includes("continue"), "subtask missing: uses continue (not return)");
}

function testResumeInvalidStageThrows() {
  // resumeFrom에 잘못된 stage 지정 시 에러 발생 코드가 있는지 확인
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  assert(forgeSource.includes("not found in pipeline"), "resume: invalid stage detection exists");
}

function testImplementFailureRecordsStage() {
  // runImplementVerifyLoop에서 implement 실패 시 recordStage 호출 확인
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  const loopSection = forgeSource.slice(
    forgeSource.indexOf("async runImplementVerifyLoop"),
    forgeSource.indexOf("async learnToHivemind")
  );
  assert(
    loopSection.includes('recordStage("implement", "fail"'),
    "implement loop: records stage failure"
  );
}

function testIntakeRecordsStage() {
  // runIntake에서 recordStage 호출 확인
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  const intakeSection = forgeSource.slice(
    forgeSource.indexOf("async runIntake"),
    forgeSource.indexOf("async setupWorktree")
  );
  assert(intakeSection.includes('recordStage("intake"'), "intake: records stage in history");
  assert(intakeSection.includes("stage:start"), "intake: emits stage:start");
  assert(intakeSection.includes("stage:complete"), "intake: emits stage:complete");
}

function testSpecifyRsaTokenUsage() {
  // specify.js RSA가 parallel worker tokenUsage를 포함하는지 확인
  const specSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "specify.js"), "utf-8"
  );
  assert(specSource.includes("parallelResult.tokenUsage"), "specify RSA: includes parallel worker tokens");
}

function testRemoveWorktreesUsesOrigin() {
  // removeWorktrees가 project.origin을 사용하는지 확인
  const worktreeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "core", "worktree.js"), "utf-8"
  );
  const removeSection = worktreeSource.slice(
    worktreeSource.indexOf("async function removeWorktrees"),
    worktreeSource.indexOf("async function getWorktreeDiff")
  );
  assert(removeSection.includes("project.origin || project.path"), "removeWorktrees: uses origin path");
}

function testIntegrateConflictResolutionUsesOrigin() {
  // integrate.js conflict resolution이 origin 경로를 사용하는지 확인
  const intSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "integrate.js"), "utf-8"
  );
  assert(intSource.includes("workspace.projects[0]?.origin"), "integrate: conflict resolution uses origin path");
}

function testPolishConfig() {
  const { POLISH_CONFIG, STAGE_ARTIFACTS, STAGE_TIMEOUTS, STAGE_MODELS, FORGE_PIPELINES } = require("../lib/core/constants");

  // POLISH_CONFIG 존재 확인
  assert(POLISH_CONFIG, "POLISH_CONFIG: exists");
  assertEqual(POLISH_CONFIG.defaultLenses.length, 4, "POLISH_CONFIG: 4 lenses");
  assert(POLISH_CONFIG.defaultLenses.includes("code_quality"), "POLISH_CONFIG: has code_quality");
  assert(POLISH_CONFIG.defaultLenses.includes("security"), "POLISH_CONFIG: has security");
  assertEqual(POLISH_CONFIG.maxRoundsPerLens, 5, "POLISH_CONFIG: maxRoundsPerLens=5");
  assertEqual(POLISH_CONFIG.maxTotalRounds, 15, "POLISH_CONFIG: maxTotalRounds=15");
  assertEqual(POLISH_CONFIG.convergenceThreshold, 2, "POLISH_CONFIG: convergenceThreshold=2");

  // STAGE_ARTIFACTS
  assert(STAGE_ARTIFACTS.polish, "STAGE_ARTIFACTS: polish exists");
  assertEqual(STAGE_ARTIFACTS.polish.requires.length, 0, "STAGE_ARTIFACTS: polish requires empty (subtask-safe)");
  assert(STAGE_ARTIFACTS.polish.produces.includes("polish-summary.json"), "STAGE_ARTIFACTS: polish produces polish-summary.json");

  // STAGE_TIMEOUTS
  assert(STAGE_TIMEOUTS.polish, "STAGE_TIMEOUTS: polish exists");
  assertEqual(STAGE_TIMEOUTS.polish.idle, 8 * 60_000, "STAGE_TIMEOUTS: polish idle=8min");
  assertEqual(STAGE_TIMEOUTS.polish.hard, 60 * 60_000, "STAGE_TIMEOUTS: polish hard=60min");

  // STAGE_MODELS
  const polishModels = STAGE_MODELS.polish;
  assert(polishModels, "STAGE_MODELS: polish exists");
  assertEqual(polishModels.review, "sonnet", "STAGE_MODELS: polish.review=sonnet");
  assertEqual(polishModels.fix, "opus", "STAGE_MODELS: polish.fix=opus");

  // FORGE_PIPELINES에 polish 포함
  assert(FORGE_PIPELINES.medium.includes("polish"), "FORGE_PIPELINES: medium has polish");
  assert(FORGE_PIPELINES.large.includes("polish"), "FORGE_PIPELINES: large has polish");
  assert(!FORGE_PIPELINES.trivial.includes("polish"), "FORGE_PIPELINES: trivial has no polish");
  assert(!FORGE_PIPELINES.small.includes("polish"), "FORGE_PIPELINES: small has no polish");

  // medium에서 polish는 verify 다음, deliver 이전
  const mediumIdx = FORGE_PIPELINES.medium;
  assert(mediumIdx.indexOf("polish") > mediumIdx.indexOf("verify"), "FORGE_PIPELINES: medium polish after verify");
  assert(mediumIdx.indexOf("polish") < mediumIdx.indexOf("deliver"), "FORGE_PIPELINES: medium polish before deliver");

  // large에서 polish는 verify 다음, integrate 이전
  const largeIdx = FORGE_PIPELINES.large;
  assert(largeIdx.indexOf("polish") > largeIdx.indexOf("verify"), "FORGE_PIPELINES: large polish after verify");
  assert(largeIdx.indexOf("polish") < largeIdx.indexOf("integrate"), "FORGE_PIPELINES: large polish before integrate");
}

function testPolishModuleExports() {
  const polish = require("../lib/forge/polish");
  assertEqual(typeof polish.run, "function", "polish: exports run function");
}

function testPolishInSubtaskStages() {
  // forge/index.js가 subtask stages에 polish를 포함하는지 소스 확인
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  assert(forgeSource.includes('"polish"') && forgeSource.includes("pipelineStages.includes"), "forge/index: polish in subtask stages");
}

function testPolishLensPromptsCoverage() {
  const { POLISH_CONFIG } = require("../lib/core/constants");
  // polish.js의 LENS_PROMPTS가 모든 defaultLenses를 커버하는지 확인
  const polishSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "polish.js"), "utf-8"
  );
  for (const lens of POLISH_CONFIG.defaultLenses) {
    assert(polishSource.includes(`${lens}:`), `polish LENS_PROMPTS: covers ${lens}`);
  }
}

function testPolishModelEnvOverride() {
  const { STAGE_MODELS } = require("../lib/core/constants");
  // polish는 객체 타입 — env override가 동작하는지 확인
  process.env.UCM_MODEL_POLISH_REVIEW = "haiku";
  const overridden = STAGE_MODELS.polish;
  assertEqual(overridden.review, "haiku", "STAGE_MODELS: polish.review env override works");
  assertEqual(overridden.fix, "opus", "STAGE_MODELS: polish.fix unchanged when only review overridden");
  delete process.env.UCM_MODEL_POLISH_REVIEW;
}

function testPolishCustomPipelineDetection() {
  // 커스텀 파이프라인 문자열에서 polish 포함 여부 탐지 로직
  const { FORGE_PIPELINES } = require("../lib/core/constants");
  const custom = "implement,verify,polish,deliver";
  const stages = FORGE_PIPELINES[custom]
    || (typeof custom === "string" && custom.includes(",") ? custom.split(",").map((s) => s.trim()) : []);
  assert(stages.includes("polish"), "custom pipeline: detects polish");

  // 일반 파이프라인 키도 동작
  const medium = FORGE_PIPELINES["medium"] || [];
  assert(medium.includes("polish"), "named pipeline: detects polish from medium");
}

function testPolishStageEstimate() {
  // bin/ucm.js의 STAGE_EST에 polish가 포함되어 있는지 확인
  const ucmSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "ucm.js"), "utf-8"
  );
  assert(ucmSource.includes("polish:"), "ucm.js: STAGE_EST has polish");
}

// ── UX Review Tests ──

function testUxReviewModuleExports() {
  const uxReview = require("../lib/forge/ux-review");
  assertEqual(typeof uxReview.run, "function", "ux-review: exports run");
  assertEqual(typeof uxReview.parseUxReview, "function", "ux-review: exports parseUxReview");
  assertEqual(typeof uxReview.formatUxFeedback, "function", "ux-review: exports formatUxFeedback");
  assertEqual(typeof uxReview.detectFrontend, "function", "ux-review: exports detectFrontend");
  assertEqual(typeof uxReview.loadTemplate, "function", "ux-review: exports loadTemplate");
}

function testUxReviewParseValid() {
  const { parseUxReview } = require("../lib/forge/ux-review");
  const input = JSON.stringify({
    score: 8,
    summary: "Good UI",
    canUserAccomplishGoal: { goal: "create items", result: "yes", blockers: [] },
    usabilityIssues: [{ severity: "minor", description: "label unclear", where: "header", fix: "rename" }],
    confusingElements: [],
    positives: ["clean layout"],
    mobile: { usable: true, issues: [] },
  });
  const result = parseUxReview(input);
  assertEqual(result.score, 8, "parseUxReview: score");
  assertEqual(result.usabilityIssues.length, 1, "parseUxReview: 1 usability issue");
  assertEqual(result.positives.length, 1, "parseUxReview: 1 positive");
  assertEqual(result.canUserAccomplishGoal.result, "yes", "parseUxReview: goal accomplished");
}

function testUxReviewParseInvalid() {
  const { parseUxReview } = require("../lib/forge/ux-review");
  const result = parseUxReview("not json at all");
  assertEqual(result.score, 0, "parseUxReview invalid: score 0");
  assertEqual(result.usabilityIssues.length, 1, "parseUxReview invalid: has error issue");
}

function testUxReviewFormatFeedback() {
  const { formatUxFeedback } = require("../lib/forge/ux-review");
  const review = {
    usabilityIssues: [
      { severity: "critical", description: "can't find main action", where: "landing page", fix: "add CTA" },
      { severity: "major", description: "confusing labels", where: "sidebar", fix: "rename" },
      { severity: "minor", description: "small icons", where: "toolbar", fix: "enlarge" },
    ],
    canUserAccomplishGoal: { goal: "submit form", result: "no", blockers: ["button not visible"] },
  };
  const feedback = formatUxFeedback(review);
  assert(feedback.includes("Critical Usability Issues"), "formatUxFeedback: has critical section");
  assert(feedback.includes("can't find main action"), "formatUxFeedback: has critical issue");
  assert(feedback.includes("Major Usability Issues"), "formatUxFeedback: has major section");
  assert(feedback.includes("confusing labels"), "formatUxFeedback: has major item");
  assert(!feedback.includes("small icons"), "formatUxFeedback: excludes minor");
  assert(feedback.includes("User Goal Not Met"), "formatUxFeedback: goal not met section");
}

function testUxReviewConstants() {
  const { STAGE_ARTIFACTS, STAGE_TIMEOUTS, STAGE_MODELS, FORGE_PIPELINES } = require("../lib/core/constants");

  assert(STAGE_ARTIFACTS["ux-review"], "constants: ux-review in STAGE_ARTIFACTS");
  assertDeepEqual(STAGE_ARTIFACTS["ux-review"].requires, [], "constants: ux-review requires nothing");
  assertDeepEqual(STAGE_ARTIFACTS["ux-review"].produces, ["ux-review.json"], "constants: ux-review produces json");

  assert(STAGE_TIMEOUTS["ux-review"], "constants: ux-review in STAGE_TIMEOUTS");
  assertEqual(STAGE_TIMEOUTS["ux-review"].idle, 5 * 60_000, "constants: ux-review idle timeout");
  assertEqual(STAGE_TIMEOUTS["ux-review"].hard, 15 * 60_000, "constants: ux-review hard timeout");

  assertEqual(STAGE_MODELS["ux-review"], "sonnet", "constants: ux-review model is sonnet");

  assert(FORGE_PIPELINES.medium.includes("ux-review"), "constants: medium pipeline has ux-review");
  assert(FORGE_PIPELINES.large.includes("ux-review"), "constants: large pipeline has ux-review");

  const mediumIdx = FORGE_PIPELINES.medium.indexOf("ux-review");
  const verifyIdx = FORGE_PIPELINES.medium.indexOf("verify");
  const polishIdx = FORGE_PIPELINES.medium.indexOf("polish");
  assert(mediumIdx > verifyIdx, "constants: ux-review after verify in medium");
  assert(mediumIdx < polishIdx, "constants: ux-review before polish in medium");
}

function testUxReviewTemplate() {
  const { loadTemplate } = require("../lib/forge/ux-review");
  const template = loadTemplate();
  assert(template.includes("{{SPEC}}"), "template: has SPEC placeholder");
  assert(template.includes("{{DESIGN}}"), "template: has DESIGN placeholder");
  assert(template.includes("{{DEV_URL}}"), "template: has DEV_URL placeholder");
  assert(template.includes("accomplish the main task"), "template: has main task evaluation");
  assert(template.includes("dangerous actions"), "template: has dangerous actions check");
  assert(template.includes("different sizes"), "template: has responsive check");
  assert(template.includes("score"), "template: has scoring");
  assert(template.includes("usabilityIssues"), "template: has usability issues output");
}

function testUxReviewInPipeline() {
  const forgeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "lib", "forge", "index.js"), "utf-8"
  );
  assert(forgeSource.includes('"ux-review"'), "forge/index: includes ux-review stage");
  assert(forgeSource.includes("ux-review"), "forge/index: handles ux-review in subtask stages");

  // ux-review가 runImplementVerifyLoop에서 처리되는지 확인
  const loopSection = forgeSource.slice(
    forgeSource.indexOf("async runImplementVerifyLoop"),
    forgeSource.indexOf("async learnToHivemind")
  );
  assert(loopSection.includes("ux-review"), "forge/index: ux-review in implement-verify loop");
}

async function testUxReviewDetectFrontend() {
  const { detectFrontend } = require("../lib/core/browser");
  const ts = Date.now();

  // non-existent project → null
  const result = await detectFrontend(`/tmp/ucm-test-nonexistent-${ts}`);
  assertEqual(result, null, "detectFrontend: non-existent dir returns null");

  // .ucm.json explicit config (highest priority)
  const t1 = path.join(os.tmpdir(), `ucm-fe-ucmjson-${ts}`);
  await mkdir(t1, { recursive: true });
  await writeFile(path.join(t1, ".ucm.json"), JSON.stringify({ devCommand: "node bin/app.js ui", devPort: 4000 }));
  const r1 = await detectFrontend(t1);
  assertEqual(r1.devCommand, "node bin/app.js ui", "detectFrontend: .ucm.json devCommand");
  assertEqual(r1.devPort, 4000, "detectFrontend: .ucm.json devPort");
  assertEqual(r1.source, ".ucm.json", "detectFrontend: .ucm.json source");
  await rm(t1, { recursive: true });

  // package.json "ucm" field
  const t2 = path.join(os.tmpdir(), `ucm-fe-pkgucm-${ts}`);
  await mkdir(t2, { recursive: true });
  await writeFile(path.join(t2, "package.json"), JSON.stringify({ ucm: { devCommand: "ucm ui", devPort: 3000 } }));
  const r2 = await detectFrontend(t2);
  assertEqual(r2.devCommand, "ucm ui", "detectFrontend: pkg.ucm devCommand");
  assertEqual(r2.source, "package.json/ucm", "detectFrontend: pkg.ucm source");
  await rm(t2, { recursive: true });

  // framework config (vite.config.ts)
  const t3 = path.join(os.tmpdir(), `ucm-fe-vite-${ts}`);
  await mkdir(t3, { recursive: true });
  await writeFile(path.join(t3, "vite.config.ts"), "export default {}");
  const r3 = await detectFrontend(t3);
  assert(r3 !== null, "detectFrontend: vite config detected");
  assertEqual(r3.devPort, 5173, "detectFrontend: vite default port");
  assert(r3.source.startsWith("framework:"), "detectFrontend: vite source");
  await rm(t3, { recursive: true });

  // framework config + scripts → scripts의 port 우선
  const t4 = path.join(os.tmpdir(), `ucm-fe-vite-script-${ts}`);
  await mkdir(t4, { recursive: true });
  await writeFile(path.join(t4, "vite.config.ts"), "export default {}");
  await writeFile(path.join(t4, "package.json"), JSON.stringify({ scripts: { dev: "vite --port 4444" } }));
  const r4 = await detectFrontend(t4);
  assertEqual(r4.devCommand, "npm run dev", "detectFrontend: vite+scripts uses npm run dev");
  assertEqual(r4.devPort, 4444, "detectFrontend: port from script content");
  await rm(t4, { recursive: true });

  // frontend dependency (react)
  const t5 = path.join(os.tmpdir(), `ucm-fe-react-${ts}`);
  await mkdir(t5, { recursive: true });
  await writeFile(path.join(t5, "package.json"), JSON.stringify({ dependencies: { react: "^18" }, scripts: { dev: "next dev" } }));
  const r5 = await detectFrontend(t5);
  assert(r5 !== null, "detectFrontend: react dep detected");
  assertEqual(r5.source, "package.json/deps", "detectFrontend: react source");
  await rm(t5, { recursive: true });

  // scripts keyword analysis (no framework config, no frontend deps, but script has "vite")
  const t6 = path.join(os.tmpdir(), `ucm-fe-scriptkw-${ts}`);
  await mkdir(t6, { recursive: true });
  await writeFile(path.join(t6, "package.json"), JSON.stringify({ scripts: { dev: "vite --host" } }));
  const r6 = await detectFrontend(t6);
  assert(r6 !== null, "detectFrontend: script keyword detected");
  assertEqual(r6.source, "package.json/scripts", "detectFrontend: script keyword source");
  await rm(t6, { recursive: true });

  // static index.html
  const t7 = path.join(os.tmpdir(), `ucm-fe-static-${ts}`);
  await mkdir(t7, { recursive: true });
  await writeFile(path.join(t7, "index.html"), "<html></html>");
  const r7 = await detectFrontend(t7);
  assert(r7 !== null, "detectFrontend: static index.html");
  assert(r7.devCommand.includes("serve"), "detectFrontend: static uses serve");
  assertEqual(r7.staticOnly, true, "detectFrontend: static flag");
  await rm(t7, { recursive: true });

  // pure backend (no frontend signals) → null
  const t8 = path.join(os.tmpdir(), `ucm-fe-backend-${ts}`);
  await mkdir(t8, { recursive: true });
  await writeFile(path.join(t8, "package.json"), JSON.stringify({ scripts: { test: "jest" }, dependencies: { express: "^4" } }));
  const r8 = await detectFrontend(t8);
  assertEqual(r8, null, "detectFrontend: pure backend returns null");
  await rm(t8, { recursive: true });

  // Python Django
  const t9 = path.join(os.tmpdir(), `ucm-fe-django-${ts}`);
  await mkdir(t9, { recursive: true });
  await writeFile(path.join(t9, "manage.py"), "#!/usr/bin/env python");
  const r9 = await detectFrontend(t9);
  assert(r9 !== null, "detectFrontend: Django manage.py");
  assert(r9.devCommand.includes("runserver"), "detectFrontend: Django command");
  assertEqual(r9.devPort, 8000, "detectFrontend: Django port");
  await rm(t9, { recursive: true });
}

function testBrowserModuleExports() {
  const browser = require("../lib/core/browser");
  assertEqual(typeof browser.launchBrowser, "function", "browser: exports launchBrowser");
  assertEqual(typeof browser.killBrowser, "function", "browser: exports killBrowser");
  assertEqual(typeof browser.detectFrontend, "function", "browser: exports detectFrontend");
  assertEqual(typeof browser.startDevServer, "function", "browser: exports startDevServer");
  assertEqual(typeof browser.resolvePort, "function", "browser: exports resolvePort");
  assertEqual(typeof browser.extractPortFromScript, "function", "browser: exports extractPortFromScript");
  assertEqual(typeof browser.pickDevScript, "function", "browser: exports pickDevScript");
  assertEqual(typeof browser.scriptLooksLikeWebServer, "function", "browser: exports scriptLooksLikeWebServer");
}

function testBrowserResolvePort() {
  const { resolvePort } = require("../lib/core/browser");
  const port1 = resolvePort("forge-20260219-abc");
  assert(port1 >= 9222 && port1 < 10222, "resolvePort: within range");
  const port2 = resolvePort("forge-20260219-xyz");
  assert(typeof port2 === "number", "resolvePort: returns number");
}

function testExtractPortFromScript() {
  const { extractPortFromScript } = require("../lib/core/browser");
  assertEqual(extractPortFromScript("vite --port 4444"), 4444, "extractPort: --port");
  assertEqual(extractPortFromScript("next dev -p 3001"), 3001, "extractPort: -p");
  assertEqual(extractPortFromScript("ng serve"), null, "extractPort: no port");
  assertEqual(extractPortFromScript("node server.js"), null, "extractPort: no port pattern");
}

function testPickDevScript() {
  const { pickDevScript } = require("../lib/core/browser");
  assertEqual(pickDevScript({ dev: "vite", start: "node index.js" }).name, "dev", "pickDevScript: dev > start");
  assertEqual(pickDevScript({ serve: "http-server", start: "node ." }).name, "serve", "pickDevScript: serve > start");
  assertEqual(pickDevScript({ "dev:web": "vite", test: "jest" }).name, "dev:web", "pickDevScript: dev: prefix");
  assertEqual(pickDevScript({ test: "jest", build: "tsc" }), null, "pickDevScript: no dev script");
  assertEqual(pickDevScript(null), null, "pickDevScript: null scripts");
}

function testScriptLooksLikeWebServer() {
  const { scriptLooksLikeWebServer } = require("../lib/core/browser");
  assertEqual(scriptLooksLikeWebServer("vite --host"), true, "scriptWebServer: vite");
  assertEqual(scriptLooksLikeWebServer("next dev"), true, "scriptWebServer: next");
  assertEqual(scriptLooksLikeWebServer("react-scripts start"), true, "scriptWebServer: react-scripts");
  assertEqual(scriptLooksLikeWebServer("jest --coverage"), false, "scriptWebServer: jest");
  assertEqual(scriptLooksLikeWebServer("tsc && node dist/index.js"), false, "scriptWebServer: tsc");
}

function testFrameworkSignatures() {
  const { FRAMEWORK_SIGNATURES, FRONTEND_DEPS } = require("../lib/core/browser");
  assert(FRAMEWORK_SIGNATURES.length >= 10, "signatures: at least 10 frameworks");
  assert(FRONTEND_DEPS.has("react"), "frontendDeps: has react");
  assert(FRONTEND_DEPS.has("vue"), "frontendDeps: has vue");
  assert(FRONTEND_DEPS.has("svelte"), "frontendDeps: has svelte");
  assert(!FRONTEND_DEPS.has("express"), "frontendDeps: no express");
}

async function testPolishSimulations() {
  const polishPath = require.resolve("../lib/forge/polish");
  const llmMod = require("../lib/core/llm");
  const agentMod = require("../lib/core/agent");
  const worktreeMod = require("../lib/core/worktree");

  const origLlmJson = llmMod.llmJson;
  const origSpawnAgent = agentMod.spawnAgent;
  const origLoad = worktreeMod.loadArtifact;
  const origSave = worktreeMod.saveArtifact;

  function setup(llmFn, agentFn) {
    delete require.cache[polishPath];
    llmMod.llmJson = llmFn;
    agentMod.spawnAgent = agentFn;
    worktreeMod.loadArtifact = async () => "";
    worktreeMod.saveArtifact = async () => {};
    return require("../lib/forge/polish");
  }

  function restore() {
    delete require.cache[polishPath];
    llmMod.llmJson = origLlmJson;
    agentMod.spawnAgent = origSpawnAgent;
    worktreeMod.loadArtifact = origLoad;
    worktreeMod.saveArtifact = origSave;
  }

  const baseOpts = {
    taskId: "sim-test",
    dag: { totalTokens: () => 0 },
    project: "/tmp/sim",
    timeouts: { idle: 60000, hard: 300000 },
    onLog: () => {},
  };

  const cleanReview = { data: { issues: [], summary: "clean" }, tokenUsage: { input: 100, output: 50 } };
  const issueReview = (n) => ({
    data: {
      issues: Array.from({ length: n }, (_, i) => ({ severity: "minor", description: `issue ${i + 1}`, file: "a.js" })),
      summary: `${n} issues`,
    },
    tokenUsage: { input: 100, output: 50 },
  });
  const agentOk = { status: "done", stdout: '{"testsPassed":true,"summary":"ok","failures":[]}', tokenUsage: { input: 200, output: 100 } };
  const agentTestFail = { status: "done", stdout: '{"testsPassed":false,"summary":"fail","failures":["test1 failed"]}', tokenUsage: { input: 200, output: 100 } };

  // ── Scenario 1: Immediate convergence (all 0 issues) ──
  // 4 lenses × 2 consecutive clean rounds = 8 total rounds, all converge
  {
    let llmCalls = 0;
    const polish = setup(
      async () => { llmCalls++; return cleanReview; },
      async () => agentOk,
    );
    const r = await polish.run(baseOpts);
    assertEqual(r.summary.totalRounds, 8, "sim:converge: 8 rounds (4×2)");
    assertEqual(r.summary.totalIssuesFound, 0, "sim:converge: 0 issues");
    assert(r.summary.lenses.every((l) => l.converged), "sim:converge: all converged");
    assertEqual(r.summary.lenses.length, 4, "sim:converge: 4 lenses");
    assertEqual(llmCalls, 8, "sim:converge: 8 llm calls");
    restore();
  }

  // ── Scenario 2: Issues found → fix → converge ──
  // code_quality R1: 2 issues → fix+test → R2: clean → R3: clean → converge (3 rounds)
  // other 3 lenses: 2 clean rounds each (6 rounds)
  // total: 9 rounds, 2 issues found
  {
    let llmCalls = 0;
    let agentCalls = 0;
    const polish = setup(
      async () => { llmCalls++; return llmCalls === 1 ? issueReview(2) : cleanReview; },
      async () => { agentCalls++; return agentOk; },
    );
    const r = await polish.run(baseOpts);
    assertEqual(r.summary.totalRounds, 9, "sim:fix: 9 rounds");
    assertEqual(r.summary.totalIssuesFound, 2, "sim:fix: 2 issues");
    assertEqual(r.summary.lenses[0].lens, "code_quality", "sim:fix: first lens is code_quality");
    assertEqual(r.summary.lenses[0].issuesFound, 2, "sim:fix: code_quality 2 issues");
    assertEqual(r.summary.lenses[0].rounds, 3, "sim:fix: code_quality 3 rounds");
    assert(r.summary.lenses.every((l) => l.converged), "sim:fix: all converged");
    assertEqual(agentCalls, 2, "sim:fix: 2 agent calls (fix + test gate)");
    restore();
  }

  // ── Scenario 3: Max rounds per lens exhausted ──
  // code_quality: always 1 issue → 5 rounds (maxPerLens), no convergence
  // other lenses: immediate convergence (2 rounds each)
  // total: 5 + 2 + 2 + 2 = 11
  {
    let llmCalls = 0;
    const polish = setup(
      async () => { llmCalls++; return llmCalls <= 5 ? issueReview(1) : cleanReview; },
      async () => agentOk,
    );
    const r = await polish.run(baseOpts);
    assertEqual(r.summary.totalRounds, 11, "sim:maxPerLens: 11 rounds");
    assertEqual(r.summary.lenses[0].rounds, 5, "sim:maxPerLens: code_quality 5 rounds");
    assertEqual(r.summary.lenses[0].converged, false, "sim:maxPerLens: code_quality not converged");
    assertEqual(r.summary.lenses[0].issuesFound, 5, "sim:maxPerLens: code_quality 5 issues");
    assert(r.summary.lenses.slice(1).every((l) => l.converged), "sim:maxPerLens: others converged");
    restore();
  }

  // ── Scenario 4: Max total rounds reached ──
  // All lenses always return issues → each gets 5 rounds
  // code_quality(5) + design(5) + testing(5) = 15 → maxTotalRounds → security skipped
  {
    const polish = setup(
      async () => issueReview(1),
      async () => agentOk,
    );
    const r = await polish.run(baseOpts);
    assertEqual(r.summary.totalRounds, 15, "sim:maxTotal: 15 total rounds");
    assertEqual(r.summary.lenses.length, 3, "sim:maxTotal: 3 lenses (security skipped)");
    assertEqual(r.summary.totalIssuesFound, 15, "sim:maxTotal: 15 issues");
    assert(r.summary.lenses.every((l) => !l.converged), "sim:maxTotal: none converged");
    assertEqual(r.summary.lenses[0].lens, "code_quality", "sim:maxTotal: lens order preserved");
    assertEqual(r.summary.lenses[2].lens, "testing", "sim:maxTotal: last lens is testing");
    restore();
  }

  // ── Scenario 5: Token budget exhausted from previous stages ──
  // dag.totalTokens() = 960 (96% of 1000) → polish refuses to start any lens
  {
    const polish = setup(
      async () => cleanReview,
      async () => agentOk,
    );
    const r = await polish.run({
      ...baseOpts,
      dag: { totalTokens: () => 960 },
      tokenBudget: 1000,
    });
    assertEqual(r.summary.totalRounds, 0, "sim:budget: 0 rounds");
    assertEqual(r.summary.lenses.length, 0, "sim:budget: 0 lenses ran");
    assertEqual(r.status, "pass", "sim:budget: still returns pass status");
    restore();
  }

  // ── Scenario 6: Test gate failure → fixTestFailures → then converge ──
  // code_quality R1: 1 issue → fix → test FAIL → fixTest
  // code_quality R2: clean → R3: clean → converge
  // other lenses: 2 clean rounds each
  {
    let llmCalls = 0;
    let agentCalls = 0;
    const polish = setup(
      async () => { llmCalls++; return llmCalls === 1 ? issueReview(1) : cleanReview; },
      async () => {
        agentCalls++;
        // call 1: fix → ok, call 2: test gate → FAIL, call 3: fixTest → ok
        return agentCalls === 2 ? agentTestFail : agentOk;
      },
    );
    const r = await polish.run(baseOpts);
    assertEqual(r.summary.totalRounds, 9, "sim:testFail: 9 rounds");
    assertEqual(r.summary.lenses[0].issuesFound, 1, "sim:testFail: 1 issue found");
    assertEqual(agentCalls, 3, "sim:testFail: 3 agent calls (fix, test, fixTest)");
    assert(r.summary.lenses.every((l) => l.converged), "sim:testFail: all converged after fix");
    // token usage should include all 3 agent calls
    const totalAgentTokens = 3 * (200 + 100); // 3 calls × (input + output)
    const totalLlmTokens = 9 * (100 + 50); // 9 calls × (input + output)
    const expectedTotal = totalAgentTokens + totalLlmTokens;
    const actualTotal = r.tokenUsage.input + r.tokenUsage.output;
    assertEqual(actualTotal, expectedTotal, "sim:testFail: token usage accumulated correctly");
    restore();
  }
}

// ── Run All Tests ──

// ── Autopilot Tests ──

function testAutopilotModuleExports() {
  assert(typeof ucmdAutopilot.setDeps === "function", "autopilot exports setDeps");
  assert(typeof ucmdAutopilot.setLog === "function", "autopilot exports setLog");
  assert(typeof ucmdAutopilot.handleAutopilotStart === "function", "autopilot exports handleAutopilotStart");
  assert(typeof ucmdAutopilot.handleAutopilotPause === "function", "autopilot exports handleAutopilotPause");
  assert(typeof ucmdAutopilot.handleAutopilotResume === "function", "autopilot exports handleAutopilotResume");
  assert(typeof ucmdAutopilot.handleAutopilotStop === "function", "autopilot exports handleAutopilotStop");
  assert(typeof ucmdAutopilot.handleAutopilotStatus === "function", "autopilot exports handleAutopilotStatus");
  assert(typeof ucmdAutopilot.handleAutopilotSession === "function", "autopilot exports handleAutopilotSession");
  assert(ucmdAutopilot.sessions instanceof Map, "autopilot exports sessions Map");
  assert(ucmdAutopilot.projectSessionMap instanceof Map, "autopilot exports projectSessionMap");
}

function testAutopilotSessionCreation() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  const session = ucmdAutopilot.createSession("/tmp/test-project");
  assert(session.id.startsWith("ap_"), "session id starts with ap_");
  assertEqual(session.status, "planning", "session initial status is planning");
  assertEqual(session.project, "/tmp/test-project", "session project path");
  assertEqual(session.projectName, "test-project", "session project name");
  assertEqual(session.iteration, 0, "session initial iteration");
  assert(Array.isArray(session.roadmap), "session has roadmap array");
  assert(Array.isArray(session.releases), "session has releases array");
  assert(Array.isArray(session.log), "session has log array");
  assertEqual(session.maxItems, DEFAULT_CONFIG.autopilot.maxItemsPerSession, "session maxItems from config");
  assertEqual(session.consecutiveFailures, 0, "session initial consecutiveFailures");
  assertEqual(session.totalItemsProcessed, 0, "session initial totalItemsProcessed");
  assert(session.startedAt !== null, "session has startedAt");

  // Verify session is stored
  assert(ucmdAutopilot.sessions.has(session.id), "session stored in sessions map");
  assert(ucmdAutopilot.projectSessionMap.has("/tmp/test-project"), "project stored in projectSessionMap");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/test-project");
}

function testAutopilotDuplicateProject() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  const session = ucmdAutopilot.createSession("/tmp/dup-project");
  let threw = false;
  try {
    ucmdAutopilot.createSession("/tmp/dup-project");
  } catch (e) {
    threw = true;
    assert(e.message.includes("already running"), "duplicate project error message");
  }
  assert(threw, "duplicate project throws error");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/dup-project");
}

function testAutopilotStatusHandler() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  // Empty sessions
  const emptyStatus = ucmdAutopilot.handleAutopilotStatus();
  assert(Array.isArray(emptyStatus), "status returns array");
  assertEqual(emptyStatus.length, 0, "status returns empty when no sessions");

  // With a session
  const session = ucmdAutopilot.createSession("/tmp/status-test");
  const status = ucmdAutopilot.handleAutopilotStatus();
  assertEqual(status.length, 1, "status returns 1 session");
  assertEqual(status[0].id, session.id, "status session id matches");
  assertEqual(status[0].projectName, "status-test", "status session projectName");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/status-test");
}

function testAutopilotPauseResume() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  const session = ucmdAutopilot.createSession("/tmp/pause-test");
  session.status = "running";

  // Pause
  const pauseResult = ucmdAutopilot.handleAutopilotPause({ sessionId: session.id });
  assertEqual(pauseResult.status, "paused", "pause returns paused status");
  assertEqual(session.status, "paused", "session status is paused");
  assertEqual(session.pausedPhase, "running", "pausedPhase preserved");

  // Resume
  const resumeResult = ucmdAutopilot.handleAutopilotResume({ sessionId: session.id });
  assertEqual(resumeResult.status, "running", "resume returns previous status");
  assertEqual(session.status, "running", "session status restored to running");
  assertEqual(session.pausedPhase, null, "pausedPhase cleared");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/pause-test");
}

function testAutopilotStop() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  const session = ucmdAutopilot.createSession("/tmp/stop-test");
  session.status = "running";

  const result = ucmdAutopilot.handleAutopilotStop({ sessionId: session.id });
  assertEqual(result.status, "stopped", "stop returns stopped status");
  assertEqual(session.status, "stopped", "session status is stopped");
  assert(!ucmdAutopilot.projectSessionMap.has("/tmp/stop-test"), "project removed from projectSessionMap");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
}

function testAutopilotSessionDetail() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  const session = ucmdAutopilot.createSession("/tmp/detail-test");
  session.roadmap = [{ title: "test item", type: "feature", status: "pending" }];

  const detail = ucmdAutopilot.handleAutopilotSession({ sessionId: session.id });
  assertEqual(detail.id, session.id, "detail id matches");
  assertEqual(detail.projectName, "detail-test", "detail projectName");
  assertEqual(detail.roadmap.length, 1, "detail has roadmap");
  assert(Array.isArray(detail.log), "detail has log array");
  assert(Array.isArray(detail.releases), "detail has releases array");

  // Not found
  let threw = false;
  try { ucmdAutopilot.handleAutopilotSession({ sessionId: "nonexistent" }); } catch { threw = true; }
  assert(threw, "session not found throws");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/detail-test");
}

function testParseRoadmapOutput() {
  const validOutput = 'Some text before\n[\n{"title":"Add login","type":"feature","description":"Implement login"},\n{"title":"Write tests","type":"test","description":"Add unit tests"}\n]\nSome text after';
  const roadmap = ucmdAutopilot.parseRoadmapOutput(validOutput, 1);
  assertEqual(roadmap.length, 2, "parseRoadmapOutput returns 2 items");
  assertEqual(roadmap[0].title, "Add login", "first item title");
  assertEqual(roadmap[0].type, "feature", "first item type");
  assertEqual(roadmap[0].iteration, 1, "first item iteration");
  assertEqual(roadmap[0].status, "pending", "first item status pending");

  // Invalid output
  const empty = ucmdAutopilot.parseRoadmapOutput("no json here", 1);
  assertEqual(empty.length, 0, "parseRoadmapOutput returns empty for invalid");
}

function testBumpVersion() {
  assertEqual(ucmdAutopilot.bumpVersion("0.0.0", "patch"), "0.0.1", "bumpVersion patch");
  assertEqual(ucmdAutopilot.bumpVersion("0.0.0", "minor"), "0.1.0", "bumpVersion minor");
  assertEqual(ucmdAutopilot.bumpVersion("0.0.0", "major"), "1.0.0", "bumpVersion major");
  assertEqual(ucmdAutopilot.bumpVersion("1.2.3", "patch"), "1.2.4", "bumpVersion patch from 1.2.3");
  assertEqual(ucmdAutopilot.bumpVersion("1.2.3", "minor"), "1.3.0", "bumpVersion minor from 1.2.3");
  assertEqual(ucmdAutopilot.bumpVersion("invalid", "patch"), "0.1.0", "bumpVersion with invalid version");
}

function testAutopilotDefaultConfig() {
  assert(DEFAULT_CONFIG.autopilot !== undefined, "DEFAULT_CONFIG has autopilot section");
  assertEqual(DEFAULT_CONFIG.autopilot.releaseEvery, 4, "autopilot releaseEvery default");
  assertEqual(DEFAULT_CONFIG.autopilot.maxConsecutiveFailures, 3, "autopilot maxConsecutiveFailures default");
  assertEqual(DEFAULT_CONFIG.autopilot.maxItemsPerSession, 50, "autopilot maxItemsPerSession default");
  assertEqual(DEFAULT_CONFIG.autopilot.reviewRetries, 2, "autopilot reviewRetries default");
  assert(DEFAULT_CONFIG.autopilot.itemMix !== undefined, "autopilot has itemMix");
  assertEqual(DEFAULT_CONFIG.autopilot.itemMix.feature, 0.4, "autopilot itemMix feature");
}

function testAutopilotSessionMetaKey() {
  assert(META_KEYS.has("autopilotSession"), "META_KEYS includes autopilotSession");
}

function testAutopilotTemplatesExist() {
  const templateDir = path.join(SOURCE_ROOT, "templates");
  assert(fs.existsSync(path.join(templateDir, "ucm-autopilot-plan.md")), "autopilot plan template exists");
  assert(fs.existsSync(path.join(templateDir, "ucm-autopilot-review.md")), "autopilot review template exists");
  assert(fs.existsSync(path.join(templateDir, "ucm-autopilot-release.md")), "autopilot release template exists");
}

function testAutopilotSessionHasForgeFields() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  const session = ucmdAutopilot.createSession("/tmp/forge-field-test");
  assert("stableTag" in session, "session has stableTag field");
  assert(Array.isArray(session.currentTestResults), "session has currentTestResults array");
  assert(Array.isArray(session.currentItemLog), "session has currentItemLog array");
  assertEqual(session._reviewResolve, null, "session _reviewResolve starts null");
  assertEqual(session._reviewTimer, null, "session _reviewTimer starts null");

  const detail = ucmdAutopilot.handleAutopilotSession({ sessionId: session.id });
  assert("stableTag" in detail, "session detail includes stableTag");
  assert("currentTestResults" in detail, "session detail includes currentTestResults");
  assert("currentItemLog" in detail, "session detail includes currentItemLog");

  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/forge-field-test");
}

async function testAutopilotGitRequired() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    spawnAgent: async () => ({ status: "done", stdout: "[]" }),
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  let threw = false;
  try {
    await ucmdAutopilot.handleAutopilotStart({ project: "/tmp/nonexistent-no-git-repo-test" });
  } catch (e) {
    threw = true;
    assert(e.message.includes("git"), "non-git project error mentions git");
  }
  assert(threw, "non-git project throws error");
}

async function testAutopilotSessionPersistence() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  const session = ucmdAutopilot.createSession("/tmp/persist-test");
  session.iteration = 2;
  session.status = "running";

  await ucmdAutopilot.saveSession(session);

  const loaded = await ucmdAutopilot.loadSession(session.id);
  assertEqual(loaded.id, session.id, "loaded session id matches");
  assertEqual(loaded.iteration, 2, "loaded session iteration matches");
  assertEqual(loaded.project, "/tmp/persist-test", "loaded session project matches");
  assertEqual(loaded._reviewResolve, null, "loaded session _reviewResolve is null");

  await ucmdAutopilot.deleteSessionFile(session.id);
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/persist-test");
}

function testAutopilotForgePipelineConfig() {
  assertEqual(DEFAULT_CONFIG.autopilot.forgePipeline, "small", "autopilot forgePipeline default is small");
}

function testAutopilotReleasesHandler() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });

  const session = ucmdAutopilot.createSession("/tmp/releases-test");
  session.releases.push({ version: "0.1.0", changelog: "test", taskIds: [], itemTitles: ["feat1"], tag: "v0.1.0-stable", timestamp: new Date().toISOString() });

  const result = ucmdAutopilot.handleAutopilotReleases({ sessionId: session.id });
  assertEqual(result.sessionId, session.id, "releases handler returns sessionId");
  assertEqual(result.releases.length, 1, "releases handler returns releases");
  assert(Array.isArray(result.stableTags), "releases handler returns stableTags array");

  // Not found
  let threw = false;
  try { ucmdAutopilot.handleAutopilotReleases({ sessionId: "nonexistent" }); } catch { threw = true; }
  assert(threw, "releases handler throws for nonexistent session");

  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/releases-test");
}

function testAutopilotDirectiveExports() {
  assert(typeof ucmdAutopilot.handleAutopilotDirectiveAdd === "function", "autopilot exports handleAutopilotDirectiveAdd");
  assert(typeof ucmdAutopilot.handleAutopilotDirectiveEdit === "function", "autopilot exports handleAutopilotDirectiveEdit");
  assert(typeof ucmdAutopilot.handleAutopilotDirectiveDelete === "function", "autopilot exports handleAutopilotDirectiveDelete");
  assert(typeof ucmdAutopilot.handleAutopilotDirectiveList === "function", "autopilot exports handleAutopilotDirectiveList");
  assert(typeof ucmdAutopilot.generateDirectiveId === "function", "autopilot exports generateDirectiveId");
}

function testAutopilotDirectiveCrud() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  const session = ucmdAutopilot.createSession("/tmp/directive-crud-test");

  // Add
  const addResult = ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "Add dark mode support" });
  assertEqual(addResult.directive.text, "Add dark mode support", "directive add returns correct text");
  assertEqual(addResult.directive.status, "pending", "directive add status is pending");
  assert(addResult.directive.id.startsWith("d_"), "directive id starts with d_");

  // Add another
  ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "Fix login bug" });

  // List all
  const listAll = ucmdAutopilot.handleAutopilotDirectiveList({ sessionId: session.id });
  assertEqual(listAll.directives.length, 2, "list returns 2 directives");

  // List by status
  const listPending = ucmdAutopilot.handleAutopilotDirectiveList({ sessionId: session.id, status: "pending" });
  assertEqual(listPending.directives.length, 2, "list pending returns 2");

  // Edit
  const directiveId = addResult.directive.id;
  const editResult = ucmdAutopilot.handleAutopilotDirectiveEdit({ sessionId: session.id, directiveId, text: "Add dark mode with toggle" });
  assertEqual(editResult.directive.text, "Add dark mode with toggle", "directive edit updates text");

  // Delete
  const secondId = listAll.directives[1].id;
  const deleteResult = ucmdAutopilot.handleAutopilotDirectiveDelete({ sessionId: session.id, directiveId: secondId });
  assertEqual(deleteResult.directiveId, secondId, "directive delete returns id");

  const afterDelete = ucmdAutopilot.handleAutopilotDirectiveList({ sessionId: session.id });
  assertEqual(afterDelete.directives.length, 1, "list returns 1 after delete");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/directive-crud-test");
}

function testAutopilotDirectiveValidation() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  // Non-existent session
  let threw = false;
  try { ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: "nonexistent", text: "test" }); } catch { threw = true; }
  assert(threw, "directive add throws for nonexistent session");

  // Empty text
  const session = ucmdAutopilot.createSession("/tmp/directive-validation-test");
  threw = false;
  try { ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "" }); } catch { threw = true; }
  assert(threw, "directive add throws for empty text");

  threw = false;
  try { ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "  " }); } catch { threw = true; }
  assert(threw, "directive add throws for whitespace-only text");

  // Stopped session
  session.status = "stopped";
  threw = false;
  try { ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "test" }); } catch (e) {
    threw = true;
    assert(e.message.includes("stopped"), "stopped session error mentions stopped");
  }
  assert(threw, "directive add throws for stopped session");

  // Consumed directive edit/delete
  session.status = "running";
  const addResult = ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "to be consumed" });
  const dId = addResult.directive.id;
  session.directives.find(d => d.id === dId).status = "consumed";

  threw = false;
  try { ucmdAutopilot.handleAutopilotDirectiveEdit({ sessionId: session.id, directiveId: dId, text: "new text" }); } catch (e) {
    threw = true;
    assert(e.message.includes("consumed"), "consumed edit error mentions consumed");
  }
  assert(threw, "directive edit throws for consumed directive");

  threw = false;
  try { ucmdAutopilot.handleAutopilotDirectiveDelete({ sessionId: session.id, directiveId: dId }); } catch (e) {
    threw = true;
    assert(e.message.includes("consumed"), "consumed delete error mentions consumed");
  }
  assert(threw, "directive delete throws for consumed directive");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/directive-validation-test");
}

function testAutopilotSessionDetailIncludesDirectives() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  const session = ucmdAutopilot.createSession("/tmp/directive-detail-test");
  ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "Test directive" });

  const detail = ucmdAutopilot.handleAutopilotSession({ sessionId: session.id });
  assert(Array.isArray(detail.directives), "session detail includes directives array");
  assertEqual(detail.directives.length, 1, "session detail has 1 directive");
  assertEqual(detail.directives[0].text, "Test directive", "session detail directive text matches");

  // Status includes pendingDirectives count
  const status = ucmdAutopilot.handleAutopilotStatus();
  const sessionStatus = status.find(s => s.id === session.id);
  assertEqual(sessionStatus.pendingDirectives, 1, "status includes pendingDirectives count");

  // Cleanup
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/directive-detail-test");
}

async function testAutopilotDirectivePersistence() {
  ucmdAutopilot.setDeps({
    config: () => DEFAULT_CONFIG,
    daemonState: () => ({ daemonStatus: "running" }),
    broadcastWs: () => {},
    log: () => {},
  });
  ucmdAutopilot.setLog(() => {});

  const session = ucmdAutopilot.createSession("/tmp/directive-persist-test");
  ucmdAutopilot.handleAutopilotDirectiveAdd({ sessionId: session.id, text: "Persist this" });

  await ucmdAutopilot.saveSession(session);
  const loaded = await ucmdAutopilot.loadSession(session.id);

  assert(Array.isArray(loaded.directives), "loaded session has directives array");
  assertEqual(loaded.directives.length, 1, "loaded session has 1 directive");
  assertEqual(loaded.directives[0].text, "Persist this", "loaded directive text matches");
  assertEqual(loaded.directives[0].status, "pending", "loaded directive status is pending");

  await ucmdAutopilot.deleteSessionFile(session.id);
  ucmdAutopilot.sessions.delete(session.id);
  ucmdAutopilot.projectSessionMap.delete("/tmp/directive-persist-test");
}

function testSandboxCommitAllChanges() {
  assert(typeof ucmdSandbox.commitAllChanges === "function", "sandbox exports commitAllChanges");
}

function testSandboxDetectTestCommand() {
  assert(typeof ucmdSandbox.detectTestCommand === "function", "sandbox exports detectTestCommand");
  assert(typeof ucmdSandbox.runProjectTests === "function", "sandbox exports runProjectTests");

  // UCM itself should be detected as "ucm" type
  const ucmResult = ucmdSandbox.detectTestCommand(SOURCE_ROOT);
  assert(ucmResult !== null, "detectTestCommand finds UCM tests");
  assertEqual(ucmResult.type, "ucm", "detectTestCommand returns ucm type for self");
  assert(Array.isArray(ucmResult.layers), "ucm test info has layers");

  // Non-existent path should return null
  const noResult = ucmdSandbox.detectTestCommand("/tmp/no-such-project-" + Date.now());
  assertEqual(noResult, null, "detectTestCommand returns null for non-project");
}

function testSandboxIsGitRepo() {
  assert(typeof ucmdSandbox.isGitRepo === "function", "sandbox exports isGitRepo");
  assertEqual(ucmdSandbox.isGitRepo(SOURCE_ROOT), true, "isGitRepo true for UCM root");
  assertEqual(ucmdSandbox.isGitRepo("/tmp"), false, "isGitRepo false for /tmp");
}

function testSandboxListStableTags() {
  assert(typeof ucmdSandbox.listStableTags === "function", "sandbox exports listStableTags");
  const tags = ucmdSandbox.listStableTags();
  assert(Array.isArray(tags), "listStableTags returns array");
}

// ── Sandbox Tests ──

function testSandboxModuleExports() {
  assert(typeof ucmdSandbox.setLog === "function", "sandbox exports setLog");
  assert(typeof ucmdSandbox.isSelfTarget === "function", "sandbox exports isSelfTarget");
  assert(typeof ucmdSandbox.selfSafetyGate === "function", "sandbox exports selfSafetyGate");
  assert(typeof ucmdSandbox.getCurrentStableTag === "function", "sandbox exports getCurrentStableTag");
  assert(typeof ucmdSandbox.tagStableVersion === "function", "sandbox exports tagStableVersion");
  assert(typeof ucmdSandbox.createDevBranch === "function", "sandbox exports createDevBranch");
  assert(typeof ucmdSandbox.mergeDevBranch === "function", "sandbox exports mergeDevBranch");
  assert(typeof ucmdSandbox.deleteDevBranch === "function", "sandbox exports deleteDevBranch");
  assert(typeof ucmdSandbox.rollbackToTag === "function", "sandbox exports rollbackToTag");
  assert(typeof ucmdSandbox.getCurrentBranch === "function", "sandbox exports getCurrentBranch");
  assert(typeof ucmdSandbox.checkoutBranch === "function", "sandbox exports checkoutBranch");
  assert(typeof ucmdSandbox.discardChanges === "function", "sandbox exports discardChanges");
  assert(typeof ucmdSandbox.runTestLayer === "function", "sandbox exports runTestLayer");
  assert(typeof ucmdSandbox.runAllTests === "function", "sandbox exports runAllTests");
  assert(Array.isArray(ucmdSandbox.TEST_LAYERS), "sandbox exports TEST_LAYERS array");
}

function testSandboxIsSelfTarget() {
  assert(ucmdSandbox.isSelfTarget(SOURCE_ROOT), "isSelfTarget returns true for SOURCE_ROOT");
  assert(!ucmdSandbox.isSelfTarget("/tmp/other-project"), "isSelfTarget returns false for other path");
  assert(!ucmdSandbox.isSelfTarget(null), "isSelfTarget returns false for null");
  assert(!ucmdSandbox.isSelfTarget(""), "isSelfTarget returns false for empty string");
}

function testSandboxTestLayers() {
  assertEqual(ucmdSandbox.TEST_LAYERS.length, 3, "TEST_LAYERS has 3 layers");
  assertEqual(ucmdSandbox.TEST_LAYERS[0].name, "unit", "first layer is unit");
  assertEqual(ucmdSandbox.TEST_LAYERS[1].name, "integration", "second layer is integration");
  assertEqual(ucmdSandbox.TEST_LAYERS[2].name, "browser", "third layer is browser");
  for (const layer of ucmdSandbox.TEST_LAYERS) {
    assert(Array.isArray(layer.command), `layer ${layer.name} has command array`);
    assert(layer.command.length >= 2, `layer ${layer.name} command has at least 2 elements`);
  }
}

function testSandboxGetCurrentBranch() {
  const branch = ucmdSandbox.getCurrentBranch();
  assert(typeof branch === "string" || branch === null, "getCurrentBranch returns string or null");
  if (branch) {
    assert(branch.length > 0, "getCurrentBranch returns non-empty string");
  }
}

function testSandboxGetCurrentStableTag() {
  // May return null if no tags exist — that's fine
  const tag = ucmdSandbox.getCurrentStableTag();
  assert(tag === null || typeof tag === "string", "getCurrentStableTag returns string or null");
}

async function testSandboxRunTestLayer() {
  // Run a quick command that always succeeds to test the test runner itself
  const result = await ucmdSandbox.runTestLayer("echo-test", ["node", "-e", `
    console.log("1 tests, 1 passed, 0 failed");
  `], { timeoutMs: 10000 });
  assertEqual(result.name, "echo-test", "runTestLayer returns correct name");
  assertEqual(result.passed, true, "runTestLayer passes for passing test");
  assertEqual(result.total, 1, "runTestLayer parses total");
  assertEqual(result.passing, 1, "runTestLayer parses passing");
  assertEqual(result.failing, 0, "runTestLayer parses failing");
  assert(result.elapsed >= 0, "runTestLayer records elapsed time");
}

async function testSandboxRunTestLayerFailure() {
  // A test that reports a failure
  const result = await ucmdSandbox.runTestLayer("fail-test", ["node", "-e", `
    console.log("2 tests, 1 passed, 1 failed");
    process.exit(1);
  `], { timeoutMs: 10000 });
  assertEqual(result.name, "fail-test", "runTestLayer failure returns correct name");
  assertEqual(result.passed, false, "runTestLayer failure detected");
  assertEqual(result.total, 2, "runTestLayer failure parses total");
  assertEqual(result.failing, 1, "runTestLayer failure parses failing count");
}

function testSandboxDefaultConfig() {
  assert(DEFAULT_CONFIG.selfImprove !== undefined, "DEFAULT_CONFIG has selfImprove section");
  assertEqual(DEFAULT_CONFIG.selfImprove.enabled, false, "selfImprove disabled by default");
  assertEqual(DEFAULT_CONFIG.selfImprove.maxIterations, 5, "selfImprove maxIterations default");
  assertEqual(DEFAULT_CONFIG.selfImprove.requireAllTestLayers, true, "selfImprove requireAllTestLayers default");
  assertEqual(DEFAULT_CONFIG.selfImprove.requireHumanApproval, true, "selfImprove requireHumanApproval default");
  assertEqual(DEFAULT_CONFIG.selfImprove.backupBranch, true, "selfImprove backupBranch default");
  assertEqual(DEFAULT_CONFIG.selfImprove.testTimeoutMs, 300000, "selfImprove testTimeoutMs default");
  assertEqual(DEFAULT_CONFIG.selfImprove.maxRisk, "low", "selfImprove maxRisk default");
  // Autopilot config has its own execution settings
  assertEqual(DEFAULT_CONFIG.autopilot.maxIterations, 5, "autopilot maxIterations default");
  assertEqual(DEFAULT_CONFIG.autopilot.requireHumanApproval, true, "autopilot requireHumanApproval default");
  assertEqual(DEFAULT_CONFIG.autopilot.reviewTimeoutMs, 30 * 60 * 1000, "autopilot reviewTimeoutMs default");
  assertEqual(DEFAULT_CONFIG.autopilot.testTimeoutMs, 300000, "autopilot testTimeoutMs default");
}

async function main() {
  startSuiteTimer(120_000);
  console.log("UCM Test Suite\n");
  await ensureDirectories();

  // Unit tests
  console.log("Unit Tests:");
  testParseTaskFileBasic();
  testParseTaskFileQuotedValues();
  testParseTaskFileArrays();
  testParseTaskFileBooleans();
  testParseTaskFileNoFrontmatter();
  testParseTaskFileColonInValue();
  testSerializeTaskFile();
  testSerializeRoundtrip();
  testExtractMeta();
  testNormalizeProjectsSingle();
  testNormalizeProjectsArray();
  testNormalizeProjectsEmpty();
  await testCreateTempWorkspace();
  await testUpdateTaskProject();
  await testResolveProjectForTaskWithProject();
  await testResolveProjectForTaskWithoutProject();
  testGenerateTaskId();
  console.log();

  console.log("Resource Monitor Tests:");
  testCheckResources();
  testGetResourcePressure();
  console.log();

  console.log("Pipeline Engine Tests:");
  testResolvePipeline();
  testNormalizeStep();
  testFindResumeStepIndex();
  testParseGateResult();
  testExtractCriticalIssues();
  testIsGateStep();
  testBuildStageResultsSummary();
  testPipelineInMetaKeys();
  testResolveMaxIterations();
  testNormalizeStepMaxIterationsAuto();
  testNormalizeStepLoopDefaults();
  testTestTemplateExists();
  testImplementTemplateHasTestFeedback();
  testSelfReviewTemplateExists();
  testGatherTemplateExists();
  testSpecTemplateExists();
  testRsaTemplatesExist();
  testVisualCheckTemplateExists();
  testDefaultConfigInfra();
  testDefaultConfigPipelines();
  testThoroughPipelineResolve();
  testSuspendedMetaKeys();
  await testInfraLockAcquireRelease();
  console.log();

  console.log("WebSocket Frame Tests:");
  testBroadcastWsType();
  console.log();

  console.log("Self-Update Tests:");
  testDataVersion();
  testDefaultStateDataVersion();
  testSourceRoot();
  console.log();

  console.log("Structure Analysis Tests:");
  testGetLanguageFamily();
  testCountFunctions();
  testGetSizeCategory();
  await testAnalyzeFile();
  testGetChangedFiles();
  testFormatChangedFilesMetrics();
  testFormatProjectStructureMetrics();
  console.log();

  console.log("Git Validation Tests:");
  testIsGitRepo();
  testValidateGitProjectsValid();
  testValidateGitProjectsInvalid();
  console.log();

  console.log("Commit History Tests:");
  testAnalyzeCommitHistory();
  testAnalyzeCommitHistoryNonexistent();
  testEmptyCommitMetrics();
  testFormatCommitHistory();
  testFormatCommitHistoryEmpty();
  testLargeCommitThreshold();
  console.log();

  console.log("Documentation Coverage Tests:");
  await testScanDocumentation();
  await testScanDocumentationNonexistent();
  testFormatDocumentation();
  testFormatDocumentationMissing();
  testAnalyzeDocCoverage();
  testAnalyzeDocCoverageWithFiles();
  testDocExtensionsAndDirs();
  await testGenerateProjectContext();
  testFormatProjectContext();
  console.log();

  console.log("Template Placeholder Tests:");
  testObserveTemplateHasCommitHistory();
  testSelfReviewTemplateHasDocCoverage();
  testAutopilotPlanTemplateHasProjectContext();
  testAutopilotReleaseTemplateUpdated();
  console.log();

  console.log("Observer/Proposal Tests:");
  testGenerateProposalId();
  testComputeDedupHash();
  testSerializeAndParseProposal();
  testCaptureMetricsSnapshot();
  testParseObserverOutput();
  testDefaultConfigObserver();
  testProposalConstants();
  testObserveTemplateExists();
  testObserveTemplateHasPlaceholders();
  await testSaveAndLoadProposal();
  await testListProposals();
  await testProposalDirectories();
  console.log();

  console.log("Multi-Perspective Observer Tests:");
  testObserverPerspectivesDefined();
  testExpandedCategories();
  testObserveTemplateHasPerspective();
  testResearchTemplateExists();
  testParseObserverOutputExpandedCategories();
  testBugfixPriorityBoost();
  console.log();

  console.log("On-Demand Analysis/Research Tests:");
  testAnalyzeProjectExported();
  testHandleAnalyzeProjectExported();
  testHandleResearchProjectExported();
  testSocketHandlerMappings();
  testUiServerAnalyzeRoute();
  testUiServerResearchRoute();
  await testMkdirApi();
  testUiModalNotClosedBeforeSuccess();
  testUiRightPanelRefinementGuard();
  testUiHtmlJsSyntax();
  console.log();

  console.log("QnA Core Tests:");
  testExpectedConstants();
  testComputeCoverageGreenfield();
  testComputeCoveragePartial();
  testComputeCoverageOverflow();
  testComputeCoverageBrownfield();
  testComputeCoverageBooleanFlag();
  testComputeCoverageRefinement();
  testComputeCoverageWithRefinementBrownfield();
  testIsFullyCovered();
  testParseDecisionsFileBasic();
  testParseDecisionsFileEmpty();
  testParseDecisionsFileNoReason();
  testParseDecisionsFileMultipleInArea();
  testFormatDecisionsBasic();
  testFormatDecisionsNoCoverage();
  testFormatDecisionsEmpty();
  testFormatDecisionsRoundtrip();
  testBuildQuestionPromptGreenfield();
  testBuildQuestionPromptBrownfield();
  testBuildQuestionPromptBrownfieldNoContext();
  testBuildQuestionPromptWithDecisions();
  testBuildQuestionPromptWithTemplate();
  testBuildQuestionPromptNoTemplate();
  testBuildQuestionPromptWithFeedback();
  testBuildRefinementPromptGreenfield();
  testBuildRefinementPromptBrownfield();
  testBuildRefinementPromptWithDecisions();
  testBuildAutopilotRefinementPrompt();
  testBuildAutopilotRefinementPromptBrownfield();
  testBuildAutopilotRefinementPromptNoDescription();
  testFormatRefinedRequirementsBasic();
  testFormatRefinedRequirementsFallbackToAnswer();
  testFormatRefinedRequirementsBrownfield();
  testFormatRefinedRequirementsEmpty();
  testFormatRefinedRequirementsUnknownArea();
  testFormatRefinedRequirementsSectionOrder();
  console.log();

  console.log("Snapshot/Evaluation Tests:");
  testCompareSnapshotsExported();
  testCompareSnapshotsImproved();
  testCompareSnapshotsRegressed();
  testCompareSnapshotsNeutral();
  await testSaveAndLoadSnapshot();
  await testCleanupOldSnapshots();
  await testFindProposalByTaskId();
  console.log();

  // Integration tests
  console.log("Integration Tests:");
  await testEnsureDirectories();
  await testLessonsDirectory();
  await testCollectRelevantLessons();
  await testLoadProjectPreferences();
  await testConfig();
  await testArtifacts();
  console.log();

  console.log("Worktree Tests:");
  await testWorktreeCreateAndDiff();
  console.log();

  console.log("Daemon Tests:");
  await testDaemonLifecycle();
  console.log();

  console.log("Approve/Reject Tests:");
  await testApproveRejectFlow();
  console.log();

  console.log("Socket Server Tests:");
  await testHttpServer();
  console.log();

  console.log("Socket Proposals API Tests:");
  await testHttpProposalsApi();
  console.log();

  console.log("Forge V2 Tests:");
  testSanitizeEnv();
  testExtractJsonVariants();
  testBuildCommandProviders();
  testStageModelsProxy();
  testCheckRequiredArtifactsLogic();
  testCustomPipelineParsing();
  testSanitizeContentPatterns();
  testParseArgsCli();
  testGetNextAction();
  testDetectOrphanLogic();
  testTaskDagSaveChaining();
  testDeliverAutoMergeFailureSetsReview();
  testAgentSkipPermissions();
  testRsaClassifySkipPermissions();
  testServerTaskIdValidation();
  testWireEventsIncludesAbort();
  testSubtasksRunSequentially();
  testParallelTokenUsage();
  testVerifyUsesExtractJson();
  testSubtaskMissingContinues();
  testResumeInvalidStageThrows();
  testImplementFailureRecordsStage();
  testIntakeRecordsStage();
  testSpecifyRsaTokenUsage();
  testRemoveWorktreesUsesOrigin();
  testIntegrateConflictResolutionUsesOrigin();
  testPolishConfig();
  testPolishModuleExports();
  testPolishLensPromptsCoverage();
  testPolishModelEnvOverride();
  testPolishCustomPipelineDetection();
  testPolishInSubtaskStages();
  testPolishStageEstimate();
  console.log();

  console.log("Polish Simulation Tests:");
  await testPolishSimulations();
  console.log();

  console.log("UX Review Tests:");
  testUxReviewModuleExports();
  testUxReviewParseValid();
  testUxReviewParseInvalid();
  testUxReviewFormatFeedback();
  testUxReviewConstants();
  testUxReviewTemplate();
  testUxReviewInPipeline();
  await testUxReviewDetectFrontend();
  testBrowserModuleExports();
  testBrowserResolvePort();
  testExtractPortFromScript();
  testPickDevScript();
  testScriptLooksLikeWebServer();
  testFrameworkSignatures();
  console.log();

  console.log("Autopilot Tests:");
  testAutopilotModuleExports();
  testAutopilotSessionCreation();
  testAutopilotDuplicateProject();
  testAutopilotStatusHandler();
  testAutopilotPauseResume();
  testAutopilotStop();
  testAutopilotSessionDetail();
  testParseRoadmapOutput();
  testBumpVersion();
  testAutopilotDefaultConfig();
  testAutopilotSessionMetaKey();
  testAutopilotTemplatesExist();
  testAutopilotSessionHasForgeFields();
  testAutopilotReleasesHandler();
  await testAutopilotGitRequired();
  await testAutopilotSessionPersistence();
  testAutopilotForgePipelineConfig();
  testAutopilotDirectiveExports();
  testAutopilotDirectiveCrud();
  testAutopilotDirectiveValidation();
  testAutopilotSessionDetailIncludesDirectives();
  await testAutopilotDirectivePersistence();
  console.log();

  console.log("Sandbox Tests:");
  testSandboxModuleExports();
  testSandboxCommitAllChanges();
  testSandboxDetectTestCommand();
  testSandboxIsGitRepo();
  testSandboxListStableTags();
  testSandboxIsSelfTarget();
  testSandboxTestLayers();
  testSandboxGetCurrentBranch();
  testSandboxGetCurrentStableTag();
  await testSandboxRunTestLayer();
  await testSandboxRunTestLayerFailure();
  testSandboxDefaultConfig();
  console.log();


  // cleanup
  await cleanupAll();
  try { await rm(TEST_UCM_DIR, { recursive: true }); } catch {}

  // Summary
  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nTest error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
