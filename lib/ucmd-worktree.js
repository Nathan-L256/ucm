const { execFileSync } = require("child_process");
const { readFile, writeFile, mkdir, rm } = require("fs/promises");
const fs = require("fs");
const path = require("path");

const {
  WORKTREES_DIR, ARTIFACTS_DIR,
} = require("./ucmd-constants.js");

const { git, expandHome } = require("./ucmd-task.js");

// ── Logger Injection ──

let log = () => {};

function setLog(fn) {
  log = fn;
}

// ── Git Worktree Management ──

async function createWorktrees(taskId, projects) {
  const taskWorktreeDir = path.join(WORKTREES_DIR, taskId);
  await mkdir(taskWorktreeDir, { recursive: true });

  const branchName = `ucm/${taskId}`;
  const workspaceProjects = [];

  for (const project of projects) {
    const originPath = path.resolve(project.path);
    const worktreePath = path.join(taskWorktreeDir, project.name);

    // capture base commit before branching
    const baseCommit = git(["rev-parse", "HEAD"], originPath);

    // create branch from current HEAD
    try {
      git(["branch", branchName], originPath);
    } catch (e) {
      if (!e.stderr?.includes("already exists")) throw e;
    }

    // add worktree
    git(["worktree", "add", worktreePath, branchName], originPath);

    workspaceProjects.push({
      name: project.name,
      path: worktreePath,
      origin: originPath,
      role: project.role || "primary",
      baseCommit,
    });
  }

  // write workspace.json
  const workspace = { taskId, projects: workspaceProjects };
  await writeFile(
    path.join(taskWorktreeDir, "workspace.json"),
    JSON.stringify(workspace, null, 2) + "\n",
  );

  return workspace;
}

async function loadWorkspace(taskId) {
  const workspacePath = path.join(WORKTREES_DIR, taskId, "workspace.json");
  try {
    return JSON.parse(await readFile(workspacePath, "utf-8"));
  } catch {
    return null;
  }
}

async function mergeWorktrees(taskId, projects) {
  const branchName = `ucm/${taskId}`;
  const workspace = await loadWorkspace(taskId);
  const errors = [];

  for (const project of projects) {
    const originPath = path.resolve(project.path);
    const worktreePath = path.join(WORKTREES_DIR, taskId, project.name);

    try {
      const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], originPath);

      // auto-commit any uncommitted changes in worktree
      const status = git(["status", "--porcelain"], worktreePath);
      if (status) {
        git(["add", "-A"], worktreePath);
        git(["commit", "-m", `chore: uncommitted changes for ${taskId}`], worktreePath);
        log(`auto-committed uncommitted changes in ${project.name}`);
      }

      // check if the ucm branch has any new commits
      const wsProject = workspace?.projects?.find((p) => p.name === project.name);
      const baseCommit = wsProject?.baseCommit;
      const tipCommit = git(["rev-parse", "HEAD"], worktreePath);

      if (baseCommit && tipCommit === baseCommit) {
        log(`skip merge ${project.name}: no changes on ${branchName}`);
      } else {
        // stash dirty working directory before merge
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
            } catch (stashErr) {
              log(`[warn] stash pop conflict in ${project.name}, run 'git stash pop' manually`);
            }
          }
        }
      }

      // cleanup worktree + branch
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
}

async function removeWorktrees(taskId, projects) {
  const branchName = `ucm/${taskId}`;

  for (const project of projects) {
    const originPath = path.resolve(expandHome(project.path));
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
      if (baseCommit) {
        // diff from branch point to working tree (includes committed + uncommitted)
        const diff = git(["diff", baseCommit], worktreePath);
        diffs.push({ project: project.name, diff: diff || "(no changes)" });
      } else {
        // fallback: show all uncommitted changes
        const diff = git(["diff", "HEAD"], worktreePath);
        diffs.push({ project: project.name, diff: diff || "(no changes)" });
      }
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

function loadWorkspaceSync(taskId) {
  const workspacePath = path.join(WORKTREES_DIR, taskId, "workspace.json");
  try {
    return JSON.parse(fs.readFileSync(workspacePath, "utf-8"));
  } catch {
    return null;
  }
}

function getWorktreeCwd(taskId, projects) {
  const taskWorktreeDir = path.join(WORKTREES_DIR, taskId);
  if (projects.length === 1) {
    return path.join(taskWorktreeDir, projects[0].name);
  }
  return taskWorktreeDir;
}

// ── Artifact Management ──

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
  } catch (e) {
    log(`artifact git init error: ${e.message}`);
  }
}

async function saveArtifact(taskId, filename, content) {
  const artifactDir = path.join(ARTIFACTS_DIR, taskId);
  await writeFile(path.join(artifactDir, filename), content);
  try {
    git(["add", filename], artifactDir);
    git(["commit", "-m", `save: ${filename}`], artifactDir);
  } catch {}
}

async function loadArtifact(taskId, filename) {
  return readFile(path.join(ARTIFACTS_DIR, taskId, filename), "utf-8");
}

async function updateMemory(taskId, updates) {
  const artifactDir = path.join(ARTIFACTS_DIR, taskId);
  let memory;
  try {
    memory = JSON.parse(await readFile(path.join(artifactDir, "memory.json"), "utf-8"));
  } catch {
    memory = { timeline: [], metrics: { totalSpawns: 0, result: null } };
  }

  if (updates.timelineEntry) memory.timeline.push(updates.timelineEntry);
  if (updates.metrics) Object.assign(memory.metrics, updates.metrics);

  await writeFile(path.join(artifactDir, "memory.json"), JSON.stringify(memory, null, 2) + "\n");
  try {
    git(["add", "memory.json"], artifactDir);
    git(["commit", "-m", "update memory"], artifactDir);
  } catch {}
}

module.exports = {
  setLog,
  createWorktrees, loadWorkspace, mergeWorktrees, removeWorktrees,
  getWorktreeDiff, getWorktreeDiffStat,
  loadWorkspaceSync, getWorktreeCwd,
  initArtifacts, saveArtifact, loadArtifact, updateMemory,
};
