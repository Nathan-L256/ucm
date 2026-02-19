// test/helpers/cleanup.js — daemon process tracking and safe cleanup

const trackedPids = new Set();

function trackPid(pid) {
  if (pid) trackedPids.add(pid);
}

function untrackPid(pid) {
  trackedPids.delete(pid);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killDaemon(pid, { waitMs = 3000 } = {}) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isProcessAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  trackedPids.delete(pid);
}

async function cleanupAll() {
  for (const pid of trackedPids) {
    await killDaemon(pid, { waitMs: 2000 });
  }
  trackedPids.clear();
}

// Safety net: kill all tracked daemons on process exit
process.on("exit", () => {
  for (const pid of trackedPids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

module.exports = { trackPid, untrackPid, killDaemon, cleanupAll, isProcessAlive };
