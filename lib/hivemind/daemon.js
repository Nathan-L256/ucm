const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const store = require("./store");
const indexer = require("./indexer");
const extract = require("./extract");
const lifecycle = require("./lifecycle");
const { search } = require("./search");

const BUILTIN_ADAPTERS = {
  claude: require("./adapters/claude"),
  codex: require("./adapters/codex"),
  document: require("./adapters/document"),
};

const SCAN_INTERVAL_MS = 60_000;
const GC_INTERVAL_MS = 86_400_000; // 24 hours
const GIT_INTERVAL_MS = 3_600_000; // 1 hour
const CONSOLIDATION_INTERVAL_MS = 86_400_000;
const MAX_QUEUE_SIZE = 100;
const CONCURRENCY = 6;

let config;
let queue = [];
let processing = false;
let shutdownRequested = false;
let timers = [];
let socketServer;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  try {
    fs.appendFileSync(store.LOG_PATH, line + "\n");
  } catch {}
}

// --- Adapter loading ---

function loadAdapters() {
  const adapters = {};
  const adapterConfig = config.adapters || {};

  for (const [name, conf] of Object.entries(adapterConfig)) {
    if (conf.enabled === false) continue;
    if (BUILTIN_ADAPTERS[name]) {
      adapters[name] = { module: BUILTIN_ADAPTERS[name], config: conf };
    } else {
      // Custom adapter from ~/.hivemind/adapters/
      const customPath = path.join(store.ADAPTERS_DIR, `${name}.js`);
      if (fs.existsSync(customPath)) {
        try {
          adapters[name] = { module: require(customPath), config: conf };
        } catch (e) {
          log(`Failed to load adapter ${name}: ${e.message}`);
        }
      }
    }
  }
  return adapters;
}

// --- Scan & Queue ---

async function scanAll() {
  if (shutdownRequested) return;
  const adapters = loadAdapters();

  for (const [name, { module: adapter, config: adapterConfig }] of Object.entries(adapters)) {
    try {
      const state = store.loadSourceState(name);
      const items = await adapter.scan(state, adapterConfig);
      const newItems = items.slice(0, MAX_QUEUE_SIZE - queue.length);
      for (const item of newItems) {
        if (!queue.find((q) => q.ref === item.ref)) {
          queue.push({ adapter: name, ...item });
        }
      }
      if (newItems.length > 0) {
        log(`Scan ${name}: ${newItems.length} new items queued`);
      }
    } catch (e) {
      log(`Scan ${name} error: ${e.message}`);
    }
  }
}

async function processQueue() {
  if (processing || shutdownRequested || queue.length === 0) return;
  processing = true;

  // Phase 1: extract in parallel (LLM calls, stateless)
  while (queue.length > 0 && !shutdownRequested) {
    const batch = queue.splice(0, CONCURRENCY);
    const extractionResults = await Promise.all(batch.map((item) => extractItem(item).catch((e) => {
      log(`Extract error for ${item.ref}: ${e.message}`);
      return null;
    })));

    // Phase 2: save sequentially (index/store writes, needs serialization)
    // skipDedup: intra-batch dedup already done in extractItem, cross-session LLM dedup deferred to consolidation
    const dedupModel = config.models?.dedup;
    for (const result of extractionResults) {
      if (!result) continue;
      try {
        const saved = await extract.processAndSave(result.zettels, { log, skipDedup: true, dedupModel });
        log(`  Saved ${saved.length} zettels from ${result.item.ref}`);
        markProcessed(result.item);
      } catch (e) {
        log(`Save error for ${result.item.ref}: ${e.message}`);
      }
    }
  }

  // Phase 3: cleanup + cross-zettel dedup
  try {
    const cleanupResult = lifecycle.cleanupAll({ log });
    if (cleanupResult.bodyFixed > 0 || cleanupResult.kwFixed > 0) {
      log(`Cleanup: ${cleanupResult.bodyFixed} bodies deduped, ${cleanupResult.kwFixed} keywords capped`);
    }
    const dedupResult = lifecycle.dedupAll({ log });
    if (dedupResult.merged > 0) {
      log(`Cross-dedup: ${dedupResult.merged} merges, ${dedupResult.remaining} remaining`);
    }
  } catch (e) {
    log(`Post-process error: ${e.message}`);
  }

  processing = false;
}

async function extractItem(item) {
  const adapters = loadAdapters();
  const adapterEntry = adapters[item.adapter];
  if (!adapterEntry) return null;

  const { module: adapter } = adapterEntry;
  log(`Processing: ${item.ref}`);

  const chunks = await adapter.read(item);
  if (chunks.length === 0) {
    log(`  No content from ${item.ref}`);
    markProcessed(item);
    return null;
  }

  const extractionModel = config.models?.extraction;
  const allZettels = [];
  for (const chunk of chunks) {
    const source = {
      adapter: item.adapter,
      ref: chunk.metadata?.ref || item.ref,
      timestamp: chunk.metadata?.timestamp,
    };

    const zettels = await extract.extractZettels(chunk.text, source, { log, model: extractionModel });
    allZettels.push(...zettels);
  }

  const deduped = extract.deduplicateBatch(allZettels, { log });
  return { item, zettels: deduped };
}

function markProcessed(item) {
  const state = store.loadSourceState(item.adapter);
  if (!state.processed) state.processed = {};
  state.processed[item.ref] = item.mtime;
  store.saveSourceState(item.adapter, state);
}

// --- Manual ingest ---

async function ingest(adapterName) {
  if (processing) throw new Error("Processing already in progress");

  const adapters = loadAdapters();
  const adapterEntry = adapters[adapterName];
  if (!adapterEntry) throw new Error(`Adapter not found: ${adapterName}`);

  processing = true;
  try {
    const { module: adapter, config: adapterConfig } = adapterEntry;
    const state = store.loadSourceState(adapterName);
    const items = await adapter.scan(state, adapterConfig);

    // Exclude items already in queue
    const queuedRefs = new Set(queue.map((q) => q.ref));
    const newItems = items.filter((item) => !queuedRefs.has(item.ref));

    log(`Ingest ${adapterName}: ${newItems.length} items found (${items.length - newItems.length} already queued)`);
    let totalSaved = 0;
    const extractionModel = config.models?.extraction;

    for (const item of newItems) {
      try {
        const chunks = await adapter.read(item);
        const allZettels = [];
        for (const chunk of chunks) {
          const source = {
            adapter: adapterName,
            ref: chunk.metadata?.ref || item.ref,
            timestamp: chunk.metadata?.timestamp,
          };
          const zettels = await extract.extractZettels(chunk.text, source, { log, model: extractionModel });
          allZettels.push(...zettels);
        }
        const deduped = extract.deduplicateBatch(allZettels, { log });
        const dedupModel = config.models?.dedup;
        const saved = await extract.processAndSave(deduped, { log, model: extractionModel, dedupModel });
        totalSaved += saved.length;
        markProcessed({ adapter: adapterName, ...item });
      } catch (e) {
        log(`Ingest error for ${item.ref}: ${e.message}`);
      }
    }

    return { processed: newItems.length, saved: totalSaved };
  } finally {
    processing = false;
  }
}

// --- Git commit ---

async function gitCommit() {
  if (shutdownRequested) return;
  return new Promise((resolve) => {
    const child = spawn("git", ["add", "-A"], { cwd: store.HIVEMIND_DIR });
    child.on("close", () => {
      const commit = spawn("git", ["commit", "-m", `auto: ${new Date().toISOString()}`], {
        cwd: store.HIVEMIND_DIR,
      });
      commit.on("close", (code) => {
        if (code === 0) log("Git commit done");
        resolve();
      });
    });
  });
}

function initGitRepo() {
  const gitDir = path.join(store.HIVEMIND_DIR, ".git");
  if (!fs.existsSync(gitDir)) {
    try {
      const { execSync } = require("child_process");
      execSync("git init", { cwd: store.HIVEMIND_DIR, stdio: "ignore" });
      log("Git repo initialized");
    } catch {}
  }
}

// --- Socket Server ---

function startSocketServer() {
  if (fs.existsSync(store.SOCK_PATH)) {
    try { fs.unlinkSync(store.SOCK_PATH); } catch {}
  }

  socketServer = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        conn.write(JSON.stringify({ ok: false, error: "invalid JSON" }) + "\n");
        conn.end();
        return;
      }

      handleRequest(request).then((result) => {
        try { conn.write(JSON.stringify({ ok: true, data: result }) + "\n"); } catch {}
        conn.end();
      }).catch((e) => {
        try { conn.write(JSON.stringify({ ok: false, error: e.message }) + "\n"); } catch {}
        conn.end();
      });
    });
  });

  socketServer.listen(store.SOCK_PATH, () => {
    log(`Socket server listening on ${store.SOCK_PATH}`);
  });
}

async function handleRequest(request) {
  const { method, params = {} } = request;

  switch (method) {
    case "search":
      return search(params.query, { limit: params.limit });

    case "show": {
      const zettel = store.loadZettel(params.id);
      if (!zettel) throw new Error(`Zettel not found: ${params.id}`);
      store.boostZettel(params.id);
      indexer.updateBoost(params.id);
      return zettel;
    }

    case "list":
      return store.listZettels({ kind: params.kind, limit: params.limit });

    case "add": {
      const now = new Date().toISOString();
      const zettel = {
        id: store.generateUniqueId(),
        kind: "fleeting",
        title: params.title || "Untitled",
        body: params.body || "",
        keywords: params.keywords || {},
        links: [],
        createdAt: now,
        lastAccessed: now,
        boostCount: 0,
      };
      store.saveZettel(zettel);
      indexer.indexZettel(zettel);
      return zettel;
    }

    case "delete":
      if (!store.deleteZettel(params.id)) throw new Error(`Not found: ${params.id}`);
      indexer.unindexZettel(params.id);
      return { deleted: params.id };

    case "restore":
      if (!store.restoreZettel(params.id)) throw new Error(`Not found in archive: ${params.id}`);
      const restored = store.loadZettel(params.id);
      if (restored) indexer.indexZettel(restored);
      return { restored: params.id };

    case "link":
      if (!store.addLink(params.id1, params.id2)) throw new Error("Link failed");
      return { linked: [params.id1, params.id2] };

    case "ingest":
      return ingest(params.adapter);

    case "gc":
      return lifecycle.runGc({ dryRun: params.dryRun, log });

    case "cleanup":
      return lifecycle.cleanupAll({ log });

    case "dedup-all":
      return lifecycle.dedupAll({ log });

    case "reindex": {
      const result = indexer.buildFromDisk();
      return result;
    }

    case "stats": {
      const entries = indexer.getAllEntries();
      const byKind = {};
      for (const e of entries) {
        byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      }
      return {
        totalZettels: entries.length,
        totalKeywords: indexer.getKeywordCount(),
        byKind,
        queueLength: queue.length,
        processing,
      };
    }

    case "status":
      return {
        running: true,
        pid: process.pid,
        uptime: process.uptime(),
        queueLength: queue.length,
        processing,
      };

    case "shutdown":
      gracefulShutdown();
      return { shutting_down: true };

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// --- Lifecycle ---

function startTimers() {
  timers.push(setInterval(() => {
    scanAll().then(processQueue).catch((e) => log(`Scan/process error: ${e.message}`));
  }, SCAN_INTERVAL_MS));

  timers.push(setInterval(() => {
    lifecycle.runGc({ log }).catch((e) => log(`GC error: ${e.message}`));
    lifecycle.consolidate({ log, model: config.models?.consolidation || config.models?.extraction }).catch((e) => log(`Consolidation error: ${e.message}`));
  }, GC_INTERVAL_MS));

  timers.push(setInterval(() => {
    gitCommit().catch((e) => log(`Git error: ${e.message}`));
  }, GIT_INTERVAL_MS));
}

function gracefulShutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  log("Shutting down...");

  for (const timer of timers) clearInterval(timer);
  timers = [];

  if (socketServer) {
    socketServer.close();
    try { fs.unlinkSync(store.SOCK_PATH); } catch {}
  }

  try { fs.unlinkSync(store.PID_PATH); } catch {}
  indexer.close();
  log("Shutdown complete");
  process.exit(0);
}

// --- Main ---

async function startDaemon(foreground) {
  store.ensureDirectories();
  config = store.loadConfig();

  if (!foreground) {
    const logFd = fs.openSync(store.LOG_PATH, "a");
    const child = spawn(process.execPath, [__filename, "start", "--foreground"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, HM_FOREGROUND: "1" },
    });
    child.unref();
    fs.closeSync(logFd);

    // Wait for socket
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(store.SOCK_PATH)) {
        console.log(`hivemind daemon started (pid: ${child.pid})`);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`hivemind daemon started (pid: ${child.pid}) — socket may be slow`);
    return;
  }

  // Foreground mode
  process.env.HM_FOREGROUND = "1";

  process.on("uncaughtException", (e) => {
    log(`Uncaught exception: ${e.message}\n${e.stack}`);
  });
  process.on("unhandledRejection", (e) => {
    log(`Unhandled rejection: ${e?.message || e}`);
  });
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  fs.writeFileSync(store.PID_PATH, String(process.pid));
  log(`Daemon started (pid: ${process.pid})`);

  initGitRepo();
  const indexStats = indexer.loadFromDisk();
  log(`Index loaded: ${indexStats.zettels} zettels, ${indexStats.keywords} keywords`);

  startSocketServer();
  startTimers();

  // Initial scan + immediate processing
  scanAll().then(processQueue).catch((e) => log(`Initial scan error: ${e.message}`));
}

function stopDaemon() {
  if (!fs.existsSync(store.PID_PATH)) {
    console.log("hivemind daemon not running");
    return;
  }
  const pid = parseInt(fs.readFileSync(store.PID_PATH, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(`hivemind daemon stopped (pid: ${pid})`);
  } catch (e) {
    if (e.code === "ESRCH") {
      console.log("hivemind daemon not running (stale pid file)");
      try { fs.unlinkSync(store.PID_PATH); } catch {}
    } else {
      throw e;
    }
  }
}

function daemonStatus() {
  if (!fs.existsSync(store.PID_PATH)) {
    console.log("hivemind daemon: not running");
    return false;
  }
  const pid = parseInt(fs.readFileSync(store.PID_PATH, "utf8").trim());
  try {
    process.kill(pid, 0);
    console.log(`hivemind daemon: running (pid: ${pid})`);
    return true;
  } catch {
    console.log("hivemind daemon: not running (stale pid file)");
    try { fs.unlinkSync(store.PID_PATH); } catch {}
    return false;
  }
}

function showLog(lines = 50) {
  if (!fs.existsSync(store.LOG_PATH)) {
    console.log("No log file");
    return;
  }
  const content = fs.readFileSync(store.LOG_PATH, "utf8");
  const allLines = content.split("\n").filter(Boolean);
  const tail = allLines.slice(-lines);
  console.log(tail.join("\n"));
}

// If run directly (daemon foreground mode)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("start") && args.includes("--foreground")) {
    startDaemon(true);
  }
}

module.exports = {
  startDaemon, stopDaemon, daemonStatus, showLog,
  ingest, scanAll, processQueue, handleRequest,
  log,
};
