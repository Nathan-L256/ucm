#!/usr/bin/env node
// ucm-watchdog.js — ucmd 감시 프로세스
// 역할: ucmd spawn + 헬스체크 + 크래시 시 재시작

const { spawn } = require("child_process");
const { unlink } = require("fs/promises");
const fs = require("fs");
const net = require("net");
const path = require("path");
const os = require("os");

const UCM_DIR = process.env.UCM_DIR || path.join(os.homedir(), ".ucm");
const DAEMON_DIR = path.join(UCM_DIR, "daemon");
const SOCK_PATH = path.join(DAEMON_DIR, "ucm.sock");
const PID_PATH = path.join(DAEMON_DIR, "ucmd.pid");
const LOG_PATH = path.join(DAEMON_DIR, "ucmd.log");
const WATCHDOG_PID_PATH = path.join(DAEMON_DIR, "watchdog.pid");
const UCMD_PATH = path.join(__dirname, "ucmd.js");

const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

function log(message) {
  const line = `[${new Date().toISOString()}] [watchdog] ${message}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
  process.stderr.write(line);
}

function healthCheck() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), HEALTH_CHECK_TIMEOUT_MS);
    const client = net.createConnection(SOCK_PATH, () => {
      clearTimeout(timeout);
      client.write(JSON.stringify({ id: "hc", method: "stats", params: {} }) + "\n");
      let data = "";
      client.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          client.destroy();
          resolve(true);
        }
      });
    });
    client.on("error", () => {
      clearTimeout(timeout);
      client.destroy();
      resolve(false);
    });
  });
}

function spawnDaemon() {
  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [UCMD_PATH, "start", "--foreground"], {
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  fs.writeFileSync(PID_PATH, String(child.pid));
  log(`ucmd spawned (pid: ${child.pid})`);
  return child;
}

async function run() {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.writeFileSync(WATCHDOG_PID_PATH, String(process.pid));
  log("watchdog starting");

  let child = spawnDaemon();

  child.on("exit", async (code) => {
    log(`ucmd exited (code: ${code})`);

    if (code !== 0 && code !== null) {
      log("unexpected exit, respawning in 3s");
      await new Promise((r) => setTimeout(r, 3000));
      child = spawnDaemon();
    } else {
      log("clean exit, watchdog stopping");
      try { await unlink(WATCHDOG_PID_PATH); } catch {}
      process.exit(0);
    }
  });

  setInterval(async () => {
    const ok = await healthCheck();
    if (!ok) {
      log("health check failed");
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  process.on("SIGTERM", async () => {
    log("watchdog received SIGTERM, stopping daemon");
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 3000));
    try { await unlink(WATCHDOG_PID_PATH); } catch {}
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    log("watchdog received SIGINT, stopping daemon");
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 3000));
    try { await unlink(WATCHDOG_PID_PATH); } catch {}
    process.exit(0);
  });
}

run().catch((e) => {
  log(`watchdog error: ${e.message}`);
  process.exit(1);
});
