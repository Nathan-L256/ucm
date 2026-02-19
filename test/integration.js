#!/usr/bin/env node
// test/integration.js — daemon + HTTP integration tests

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const http = require("http");

const { state, assert, assertEqual, runGroup, startSuiteTimer, stopSuiteTimer, summary } = require("./harness.js");
const { trackPid, cleanupAll } = require("./helpers/cleanup.js");

const UCM_DIR = path.join(os.tmpdir(), `ucm-integration-${Date.now()}`);
const DAEMON_DIR = path.join(UCM_DIR, "daemon");
const SOCK_PATH = path.join(DAEMON_DIR, "ucm.sock");
const TASKS_DIR = path.join(UCM_DIR, "tasks");

// ── Helpers ──

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function setupDirs() {
  mkdirp(DAEMON_DIR);
  for (const sub of ["pending", "running", "review", "done", "failed"]) {
    mkdirp(path.join(TASKS_DIR, sub));
  }
  mkdirp(path.join(UCM_DIR, "worktrees"));
  mkdirp(path.join(UCM_DIR, "workspaces"));
  mkdirp(path.join(UCM_DIR, "artifacts"));
  mkdirp(path.join(UCM_DIR, "logs"));
  mkdirp(path.join(UCM_DIR, "lessons"));
  mkdirp(path.join(UCM_DIR, "proposals"));
  for (const sub of ["proposed", "approved", "rejected", "implemented"]) {
    mkdirp(path.join(UCM_DIR, "proposals", sub));
  }
  mkdirp(path.join(UCM_DIR, "snapshots"));

  // write minimal config
  const config = {
    concurrency: 1,
    provider: "claude",
    model: "opus",
    scanIntervalMs: 60000,
    pipeline: ["analyze", "implement"],
    defaultPipeline: "quick",
    stageTimeoutMs: 30000,
    httpPort: 0,
    uiPort: 0,
    resources: { cpuThreshold: 0.8, memoryMinFreeMb: 512, diskMinFreeGb: 1, checkIntervalMs: 60000 },
    cleanup: { retentionDays: 7, autoCleanOnDiskPressure: true },
    quota: { source: "ccusage", mode: "work", modes: { work: { windowBudgetPercent: 50 }, off: { windowBudgetPercent: 90 } }, softLimitPercent: 80, hardLimitPercent: 95 },
    infra: { slots: 1, composeFile: "docker-compose.test.yml", upTimeoutMs: 60000, downAfterTest: true, browserSlots: 1 },
    observer: { enabled: false, intervalMs: 14400000, taskCountTrigger: 10, maxProposalsPerCycle: 5, dataWindowDays: 7, proposalRetentionDays: 30 },
    selfImprove: { enabled: false, maxRisk: "low", requirePassingTests: true, backupBranch: true },
    regulator: { enabled: false },
    autopilot: { releaseEvery: 4, maxConsecutiveFailures: 3, maxItemsPerSession: 50, reviewRetries: 2, itemMix: { feature: 0.4, refactor: 0.25, docs: 0.15, test: 0.2 } },
  };
  fs.writeFileSync(path.join(UCM_DIR, "config.json"), JSON.stringify(config, null, 2));
}

function socketRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK_PATH);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("socket timeout"));
    }, 10000);

    conn.on("connect", () => {
      conn.write(JSON.stringify({ id: "test", method, params }) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        const line = buffer.slice(0, idx);
        try {
          const response = JSON.parse(line);
          if (response.ok) resolve(response.data);
          else reject(new Error(response.error || "unknown error"));
        } catch (e) {
          reject(new Error(`parse error: ${e.message}`));
        }
        conn.end();
      }
    });

    conn.on("error", (e) => {
      clearTimeout(timer);
      conn.destroy();
      reject(e);
    });
  });
}

function httpRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://localhost:${uiPort}`);
    const options = {
      hostname: "localhost",
      port: uiPort,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("http timeout")); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForSocket(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() > deadline) return reject(new Error("socket not ready"));
      socketRequest("stats")
        .then(resolve)
        .catch(() => setTimeout(attempt, 200));
    }
    attempt();
  });
}

function waitForUiServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() > deadline) return reject(new Error("UI server not ready"));
      httpRequest("GET", "/api/daemon/status")
        .then((res) => resolve(res))
        .catch(() => setTimeout(attempt, 200));
    }
    attempt();
  });
}

// ── State ──

let daemonProcess = null;
let uiProcess = null;
let uiPort = 0;

function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startDaemon() {
  setupDirs();

  const ucmdPath = path.join(__dirname, "..", "lib", "ucmd.js");
  daemonProcess = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    env: { ...process.env, UCM_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackPid(daemonProcess.pid);

  daemonProcess.on("error", (e) => {
    console.error("daemon spawn error:", e.message);
  });

  await waitForSocket();
}

async function startUiServer() {
  uiPort = await findFreePort();
  const uiPath = path.join(__dirname, "..", "lib", "ucm-ui-server.js");

  // Start UI server as a child process
  uiProcess = spawn(process.execPath, ["-e", `
    process.env.UCM_DIR = ${JSON.stringify(UCM_DIR)};
    process.env.UCM_UI_PORT = ${JSON.stringify(String(uiPort))};
    const { startUiServer } = require(${JSON.stringify(uiPath)});
    startUiServer({ port: ${uiPort} }).catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
  `], {
    env: { ...process.env, UCM_DIR, UCM_UI_PORT: String(uiPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackPid(uiProcess.pid);

  await waitForUiServer();
}

async function cleanup() {
  await cleanupAll();
  try { fs.rmSync(UCM_DIR, { recursive: true, force: true }); } catch {}
}

// ── Tests ──

async function main() {
  startSuiteTimer(120_000);

  try {
    await startDaemon();
  } catch (e) {
    console.error("Failed to start daemon:", e.message);
    await cleanup();
    process.exit(1);
  }

  try {
    await startUiServer();
  } catch (e) {
    console.error("Failed to start UI server:", e.message);
    await cleanup();
    process.exit(1);
  }

  await runGroup("Socket Tests", {
    "socket stats returns data": async () => {
      const data = await socketRequest("stats");
      assert(data !== null && data !== undefined, "stats returned null");
      assert(typeof data === "object", "stats is not an object");
    },

    "socket list returns array": async () => {
      const data = await socketRequest("list");
      assert(Array.isArray(data), "list is not an array");
    },

    "socket proposals returns array": async () => {
      const data = await socketRequest("proposals");
      assert(Array.isArray(data), "proposals is not an array");
    },
  }, { timeout: 15000 });

  await runGroup("HTTP API Tests", {
    "GET /api/stats returns 200": async () => {
      const res = await httpRequest("GET", "/api/stats");
      assertEqual(res.status, 200, "stats status code");
      assert(typeof res.body === "object", "stats body is not object");
    },

    "POST /api/submit creates task": async () => {
      const res = await httpRequest("POST", "/api/submit", {
        title: "integration test task",
        body: "this is a test task",
      });
      assertEqual(res.status, 200, "submit status code");
      assert(res.body && res.body.id, "submit returned no id");
    },

    "GET /api/list shows submitted task": async () => {
      const res = await httpRequest("GET", "/api/list");
      assertEqual(res.status, 200, "list status code");
      assert(Array.isArray(res.body), "list body is not array");
      assert(res.body.length >= 1, "list should have at least 1 task");
    },

    "POST /api/pause pauses daemon": async () => {
      const res = await httpRequest("POST", "/api/pause");
      assertEqual(res.status, 200, "pause status code");
    },

    "POST /api/resume resumes daemon": async () => {
      const res = await httpRequest("POST", "/api/resume");
      assertEqual(res.status, 200, "resume status code");
    },

    "GET /api/proposals returns array": async () => {
      const res = await httpRequest("GET", "/api/proposals");
      assertEqual(res.status, 200, "proposals status code");
      assert(Array.isArray(res.body), "proposals body is not array");
    },

    "GET /api/autopilot/status returns array": async () => {
      const res = await httpRequest("GET", "/api/autopilot/status");
      assertEqual(res.status, 200, "autopilot status code");
      assert(Array.isArray(res.body), "autopilot body is not array");
    },

  }, { timeout: 15000 });

  await runGroup("Daemon Shutdown", {
    "shutdown via socket": async () => {
      try {
        await socketRequest("shutdown");
      } catch {
        // connection may close before response
      }

      // wait for daemon to exit
      await new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        function check() {
          try {
            process.kill(daemonProcess.pid, 0);
            if (Date.now() < deadline) setTimeout(check, 200);
            else resolve();
          } catch {
            resolve();
          }
        }
        check();
      });

      // verify socket is gone
      let socketGone = false;
      try {
        await socketRequest("stats");
      } catch {
        socketGone = true;
      }
      assert(socketGone, "socket should be gone after shutdown");
    },
  }, { timeout: 15000 });

  await cleanup();

  stopSuiteTimer();
  const result = summary();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Integration test error:", e);
  cleanup().then(() => process.exit(1));
});
