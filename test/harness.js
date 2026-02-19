// test/harness.js — shared test utilities with process-level safety

// Mutable state object: shared between harness and test files
const state = { passed: 0, failed: 0, failures: [] };

// Suite-level timeout: prevents process hang regardless of cause
let suiteTimer = null;

function startSuiteTimer(timeoutMs = 120_000) {
  suiteTimer = setTimeout(() => {
    console.error(`\nSUITE TIMEOUT: ${timeoutMs}ms exceeded. Forcing exit.`);
    process.exit(2);
  }, timeoutMs);
  suiteTimer.unref();
}

function stopSuiteTimer() {
  if (suiteTimer) clearTimeout(suiteTimer);
}

function assert(condition, message) {
  if (condition) {
    state.passed++;
    process.stdout.write(".");
  } else {
    state.failed++;
    state.failures.push(message);
    process.stdout.write("F");
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    state.passed++;
    process.stdout.write(".");
  } else {
    state.failed++;
    state.failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.stdout.write("F");
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    state.passed++;
    process.stdout.write(".");
  } else {
    state.failed++;
    state.failures.push(`${message}:\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    process.stdout.write("F");
  }
}

// Wrap async test with per-test timeout
async function withTimeout(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TEST TIMEOUT: ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// Run a named group of tests with optional per-test timeout
async function runGroup(name, tests, { timeout = 30_000 } = {}) {
  console.log(`${name}:`);
  for (const [testName, testFn] of Object.entries(tests)) {
    try {
      if (testFn.constructor.name === "AsyncFunction") {
        await withTimeout(testFn, timeout, testName);
      } else {
        testFn();
      }
    } catch (e) {
      state.failed++;
      state.failures.push(`${testName}: ${e.message}`);
      process.stdout.write("F");
    }
  }
  console.log();
}

function summary() {
  console.log(`\n${state.passed + state.failed} tests, ${state.passed} passed, ${state.failed} failed`);
  if (state.failures.length > 0) {
    console.log("\nFailures:");
    for (const f of state.failures) {
      console.log(`  - ${f}`);
    }
  }
  return { passed: state.passed, failed: state.failed, failures: state.failures };
}

module.exports = {
  state,
  assert, assertEqual, assertDeepEqual,
  withTimeout, runGroup,
  startSuiteTimer, stopSuiteTimer,
  summary,
};
