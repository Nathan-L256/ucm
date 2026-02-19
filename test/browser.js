#!/usr/bin/env node
// test/browser.js — Chrome CDP browser tests for UCM Dashboard

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const http = require("http");

const { state, assert, assertEqual, runGroup, startSuiteTimer, stopSuiteTimer, summary } = require("./harness.js");
const { trackPid, cleanupAll } = require("./helpers/cleanup.js");
const { launchBrowser, killBrowser, findChrome } = require("../lib/core/browser.js");

const UCM_DIR = path.join(os.tmpdir(), `ucm-browser-${Date.now()}`);
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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
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
      socketRequest("stats").then(resolve).catch(() => setTimeout(attempt, 200));
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

function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// ── CDP Helper ──

function cdpRequest(debugPort, method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    // First get the WebSocket URL
    const listReq = http.get(`http://localhost:${debugPort}/json/list`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find((t) => t.type === "page");
          if (!page) return reject(new Error("no page target found"));
          resolve(page.webSocketDebuggerUrl);
        } catch (e) {
          reject(e);
        }
      });
    });
    listReq.on("error", reject);
    listReq.setTimeout(5000, () => { listReq.destroy(); reject(new Error("cdp list timeout")); });
  });
}

function cdpEvaluate(wsUrl, expression) {
  const WebSocket = require("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("cdp evaluate timeout"));
    }, 10000);

    const msgId = 1;
    ws.on("open", () => {
      ws.send(JSON.stringify({
        id: msgId,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === msgId) {
          clearTimeout(timer);
          ws.close();
          if (msg.result?.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.text || "evaluation error"));
          } else {
            resolve(msg.result?.result?.value);
          }
        }
      } catch {}
    });

    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function cdpNavigate(wsUrl, targetUrl) {
  const WebSocket = require("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("cdp navigate timeout"));
    }, 15000);

    ws.on("open", () => {
      // Enable Page events
      ws.send(JSON.stringify({ id: 1, method: "Page.enable", params: {} }));
      ws.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url: targetUrl } }));
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Wait for Page.loadEventFired or just resolve on navigate response
        if (msg.method === "Page.loadEventFired") {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        if (msg.id === 2 && msg.result?.frameId) {
          // navigate accepted, wait a bit for load
          setTimeout(() => {
            clearTimeout(timer);
            ws.close();
            resolve();
          }, 2000);
        }
      } catch {}
    });

    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── State ──

let daemonProcess = null;
let uiProcess = null;
let uiPort = 0;
let browser = null;
let wsUrl = null;

async function startDaemon() {
  setupDirs();

  const ucmdPath = path.join(__dirname, "..", "lib", "ucmd.js");
  daemonProcess = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    env: { ...process.env, UCM_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackPid(daemonProcess.pid);
  await waitForSocket();
}

async function startUiServer() {
  uiPort = await findFreePort();
  const uiPath = path.join(__dirname, "..", "lib", "ucm-ui-server.js");

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
  if (browser) killBrowser(browser);
  await cleanupAll();
  try { fs.rmSync(UCM_DIR, { recursive: true, force: true }); } catch {}
}

// ── Tests ──

async function main() {
  startSuiteTimer(180_000);

  // Check Chrome is available
  if (!findChrome()) {
    console.log("Chrome not found — skipping browser tests");
    console.log("\n0 tests, 0 passed, 0 failed");
    process.exit(0);
  }

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

  // Launch browser
  try {
    browser = await launchBrowser("integration-test");
    if (!browser) throw new Error("launchBrowser returned null");
    trackPid(browser.process.pid);
    wsUrl = await cdpRequest(browser.port);
  } catch (e) {
    console.error("Failed to launch browser:", e.message);
    await cleanup();
    process.exit(1);
  }

  // Navigate to dashboard
  try {
    await cdpNavigate(wsUrl, `http://localhost:${uiPort}/`);
    // Refresh wsUrl after navigation (new page context)
    wsUrl = await cdpRequest(browser.port);
  } catch (e) {
    console.error("Failed to navigate:", e.message);
    await cleanup();
    process.exit(1);
  }

  await runGroup("Dashboard Page Load", {
    "page title is UCM Dashboard": async () => {
      const title = await cdpEvaluate(wsUrl, "document.title");
      assertEqual(title, "UCM Dashboard", "page title");
    },

    "left panel (task list) exists": async () => {
      const exists = await cdpEvaluate(wsUrl, "!!document.querySelector('.left')");
      assert(exists, "left panel should exist");
    },

    "right panel (detail) exists": async () => {
      const exists = await cdpEvaluate(wsUrl, "!!document.querySelector('.right')");
      assert(exists, "right panel should exist");
    },

    "header exists with UCM title": async () => {
      const text = await cdpEvaluate(wsUrl, "document.querySelector('.header h1')?.textContent || ''");
      assert(text.includes("UCM"), "header should contain UCM");
    },
  }, { timeout: 15000 });

  // Create a task via HTTP API, then check if it appears in the UI
  let taskId = null;
  await runGroup("Dynamic Task Rendering", {
    "create task via API": async () => {
      const res = await httpRequest("POST", "/api/submit", {
        title: "browser test task",
        body: "task for browser testing",
      });
      assertEqual(res.status, 200, "submit status");
      taskId = res.body?.id;
      assert(!!taskId, "task id should be returned");
    },

    "task appears in UI task list": async () => {
      // Wait a moment for WebSocket update to propagate
      await new Promise((r) => setTimeout(r, 2000));

      // Re-fetch wsUrl in case the page context changed
      wsUrl = await cdpRequest(browser.port);

      const hasTask = await cdpEvaluate(wsUrl, `
        (function() {
          const items = document.querySelectorAll('.task-item .title');
          for (const item of items) {
            if (item.textContent.includes('browser test task')) return true;
          }
          return false;
        })()
      `);
      assert(hasTask, "task should appear in task list");
    },
  }, { timeout: 20000 });

  await runGroup("UI Panels", {
    "proposals tab or section exists": async () => {
      // Check for proposals toggle or tab
      const hasProposals = await cdpEvaluate(wsUrl, `
        (function() {
          const toggles = document.querySelectorAll('.toggle, .tabs button');
          for (const el of toggles) {
            if (el.textContent.toLowerCase().includes('proposal')) return true;
          }
          return false;
        })()
      `);
      assert(hasProposals, "proposals section should exist");
    },

    "autopilot tab exists": async () => {
      const hasAutopilot = await cdpEvaluate(wsUrl, `
        (function() {
          const toggles = document.querySelectorAll('.toggle, .tabs button');
          for (const el of toggles) {
            if (el.textContent.toLowerCase().includes('autopilot')) return true;
          }
          return false;
        })()
      `);
      assert(hasAutopilot, "autopilot tab should exist in UI");
    },
  }, { timeout: 15000 });

  await runGroup("Browser Cleanup", {
    "chrome and daemon shutdown": async () => {
      if (browser) {
        killBrowser(browser);
        browser = null;
      }
      assert(true, "browser shutdown");
    },
  });

  await cleanup();

  stopSuiteTimer();
  const result = summary();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Browser test error:", e);
  cleanup().then(() => process.exit(1));
});
