const path = require("path");
const os = require("os");

const UCM_DIR = process.env.UCM_DIR || path.join(os.homedir(), ".ucm");
const FORGE_DIR = path.join(UCM_DIR, "forge");
const TASKS_DIR = path.join(UCM_DIR, "tasks");
const WORKTREES_DIR = path.join(UCM_DIR, "worktrees");
const ARTIFACTS_DIR = path.join(UCM_DIR, "artifacts");
const LOGS_DIR = path.join(UCM_DIR, "logs");
const DAEMON_DIR = path.join(UCM_DIR, "daemon");
const TEMPLATES_DIR = path.join(__dirname, "..", "..", "templates");

const SOCK_PATH = path.join(DAEMON_DIR, "ucm.sock");
const PID_PATH = path.join(DAEMON_DIR, "ucmd.pid");
const LOG_PATH = path.join(DAEMON_DIR, "ucmd.log");

const RATE_LIMIT_RE = /rate.limit|429|quota|overloaded/i;

const FORGE_PIPELINES = {
  trivial: ["implement", "verify", "deliver"],
  small: ["design", "implement", "verify", "deliver"],
  medium: ["clarify", "specify", "design", "implement", "verify", "ux-review", "polish", "deliver"],
  large: ["clarify", "specify", "decompose", "design", "implement", "verify", "ux-review", "polish", "integrate", "deliver"],
};

const POLISH_CONFIG = {
  defaultLenses: ["code_quality", "design_consistency", "testing", "security"],
  maxRoundsPerLens: 5,
  maxTotalRounds: 15,
  convergenceThreshold: 2,
};

// 각 stage의 입력/출력 artifact 및 반환 스키마 정의
// 모든 stage는 { tokenUsage: { input, output } }를 반환해야 함
// stage-specific 필드: intake: { complexity, title }, verify: { passed, feedback, report }
const STAGE_ARTIFACTS = {
  intake:    { requires: [],                        produces: ["task.md", "intake.json"] },
  clarify:   { requires: ["task.md"],               produces: ["decisions.md", "decisions.json"] },
  specify:   { requires: ["decisions.json"],         produces: ["spec.md"] },
  decompose: { requires: ["spec.md"],               produces: ["tasks.json"] },
  design:    { requires: ["task.md"],               produces: ["design.md"] },
  implement: { requires: ["design.md"],             produces: [] },
  verify:    { requires: [],                        produces: ["verify.json"] },
  "ux-review": { requires: [],                      produces: ["ux-review.json"] },
  polish:    { requires: [],                          produces: ["polish-summary.json"] },
  integrate: { requires: [],                        produces: ["integrate-result.json"] },
  deliver:   { requires: [],                        produces: ["summary.md"] },
};

const STAGE_TIMEOUTS = {
  intake:    { idle: 2 * 60_000, hard: 5 * 60_000 },
  clarify:   { idle: 3 * 60_000, hard: 10 * 60_000 },
  specify:   { idle: 3 * 60_000, hard: 15 * 60_000 },
  decompose: { idle: 3 * 60_000, hard: 10 * 60_000 },
  design:    { idle: 5 * 60_000, hard: 20 * 60_000 },
  implement: { idle: 8 * 60_000, hard: 45 * 60_000 },
  verify:    { idle: 5 * 60_000, hard: 20 * 60_000 },
  "ux-review": { idle: 5 * 60_000, hard: 15 * 60_000 },
  polish:    { idle: 8 * 60_000, hard: 60 * 60_000 },
  integrate: { idle: 5 * 60_000, hard: 20 * 60_000 },
  deliver:   { idle: 2 * 60_000, hard: 5 * 60_000 },
};

const _DEFAULT_MODELS = {
  intake: "sonnet",
  clarify: "sonnet",
  specify: { worker: "sonnet", converge: "opus" },
  decompose: "opus",
  design: "opus",
  implement: "opus",
  verify: "sonnet",
  "ux-review": "sonnet",
  polish: { review: "sonnet", fix: "opus" },
  integrate: "opus",
  deliver: "sonnet",
};

// UCM_MODEL_<STAGE> 환경변수로 override 가능 (예: UCM_MODEL_IMPLEMENT=sonnet)
// 객체 타입(specify)은 UCM_MODEL_SPECIFY_WORKER, UCM_MODEL_SPECIFY_CONVERGE로 개별 override
const _modelCache = new Map();
const STAGE_MODELS = new Proxy(_DEFAULT_MODELS, {
  get(target, prop) {
    const defaultVal = target[prop];
    if (defaultVal === undefined) return defaultVal;
    const propUpper = String(prop).toUpperCase();

    // 객체 타입 (예: specify: { worker, converge })
    if (defaultVal && typeof defaultVal === "object" && !Array.isArray(defaultVal)) {
      // 환경변수 값을 포함한 캐시 키 생성
      const envVals = Object.keys(defaultVal).map((k) => process.env[`UCM_MODEL_${propUpper}_${k.toUpperCase()}`] || "").join(",");
      const cacheKey = `${prop}:${envVals}`;
      if (_modelCache.has(cacheKey)) return _modelCache.get(cacheKey);

      const overridden = { ...defaultVal };
      for (const subKey of Object.keys(defaultVal)) {
        const envKey = `UCM_MODEL_${propUpper}_${subKey.toUpperCase()}`;
        const envVal = process.env[envKey];
        if (envVal) overridden[subKey] = envVal;
      }
      Object.freeze(overridden);
      _modelCache.set(cacheKey, overridden);
      return overridden;
    }

    // 단일 문자열 타입
    const envKey = `UCM_MODEL_${propUpper}`;
    const envVal = process.env[envKey];
    if (envVal) return envVal;
    return defaultVal;
  },
});

const MAX_CONCURRENT_TASKS = parseInt(process.env.UCM_MAX_CONCURRENT || "3", 10);
const DEFAULT_TOKEN_BUDGET = parseInt(process.env.UCM_TOKEN_BUDGET || "0", 10);

module.exports = {
  UCM_DIR, FORGE_DIR, TASKS_DIR, WORKTREES_DIR, ARTIFACTS_DIR, LOGS_DIR, DAEMON_DIR,
  TEMPLATES_DIR, SOCK_PATH, PID_PATH, LOG_PATH,
  RATE_LIMIT_RE,
  FORGE_PIPELINES, STAGE_TIMEOUTS, STAGE_MODELS, STAGE_ARTIFACTS, POLISH_CONFIG,
  MAX_CONCURRENT_TASKS, DEFAULT_TOKEN_BUDGET,
};
