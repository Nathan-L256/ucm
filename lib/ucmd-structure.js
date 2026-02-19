const { execFileSync } = require("child_process");
const { readFile, readdir, access } = require("fs/promises");
const path = require("path");

const SOURCE_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".rb", ".rs",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "vendor",
  ".next", "__pycache__", "target", "coverage", ".turbo", ".cache",
]);

const FUNCTION_PATTERNS = {
  js: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/,
    /^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*\{/,
  ],
  py: [/^\s*(?:async\s+)?def\s+\w+/],
  go: [/^func\s+/],
  java: [/^\s*(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+\w+\s*\(/],
  rb: [/^\s*def\s+\w+/],
  rs: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/],
};

function getLanguageFamily(ext) {
  if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) return "js";
  if (ext === ".py") return "py";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".rb") return "rb";
  if (ext === ".rs") return "rs";
  return null;
}

function countFunctions(content, ext) {
  const family = getLanguageFamily(ext);
  if (!family) return 0;
  const patterns = FUNCTION_PATTERNS[family];
  const lines = content.split("\n");
  let count = 0;
  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        count++;
        break;
      }
    }
  }
  return count;
}

function getSizeCategory(lines) {
  if (lines <= 100) return "small";
  if (lines <= 300) return "ok";
  if (lines <= 500) return "large";
  return "very large";
}

async function analyzeFile(filePath) {
  const content = await readFile(filePath, "utf-8");
  const ext = path.extname(filePath);
  const lines = content.split("\n").length;
  const functions = countFunctions(content, ext);
  const sizeCategory = getSizeCategory(lines);
  return { lines, functions, sizeCategory };
}

function getChangedFiles(worktreePath, baseCommit) {
  try {
    const output = execFileSync(
      "git", ["diff", "--name-only", baseCommit, "HEAD"],
      { cwd: worktreePath, encoding: "utf-8", timeout: 10000 },
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function analyzeChangedFiles(worktreePath, baseCommit) {
  const changedFiles = getChangedFiles(worktreePath, baseCommit);
  const files = [];
  for (const relativePath of changedFiles) {
    const ext = path.extname(relativePath);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const fullPath = path.join(worktreePath, relativePath);
    try {
      const analysis = await analyzeFile(fullPath);
      files.push({ path: relativePath, ...analysis });
    } catch {
      files.push({ path: relativePath, lines: 0, functions: 0, sizeCategory: "deleted" });
    }
  }
  const summary = formatChangedFilesMetrics(files);
  return { files, summary };
}

async function scanProjectStructure(projectPath, { topN = 10 } = {}) {
  let totalFiles = 0;
  let totalLines = 0;
  let largeFileCount = 0;
  const allFiles = [];

  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          const analysis = await analyzeFile(fullPath);
          const relativePath = path.relative(projectPath, fullPath);
          totalFiles++;
          totalLines += analysis.lines;
          if (analysis.lines > 300) largeFileCount++;
          allFiles.push({ path: relativePath, ...analysis });
        } catch {}
      }
    }
  }

  await walk(projectPath);
  allFiles.sort((a, b) => b.lines - a.lines);
  const topFiles = allFiles.slice(0, topN);
  const avgLines = totalFiles > 0 ? Math.round(totalLines / totalFiles) : 0;
  const summary = formatProjectStructureMetrics(
    path.basename(projectPath), projectPath,
    { totalFiles, totalLines, avgLines, largeFileCount, topFiles },
  );
  return { totalFiles, totalLines, avgLines, largeFileCount, topFiles, summary };
}

function formatChangedFilesMetrics(files) {
  if (files.length === 0) return "";
  const rows = files.map((f) => {
    const status = f.sizeCategory === "deleted" ? "deleted"
      : f.sizeCategory === "very large" ? "\u26a0 very large"
      : f.sizeCategory === "large" ? "large"
      : f.sizeCategory;
    return `| ${f.path} | ${f.lines} | ${f.functions} | ${status} |`;
  });
  return [
    "| File | Lines | Functions | Status |",
    "|------|-------|-----------|--------|",
    ...rows,
  ].join("\n");
}

function formatProjectStructureMetrics(name, projectPath, metrics) {
  const header = `### ${name} (${projectPath})\nTotal: ${metrics.totalFiles} files | Avg: ${metrics.avgLines} lines | >300 lines: ${metrics.largeFileCount} files`;
  if (!metrics.topFiles || metrics.topFiles.length === 0) return header;
  const rows = metrics.topFiles.map((f) =>
    `| ${f.path} | ${f.lines} | ${f.functions} |`,
  );
  return [
    header,
    "",
    "| File | Lines | Functions |",
    "|------|-------|-----------|",
    ...rows,
  ].join("\n");
}

// ── Commit History Analysis ──

const LARGE_COMMIT_THRESHOLD = 500;

function analyzeCommitHistory(projectPath, { windowDays = 7 } = {}) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let logOutput;
  try {
    logOutput = execFileSync(
      "git", ["log", `--since=${since}`, "--format=%H|%s|%aI", "--no-merges"],
      { cwd: projectPath, encoding: "utf-8", timeout: 15000 },
    ).trim();
  } catch {
    return emptyCommitMetrics(windowDays);
  }

  if (!logOutput) return emptyCommitMetrics(windowDays);

  const lines = logOutput.split("\n").filter(Boolean);
  const commits = lines.map((line) => {
    const [hash, subject, date] = line.split("|");
    return { hash, subject: subject || "", date: date || "" };
  });

  let totalDiffLines = 0;
  let maxDiffLines = 0;
  let largeCommitCount = 0;
  let totalMessageLength = 0;
  const activeDaysSet = new Set();

  for (const commit of commits) {
    totalMessageLength += commit.subject.length;
    if (commit.date) activeDaysSet.add(commit.date.slice(0, 10));

    let diffLines = 0;
    try {
      const stat = execFileSync(
        "git", ["diff", "--shortstat", `${commit.hash}~1`, commit.hash],
        { cwd: projectPath, encoding: "utf-8", timeout: 10000 },
      ).trim();
      const match = stat.match(/(\d+) insertion|(\d+) deletion/g);
      if (match) {
        for (const m of match) {
          const num = parseInt(m);
          if (!isNaN(num)) diffLines += num;
        }
      }
    } catch {
      diffLines = 0;
    }

    totalDiffLines += diffLines;
    if (diffLines > maxDiffLines) maxDiffLines = diffLines;
    if (diffLines > LARGE_COMMIT_THRESHOLD) largeCommitCount++;
  }

  const commitCount = commits.length;
  const activeDays = activeDaysSet.size;

  return {
    commitCount,
    avgDiffLines: commitCount > 0 ? Math.round(totalDiffLines / commitCount) : 0,
    maxDiffLines,
    largeCommitCount,
    commitsPerDay: activeDays > 0 ? Math.round((commitCount / activeDays) * 10) / 10 : 0,
    avgMessageLength: commitCount > 0 ? Math.round(totalMessageLength / commitCount) : 0,
    windowDays,
    activeDays,
  };
}

function emptyCommitMetrics(windowDays = 7) {
  return {
    commitCount: 0,
    avgDiffLines: 0,
    maxDiffLines: 0,
    largeCommitCount: 0,
    commitsPerDay: 0,
    avgMessageLength: 0,
    windowDays,
    activeDays: 0,
  };
}

function formatCommitHistory(name, metrics) {
  if (metrics.commitCount === 0) {
    return `### ${name}\n- No commits in the last ${metrics.windowDays} days`;
  }
  return [
    `### ${name}`,
    `- Commits: ${metrics.commitCount} (${metrics.commitsPerDay}/day over ${metrics.activeDays} active days)`,
    `- Avg diff: ${metrics.avgDiffLines} lines | Max: ${metrics.maxDiffLines} lines`,
    `- Large commits (>${LARGE_COMMIT_THRESHOLD} lines): ${metrics.largeCommitCount}`,
    `- Avg message length: ${metrics.avgMessageLength} chars`,
  ].join("\n");
}

// ── Documentation Scanning ──

const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);
const DOC_DIRS = new Set(["docs", "doc", "documentation"]);

async function scanDocumentation(projectPath) {
  let hasReadme = false;
  try {
    await access(path.join(projectPath, "README.md"));
    hasReadme = true;
  } catch {}

  let hasDocsDir = false;
  let docFileCount = 0;

  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        docFileCount++;
      }
      if (entry.isDirectory() && DOC_DIRS.has(entry.name.toLowerCase())) {
        hasDocsDir = true;
        try {
          const docEntries = await readdir(path.join(projectPath, entry.name), { withFileTypes: true });
          for (const docEntry of docEntries) {
            if (docEntry.isFile() && DOC_EXTENSIONS.has(path.extname(docEntry.name).toLowerCase())) {
              docFileCount++;
            }
          }
        } catch {}
      }
    }
  } catch {}

  return { hasReadme, hasDocsDir, docFileCount };
}

function formatDocumentation(name, info, sourceFileCount) {
  const readmeStatus = info.hasReadme ? "present" : "MISSING";
  const docsStatus = info.hasDocsDir ? "present" : "absent";
  const ratio = sourceFileCount > 0
    ? ` (${Math.round((info.docFileCount / sourceFileCount) * 100)}% of ${sourceFileCount} source files)`
    : "";
  return [
    `### ${name}`,
    `- README: ${readmeStatus}`,
    `- docs/ directory: ${docsStatus}`,
    `- Doc files: ${info.docFileCount}${ratio}`,
  ].join("\n");
}

// ── Project Context Generation ──

async function generateProjectContext(projectPath) {
  const files = [];

  async function collectDocFiles(dir, relative) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (relative === "" && DOC_DIRS.has(entry.name.toLowerCase())) {
          await collectDocFiles(path.join(dir, entry.name), entry.name);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!DOC_EXTENSIONS.has(ext)) continue;
      const filePath = relative ? path.join(relative, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);
      try {
        const content = await readFile(fullPath, "utf-8");
        const allLines = content.split("\n");
        const lines = allLines.length;
        const preview = allLines.slice(0, 5).join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
        files.push({ path: filePath, lines, preview });
      } catch {}
    }
  }

  await collectDocFiles(projectPath, "");

  // Also recurse into doc dirs that are nested
  try {
    const topEntries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of topEntries) {
      if (entry.isDirectory() && DOC_DIRS.has(entry.name.toLowerCase())) {
        await collectDocDirRecursive(path.join(projectPath, entry.name), entry.name, files);
      }
    }
  } catch {}

  // Deduplicate by path
  const seen = new Set();
  const deduplicated = [];
  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      deduplicated.push(file);
    }
  }

  const hasReadme = deduplicated.some((f) => f.path.toLowerCase() === "readme.md");
  const hasDocsDir = deduplicated.some((f) => f.path.includes("/") || f.path.includes(path.sep));

  return {
    files: deduplicated,
    hasReadme,
    hasDocsDir,
    docFileCount: deduplicated.length,
  };
}

async function collectDocDirRecursive(dir, relative, files) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectDocDirRecursive(path.join(dir, entry.name), path.join(relative, entry.name), files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!DOC_EXTENSIONS.has(ext)) continue;
      const filePath = path.join(relative, entry.name);
      const fullPath = path.join(dir, entry.name);
      try {
        const content = await readFile(fullPath, "utf-8");
        const allLines = content.split("\n");
        const lines = allLines.length;
        const preview = allLines.slice(0, 5).join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
        files.push({ path: filePath, lines, preview });
      } catch {}
    }
  }
}

function formatProjectContext(context) {
  if (!context || context.files.length === 0) {
    return "No documentation files found.";
  }

  const rows = context.files.map((f) =>
    `| ${f.path} | ${f.lines} | ${f.preview} |`
  );

  const readmeStatus = context.hasReadme ? "present" : "MISSING";
  const docsDirStatus = context.hasDocsDir ? "present" : "absent";

  return [
    "### Documentation Files",
    "",
    "| Path | Lines | Preview |",
    "|------|-------|---------|",
    ...rows,
    "",
    `Summary: ${context.docFileCount} doc files, README ${readmeStatus}, docs/ ${docsDirStatus}`,
  ].join("\n");
}

// ── Doc Coverage for Changed Files (Self-review) ──

function analyzeDocCoverage(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) {
    return { sourceChanged: 0, docsChanged: 0, summary: "" };
  }

  let sourceChanged = 0;
  let docsChanged = 0;

  for (const file of changedFiles) {
    const ext = path.extname(file).toLowerCase();
    if (DOC_EXTENSIONS.has(ext)) {
      docsChanged++;
    } else if (SOURCE_EXTENSIONS.has(ext)) {
      sourceChanged++;
    }
  }

  const lines = [
    `- Source files changed: ${sourceChanged}`,
    `- Documentation files changed: ${docsChanged}`,
  ];

  if (sourceChanged > 0 && docsChanged === 0) {
    lines.push("- **Warning**: source files were modified but no documentation was updated");
  }

  return { sourceChanged, docsChanged, summary: lines.join("\n") };
}

module.exports = {
  SOURCE_EXTENSIONS,
  SKIP_DIRS,
  FUNCTION_PATTERNS,
  getLanguageFamily,
  countFunctions,
  getSizeCategory,
  analyzeFile,
  getChangedFiles,
  analyzeChangedFiles,
  scanProjectStructure,
  formatChangedFilesMetrics,
  formatProjectStructureMetrics,
  analyzeCommitHistory,
  emptyCommitMetrics,
  formatCommitHistory,
  LARGE_COMMIT_THRESHOLD,
  DOC_EXTENSIONS,
  DOC_DIRS,
  scanDocumentation,
  formatDocumentation,
  generateProjectContext,
  formatProjectContext,
  analyzeDocCoverage,
};
