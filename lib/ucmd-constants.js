const path = require("path");
const os = require("os");

// ── Directory Constants ──

const UCM_DIR = process.env.UCM_DIR || path.join(os.homedir(), ".ucm");
const TASKS_DIR = path.join(UCM_DIR, "tasks");
const WORKTREES_DIR = path.join(UCM_DIR, "worktrees");
const WORKSPACES_DIR = path.join(UCM_DIR, "workspaces");
const ARTIFACTS_DIR = path.join(UCM_DIR, "artifacts");
const LOGS_DIR = path.join(UCM_DIR, "logs");
const DAEMON_DIR = path.join(UCM_DIR, "daemon");
const LESSONS_DIR = path.join(UCM_DIR, "lessons");
const PROPOSALS_DIR = path.join(UCM_DIR, "proposals");
const AUTOPILOT_DIR = path.join(UCM_DIR, "autopilot");
const SNAPSHOTS_DIR = path.join(UCM_DIR, "snapshots");
const CONFIG_PATH = path.join(UCM_DIR, "config.json");

const SOCK_PATH = path.join(DAEMON_DIR, "ucm.sock");
const PID_PATH = path.join(DAEMON_DIR, "ucmd.pid");
const LOG_PATH = path.join(DAEMON_DIR, "ucmd.log");
const STATE_PATH = path.join(DAEMON_DIR, "state.json");

// ── Task & Meta Constants ──

const TASK_STATES = ["pending", "running", "review", "done", "failed"];
const META_KEYS = new Set([
  "id", "title", "status", "priority", "created", "startedAt", "completedAt",
  "project", "projects", "feedback", "currentStage", "pipeline",
  "suspended", "suspendedStage", "suspendedStepIndex",

  "refined",
  "autopilotSession",
]);

// ── Timing Constants ──

const STATE_DEBOUNCE_MS = 5000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_SOCKET_REQUEST_BYTES = 1024 * 1024;
const SOCKET_READY_TIMEOUT_MS = 5000;
const SOCKET_POLL_INTERVAL_MS = 100;
const CLIENT_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_WAIT_MS = 10 * 1000;

const QUOTA_PROBE_INITIAL_MS = 5 * 60 * 1000;
const QUOTA_PROBE_MAX_MS = 30 * 60 * 1000;

// ── Template & Usage ──

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

const USAGE = `ucmd — UCM 데몬

Usage:
  ucmd start [--foreground]   데몬 시작
  ucmd stop                   데몬 종료
  ucmd --foreground           포그라운드 실행

Options:
  --foreground       포그라운드 실행 (디버깅용)
  --dev              프론트엔드 개발 모드 (ucm-ui.js 매 요청 리로드)
  --help             도움말`;

// ── Pipeline & Proposal Constants ──

const GATE_STEPS = new Set(["test", "self-review", "visual-check"]);
const PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "implemented"];
const VALID_CATEGORIES = new Set([
  "template", "core", "config", "test",
  "bugfix", "ux", "architecture", "performance", "docs", "research",
]);
const VALID_RISKS = new Set(["low", "medium", "high"]);

// ── Data & Source Constants ──

const DATA_VERSION = 1;
const SOURCE_ROOT = path.resolve(__dirname, "..");

// ── Default Config ──

const DEFAULT_CONFIG = {
  concurrency: 1,
  provider: "claude",
  model: "opus",
  scanIntervalMs: 10000,
  pipeline: ["analyze", "implement"],
  pipelines: {
    quick: ["analyze", "implement"],
    implement: ["analyze", { loop: ["implement", "test", "self-review"], maxIterations: 3 }],
    research: [{ rsa: "research", count: 3, strategy: "converge" }],
    thorough: ["analyze", { loop: ["implement", "test", { rsa: "self-review", count: 3, strategy: "converge" }], maxIterations: 3 }],
  },
  defaultPipeline: "quick",
  stageTimeoutMs: 30 * 60 * 1000,
  httpPort: 17171,
  uiPort: 17172,
  resources: {
    cpuThreshold: 0.8,
    memoryMinFreeMb: 2048,
    diskMinFreeGb: 5,
    checkIntervalMs: 30000,
  },
  cleanup: {
    retentionDays: 7,
    autoCleanOnDiskPressure: true,
  },
  quota: {
    source: "ccusage",
    mode: "work",
    modes: {
      work: { windowBudgetPercent: 50 },
      off: { windowBudgetPercent: 90 },
    },
    softLimitPercent: 80,
    hardLimitPercent: 95,
  },
  infra: {
    slots: 1,
    composeFile: "docker-compose.test.yml",
    upTimeoutMs: 60000,
    downAfterTest: true,
    browserSlots: 1,
  },
  observer: {
    enabled: true,
    intervalMs: 14400000,
    taskCountTrigger: 10,
    maxProposalsPerCycle: 5,
    dataWindowDays: 7,
    proposalRetentionDays: 30,
    perspectives: ["functionality", "ux_usability", "architecture", "quality", "docs_vision"],
    researchEnabled: true,
    researchAfterReleases: 2,
  },
  selfImprove: {
    enabled: false,
    maxRisk: "low",
    maxIterations: 5,
    requireAllTestLayers: true,
    requireHumanApproval: true,
    backupBranch: true,
    testTimeoutMs: 300000,
  },
  regulator: {
    enabled: true,
    maxRiskForAutoApprove: "low",
    blockRecentlyFailed: true,
    recentFailedWindowDays: 30,
    blockHighRiskCore: true,
  },
  autopilot: {
    releaseEvery: 4,
    maxConsecutiveFailures: 3,
    maxItemsPerSession: 50,
    reviewRetries: 2,
    maxIterations: 5,
    requireHumanApproval: true,
    reviewTimeoutMs: 30 * 60 * 1000,
    testTimeoutMs: 300000,
    forgePipeline: "small",
    itemMix: {
      feature: 0.4,
      refactor: 0.25,
      docs: 0.15,
      test: 0.2,
    },
  },
};

// ── Misc Constants ──

const MAX_SNAPSHOTS = 30;
const RATE_LIMIT_RE = /rate.limit|429|quota|overloaded/i;

module.exports = {
  UCM_DIR, TASKS_DIR, WORKTREES_DIR, WORKSPACES_DIR, ARTIFACTS_DIR, LOGS_DIR, DAEMON_DIR,
  LESSONS_DIR, PROPOSALS_DIR, AUTOPILOT_DIR, SNAPSHOTS_DIR, CONFIG_PATH,
  SOCK_PATH, PID_PATH, LOG_PATH, STATE_PATH,
  TASK_STATES, META_KEYS,
  STATE_DEBOUNCE_MS, MAX_LOG_BYTES, MAX_SOCKET_REQUEST_BYTES,
  SOCKET_READY_TIMEOUT_MS, SOCKET_POLL_INTERVAL_MS, CLIENT_TIMEOUT_MS, SHUTDOWN_WAIT_MS,
  QUOTA_PROBE_INITIAL_MS, QUOTA_PROBE_MAX_MS,
  TEMPLATES_DIR, USAGE,
  GATE_STEPS, PROPOSAL_STATUSES, VALID_CATEGORIES, VALID_RISKS,
  DATA_VERSION, SOURCE_ROOT,
  DEFAULT_CONFIG,
  MAX_SNAPSHOTS, RATE_LIMIT_RE,
};
