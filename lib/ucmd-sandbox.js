const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const { SOURCE_ROOT } = require("./ucmd-constants.js");

let log = () => {};

function setLog(fn) { log = fn; }

function isSelfTarget(projectPath) {
  if (!projectPath) return false;
  return path.resolve(projectPath) === SOURCE_ROOT;
}

// ── Git Operations (project-agnostic) ──

function gitSync(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getMainBranch(cwd) {
  try {
    const ref = gitSync(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // fallback: check if main or master exists
    try {
      gitSync(["rev-parse", "--verify", "main"], cwd);
      return "main";
    } catch {
      try {
        gitSync(["rev-parse", "--verify", "master"], cwd);
        return "master";
      } catch {
        return "main";
      }
    }
  }
}

function getCurrentBranch(cwd = SOURCE_ROOT) {
  try {
    return gitSync(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  } catch {
    return null;
  }
}

function getCurrentStableTag(cwd = SOURCE_ROOT) {
  try {
    const tags = gitSync(["tag", "--list", "v*-stable", "--sort=-creatordate"], cwd);
    const first = tags.split("\n")[0];
    return first || null;
  } catch {
    return null;
  }
}

function tagStableVersion(version, cwd = SOURCE_ROOT) {
  const tag = version.endsWith("-stable") ? version : `${version}-stable`;
  gitSync(["tag", tag], cwd);
  log(`tagged stable version: ${tag} in ${cwd}`);
  return tag;
}

function createDevBranch(name, cwd = SOURCE_ROOT) {
  gitSync(["checkout", "-b", name], cwd);
  log(`created dev branch: ${name} in ${cwd}`);
}

function mergeDevBranch(name, cwd = SOURCE_ROOT) {
  const main = getMainBranch(cwd);
  gitSync(["checkout", main], cwd);
  gitSync(["merge", "--no-ff", name, "-m", `merge: autopilot ${name}`], cwd);
  log(`merged dev branch: ${name} → ${main} in ${cwd}`);
}

function deleteDevBranch(name, cwd = SOURCE_ROOT) {
  try {
    gitSync(["branch", "-d", name], cwd);
    log(`deleted dev branch: ${name}`);
  } catch (e) {
    log(`failed to delete branch ${name}: ${e.message}`);
  }
}

function rollbackToTag(tag, cwd = SOURCE_ROOT) {
  const main = getMainBranch(cwd);
  gitSync(["checkout", main], cwd);
  gitSync(["reset", "--hard", tag], cwd);
  log(`rolled back to tag: ${tag}`);
}

function checkoutBranch(name, cwd = SOURCE_ROOT) {
  gitSync(["checkout", name], cwd);
}

function discardChanges(cwd = SOURCE_ROOT) {
  try { gitSync(["checkout", "--", "."], cwd); } catch {}
  try { gitSync(["clean", "-fd"], cwd); } catch {}
}

function commitAllChanges(message, cwd) {
  try {
    const status = gitSync(["status", "--porcelain"], cwd);
    if (!status) return false; // nothing to commit
    gitSync(["add", "-A"], cwd);
    gitSync(["commit", "-m", message], cwd);
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(cwd) {
  try {
    gitSync(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

function listStableTags(cwd = SOURCE_ROOT) {
  try {
    const tags = gitSync(["tag", "--list", "v*-stable", "--sort=-creatordate"], cwd);
    if (!tags) return [];
    return tags.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ── Test Detection & Execution ──

const UCM_TEST_LAYERS = [
  { name: "unit", command: ["node", "test/ucm.test.js"] },
  { name: "integration", command: ["node", "test/integration.js"] },
  { name: "browser", command: ["node", "test/browser.js"] },
];

function detectTestCommand(projectPath) {
  // 1. UCM itself → 3-layer tests
  if (isSelfTarget(projectPath)) {
    return { type: "ucm", layers: UCM_TEST_LAYERS };
  }

  // 2. Node.js project with package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf-8"));
    if (pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      return { type: "npm", command: ["npm", "test"], cwd: projectPath };
    }
  } catch {}

  // 3. Makefile with test target
  try {
    const makefile = fs.readFileSync(path.join(projectPath, "Makefile"), "utf-8");
    if (/^test\s*:/m.test(makefile)) {
      return { type: "make", command: ["make", "test"], cwd: projectPath };
    }
  } catch {}

  // 4. Python project
  try {
    fs.statSync(path.join(projectPath, "pytest.ini"));
    return { type: "pytest", command: ["pytest"], cwd: projectPath };
  } catch {}
  try {
    fs.statSync(path.join(projectPath, "setup.py"));
    return { type: "pytest", command: ["python", "-m", "pytest"], cwd: projectPath };
  } catch {}

  return null;
}

function runTestLayer(name, command, options = {}) {
  const { timeoutMs = 300000, cwd = SOURCE_ROOT } = options;
  return new Promise((resolve) => {
    const startTime = Date.now();
    try {
      const output = execFileSync(command[0], command.slice(1), {
        cwd,
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const combined = output + "";
      const match = combined.match(/(\d+) tests, (\d+) passed, (\d+) failed/);
      const elapsed = Date.now() - startTime;

      if (!match) {
        if (combined.includes("0 tests, 0 passed, 0 failed") || combined.includes("skipping")) {
          resolve({ name, passed: true, total: 0, passing: 0, failing: 0, elapsed, skipped: true });
        } else {
          resolve({ name, passed: true, total: 0, passing: 0, failing: 0, elapsed, output: combined.slice(-500) });
        }
        return;
      }

      resolve({
        name, passed: parseInt(match[3]) === 0,
        total: parseInt(match[1]), passing: parseInt(match[2]), failing: parseInt(match[3]), elapsed,
      });
    } catch (e) {
      const elapsed = Date.now() - startTime;
      const stderr = (e.stderr || e.message || "").slice(0, 500);
      const stdout = (e.stdout || "").slice(-500);
      const combined = stdout + stderr;

      const match = combined.match(/(\d+) tests, (\d+) passed, (\d+) failed/);
      if (match) {
        resolve({
          name, passed: false,
          total: parseInt(match[1]), passing: parseInt(match[2]), failing: parseInt(match[3]),
          elapsed, error: stderr.slice(0, 200),
        });
      } else {
        // Generic test: exit code 0 = pass, nonzero = fail
        resolve({
          name, passed: false,
          total: 0, passing: 0, failing: 0,
          elapsed, error: stderr.slice(0, 200),
        });
      }
    }
  });
}

async function runAllTests(taskId, options = {}) {
  const { requireAllLayers = true, timeoutMs = 300000 } = options;
  const results = [];

  for (const layer of UCM_TEST_LAYERS) {
    log(`[${taskId}] running ${layer.name} tests...`);
    const result = await runTestLayer(layer.name, layer.command, { timeoutMs, cwd: SOURCE_ROOT });
    results.push(result);
    log(`[${taskId}] ${layer.name}: ${result.passed ? "PASS" : "FAIL"} (${result.passing}/${result.total}, ${result.elapsed}ms)`);

    if (!result.passed && requireAllLayers) {
      return { passed: false, results, failedAt: layer.name };
    }
  }

  return {
    passed: results.every((r) => r.passed),
    results,
  };
}

async function runProjectTests(projectPath, options = {}) {
  const { timeoutMs = 300000 } = options;
  const testInfo = detectTestCommand(projectPath);

  if (!testInfo) {
    log(`[runProjectTests] no tests detected for ${projectPath}`);
    return { passed: true, results: [], skipped: true };
  }

  if (testInfo.type === "ucm") {
    return runAllTests(options.taskId || "project-test", { timeoutMs });
  }

  // Single command test (npm test, make test, pytest, etc.)
  const result = await runTestLayer("test", testInfo.command, {
    timeoutMs,
    cwd: testInfo.cwd || projectPath,
  });

  return {
    passed: result.passed,
    results: [result],
    failedAt: result.passed ? null : "test",
  };
}

// ── Legacy Safety Gate ──

async function selfSafetyGate(taskId, projectPath) {
  if (!isSelfTarget(projectPath)) return { safe: true };

  log(`[${taskId}] self-modification detected — running safety gate`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupBranch = `ucm-backup-${timestamp}`;
  try {
    gitSync(["branch", backupBranch], SOURCE_ROOT);
    log(`[${taskId}] backup branch created: ${backupBranch}`);
  } catch (e) {
    log(`[${taskId}] backup branch creation failed: ${e.message}`);
    return { safe: false, reason: `backup branch creation failed: ${e.message}` };
  }

  const testResult = await runAllTests(taskId);

  if (!testResult.passed) {
    const failedLayers = testResult.results.filter((r) => !r.passed).map((r) => r.name);
    return {
      safe: false,
      reason: `tests failed in: ${failedLayers.join(", ")}`,
      backupBranch,
      testResults: testResult.results,
    };
  }

  const totalPassed = testResult.results.reduce((sum, r) => sum + r.passing, 0);
  const totalTests = testResult.results.reduce((sum, r) => sum + r.total, 0);
  log(`[${taskId}] safety gate passed: ${totalPassed}/${totalTests} tests across ${testResult.results.length} layers`);

  return {
    safe: true, backupBranch,
    testsRun: totalTests, testsPassed: totalPassed,
    testResults: testResult.results,
  };
}

module.exports = {
  setLog,
  isSelfTarget,
  selfSafetyGate,
  // Git operations (project-agnostic)
  commitAllChanges,
  getMainBranch,
  getCurrentStableTag,
  tagStableVersion,
  createDevBranch,
  mergeDevBranch,
  deleteDevBranch,
  rollbackToTag,
  getCurrentBranch,
  checkoutBranch,
  discardChanges,
  isGitRepo,
  listStableTags,
  // Test detection & execution
  detectTestCommand,
  runTestLayer,
  runAllTests,
  runProjectTests,
  TEST_LAYERS: UCM_TEST_LAYERS,
};
