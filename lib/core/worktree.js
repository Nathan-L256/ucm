const { execFileSync } = require("child_process");
const { readFile, writeFile, mkdir, rm } = require("fs/promises");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WORKTREES_DIR, ARTIFACTS_DIR } = require("./constants");

// worktree 동시 접근 방지를 위한 lockfile
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

async function acquireLock(taskId) {
  const lockPath = path.join(WORKTREES_DIR, `${taskId}.lock`);
  await mkdir(WORKTREES_DIR, { recursive: true });

  // stale lock 체크
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {}

  try {
    fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx" });
    return lockPath;
  } catch (e) {
    if (e.code === "EEXIST") {
      throw new Error(`worktree locked for task ${taskId}. Another operation may be in progress.`);
    }
    throw e;
  }
}

function releaseLock(taskId) {
  const lockPath = path.join(WORKTREES_DIR, `${taskId}.lock`);
  try { fs.unlinkSync(lockPath); } catch {}
}

// 민감 정보 패턴 (source + flags 분리 저장하여 매 호출마다 fresh regex 생성)
const SENSITIVE_PATTERN_DEFS = [
  { source: "(?:api[_-]?key|apikey)\\s*[:=]\\s*[\"']?[\\w\\-]{20,}", flags: "gi" },
  { source: "(?:secret|password|passwd|token)\\s*[:=]\\s*[\"']?[\\w\\-]{8,}", flags: "gi" },
  { source: "(?:AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)\\s*[:=]\\s*\\S+", flags: "gi" },
  { source: "Bearer\\s+[\\w\\-.]+", flags: "g" },
  { source: "ghp_[\\w]{36}", flags: "g" },
  { source: "sk-[\\w]{32,}", flags: "g" },
];

function sanitizeContent(content) {
  if (!content || typeof content !== "string") return content;
  let sanitized = content;
  for (const def of SENSITIVE_PATTERN_DEFS) {
    const pattern = new RegExp(def.source, def.flags);
    sanitized = sanitized.replace(pattern, (match) => {
      const prefix = match.slice(0, Math.min(10, Math.floor(match.length / 3)));
      return `${prefix}[REDACTED]`;
    });
  }
  return sanitized;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function expandHome(p) {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

function isGitRepo(projectPath) {
  try {
    git(["rev-parse", "--show-toplevel"], projectPath);
    return true;
  } catch {
    return false;
  }
}

async function createWorktrees(taskId, projects, { log = () => {} } = {}) {
  await acquireLock(taskId);
  try {
    const taskWorktreeDir = path.join(WORKTREES_DIR, taskId);
    await mkdir(taskWorktreeDir, { recursive: true });

    const branchName = `ucm/${taskId}`;
    const workspaceProjects = [];

    for (const project of projects) {
      const originPath = path.resolve(project.path);
      const worktreePath = path.join(taskWorktreeDir, project.name);

      const baseCommit = git(["rev-parse", "HEAD"], originPath);

      try {
        git(["branch", branchName], originPath);
      } catch (e) {
        if (!e.stderr?.includes("already exists")) throw e;
      }

      git(["worktree", "add", worktreePath, branchName], originPath);

      workspaceProjects.push({
        name: project.name,
        path: worktreePath,
        origin: originPath,
        role: project.role || "primary",
        baseCommit,
      });
    }

    const workspace = { taskId, projects: workspaceProjects };
    await writeFile(
      path.join(taskWorktreeDir, "workspace.json"),
      JSON.stringify(workspace, null, 2) + "\n",
    );

    return workspace;
  } finally {
    releaseLock(taskId);
  }
}

async function loadWorkspace(taskId) {
  const workspacePath = path.join(WORKTREES_DIR, taskId, "workspace.json");
  try {
    return JSON.parse(await readFile(workspacePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadWorkspaceSync(taskId) {
  const workspacePath = path.join(WORKTREES_DIR, taskId, "workspace.json");
  try {
    return JSON.parse(fs.readFileSync(workspacePath, "utf-8"));
  } catch {
    return null;
  }
}

// 머지 시 경고할 민감 파일 패턴
const SENSITIVE_FILE_PATTERNS = [
  /\.env($|\.)/, /\.key$/, /\.pem$/, /\.p12$/, /\.pfx$/,
  /credentials\.json$/, /\.secret$/, /id_rsa/, /\.keystore$/,
];

async function mergeWorktrees(taskId, projects, { log = () => {} } = {}) {
  await acquireLock(taskId);
  try {
    const branchName = `ucm/${taskId}`;
    const workspace = await loadWorkspace(taskId);
    const errors = [];

    for (const project of projects) {
      const originPath = path.resolve(project.origin || project.path);
      const worktreePath = path.join(WORKTREES_DIR, taskId, project.name);

      try {
        const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], originPath);

        const status = git(["status", "--porcelain"], worktreePath);
        if (status) {
          git(["add", "-A"], worktreePath);
          git(["commit", "-m", `chore: uncommitted changes for ${taskId}`], worktreePath);
          log(`auto-committed uncommitted changes in ${project.name}`);
        }

        const wsProject = workspace?.projects?.find((p) => p.name === project.name);
        const baseCommit = wsProject?.baseCommit;
        const tipCommit = git(["rev-parse", "HEAD"], worktreePath);

        if (baseCommit && tipCommit === baseCommit) {
          log(`skip merge ${project.name}: no changes on ${branchName}`);
        } else {
          // 민감 파일 수정 경고
          try {
            const diffArgs = baseCommit ? ["diff", "--name-only", baseCommit] : ["diff", "--name-only", "HEAD"];
            const changed = git(diffArgs, worktreePath).split("\n").filter(Boolean);
            const sensitiveFiles = changed.filter((f) => SENSITIVE_FILE_PATTERNS.some((p) => p.test(f)));
            if (sensitiveFiles.length > 0) {
              log(`[WARN] sensitive files modified: ${sensitiveFiles.join(", ")}`);
            }
          } catch {}
          const originStatus = git(["status", "--porcelain"], originPath);
          let stashed = false;
          if (originStatus) {
            git(["stash", "push", "-m", `ucm-merge-${taskId}`], originPath);
            stashed = true;
            log(`stashed changes in ${project.name} before merge`);
          }
          try {
            git(["merge", branchName, "--no-edit"], originPath);
            log(`merged ${project.name}: ${branchName} → ${currentBranch}`);
          } finally {
            if (stashed) {
              try {
                git(["stash", "pop"], originPath);
                log(`restored stashed changes in ${project.name}`);
              } catch {
                log(`[warn] stash pop conflict in ${project.name}, run 'git stash pop' manually`);
              }
            }
          }
        }

        git(["worktree", "remove", worktreePath], originPath);
        git(["branch", "-d", branchName], originPath);
      } catch (e) {
        const msg = e.stderr || e.message;
        errors.push({ project: project.name, error: msg });
      }
    }

    if (errors.length > 0) {
      const details = errors.map((e) => `${e.project}: ${e.error}`).join("; ");
      throw new Error(`merge failed: ${details}`);
    }

    try { await rm(path.join(WORKTREES_DIR, taskId), { recursive: true }); } catch {}
  } finally {
    releaseLock(taskId);
  }
}

async function removeWorktrees(taskId, projects) {
  const branchName = `ucm/${taskId}`;

  for (const project of projects) {
    const originPath = path.resolve(expandHome(project.origin || project.path));
    const worktreePath = path.join(WORKTREES_DIR, taskId, project.name);

    try { git(["worktree", "remove", "--force", worktreePath], originPath); } catch {}
    try { git(["worktree", "prune"], originPath); } catch {}
    try { git(["branch", "-D", branchName], originPath); } catch {}
  }

  try { await rm(path.join(WORKTREES_DIR, taskId), { recursive: true }); } catch {}
}

async function getWorktreeDiff(taskId, projects) {
  const workspace = await loadWorkspace(taskId);
  const diffs = [];

  for (const project of projects) {
    const worktreePath = path.join(WORKTREES_DIR, taskId, project.name);
    const wsProject = workspace?.projects?.find((p) => p.name === project.name);
    const baseCommit = wsProject?.baseCommit;

    try {
      const args = baseCommit ? ["diff", baseCommit] : ["diff", "HEAD"];
      const diff = git(args, worktreePath);
      diffs.push({ project: project.name, diff: diff || "(no changes)" });
    } catch (e) {
      diffs.push({ project: project.name, diff: `(error: ${e.message})` });
    }
  }

  return diffs;
}

function getWorktreeDiffStat(taskId, projects) {
  const workspace = loadWorkspaceSync(taskId);
  const stats = [];
  for (const project of projects) {
    const worktreePath = path.join(WORKTREES_DIR, taskId, project.name);
    const wsProject = workspace?.projects?.find((p) => p.name === project.name);
    const baseCommit = wsProject?.baseCommit;
    try {
      const args = baseCommit ? ["diff", "--stat", baseCommit] : ["diff", "--stat", "HEAD"];
      const output = execFileSync("git", args, { cwd: worktreePath, encoding: "utf-8" }).trim();
      stats.push({ project: project.name, stat: output || "(no changes)" });
    } catch {
      stats.push({ project: project.name, stat: "(error)" });
    }
  }
  return stats;
}

function getWorktreeCwd(taskId, projects) {
  const taskWorktreeDir = path.join(WORKTREES_DIR, taskId);
  if (projects.length === 1) {
    return path.join(taskWorktreeDir, projects[0].name);
  }
  return taskWorktreeDir;
}

async function initArtifacts(taskId, taskContent) {
  const artifactDir = path.join(ARTIFACTS_DIR, taskId);
  await mkdir(artifactDir, { recursive: true });

  await writeFile(path.join(artifactDir, "task.md"), taskContent);

  const memory = { timeline: [], metrics: { totalSpawns: 0, result: null } };
  await writeFile(path.join(artifactDir, "memory.json"), JSON.stringify(memory, null, 2) + "\n");

  try {
    git(["init"], artifactDir);
    git(["add", "-A"], artifactDir);
    git(["commit", "-m", "init: task submitted"], artifactDir);
  } catch {}
}

async function saveArtifact(taskId, filename, content) {
  const artifactDir = path.join(ARTIFACTS_DIR, taskId);
  await mkdir(artifactDir, { recursive: true });
  const safeContent = sanitizeContent(content);
  await writeFile(path.join(artifactDir, filename), safeContent);
  try {
    git(["add", filename], artifactDir);
    git(["commit", "-m", `save: ${filename}`], artifactDir);
  } catch {}
}

async function loadArtifact(taskId, filename) {
  return readFile(path.join(ARTIFACTS_DIR, taskId, filename), "utf-8");
}

async function cleanupTask(taskId) {
  const removed = { worktrees: false, artifacts: false, forge: false };

  // lock 파일 해제
  releaseLock(taskId);

  // worktrees 정리
  const worktreeDir = path.join(WORKTREES_DIR, taskId);
  try {
    const workspace = await loadWorkspace(taskId);
    if (workspace) {
      await removeWorktrees(taskId, workspace.projects);
    }
    removed.worktrees = true;
  } catch {
    try { await rm(worktreeDir, { recursive: true }); removed.worktrees = true; } catch {}
  }

  // artifacts 정리
  const artifactDir = path.join(ARTIFACTS_DIR, taskId);
  try { await rm(artifactDir, { recursive: true }); removed.artifacts = true; } catch {}

  // forge dir 정리
  const forgeDir = path.join(require("./constants").FORGE_DIR, taskId);
  try { await rm(forgeDir, { recursive: true }); removed.forge = true; } catch {}

  return removed;
}

async function gcTasks({ maxAgeDays = 30, statuses = ["done", "failed", "aborted"] } = {}) {
  const { FORGE_DIR } = require("./constants");
  const { readdir } = require("fs/promises");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const cleaned = [];

  try {
    const entries = await readdir(FORGE_DIR);
    for (const entry of entries) {
      if (!entry.startsWith("forge-")) continue;
      try {
        const taskPath = path.join(FORGE_DIR, entry, "task.json");
        const data = JSON.parse(await readFile(taskPath, "utf-8"));

        // createdAt 기준으로 오래된 태스크만 정리
        const createdTime = new Date(data.createdAt || 0).getTime();
        if (createdTime > cutoff) continue;

        if (!statuses.includes(data.status)) continue;

        await cleanupTask(entry);
        cleaned.push(entry);
      } catch {}
    }
  } catch {}

  return cleaned;
}

module.exports = {
  git,
  expandHome,
  isGitRepo,
  createWorktrees, loadWorkspace, mergeWorktrees, removeWorktrees,
  getWorktreeDiff, getWorktreeDiffStat, getWorktreeCwd,
  initArtifacts, saveArtifact, loadArtifact,
  cleanupTask, gcTasks,
  sanitizeContent, acquireLock, releaseLock,
};
