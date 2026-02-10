const { execFileSync } = require("child_process");
const { readFile, mkdir, access, unlink } = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  UCM_DIR, TASKS_DIR, WORKTREES_DIR, WORKSPACES_DIR, LOGS_DIR, DAEMON_DIR,
  LESSONS_DIR, PROPOSALS_DIR, SNAPSHOTS_DIR,
  SOCK_PATH, PID_PATH,
  TASK_STATES, META_KEYS, PROPOSAL_STATUSES,
  DATA_VERSION, SOURCE_ROOT,
  USAGE,
} = require("./ucmd-constants.js");

// ── Arg Parser ──

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (args[i] === "--foreground") {
      opts.foreground = true;
    } else if (args[i] === "--dev") {
      opts.dev = true;
    } else if (args[i].startsWith("-")) {
      console.error(`알 수 없는 옵션: ${args[i]}`);
      process.exit(1);
    } else {
      positional.push(args[i]);
    }
  }
  opts.command = positional[0];
  return opts;
}

// ── Directory Setup ──

async function ensureDirectories() {
  const dirs = [
    UCM_DIR,
    ...TASK_STATES.map((s) => path.join(TASKS_DIR, s)),
    WORKTREES_DIR,
    WORKSPACES_DIR,
    path.join(UCM_DIR, "artifacts"),
    LOGS_DIR,
    DAEMON_DIR,
    LESSONS_DIR,
    path.join(LESSONS_DIR, "global"),
    PROPOSALS_DIR,
    ...PROPOSAL_STATUSES.map((s) => path.join(PROPOSALS_DIR, s)),
    SNAPSHOTS_DIR,
    WORKSPACES_DIR,
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

// ── Task File Parsing (YAML Frontmatter) ──

function parseTaskFile(content) {
  const lines = content.split("\n");
  if (lines[0] !== "---") return { meta: {}, body: content };

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { endIndex = i; break; }
  }
  if (endIndex === -1) return { meta: {}, body: content };

  const meta = {};
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i];
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // strip surrounding quotes
    if (value.length >= 2) {
      if ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'")) {
        value = value.slice(1, -1);
      }
    }

    // handle inline arrays: [item1, item2]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    }
    // handle numbers (but keep id and hex-like fields as strings)
    else if (/^\d+$/.test(value) && key !== "id") {
      value = parseInt(value);
    }
    // handle booleans
    else if (value === "true") { value = true; }
    else if (value === "false") { value = false; }

    meta[key] = value;
  }

  const body = lines.slice(endIndex + 1).join("\n").trim();
  return { meta, body };
}

function serializeTaskFile(meta, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  if (body) {
    lines.push("");
    lines.push(body);
  }
  return lines.join("\n") + "\n";
}

function extractMeta(task) {
  const meta = {};
  for (const [key, value] of Object.entries(task)) {
    if (META_KEYS.has(key)) meta[key] = value;
  }
  return meta;
}

function generateTaskId() {
  return crypto.randomBytes(4).toString("hex");
}

function expandHome(p) {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

function normalizeProjects(meta) {
  if (meta.projects && Array.isArray(meta.projects)) return meta.projects;
  if (meta.project) {
    const projectPath = path.resolve(expandHome(meta.project));
    return [{ path: projectPath, name: path.basename(projectPath), role: "primary" }];
  }
  return [];
}

// ── Git Helpers ──

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// ── Git Validation ──

function isGitRepo(projectPath) {
  try {
    git(["rev-parse", "--show-toplevel"], projectPath);
    return true;
  } catch {
    return false;
  }
}

function validateGitProjects(projects) {
  const errors = [];
  for (const project of projects) {
    if (!isGitRepo(project.path)) {
      errors.push(`"${project.name}" (${project.path}) is not a git repository`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Git validation failed:\n${errors.join("\n")}`);
  }
}

// ── PID Utilities ──

async function readPid() {
  try {
    const content = await readFile(PID_PATH, "utf-8");
    return parseInt(content.trim());
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanStaleFiles() {
  const pid = await readPid();
  if (pid && !isProcessAlive(pid)) {
    try { await unlink(PID_PATH); } catch {}
  }
  try {
    await access(SOCK_PATH);
    const currentPid = await readPid();
    if (!currentPid || !isProcessAlive(currentPid)) {
      try { await unlink(SOCK_PATH); } catch {}
    }
  } catch {}
}

// ── Daemon State (default) ──

function defaultState() {
  return {
    dataVersion: DATA_VERSION,
    daemonStatus: "running",
    pausedAt: null,
    pauseReason: null,
    activeTasks: [],
    suspendedTasks: [],
    stats: { tasksCompleted: 0, tasksFailed: 0, totalSpawns: 0 },
  };
}

// ── Resource Monitor ──

function checkResources() {
  const cpuLoad = os.loadavg()[0] / os.cpus().length;
  const memoryFreeMb = os.freemem() / (1024 * 1024);
  let diskFreeGb = null;
  try {
    const output = execFileSync("df", ["-k", UCM_DIR], { encoding: "utf-8" });
    const lines = output.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const availKb = parseInt(parts[3]);
      if (!isNaN(availKb)) diskFreeGb = availKb / (1024 * 1024);
    }
  } catch {}
  return { cpuLoad, memoryFreeMb, diskFreeGb };
}

module.exports = {
  parseArgs,
  ensureDirectories,
  parseTaskFile, serializeTaskFile, extractMeta, generateTaskId,
  expandHome, normalizeProjects,
  git,
  isGitRepo, validateGitProjects,
  readPid, isProcessAlive, cleanStaleFiles,
  defaultState,
  checkResources,
};
