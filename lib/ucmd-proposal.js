const { readFile, writeFile, mkdir, readdir, unlink } = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const {
  PROPOSALS_DIR, SNAPSHOTS_DIR,
  PROPOSAL_STATUSES, MAX_SNAPSHOTS,
} = require("./ucmd-constants.js");

const { parseTaskFile, serializeTaskFile } = require("./ucmd-task.js");

// ── Logger Injection ──

let log = () => {};

function setLog(fn) {
  log = fn;
}

// ── Proposal ID & Hashing ──

function generateProposalId() {
  return "p-" + crypto.randomBytes(4).toString("hex");
}

function computeDedupHash(title, category, change) {
  const parts = [title, category, change].map((s) => (s || "").trim().toLowerCase().replace(/\s+/g, " "));
  const normalized = parts.join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Proposal Serialization ──

function serializeProposal(proposal) {
  const meta = {
    id: proposal.id,
    title: proposal.title,
    status: proposal.status,
    category: proposal.category,
    risk: proposal.risk,
    priority: proposal.priority || 0,
    created: proposal.created,
    observationCycle: proposal.observationCycle,
    dedupHash: proposal.dedupHash,
    implementedBy: proposal.implementedBy || null,
  };
  if (proposal.project) {
    meta.project = proposal.project;
  }
  if (proposal.relatedTasks && proposal.relatedTasks.length > 0) {
    meta.relatedTasks = proposal.relatedTasks;
  }

  const body = [
    "## Problem",
    "",
    proposal.problem || "",
    "",
    "## Proposed Change",
    "",
    proposal.change || "",
    "",
    "## Expected Impact",
    "",
    proposal.expectedImpact || "",
  ].join("\n");

  return serializeTaskFile(meta, body);
}

function parseProposalFile(content) {
  const { meta, body } = parseTaskFile(content);

  const sections = {};
  const sectionRegex = /^## (.+)$/gm;
  let match;
  const sectionStarts = [];
  while ((match = sectionRegex.exec(body)) !== null) {
    sectionStarts.push({ name: match[1].trim(), index: match.index + match[0].length });
  }
  for (let i = 0; i < sectionStarts.length; i++) {
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index - sectionStarts[i + 1].name.length - 3 : body.length;
    sections[sectionStarts[i].name] = body.slice(sectionStarts[i].index, end).trim();
  }

  return {
    ...meta,
    problem: sections["Problem"] || "",
    change: sections["Proposed Change"] || "",
    expectedImpact: sections["Expected Impact"] || "",
  };
}

// ── Proposal CRUD ──

async function saveProposal(proposal) {
  const statusDir = path.join(PROPOSALS_DIR, proposal.status);
  await mkdir(statusDir, { recursive: true });
  const filePath = path.join(statusDir, `${proposal.id}.md`);
  await writeFile(filePath, serializeProposal(proposal));
  return filePath;
}

async function loadProposal(proposalId) {
  for (const status of PROPOSAL_STATUSES) {
    const filePath = path.join(PROPOSALS_DIR, status, `${proposalId}.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      return { ...parseProposalFile(content), status, _filePath: filePath };
    } catch {}
  }
  return null;
}

async function moveProposal(proposalId, fromStatus, toStatus) {
  const srcPath = path.join(PROPOSALS_DIR, fromStatus, `${proposalId}.md`);
  const content = await readFile(srcPath, "utf-8");
  const proposal = parseProposalFile(content);
  proposal.status = toStatus;
  const dstPath = path.join(PROPOSALS_DIR, toStatus, `${proposalId}.md`);
  await writeFile(dstPath, serializeProposal(proposal));
  await unlink(srcPath);
  return proposal;
}

async function listProposals(statusFilter) {
  const proposals = [];
  const statuses = statusFilter ? [statusFilter] : PROPOSAL_STATUSES;
  for (const status of statuses) {
    const dir = path.join(PROPOSALS_DIR, status);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(path.join(dir, file), "utf-8");
        const proposal = parseProposalFile(content);
        proposals.push({ ...proposal, status });
      } catch {}
    }
  }
  proposals.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return proposals;
}

// ── Snapshots ──

async function saveSnapshot(metrics) {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const filePath = path.join(SNAPSHOTS_DIR, `snapshot-${fileTimestamp}.json`);
  const snapshot = { timestamp, metrics };
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n");
  log(`[snapshot] saved: ${filePath}`);
  await cleanupOldSnapshots();
  return filePath;
}

async function loadLatestSnapshot() {
  let files;
  try { files = await readdir(SNAPSHOTS_DIR); } catch { return null; }
  const snapshots = files.filter((f) => f.startsWith("snapshot-") && f.endsWith(".json")).sort();
  if (snapshots.length === 0) return null;
  try {
    return JSON.parse(await readFile(path.join(SNAPSHOTS_DIR, snapshots[snapshots.length - 1]), "utf-8"));
  } catch { return null; }
}

async function loadAllSnapshots() {
  let files;
  try { files = await readdir(SNAPSHOTS_DIR); } catch { return []; }
  const snapshots = files.filter((f) => f.startsWith("snapshot-") && f.endsWith(".json")).sort();
  const results = [];
  for (const file of snapshots) {
    try {
      const data = JSON.parse(await readFile(path.join(SNAPSHOTS_DIR, file), "utf-8"));
      results.push(data);
    } catch {}
  }
  return results;
}

async function cleanupOldSnapshots() {
  let files;
  try { files = await readdir(SNAPSHOTS_DIR); } catch { return; }
  const snapshots = files.filter((f) => f.startsWith("snapshot-") && f.endsWith(".json")).sort();
  if (snapshots.length <= MAX_SNAPSHOTS) return;
  const toDelete = snapshots.slice(0, snapshots.length - MAX_SNAPSHOTS);
  for (const file of toDelete) {
    try {
      await unlink(path.join(SNAPSHOTS_DIR, file));
      log(`[snapshot] cleaned: ${file}`);
    } catch {}
  }
}

// ── Snapshot Comparison ──

function round2(n) {
  return Math.round(n * 100) / 100;
}

function compareSnapshots(baseline, current) {
  const delta = {};

  delta.successRate = round2(current.successRate - baseline.successRate);
  delta.avgPipelineDurationMs = current.avgPipelineDurationMs - baseline.avgPipelineDurationMs;

  if (baseline.loopMetrics && current.loopMetrics) {
    delta.firstPassRate = round2((current.loopMetrics.firstPassRate || 0) - (baseline.loopMetrics.firstPassRate || 0));
    delta.avgIterations = round2((current.loopMetrics.avgIterations || 0) - (baseline.loopMetrics.avgIterations || 0));
  }

  // stage fail rate deltas
  delta.stageFailRates = {};
  const allStages = new Set([
    ...Object.keys(baseline.stageMetrics || {}),
    ...Object.keys(current.stageMetrics || {}),
  ]);
  for (const stage of allStages) {
    const baseRate = baseline.stageMetrics?.[stage]?.failRate || 0;
    const currRate = current.stageMetrics?.[stage]?.failRate || 0;
    delta.stageFailRates[stage] = round2(currRate - baseRate);
  }

  // verdict
  let score = 0;
  if (delta.successRate > 0.05) score += 2;
  else if (delta.successRate < -0.05) score -= 2;
  if (delta.firstPassRate > 0.05) score += 1;
  else if (delta.firstPassRate < -0.05) score -= 1;
  if (delta.avgPipelineDurationMs < -5000) score += 1;
  else if (delta.avgPipelineDurationMs > 10000) score -= 1;

  let verdict;
  if (score > 0) verdict = "improved";
  else if (score < 0) verdict = "regressed";
  else verdict = "neutral";

  return { delta, verdict, score };
}

// ── Find Proposal by Task ──

async function findProposalByTaskId(taskId) {
  const implementedDir = path.join(PROPOSALS_DIR, "implemented");
  let files;
  try { files = await readdir(implementedDir); } catch { return null; }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = await readFile(path.join(implementedDir, file), "utf-8");
      const proposal = parseProposalFile(content);
      if (proposal.implementedBy === taskId) {
        return { ...proposal, status: "implemented", _filePath: path.join(implementedDir, file) };
      }
    } catch {}
  }
  return null;
}

module.exports = {
  setLog,
  generateProposalId, computeDedupHash, serializeProposal, parseProposalFile,
  saveProposal, loadProposal, moveProposal, listProposals,
  saveSnapshot, loadLatestSnapshot, loadAllSnapshots, cleanupOldSnapshots,
  compareSnapshots, findProposalByTaskId,
};
