const fs = require("fs");
const path = require("path");
const net = require("net");
const readline = require("readline");

const store = require("./store");
const indexer = require("./indexer");
const { search } = require("./search");
const lifecycle = require("./lifecycle");
const daemon = require("./daemon");

const CLIENT_TIMEOUT_MS = 60_000;

function createClient() {
  return function socketRequest(request) {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(store.SOCK_PATH);
      let buffer = "";
      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error("TIMEOUT"));
      }, CLIENT_TIMEOUT_MS);

      conn.on("connect", () => {
        conn.write(JSON.stringify(request) + "\n");
      });

      conn.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          clearTimeout(timer);
          const line = buffer.slice(0, newlineIndex);
          try {
            const response = JSON.parse(line);
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
        clearTimeout(timer);
        conn.destroy();
        reject(e);
      });
    });
  };
}

function isDaemonRunning() {
  return fs.existsSync(store.SOCK_PATH);
}

// --- stdin reader ---

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

// --- CLI Commands ---

function sortByWorkTime(zettels) {
  return zettels.sort((a, b) => {
    const ta = (a.source && a.source.timestamp) || a.createdAt || "";
    const tb = (b.source && b.source.timestamp) || b.createdAt || "";
    return tb.localeCompare(ta);
  });
}

function formatContextLine(z) {
  const keywords = Object.keys(z.keywords || {})
    .filter((k) => k.length >= 2 && !/^\d+$/.test(k))
    .slice(0, 3)
    .join(", ");
  return `- ${z.title}${keywords ? ` (${keywords})` : ""}`;
}

function buildContextText(cwd) {
  indexer.loadFromDisk();

  const zettels = store.listZettels();
  if (zettels.length === 0) return null;

  // cwd를 source.ref 형식으로 변환: /Users/nathan/git/ucm → -Users-nathan-git-ucm/
  const cwdRef = cwd.replace(/\//g, "-").replace(/^-/, "-") + "/";

  const cwdZettels = sortByWorkTime(
    zettels.filter((z) => z.source && z.source.ref && z.source.ref.startsWith(cwdRef))
  ).slice(0, 5);

  const cwdIds = new Set(cwdZettels.map((z) => z.id));
  const globalZettels = sortByWorkTime(
    zettels.filter((z) => !cwdIds.has(z.id))
  ).slice(0, 5);

  if (cwdZettels.length === 0 && globalZettels.length === 0) return null;

  const lines = ["past work — /recall <query> for details:"];
  if (cwdZettels.length) {
    lines.push(`[${path.basename(cwd)}]`);
    for (const z of cwdZettels) lines.push(formatContextLine(z));
  }
  if (globalZettels.length) {
    if (cwdZettels.length) lines.push("[other]");
    for (const z of globalZettels) lines.push(formatContextLine(z));
  }
  return lines.join("\n");
}

function cmdContext({ hook = false } = {}) {
  const input = hook ? JSON.parse(fs.readFileSync("/dev/stdin", "utf8").trim() || "{}") : {};
  const cwd = input.cwd || process.cwd();
  const text = buildContextText(cwd);

  if (hook) {
    const result = text
      ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }
      : {};
    console.log(JSON.stringify(result));
  } else {
    if (text) console.log(text);
  }
}

async function cmdSearch(query, opts) {
  if (isDaemonRunning()) {
    const client = createClient();
    const results = await client({ method: "search", params: { query, limit: opts.limit } });
    printSearchResults(results);
  } else {
    indexer.loadFromDisk();
    const results = await search(query, { limit: opts.limit });
    printSearchResults(results);
  }
}

function relativeTime(isoString) {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function printSearchResults(results) {
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }
  for (const r of results) {
    const keywords = Object.keys(r.keywords || {}).slice(0, 5).join(", ");
    const zettelPath = path.join(store.ZETTEL_DIR, `${r.id}.md`);
    const age = relativeTime(r.createdAt);
    const titleLine = `${r.id}  ${(r.score || 0).toFixed(4)}  [${r.kind}]  ${r.title}`;
    console.log(age ? `${titleLine}  ${age}` : titleLine);
    console.log(`  keywords: ${keywords}`);
    if (r.supersededBy) {
      const superseding = indexer.getMasterEntry(r.supersededBy);
      const supersedingTitle = superseding ? superseding.title : r.supersededBy;
      console.log(`  \u2937 superseded by: ${r.supersededBy} (${supersedingTitle})`);
    }
    console.log(`  ${zettelPath}`);
    console.log();
  }
}

async function cmdAdd(opts) {
  const body = opts.file
    ? fs.readFileSync(opts.file, "utf8").trim()
    : await readStdin();

  if (!body) {
    console.error("Error: no input (use stdin or --file)");
    process.exit(1);
  }

  if (isDaemonRunning()) {
    const client = createClient();
    const result = await client({
      method: "add",
      params: { title: opts.title || "Untitled", body },
    });
    console.log(`Created: ${result.id} "${result.title}"`);
    console.log(`  ${path.join(store.ZETTEL_DIR, `${result.id}.md`)}`);
  } else {
    const now = new Date().toISOString();
    const zettel = {
      id: store.generateUniqueId(),
      kind: "fleeting",
      title: opts.title || "Untitled",
      body,
      keywords: {},
      links: [],
      createdAt: now,
      lastAccessed: now,
      boostCount: 0,
    };
    store.saveZettel(zettel);
    indexer.loadFromDisk();
    indexer.indexZettel(zettel);
    console.log(`Created: ${zettel.id} "${zettel.title}"`);
    console.log(`  ${path.join(store.ZETTEL_DIR, `${zettel.id}.md`)}`);
  }
}

async function cmdShow(id) {
  if (isDaemonRunning()) {
    const client = createClient();
    const zettel = await client({ method: "show", params: { id } });
    printZettel(zettel);
  } else {
    const zettel = store.loadZettel(id);
    if (!zettel) {
      console.error(`Not found: ${id}`);
      process.exit(1);
    }
    store.boostZettel(id);
    indexer.loadFromDisk();
    indexer.updateBoost(id);
    printZettel(zettel);
  }
}

function printZettel(zettel) {
  console.log(`id: ${zettel.id}`);
  console.log(`kind: ${zettel.kind}`);
  console.log(`title: ${zettel.title}`);
  console.log(`keywords: ${Object.entries(zettel.keywords || {}).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  if (zettel.links?.length) console.log(`links: ${zettel.links.join(", ")}`);
  if (zettel.supersededBy) console.log(`superseded by: ${zettel.supersededBy}`);
  if (zettel.source) console.log(`source: ${zettel.source.adapter}:${zettel.source.ref}`);
  console.log(`created: ${zettel.createdAt}`);
  console.log(`accessed: ${zettel.lastAccessed} (${zettel.boostCount} boosts)`);
  console.log(`path: ${path.join(store.ZETTEL_DIR, `${zettel.id}.md`)}`);
  console.log("---");
  console.log(zettel.body);
}

async function cmdList(opts) {
  if (isDaemonRunning()) {
    const client = createClient();
    const results = await client({ method: "list", params: { kind: opts.kind, limit: opts.limit } });
    printList(results);
  } else {
    const results = store.listZettels({ kind: opts.kind, limit: opts.limit });
    printList(results);
  }
}

function printList(zettels) {
  if (zettels.length === 0) {
    console.log("No zettels.");
    return;
  }
  for (const z of zettels) {
    const keywords = Object.keys(z.keywords || {}).slice(0, 4).join(", ");
    console.log(`${z.id}  [${z.kind}]  ${z.title}`);
    console.log(`  keywords: ${keywords}`);
    console.log(`  ${path.join(store.ZETTEL_DIR, `${z.id}.md`)}`);
    console.log();
  }
}

async function cmdLink(id1, id2) {
  if (isDaemonRunning()) {
    const client = createClient();
    await client({ method: "link", params: { id1, id2 } });
  } else {
    store.addLink(id1, id2);
  }
  console.log(`Linked: ${id1} <-> ${id2}`);
}

async function cmdIngest(adapterName) {
  if (isDaemonRunning()) {
    const client = createClient();
    const result = await client({ method: "ingest", params: { adapter: adapterName } });
    console.log(`Ingested: ${result.processed} items processed, ${result.saved} zettels saved`);
  } else {
    indexer.loadFromDisk();
    const result = await daemon.ingest(adapterName);
    console.log(`Ingested: ${result.processed} items processed, ${result.saved} zettels saved`);
  }
}

async function cmdGc(opts) {
  if (isDaemonRunning()) {
    const client = createClient();
    const result = await client({ method: "gc", params: { dryRun: opts.dryRun } });
    console.log(`GC: ${result.archived || result.wouldArchive || 0} archived, ${result.total} remaining`);
  } else {
    indexer.loadFromDisk();
    const result = lifecycle.runGc({ dryRun: opts.dryRun, log: (m) => console.log(m) });
    console.log(`GC: ${result.archived || result.wouldArchive || 0} archived, ${result.total} remaining`);
  }
}

async function cmdReindex() {
  if (isDaemonRunning()) {
    const client = createClient();
    const result = await client({ method: "reindex", params: {} });
    console.log(`Reindexed: ${result.zettels} zettels, ${result.keywords} keywords`);
  } else {
    const result = indexer.buildFromDisk();
    console.log(`Reindexed: ${result.zettels} zettels, ${result.keywords} keywords`);
  }
}

async function cmdStats() {
  if (isDaemonRunning()) {
    const client = createClient();
    const stats = await client({ method: "stats", params: {} });
    console.log(`Zettels: ${stats.totalZettels}`);
    console.log(`Keywords: ${stats.totalKeywords}`);
    for (const [kind, count] of Object.entries(stats.byKind || {})) {
      console.log(`  ${kind}: ${count}`);
    }
    console.log(`Queue: ${stats.queueLength}`);
    console.log(`Processing: ${stats.processing}`);
  } else {
    const stats = indexer.loadFromDisk();
    const entries = indexer.getAllEntries();
    const byKind = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    console.log(`Zettels: ${stats.zettels}`);
    console.log(`Keywords: ${stats.keywords}`);
    for (const [kind, count] of Object.entries(byKind)) {
      console.log(`  ${kind}: ${count}`);
    }
  }
}

async function cmdDelete(id) {
  if (isDaemonRunning()) {
    const client = createClient();
    await client({ method: "delete", params: { id } });
  } else {
    if (!store.deleteZettel(id)) {
      console.error(`Not found: ${id}`);
      process.exit(1);
    }
    indexer.loadFromDisk();
    indexer.unindexZettel(id);
  }
  console.log(`Deleted: ${id}`);
}

async function cmdRestore(id) {
  if (isDaemonRunning()) {
    const client = createClient();
    await client({ method: "restore", params: { id } });
  } else {
    if (!store.restoreZettel(id)) {
      console.error(`Not found in archive: ${id}`);
      process.exit(1);
    }
    indexer.loadFromDisk();
    const zettel = store.loadZettel(id);
    if (zettel) indexer.indexZettel(zettel);
  }
  console.log(`Restored: ${id}`);
}

function cmdConfig(subcommand) {
  const config = store.loadConfig();
  if (subcommand === "validate") {
    const warnings = store.validateConfig(config);
    if (warnings.length === 0) {
      console.log("Config OK");
    } else {
      for (const w of warnings) console.log(`  warning: ${w}`);
      process.exit(1);
    }
  } else {
    console.log(`path: ${store.CONFIG_PATH}`);
    console.log(JSON.stringify(config, null, 2));
  }
}

// --- Interactive helpers ---

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptYesNo(question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await prompt(`${question} (${hint}) `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

const HOME = process.env.HOME || process.env.USERPROFILE;

function expandPath(p) {
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}

function collapsePath(p) {
  if (p.startsWith(HOME + "/")) return "~/" + p.slice(HOME.length + 1);
  return p;
}

async function cleanupLegacyMem() {
  const legacyDir = path.join(HOME, ".mem");
  if (!fs.existsSync(legacyDir)) return;

  console.log("Legacy mem/memd data detected: ~/.mem/");

  // Stop old daemon if running
  const legacyPid = path.join(legacyDir, "daemon", "memd.pid");
  if (fs.existsSync(legacyPid)) {
    try {
      const pid = parseInt(fs.readFileSync(legacyPid, "utf8").trim(), 10);
      process.kill(pid, "SIGTERM");
      console.log(`  Stopped legacy daemon (pid ${pid})`);
    } catch {}
  }

  // Remove legacy socket
  const legacySock = path.join(legacyDir, "daemon", "mem.sock");
  if (fs.existsSync(legacySock)) {
    try { fs.unlinkSync(legacySock); } catch {}
  }

  const remove = await promptYesNo("이전 버전(~/.mem/) 데이터를 삭제할까요?", true);
  if (remove) {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    console.log("  ~/.mem/ 삭제 완료");
  }
}

async function cmdInit() {
  await cleanupLegacyMem();

  if (fs.existsSync(store.CONFIG_PATH)) {
    const overwrite = await promptYesNo("설정이 이미 존재합니다. 덮어쓸까요?", false);
    if (!overwrite) {
      console.log("취소되었습니다.");
      return;
    }
  }

  const config = JSON.parse(JSON.stringify(store.DEFAULT_CONFIG));

  const hasClaude = fs.existsSync(path.join(HOME, ".claude"));
  if (hasClaude) {
    const enableClaude = await promptYesNo("Claude Code 세션에서 지식을 추출할까요?", true);
    config.adapters.claude.enabled = enableClaude;
  } else {
    config.adapters.claude.enabled = false;
  }

  const hasCodex = fs.existsSync(path.join(HOME, ".codex", "sessions"));
  if (hasCodex) {
    const enableCodex = await promptYesNo("Codex 세션에서 지식을 추출할까요?", true);
    config.adapters.codex.enabled = enableCodex;
  } else {
    config.adapters.codex.enabled = false;
  }

  const enableDocument = await promptYesNo("마크다운 문서 디렉토리를 스캔할까요? (옵시디언 볼트 등)", true);
  config.adapters.document.enabled = enableDocument;
  config.adapters.document.dirs = [];

  if (enableDocument) {
    let addMore = true;
    while (addMore) {
      const dir = await prompt("  디렉토리 경로: ");
      if (dir) {
        const resolved = expandPath(dir);
        if (!fs.existsSync(resolved)) {
          console.log(`  경고: 디렉토리가 존재하지 않습니다: ${resolved}`);
        }
        config.adapters.document.dirs.push(collapsePath(resolved));
      }
      addMore = await promptYesNo("  다른 디렉토리도 추가할까요?", false);
    }
  }

  store.ensureDirectories();
  store.saveConfig(config);
  console.log(`\n설정 저장 완료: ${store.CONFIG_PATH}`);

  // Setup SessionStart hook in Claude Code settings
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  const hmHookCmd = "hm context --hook";
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  }
  const sessionStartEntries = settings.hooks?.SessionStart || [];
  const hasHmHook = sessionStartEntries.some((entry) =>
    entry.hooks?.some((h) => h.command === hmHookCmd)
  );
  if (hasHmHook) {
    console.log("Claude Code 세션 시작 훅이 이미 설정되어 있습니다.");
  } else {
    const add = await promptYesNo("Claude Code 세션 시작 시 과거 작업을 자동 로드할까요?", true);
    if (add) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      settings.hooks.SessionStart.push({
        matcher: "startup",
        hooks: [{ type: "command", command: hmHookCmd }],
      });
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log("  SessionStart 훅 등록 완료");
    }
  }

  // Clean up old CLAUDE.md memory hook if present
  const claudeMdPath = path.join(HOME, ".claude", "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf8");
    if (content.includes("!`hm context`")) {
      const cleaned = content.replace(/\n## Memory\n\n!`hm context`\n?/, "");
      fs.writeFileSync(claudeMdPath, cleaned);
    }
  }

  console.log("'hmd start'로 데몬을 시작하세요.");
}

async function cmdDocs(subcommand, args) {
  const config = store.loadConfig();
  if (!config.adapters.document) {
    config.adapters.document = { enabled: true, dirs: [] };
  }
  const dirs = config.adapters.document.dirs || [];

  switch (subcommand) {
    case "add": {
      if (args.length === 0) {
        console.error("Usage: hm docs add <directory>");
        process.exit(1);
      }
      for (const dir of args) {
        const resolved = expandPath(dir);
        const collapsed = collapsePath(resolved);
        if (dirs.includes(collapsed)) {
          console.log(`Already configured: ${collapsed}`);
          continue;
        }
        if (!fs.existsSync(resolved)) {
          console.log(`Warning: directory does not exist: ${resolved}`);
        }
        dirs.push(collapsed);
        console.log(`Added: ${collapsed}`);
      }
      config.adapters.document.dirs = dirs;
      config.adapters.document.enabled = true;
      store.saveConfig(config);
      break;
    }
    case "remove": {
      if (args.length === 0) {
        console.error("Usage: hm docs remove <directory>");
        process.exit(1);
      }
      for (const dir of args) {
        const resolved = expandPath(dir);
        const collapsed = collapsePath(resolved);
        const index = dirs.indexOf(collapsed);
        if (index === -1) {
          console.log(`Not found: ${collapsed}`);
          continue;
        }
        dirs.splice(index, 1);
        console.log(`Removed: ${collapsed}`);
      }
      config.adapters.document.dirs = dirs;
      store.saveConfig(config);
      break;
    }
    case "list":
    default: {
      if (dirs.length === 0) {
        console.log("No document directories configured.");
      } else {
        console.log("Document directories:");
        for (const dir of dirs) {
          const resolved = expandPath(dir);
          const exists = fs.existsSync(resolved);
          console.log(`  ${dir}${exists ? "" : " (not found)"}`);
        }
      }
      break;
    }
  }
}

// --- CLI Dispatch ---

const USAGE = `hm — hivemind knowledge memory

Usage:
  hm init                        Interactive config setup
  hm search <query>              Search zettels (with LLM query expansion)
  hm add [--title <t>] [--file]  Add fleeting zettel (stdin or --file)
  hm show <id>                   Show zettel + boost
  hm list [--kind <k>] [--limit N]  List zettels
  hm link <id1> <id2>            Add bidirectional link
  hm ingest [--adapter <name>]   Manual source processing
  hm gc [--dry-run]              Garbage collect
  hm reindex                     Rebuild index
  hm stats                       Statistics
  hm delete <id>                 Delete zettel
  hm restore <id>                Restore from archive
  hm context                     Show recent work (for CLAUDE.md)
  hm config [validate]           Show or validate config
  hm docs add <dir>              Add document directory
  hm docs remove <dir>           Remove document directory
  hm docs list                   List document directories

  hmd start [--foreground]       Start daemon
  hmd stop                       Stop daemon
  hmd status                     Daemon status
  hmd log [--lines N]            Show daemon log
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, flags };
}

async function run() {
  const { command, positional, flags } = parseArgs(process.argv);

  try {
    switch (command) {
      case "init":
        await cmdInit();
        break;

      case "search":
        if (!positional[0]) { console.error("Usage: hm search <query>"); process.exit(1); }
        await cmdSearch(positional.join(" "), { limit: parseInt(flags.limit) || 10 });
        break;

      case "add":
        await cmdAdd({ title: flags.title, file: flags.file });
        break;

      case "show":
        if (!positional[0]) { console.error("Usage: hm show <id>"); process.exit(1); }
        await cmdShow(positional[0]);
        break;

      case "list":
        await cmdList({ kind: flags.kind, limit: parseInt(flags.limit) || 20 });
        break;

      case "link":
        if (positional.length < 2) { console.error("Usage: hm link <id1> <id2>"); process.exit(1); }
        await cmdLink(positional[0], positional[1]);
        break;

      case "ingest":
        await cmdIngest(flags.adapter || positional[0] || "claude");
        break;

      case "gc":
        await cmdGc({ dryRun: !!flags["dry-run"] });
        break;

      case "reindex":
        await cmdReindex();
        break;

      case "stats":
        await cmdStats();
        break;

      case "delete":
        if (!positional[0]) { console.error("Usage: hm delete <id>"); process.exit(1); }
        await cmdDelete(positional[0]);
        break;

      case "restore":
        if (!positional[0]) { console.error("Usage: hm restore <id>"); process.exit(1); }
        await cmdRestore(positional[0]);
        break;

      case "context":
        cmdContext({ hook: !!flags.hook });
        break;

      case "config":
        cmdConfig(positional[0]);
        break;

      case "docs":
        await cmdDocs(positional[0], positional.slice(1));
        break;

      default:
        console.log(USAGE);
    }
  } catch (e) {
    if (e.message === "TIMEOUT") {
      console.error("Error: daemon not responding (timeout)");
    } else if (e.code === "ECONNREFUSED" || e.code === "ENOENT") {
      console.error("Error: daemon not running. Start with: hmd start");
    } else {
      console.error(`Error: ${e.message}`);
    }
    process.exit(1);
  }
}

async function runDaemon() {
  const { command, positional, flags } = parseArgs(process.argv);

  switch (command) {
    case "start":
      await daemon.startDaemon(!!flags.foreground);
      break;
    case "stop":
      daemon.stopDaemon();
      break;
    case "status":
      daemon.daemonStatus();
      break;
    case "log":
      daemon.showLog(parseInt(flags.lines) || 50);
      break;
    default:
      console.log(`hmd — hivemind daemon

Usage:
  hmd start [--foreground]  Start daemon
  hmd stop                  Stop daemon
  hmd status                Daemon status
  hmd log [--lines N]       Show daemon log
`);
  }
}

module.exports = { run, runDaemon };
