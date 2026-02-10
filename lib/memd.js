#!/usr/bin/env node
const { spawn, execSync } = require("child_process");
const {
  readFile, writeFile, mkdir, access, readdir, unlink, rename, stat,
} = require("fs/promises");
const fs = require("fs");
const net = require("net");
const path = require("path");
const os = require("os");
const mem = require("./mem.js");
const { createSocketClient } = require("./socket-client.js");

// ── Constants ──

const MEM_DIR = mem.MEM_DIR;
const DAEMON_DIR = path.join(MEM_DIR, "daemon");
const SOCK_PATH = path.join(DAEMON_DIR, "mem.sock");
const PID_PATH = path.join(DAEMON_DIR, "memd.pid");
const LOG_PATH = path.join(DAEMON_DIR, "memd.log");
const STATE_PATH = path.join(DAEMON_DIR, "state.json");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const SCAN_INTERVAL_MS = 60 * 1000;
const COMPLETION_THRESHOLD_MS = 5 * 60 * 1000;
const AUTOBOOST_INTERVAL_MS = 5 * 60 * 1000;
const GIT_COMMIT_INTERVAL_MS = 60 * 60 * 1000;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEARCH_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const CLIENT_TIMEOUT_MS = 10 * 1000;
const SOCKET_READY_TIMEOUT_MS = 5000;
const SOCKET_POLL_INTERVAL_MS = 100;
const MIN_TRANSCRIPT_CHARS = 2000;
const MIN_MESSAGE_COUNT = 6;
const MAX_QUEUE_SIZE = 20;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const STATE_DEBOUNCE_MS = 5000;
const SEARCH_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SEARCH_LOG_HARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SOCKET_REQUEST_BYTES = 1024 * 1024;
const GC_IDLE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const GC_RESUME_GRACE_MS = 24 * 60 * 60 * 1000;

const USAGE = `memd — mem 기반 세션 감시 + 자동 지식 축적 데몬

Usage:
  memd start [--foreground]   데몬 시작
  memd stop                   데몬 종료
  memd status                 상태 확인
  memd search <query> [opts]  검색 (데몬 경유)
  memd boost <id>             강화 (데몬 경유)
  memd log [--lines <N>]      로그 tail (기본: 50)

Options:
  --foreground       포그라운드 실행 (디버깅용)
  --project <name>   프로젝트명 지정
  --lines <N>        로그 출력 줄 수 (기본: 50)
  --help             도움말`;

// ── Shared Utilities ──

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--foreground": opts.foreground = true; break;
      case "--project": opts.project = args[++i]; break;
      case "--lines": opts.lines = parseInt(args[++i]) || 50; break;
      default:
        if (args[i].startsWith("-")) {
          console.error(`알 수 없는 옵션: ${args[i]}`);
          process.exit(1);
        }
        positional.push(args[i]);
    }
  }
  opts.command = positional[0];
  opts.query = positional.slice(1).join(" ");
  return opts;
}

const { loadConfig, computeEffectiveScore, loadIndex, saveIndex, projectDir, globalDir, detectProject } = mem;

// ── BM25 Search (state) ──

let bm25Index = null;

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

// ── LLM & Prompts (from mem.js) ──

const { spawnLlmJson, spawnLlmText, buildSavePrompt, SUMMARY_PROMPT, buildSummaryPrompt, parseMultiTopicSummary, splitTranscript, SPLIT_THRESHOLD_CHARS, processLargeTranscript } = mem;

// ── Daemon State ──

let daemonState = null;
let stateDirty = false;
let stateTimer = null;

function defaultState() {
  return {
    processedSessions: {},
    searchLog: [],
    lastGcRun: null,
    lastGitCommit: null,
    stats: { sessionsProcessed: 0, memoriesSaved: 0, searchesServed: 0, autoBoosts: 0 },
  };
}

async function loadState() {
  try {
    daemonState = JSON.parse(await readFile(STATE_PATH, "utf-8"));
    if (!daemonState.processedSessions) daemonState.processedSessions = {};
    if (!daemonState.searchLog) daemonState.searchLog = [];
    if (!daemonState.stats) daemonState.stats = { sessionsProcessed: 0, memoriesSaved: 0, searchesServed: 0, autoBoosts: 0 };
  } catch {
    daemonState = defaultState();
  }
}

async function flushState() {
  if (!daemonState) return;
  const tmpPath = STATE_PATH + ".tmp";
  await writeFile(tmpPath, JSON.stringify(daemonState, null, 2));
  await rename(tmpPath, STATE_PATH);
  stateDirty = false;
}

function markStateDirty() {
  stateDirty = true;
  if (!stateTimer) {
    stateTimer = setTimeout(async () => {
      stateTimer = null;
      if (stateDirty) {
        try { await flushState(); } catch (e) { log(`state flush error: ${e.message}`); }
      }
    }, STATE_DEBOUNCE_MS);
  }
}

// ── Logging ──

let logStream = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (logStream) {
    logStream.write(line);
  } else {
    process.stderr.write(line);
  }
}

async function truncateLogIfNeeded() {
  try {
    const stats = await stat(LOG_PATH);
    if (stats.size > MAX_LOG_BYTES) {
      const content = await readFile(LOG_PATH, "utf-8");
      const lines = content.split("\n");
      const keepLines = lines.slice(Math.floor(lines.length / 2));
      await writeFile(LOG_PATH, keepLines.join("\n"));
    }
  } catch {}
}

// ── Processing Queue ──

const processingQueue = [];
let isProcessing = false;
let rateLimitedUntil = 0;

function enqueue(session) {
  if (processingQueue.some((s) => s.sessionId === session.sessionId)) return;
  if (processingQueue.length >= MAX_QUEUE_SIZE) return;
  processingQueue.push(session);
}

// ── Transcript Extraction ──

function extractTranscript(lines, sessionEntry) {
  const parts = [];
  const userMessages = [];
  const firstPrompt = sessionEntry.firstPrompt || "";
  const projectPath = sessionEntry.projectPath || "";
  const gitBranch = sessionEntry.gitBranch || "";
  const created = sessionEntry.created || "";
  const modified = sessionEntry.modified || "";

  parts.push(`# Session: ${firstPrompt.slice(0, 100)}`);
  parts.push(`Project: ${projectPath}`);
  if (gitBranch) parts.push(`Branch: ${gitBranch}`);
  parts.push(`Date: ${created} ~ ${modified}`);
  parts.push("");

  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    const excludedTypes = ["file-history-snapshot", "progress", "system", "queue-operation", "summary"];
    if (excludedTypes.includes(record.type)) continue;

    if (record.type === "user") {
      const message = record.message;
      if (!message || !message.content) continue;

      const contentArray = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      const textBlocks = [];

      for (const block of contentArray) {
        if (block.type === "text" && block.text) {
          const text = block.text.trim();
          if (text && !text.startsWith("[Request interrupted")) {
            textBlocks.push(text);
          }
        }
      }

      if (textBlocks.length > 0) {
        const joined = textBlocks.join("\n\n");
        parts.push("## User");
        parts.push(joined);
        parts.push("");
        userMessages.push(joined);
      }
    }

    if (record.type === "assistant") {
      const message = record.message;
      if (!message || !message.content) continue;

      const contentArray = Array.isArray(message.content) ? message.content : [];
      const textBlocks = [];

      for (const block of contentArray) {
        if (block.type === "text" && block.text) {
          textBlocks.push(block.text.trim());
        } else if (block.type === "tool_use") {
          const inputSummary = block.input && typeof block.input === "object"
            ? Object.entries(block.input)
              .filter(([key]) => ["command", "file_path", "pattern", "query", "url"].includes(key))
              .map(([, value]) => typeof value === "string" ? value.slice(0, 80) : "")
              .filter(Boolean)
              .join(", ")
            : "";
          textBlocks.push(`[Tool: ${block.name}(${inputSummary})]`);
        }
      }

      if (textBlocks.length > 0) {
        parts.push("## Assistant");
        parts.push(textBlocks.join("\n"));
        parts.push("");
      }
    }
  }

  return { transcript: parts.join("\n"), userMessages };
}

// ── Project Name Resolution ──

const gitRootCache = new Map();

function resolveProjectName(projectPath) {
  if (!projectPath) return null;
  const normalized = projectPath.replace(/\/$/, "");
  if (normalized === os.homedir()) return null;

  if (gitRootCache.has(normalized)) return gitRootCache.get(normalized);

  let result;
  try {
    const gitRoot = execSync(`git -C "${normalized}" rev-parse --show-toplevel`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    result = path.basename(gitRoot);
  } catch {
    result = path.basename(normalized);
  }

  gitRootCache.set(normalized, result);
  return result;
}

// ── Session Processing Pipeline ──

async function loadOldSummary(memoryId) {
  const locations = [path.join(globalDir(), "index.jsonl")];
  try {
    const projects = await readdir(path.join(MEM_DIR, "projects"));
    for (const p of projects) locations.push(path.join(projectDir(p), "index.jsonl"));
  } catch {}

  for (const indexPath of locations) {
    const entries = await loadIndex(indexPath);
    const entry = entries.find(e => e.id === memoryId);
    if (entry && entry.summaryFile) {
      try {
        return await readFile(path.join(path.dirname(indexPath), entry.summaryFile), "utf-8");
      } catch {}
    }
  }
  return null;
}

async function processSession(sessionEntry) {
  const { sessionId, fullPath, projectPath } = sessionEntry;

  let rawContent;
  try {
    rawContent = await readFile(fullPath, "utf-8");
  } catch (e) {
    log(`  cannot read session file ${sessionId}: ${e.message}`);
    return;
  }

  const lines = rawContent.split("\n").filter(Boolean);

  if (!sessionEntry.firstPrompt) {
    for (const line of lines.slice(0, 50)) {
      try {
        const record = JSON.parse(line);
        if (record.type === "user" && record.message?.content) {
          const content = Array.isArray(record.message.content)
            ? record.message.content.find(b => b.type === "text")?.text
            : record.message.content;
          if (content) { sessionEntry.firstPrompt = content.trim(); break; }
        }
      } catch {}
    }
  }

  log(`processing session: ${sessionId} (${sessionEntry.firstPrompt?.slice(0, 60)})`);
  const { transcript, userMessages } = extractTranscript(lines, sessionEntry);

  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    log(`  skipped: transcript too short (${transcript.length} chars)`);
    daemonState.processedSessions[sessionId] = {
      mtime: sessionEntry.fileMtime,
      processedAt: new Date().toISOString(),
      memoryId: null,
    };
    markStateDirty();
    return;
  }

  const projectName = resolveProjectName(projectPath);
  const isLarge = transcript.length >= SPLIT_THRESHOLD_CHARS;

  // Step 0: Load existing memories for reconciliation
  const existingMemories = await mem.loadActiveMemories(projectName);
  log(`  existing memories: ${existingMemories.length}`);

  let meta, topics, combinedSummary, largeParts;

  if (isLarge) {
    // ── Large transcript path: per-part summary → combined → title/tags ──
    let largeResult;
    try {
      largeResult = await processLargeTranscript(transcript, { log });
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        log("  rate limited during per-part summary, requeueing");
        rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        processingQueue.unshift(sessionEntry);
      } else {
        log(`  LLM error (per-part): ${e.message}`);
      }
      return;
    }

    largeParts = largeResult.parts;

    if (largeResult.skipped) {
      log("  skipped: all parts judged no reusable knowledge");
      daemonState.processedSessions[sessionId] = {
        mtime: sessionEntry.fileMtime,
        processedAt: new Date().toISOString(),
        memoryId: null,
      };
      daemonState.stats.sessionsProcessed++;
      markStateDirty();
      return;
    }
    combinedSummary = largeResult.combinedSummary;

    log("  extracting title/tags from combined summary...");
    try {
      const { prefix, suffix } = buildSavePrompt(existingMemories, { fromSummary: true, userMessages });
      meta = await spawnLlmJson(prefix + combinedSummary + suffix);
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        log("  rate limited, requeueing");
        rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        processingQueue.unshift(sessionEntry);
      } else {
        log(`  LLM error (title): ${e.message}`);
      }
      return;
    }
  } else {
    // ── Small transcript path: existing flow ──
    log("  extracting title/tags...");
    try {
      const { prefix, suffix } = buildSavePrompt(existingMemories);
      meta = await spawnLlmJson(prefix + transcript.slice(0, 80000) + suffix);
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        log("  rate limited, requeueing");
        rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        processingQueue.unshift(sessionEntry);
      } else {
        log(`  LLM error (title): ${e.message}`);
      }
      return;
    }
  }

  // Backward compat: convert old {title, tags} format to {topics: [{title, tags}]}
  if (meta.topics && Array.isArray(meta.topics)) {
    topics = meta.topics.filter(t => t.title && t.tags);
  } else if (meta.title && meta.tags) {
    topics = [{ title: meta.title, tags: meta.tags }];
  } else {
    log("  LLM response missing title/tags, skipping");
    return;
  }

  if (topics.length === 0) {
    log("  no valid topics found, skipping");
    return;
  }

  let validTopics, validSummaries;

  if (isLarge) {
    if (topics.length > 1 && combinedSummary) {
      // Large + multi-topic: split combined summary into per-topic summaries
      log("  splitting combined summary into per-topic summaries...");
      const oldSummaries = [];
      for (const topic of topics) {
        if (topic.updates) {
          oldSummaries.push(await loadOldSummary(topic.updates));
        } else {
          oldSummaries.push(null);
        }
      }
      try {
        const splitText = await spawnLlmText(buildSummaryPrompt(combinedSummary, topics, oldSummaries));
        const topicSummaries = parseMultiTopicSummary(splitText, topics.length);
        validTopics = [];
        validSummaries = [];
        for (let i = 0; i < topics.length; i++) {
          if (topicSummaries[i] === null) continue;
          validTopics.push(topics[i]);
          validSummaries.push(topicSummaries[i]);
        }
        if (validTopics.length === 0) {
          log("  all topics SKIPped after split");
          daemonState.processedSessions[sessionId] = {
            mtime: sessionEntry.fileMtime,
            processedAt: new Date().toISOString(),
            memoryId: null,
          };
          daemonState.stats.sessionsProcessed++;
          markStateDirty();
          return;
        }
      } catch (e) {
        if (e.message === "RATE_LIMITED") {
          log("  rate limited on topic split, requeueing");
          rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
          processingQueue.unshift(sessionEntry);
          return;
        }
        log(`  topic split failed: ${e.message}, using combined summary`);
        validTopics = topics;
        validSummaries = topics.map(() => combinedSummary);
      }
    } else {
      validTopics = topics;
      validSummaries = topics.map(() => combinedSummary);
    }
  } else {
    // Small path: generate summary via existing flow
    const oldSummaries = [];
    for (const topic of topics) {
      if (topic.updates) {
        oldSummaries.push(await loadOldSummary(topic.updates));
      } else {
        oldSummaries.push(null);
      }
    }

    log(`  generating summary (${topics.length} topic(s))...`);
    let summaryText;
    try {
      summaryText = await spawnLlmText(buildSummaryPrompt(transcript, topics, oldSummaries));
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        log("  rate limited on summary, requeueing");
        rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        processingQueue.unshift(sessionEntry);
        return;
      }
      log(`  LLM error (summary): ${e.message}, continuing without summary`);
      summaryText = null;
    }

    // Check SKIP for single-topic case
    if (topics.length === 1 && summaryText && summaryText.trim().toUpperCase().startsWith("SKIP")) {
      log("  skipped: LLM judged no reusable knowledge");
      daemonState.processedSessions[sessionId] = {
        mtime: sessionEntry.fileMtime,
        processedAt: new Date().toISOString(),
        memoryId: null,
      };
      daemonState.stats.sessionsProcessed++;
      markStateDirty();
      return;
    }

    // Parse per-topic summaries
    const topicSummaries = summaryText ? parseMultiTopicSummary(summaryText, topics.length) : topics.map(() => null);

    // Check if ALL topics were SKIPped
    if (topicSummaries.every(s => s === null) && summaryText) {
      log("  skipped: all topics judged no reusable knowledge");
      daemonState.processedSessions[sessionId] = {
        mtime: sessionEntry.fileMtime,
        processedAt: new Date().toISOString(),
        memoryId: null,
      };
      daemonState.stats.sessionsProcessed++;
      markStateDirty();
      return;
    }

    // Filter out SKIPped topics
    validTopics = [];
    validSummaries = [];
    for (let i = 0; i < topics.length; i++) {
      if (topicSummaries[i] === null && summaryText) continue;
      validTopics.push(topics[i]);
      validSummaries.push(topicSummaries[i]);
    }

    if (validTopics.length === 0) {
      log("  all topics filtered out after SKIP check");
      daemonState.processedSessions[sessionId] = {
        mtime: sessionEntry.fileMtime,
        processedAt: new Date().toISOString(),
        memoryId: null,
      };
      daemonState.stats.sessionsProcessed++;
      markStateDirty();
      return;
    }
  }

  // Step 3: Determine scope and save
  // projectPath에서 프로젝트가 감지되면 LLM의 scope 판단보다 우선
  const effectiveProjectName = projectName || meta.projectName || null;
  const scope = !effectiveProjectName ? "global" : "project";

  // Step 4: Split valid topics into new vs update
  const newTopics = [];
  const newSummaries = [];
  const updateTopics = [];
  const updateSummaries = [];

  for (let i = 0; i < validTopics.length; i++) {
    if (validTopics[i].updates) {
      updateTopics.push(validTopics[i]);
      updateSummaries.push(validSummaries[i]);
    } else {
      newTopics.push(validTopics[i]);
      newSummaries.push(validSummaries[i]);
    }
  }

  // Step 5a: Update existing topics first (fallback adds to newTopics)
  const updatedEntries = [];
  for (let i = 0; i < updateTopics.length; i++) {
    const topic = updateTopics[i];
    const result = await mem.updateMemory(topic.updates, {
      title: topic.title,
      tags: topic.tags,
      summary: updateSummaries[i],
      updateReason: topic.updateReason,
      sessionId,
    });
    if (result) {
      updatedEntries.push(result);
      mem.addToSearchIndex(bm25Index, result.entry, result.baseDir, updateSummaries[i] || "");
      log(`  updated: "${result.entry.id}" — ${topic.updateReason || "no reason"}`);
    } else {
      log(`  update target not found: "${topic.updates}", saving as new`);
      newTopics.push(topic);
      newSummaries.push(updateSummaries[i]);
    }
  }

  // Step 5b: Save new topics (includes fallback from failed updates)
  let savedEntries = [];
  let baseDir = null;
  if (newTopics.length > 0) {
    let partsCount = 1;
    if (isLarge && largeParts) {
      baseDir = scope === "project" ? projectDir(effectiveProjectName) : globalDir();
      const originalsDir = path.join(baseDir, "originals");
      await mkdir(originalsDir, { recursive: true });
      partsCount = largeParts.length;
      for (let i = 0; i < largeParts.length; i++) {
        await writeFile(path.join(originalsDir, `${sessionId}.part${i + 1}.md`), largeParts[i] + "\n");
      }
      log(`  split into ${partsCount} parts`);
    }

    const result = await mem.saveMemory({
      scope,
      projectName: effectiveProjectName,
      memoryId: sessionId,
      topics: newTopics,
      content: transcript,
      summaries: newSummaries,
      partsCount,
      sourceSessionId: sessionId,
    });
    savedEntries = result.entries;
    baseDir = result.baseDir;

    for (let i = 0; i < savedEntries.length; i++) {
      mem.addToSearchIndex(bm25Index, savedEntries[i], baseDir, newSummaries[i] || "");
      log(`  new: "${savedEntries[i].title}"`);
    }
  }

  // Step 5c: Post-save conflict reconciliation
  const allSaved = [...savedEntries, ...updatedEntries.map(r => r.entry)];
  if (allSaved.length > 0) {
    let reconcileResults = [];
    try {
      reconcileResults = await mem.reconcileMemories(allSaved, effectiveProjectName, { bm25Index, log });
      for (const r of reconcileResults) log(`  reconcile: ${r.judgment} ${r.candidateId} — ${r.reason}`);
      if (reconcileResults.some(r => r.judgment !== "INDEPENDENT")) {
        bm25Index = await mem.buildSearchIndex();
      }
    } catch (e) {
      log(`  reconcile error: ${e.message}`);
      reconcileResults = [];
    }

  }

  // Step 6: Update state
  const allIds = [
    ...savedEntries.map(e => e.id),
    ...updatedEntries.map(r => r.entry.id),
  ];

  daemonState.processedSessions[sessionId] = {
    mtime: sessionEntry.fileMtime,
    processedAt: new Date().toISOString(),
    memoryId: allIds.length === 1 ? allIds[0] : allIds,
  };
  daemonState.stats.sessionsProcessed++;
  daemonState.stats.memoriesSaved += allIds.length;
  markStateDirty();

  const scopeLabel = scope === "project" ? `project(${effectiveProjectName})` : "global";
  log(`  saved: ${allIds.join(", ")} [${scopeLabel}] (${newTopics.length} new, ${updateTopics.length} updated)`);
}

async function processQueue() {
  if (isProcessing) return;
  if (processingQueue.length === 0) return;

  isProcessing = true;
  try {
    while (processingQueue.length > 0) {
      if (Date.now() < rateLimitedUntil) {
        log(`rate limited, waiting until ${new Date(rateLimitedUntil).toISOString()}`);
        break;
      }
      const session = processingQueue.shift();
      try {
        await processSession(session);
      } catch (e) {
        log(`process error: ${e.message}`);
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ── Session Scanning ──

async function scanSessions() {
  let projectDirs;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return;
  }

  const candidates = [];
  const now = Date.now();

  for (const dir of projectDirs) {
    const projectDirPath = path.join(CLAUDE_PROJECTS_DIR, dir);

    // sessions-index.json은 메타데이터 보조용 lookup
    const indexPath = path.join(projectDirPath, "sessions-index.json");
    const indexMap = new Map();
    let projectPath = null;
    try {
      const indexData = JSON.parse(await readFile(indexPath, "utf-8"));
      projectPath = indexData.originalPath || null;
      for (const entry of (indexData.entries || [])) {
        if (entry.sessionId) indexMap.set(entry.sessionId, entry);
      }
    } catch {}

    // .jsonl 파일 직접 스캔 (단일 소스)
    let files;
    try {
      files = await readdir(projectDirPath);
    } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(".jsonl", "");
      const fullPath = path.join(projectDirPath, file);
      const indexed = indexMap.get(sessionId);

      let mtime;
      if (indexed) {
        mtime = indexed.fileMtime || 0;
        if (indexed.messageCount < MIN_MESSAGE_COUNT) continue;
      } else {
        let fileStat;
        try { fileStat = await stat(fullPath); } catch { continue; }
        mtime = fileStat.mtimeMs;
        if (fileStat.size < 2000) continue;
      }

      if (now - mtime < COMPLETION_THRESHOLD_MS) continue;

      const processed = daemonState.processedSessions[sessionId];
      if (processed && processed.mtime === mtime) continue;

      candidates.push(indexed || {
        sessionId,
        fullPath,
        fileMtime: mtime,
        projectPath,
        firstPrompt: null,
        messageCount: MIN_MESSAGE_COUNT,
        created: null,
        modified: new Date(mtime).toISOString(),
      });
    }
  }

  // 시간순 정렬 (오래된 세션 먼저 처리 → 설계→구현 순서 보장)
  candidates.sort((a, b) => (a.fileMtime || 0) - (b.fileMtime || 0));

  const beforeSize = processingQueue.length;
  for (const entry of candidates) {
    enqueue(entry);
  }
  const queued = processingQueue.length - beforeSize;

  if (queued > 0) {
    log(`scan: ${candidates.length} candidates, enqueued ${queued} (queue: ${processingQueue.length})`);
  }
}

// ── Search (daemon-side) ──

async function handleSearch(params) {
  const query = (params.query || "");
  const projectName = params.project || null;
  const topK = params.topK || 10;

  if (!bm25Index) bm25Index = await mem.buildSearchIndex();

  const results = await mem.searchMemories(query, { project: projectName, topK, bm25Index });

  daemonState.searchLog.push({
    query: params.query,
    resultIds: results.map(m => m.id),
    project: projectName,
    timestamp: new Date().toISOString(),
    boosted: false,
  });
  daemonState.stats.searchesServed++;
  markStateDirty();

  return results;
}

// ── Boost (daemon-side) ──

async function handleBoost(params) {
  return mem.boostMemory(params.id, params.project || null);
}

// ── Auto-Boost ──

async function runAutoBoost() {
  if (daemonState.searchLog.length === 0) return;

  const now = Date.now();
  const recentCutoff = now - AUTOBOOST_INTERVAL_MS * 2;
  let boosted = 0;

  // Only check sessions processed since the last boost cycle
  for (const [sessionId, info] of Object.entries(daemonState.processedSessions)) {
    const processedAt = new Date(info.processedAt).getTime();
    if (processedAt < recentCutoff) continue;

    // memoryId can be a string or an array (multi-topic)
    const memoryIds = info.memoryId
      ? (Array.isArray(info.memoryId) ? info.memoryId : [info.memoryId])
      : null;
    if (!memoryIds) continue;

    // Find the session entry to get project and time range
    const sessionEntry = await findSessionEntry(sessionId);
    if (!sessionEntry) continue;

    const sessionCreated = new Date(sessionEntry.created).getTime();
    const sessionModified = new Date(sessionEntry.modified).getTime();

    // Find search logs that happened during this session's timeframe
    const relevantSearches = daemonState.searchLog.filter((sl) => {
      if (sl.boosted) return false;
      const searchTime = new Date(sl.timestamp).getTime();
      return searchTime >= sessionCreated && searchTime <= sessionModified;
    });

    if (relevantSearches.length === 0) continue;

    // Read the session transcript to check if search results were used
    let sessionContent;
    try {
      sessionContent = (await readFile(sessionEntry.fullPath, "utf-8")).toLowerCase();
    } catch {
      continue;
    }

    for (const search of relevantSearches) {
      for (const resultId of search.resultIds) {
        // Check if the result ID or related title keywords appear in the session
        const titleKeywords = await getMemoryTitleKeywords(resultId);
        const used = titleKeywords.some((kw) => sessionContent.includes(kw.toLowerCase()))
          || sessionContent.includes(resultId.toLowerCase());

        if (used) {
          try {
            await handleBoost({ id: resultId, project: search.project });
            search.boosted = true;
            daemonState.stats.autoBoosts++;
            boosted++;
            log(`auto-boosted: ${resultId}`);
          } catch {}
        }
      }
    }
  }

  if (boosted > 0) {
    markStateDirty();
    log(`auto-boost: boosted ${boosted} memories`);
  }
}

async function findSessionEntry(sessionId) {
  let projectDirs;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dir of projectDirs) {
    const indexPath = path.join(CLAUDE_PROJECTS_DIR, dir, "sessions-index.json");
    try {
      const indexData = JSON.parse(await readFile(indexPath, "utf-8"));
      const entry = indexData.entries?.find((e) => e.sessionId === sessionId);
      if (entry) return entry;
    } catch {}
  }
  return null;
}

async function getMemoryTitleKeywords(memoryId) {
  // Search all indexes for this memory
  const locations = [path.join(globalDir(), "index.jsonl")];
  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const project of projects) {
      locations.push(path.join(projectDir(project), "index.jsonl"));
    }
  } catch {}

  for (const indexPath of locations) {
    const entries = await loadIndex(indexPath);
    const entry = entries.find((e) => e.id === memoryId);
    if (entry) {
      // Extract significant keywords from title (skip common words)
      return entry.title.split(/[\s:,→↔]+/).filter((w) => w.length > 2);
    }
  }
  return [];
}

// ── Periodic Tasks ──

async function runGitCommit() {
  try {
    execSync("git add -A && git diff --cached --quiet || git commit -m 'auto-commit by memd'", {
      cwd: MEM_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    daemonState.lastGitCommit = new Date().toISOString();
    markStateDirty();
    log("git commit completed");
  } catch (e) {
    // Check if git is initialized
    try {
      execSync("git rev-parse --git-dir", { cwd: MEM_DIR, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      try {
        execSync("git init", { cwd: MEM_DIR, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        log("git init in ~/.mem/");
      } catch {}
    }
  }
}

function getLastActivityTime() {
  let latest = 0;
  for (const info of Object.values(daemonState.processedSessions)) {
    const t = new Date(info.processedAt).getTime();
    if (t > latest) latest = t;
  }
  return latest;
}

async function runGc() {
  const now = Date.now();
  const lastActivity = getLastActivityTime();

  if (lastActivity > 0 && (now - lastActivity) > GC_IDLE_THRESHOLD_MS) {
    log("gc: skipped (idle — no sessions processed in 7+ days)");
    return;
  }

  if (lastActivity > 0 && (now - lastActivity) < GC_RESUME_GRACE_MS) {
    const idleBeforeResume = (() => {
      const times = Object.values(daemonState.processedSessions)
        .map(info => new Date(info.processedAt).getTime())
        .sort((a, b) => b - a);
      if (times.length < 2) return 0;
      return times[0] - times[1];
    })();
    if (idleBeforeResume > GC_IDLE_THRESHOLD_MS) {
      log("gc: skipped (grace period — recently resumed after long idle)");
      return;
    }
  }

  const result = await mem.gcMemories();

  daemonState.lastGcRun = new Date().toISOString();
  markStateDirty();

  if (result.archived > 0) {
    log(`gc: archived ${result.archived} decayed memories`);
  }
}

function cleanSearchLog() {
  const cutoff = Date.now() - SEARCH_LOG_MAX_AGE_MS;
  const hardCutoff = Date.now() - SEARCH_LOG_HARD_MAX_AGE_MS;
  const before = daemonState.searchLog.length;
  daemonState.searchLog = daemonState.searchLog.filter((sl) => {
    const time = new Date(sl.timestamp).getTime();
    if (time <= hardCutoff) return false;
    return time > cutoff || !sl.boosted;
  });
  const removed = before - daemonState.searchLog.length;
  if (removed > 0) {
    markStateDirty();
    log(`search log cleanup: removed ${removed} entries`);
  }
}

// ── Socket Server (Daemon) ──

let socketServer = null;

function startSocketServer() {
  return new Promise((resolve, reject) => {
    socketServer = net.createServer((conn) => {
      let data = "";
      conn.on("data", (chunk) => {
        data += chunk;
        if (data.length > MAX_SOCKET_REQUEST_BYTES) {
          conn.end(JSON.stringify({ id: null, ok: false, error: "request too large" }) + "\n");
          return;
        }
        const newlineIndex = data.indexOf("\n");
        if (newlineIndex !== -1) {
          const requestLine = data.slice(0, newlineIndex);
          handleSocketRequest(requestLine, conn);
        }
      });
      conn.on("error", () => {});
    });

    socketServer.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        try { fs.unlinkSync(SOCK_PATH); } catch {}
        socketServer.listen(SOCK_PATH, () => resolve());
      } else {
        reject(e);
      }
    });

    socketServer.listen(SOCK_PATH, () => resolve());
  });
}

async function handleSocketRequest(line, conn) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    conn.end(JSON.stringify({ id: null, ok: false, error: "invalid JSON" }) + "\n");
    return;
  }

  const { id, method, params } = request;

  try {
    let result;
    switch (method) {
      case "search":
        result = await handleSearch(params || {});
        break;
      case "boost":
        result = await handleBoost(params || {});
        break;
      case "status":
        result = {
          pid: process.pid,
          uptime: Math.floor(process.uptime()),
          queue: processingQueue.length,
          processing: isProcessing,
          ...daemonState.stats,
        };
        break;
      case "shutdown":
        conn.end(JSON.stringify({ id, ok: true }) + "\n");
        gracefulShutdown();
        return;
      default:
        conn.end(JSON.stringify({ id, ok: false, error: `unknown method: ${method}` }) + "\n");
        return;
    }
    conn.end(JSON.stringify({ id, ok: true, data: result }) + "\n");
  } catch (e) {
    conn.end(JSON.stringify({ id, ok: false, error: e.message }) + "\n");
  }
}

// ── Daemon Lifecycle ──

let intervals = [];

async function startDaemon(foreground) {
  await mkdir(DAEMON_DIR, { recursive: true });
  await cleanStaleFiles();

  if (!foreground) {
    // Spawn self as detached background process
    await truncateLogIfNeeded();
    const logFd = fs.openSync(LOG_PATH, "a");
    const child = spawn(process.execPath, [__filename, "start", "--foreground"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);

    // Write PID and exit
    await writeFile(PID_PATH, String(child.pid));
    console.log(`memd started (pid: ${child.pid})`);
    process.exit(0);
  }

  // Foreground mode: run the daemon loop
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

  await writeFile(PID_PATH, String(process.pid));
  await loadState();
  bm25Index = await mem.buildSearchIndex();
  log(`BM25 index built: ${bm25Index.docs.length} documents`);

  log("daemon starting...");

  // Start socket server
  await startSocketServer();
  log(`socket listening: ${SOCK_PATH}`);

  // Signal handlers
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  // Scan timer — only adds to queue, never blocks on processing
  const scanTimer = setInterval(async () => {
    try { await scanSessions(); } catch (e) { log(`scan error: ${e.message}`); }
  }, SCAN_INTERVAL_MS);
  intervals.push(scanTimer);

  const boostTimer = setInterval(async () => {
    try { await runAutoBoost(); } catch (e) { log(`auto-boost error: ${e.message}`); }
  }, AUTOBOOST_INTERVAL_MS);
  intervals.push(boostTimer);

  const gitTimer = setInterval(async () => {
    try { await runGitCommit(); } catch (e) { log(`git commit error: ${e.message}`); }
  }, GIT_COMMIT_INTERVAL_MS);
  intervals.push(gitTimer);

  const gcTimer = setInterval(async () => {
    try { await runGc(); } catch (e) { log(`gc error: ${e.message}`); }
  }, GC_INTERVAL_MS);
  intervals.push(gcTimer);

  const cleanupTimer = setInterval(() => {
    try { cleanSearchLog(); } catch (e) { log(`search log cleanup error: ${e.message}`); }
  }, SEARCH_LOG_CLEANUP_INTERVAL_MS);
  intervals.push(cleanupTimer);

  // Initial scan — populate queue before processing loop starts
  try { await scanSessions(); } catch (e) { log(`initial scan error: ${e.message}`); }

  log(`daemon ready (${processingQueue.length} sessions queued)`);

  // Processing loop — runs independently, drains queue then sleeps
  (async function processingLoop() {
    while (true) {
      try { await processQueue(); } catch (e) { log(`process loop error: ${e.message}`); }
      await new Promise((r) => setTimeout(r, processingQueue.length > 0 ? 1000 : 10000));
    }
  })();
}

async function gracefulShutdown() {
  log("shutting down...");

  for (const timer of intervals) clearInterval(timer);
  intervals = [];
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }

  if (stateDirty) {
    try { await flushState(); } catch {}
  }

  if (socketServer) {
    socketServer.close();
    try { await unlink(SOCK_PATH); } catch {}
  }

  try { await unlink(PID_PATH); } catch {}

  log("daemon stopped");
  if (logStream) logStream.end();
  process.exit(0);
}

async function stopDaemon() {
  const pid = await readPid();
  if (!pid) {
    console.log("memd is not running");
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log("memd is not running (stale PID)");
    await cleanStaleFiles();
    return;
  }

  process.kill(pid, "SIGTERM");
  console.log(`memd stopped (pid: ${pid})`);
}

async function showStatus() {
  // Try connecting to daemon socket first
  try {
    const result = await socketRequest({ method: "status", params: {} });
    console.log(`pid:        ${result.pid}`);
    console.log(`uptime:     ${formatUptime(result.uptime)}`);
    console.log(`queue:      ${result.queue}`);
    console.log(`processing: ${result.processing}`);
    console.log(`sessions:   ${result.sessionsProcessed}`);
    console.log(`memories:   ${result.memoriesSaved}`);
    console.log(`searches:   ${result.searchesServed}`);
    console.log(`boosts:     ${result.autoBoosts}`);
  } catch {
    const pid = await readPid();
    if (pid && isProcessAlive(pid)) {
      console.log(`pid: ${pid} (socket not responding)`);
    } else {
      console.log("memd is not running");
    }
  }
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

async function showLog(lines) {
  const count = lines || 50;
  try {
    const content = await readFile(LOG_PATH, "utf-8");
    const allLines = content.trim().split("\n");
    const tail = allLines.slice(-count);
    console.log(tail.join("\n"));
  } catch {
    console.log("로그 파일 없음");
  }
}

// ── Client Mode ──

const socketRequest = createSocketClient(SOCK_PATH, CLIENT_TIMEOUT_MS);

async function ensureDaemon() {
  // Try connecting to socket
  try {
    await socketRequest({ method: "status", params: {} });
    return;
  } catch (e) {
    if (e.code !== "ECONNREFUSED" && e.code !== "ENOENT" && e.message !== "TIMEOUT") {
      throw e;
    }
  }

  // Clean stale files and start daemon
  await cleanStaleFiles();

  await mkdir(DAEMON_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [__filename, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(child.pid));

  // Wait for socket to be ready
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "status", params: {} });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
    }
  }

  throw new Error("daemon failed to start");
}

async function clientSearch(opts) {
  await ensureDaemon();

  const project = opts.project || detectProject();
  const results = await socketRequest({
    method: "search",
    params: { query: opts.query, project },
  });

  if (!results || results.length === 0) {
    console.log("검색 결과 없음");
    return;
  }

  for (const result of results) {
    const boostLabel = result.boostCount > 0 ? ` (${result.boostCount}회 강화)` : "";
    console.log(`[${result.score.toFixed(2)}] ${result.title}${boostLabel}`);
    console.log(`       ${result.file}`);
    console.log();
  }
}

async function clientBoost(opts) {
  await ensureDaemon();

  const project = opts.project || detectProject();
  const result = await socketRequest({
    method: "boost",
    params: { id: opts.query, project },
  });

  console.log(`boosted ${result.id} → boostCount: ${result.boostCount}`);
  console.log(`title: ${result.title}`);
}

// ── Main ──

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.command) {
    console.log(USAGE);
    process.exit(1);
  }

  await mkdir(DAEMON_DIR, { recursive: true });

  switch (opts.command) {
    case "start":
      await startDaemon(opts.foreground);
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status":
      await showStatus();
      break;
    case "log":
      await showLog(opts.lines);
      break;
    case "search":
      if (!opts.query) { console.error("검색어 필수"); process.exit(1); }
      await clientSearch(opts);
      break;
    case "boost":
      if (!opts.query) { console.error("기억 ID 필수"); process.exit(1); }
      await clientBoost(opts);
      break;
    default:
      console.error(`알 수 없는 커맨드: ${opts.command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
