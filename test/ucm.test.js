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
  captureMetricsSnapshot, parseObserverOutput,
  getLanguageFamily, countFunctions, getSizeCategory, analyzeFile, getChangedFiles,
  formatChangedFilesMetrics, formatProjectStructureMetrics,
  isGitRepo, validateGitProjects,
  analyzeCommitHistory, emptyCommitMetrics, formatCommitHistory, LARGE_COMMIT_THRESHOLD,
  DOC_EXTENSIONS, DOC_DIRS, scanDocumentation, formatDocumentation, analyzeDocCoverage,
  saveSnapshot, loadLatestSnapshot, loadAllSnapshots, cleanupOldSnapshots,
  compareSnapshots, findProposalByTaskId, evaluateProposal,
} = require("../lib/ucmd.js");

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

// ── Run All Tests ──

async function main() {
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
  console.log();

  console.log("Template Placeholder Tests:");
  testObserveTemplateHasCommitHistory();
  testSelfReviewTemplateHasDocCoverage();
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

  // cleanup test directory
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
}

main().catch((e) => {
  console.error(`\nTest error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
