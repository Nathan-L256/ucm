const { spawn } = require("child_process");
const { RATE_LIMIT_RE } = require("./constants");

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 5000;

// 자식 프로세스에 전달할 환경변수 화이트리스트
const ENV_ALLOWED_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "HOSTNAME", "LOGNAME",
  "EDITOR", "VISUAL", "DISPLAY", "TMPDIR", "TMP", "TEMP",
  "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME", "ANDROID_HOME",
  "VIRTUAL_ENV", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);
const ENV_ALLOWED_PREFIXES = [
  "LC_", "NODE_", "NPM_", "NVM_", "GIT_", "XDG_", "SSH_", "GPG_",
  "UCM_", "CONDA_", "PYENV_", "DBUS_",
];

function sanitizeEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_ALLOWED_EXACT.has(key) || ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }
  return env;
}

function killPidTree(pid) {
  if (!pid || pid <= 0) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  try { process.kill(pid, "SIGTERM"); } catch {}
  const fallback = setTimeout(() => {
    try { process.kill(pid, 0); } catch { return; }
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }, 1200);
  fallback.unref();
}

// Provider registry: 새 provider 추가 시 여기에 등록
const PROVIDERS = {
  claude: {
    buildArgs({ model, outputFormat, allowTools, skipPermissions, sessionPersistence, cwd }) {
      const args = ["-p"];
      if (skipPermissions) args.push("--dangerously-skip-permissions");
      if (!sessionPersistence) args.push("--no-session-persistence");
      args.push("--output-format", outputFormat || "text");
      if (model) args.push("--model", model);
      if (allowTools !== undefined) args.push("--allowedTools", allowTools);
      return { cmd: "claude", args, cwd };
    },
  },
  codex: {
    buildArgs({ model, cwd }) {
      const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
      if (model && REASONING_EFFORTS.has(model)) {
        args.push("-c", `model_reasoning_effort=${model}`);
      } else if (model) {
        args.push("--model", model);
      }
      if (cwd) args.push("--cd", cwd);
      args.push("-");
      return { cmd: "codex", args, cwd };
    },
  },
};

function buildCommand(opts) {
  const provider = PROVIDERS[opts.provider || "claude"];
  if (!provider) throw new Error(`unknown provider: ${opts.provider}`);
  return provider.buildArgs(opts);
}

function spawnLlm(prompt, {
  provider = "claude",
  model,
  cwd,
  outputFormat = "text",
  allowTools,
  skipPermissions = true,
  sessionPersistence = false,
  timeoutMs,
  idleTimeoutMs,
  hardTimeoutMs,
  onData,
  onStderr,
  onSpawn,
} = {}) {
  return new Promise((resolve) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider, model, outputFormat, allowTools, skipPermissions, sessionPersistence, cwd,
    });
    const env = sanitizeEnv();
    const child = spawn(cmd, args, {
      cwd: spawnCwd || cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: true,
    });
    if (onSpawn) onSpawn(child);

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timeoutKind = null;
    let killed = false;

    let stdoutBuf = "";
    let resultText = "";
    let tokenUsage = { input: 0, output: 0 };

    let singleTimer = null;
    let idleTimer = null;
    let hardTimer = null;

    function killChild(kind) {
      if (killed) return;
      killed = true;
      timeoutKind = kind;
      killPidTree(child.pid);
    }

    if (timeoutMs) {
      singleTimer = setTimeout(() => killChild("single"), timeoutMs);
    }
    if (idleTimeoutMs) {
      idleTimer = setTimeout(() => killChild("idle"), idleTimeoutMs);
    }
    if (hardTimeoutMs) {
      hardTimer = setTimeout(() => killChild("hard"), hardTimeoutMs);
    }

    function clearTimers() {
      if (singleTimer) clearTimeout(singleTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    }

    function resetIdleTimer() {
      if (idleTimeoutMs && idleTimer && !killed) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killChild("idle"), idleTimeoutMs);
      }
    }

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      resetIdleTimer();
      if (onData) onData(chunk);

      if (outputFormat === "stream-json") {
        stdoutBuf += chunk;
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  resultText += block.text;
                }
              }
            } else if (event.type === "result") {
              resultText = event.result || resultText;
              if (event.usage) {
                tokenUsage.input += event.usage.input_tokens || 0;
                tokenUsage.output += event.usage.output_tokens || 0;
              }
            }
          } catch {}
        }
      }
    });

    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });

    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdin.end(prompt);

    child.on("close", (code) => {
      clearTimers();
      const durationMs = Date.now() - startTime;
      const output = outputFormat === "stream-json" ? resultText : stdout;

      if (killed) {
        return resolve({ status: "timeout", stdout: output, stderr, exitCode: code, timeoutKind, durationMs, tokenUsage });
      }
      if (code === 0) {
        return resolve({ status: "done", stdout: output, stderr, exitCode: 0, timeoutKind: null, durationMs, tokenUsage });
      }
      if (RATE_LIMIT_RE.test(stderr)) {
        return resolve({ status: "rate_limited", stdout: output, stderr, exitCode: code, timeoutKind: null, durationMs, tokenUsage });
      }
      resolve({ status: "failed", stdout: output, stderr, exitCode: code, timeoutKind: null, durationMs, tokenUsage });
    });

    child.on("error", (e) => {
      clearTimers();
      const durationMs = Date.now() - startTime;
      resolve({ status: "failed", stdout: "", stderr: e.message, exitCode: -1, timeoutKind: null, durationMs });
    });
  });
}

async function llmText(prompt, opts) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const result = await spawnLlm(prompt, { ...opts, outputFormat: "stream-json" });
    if (result.status === "rate_limited") {
      if (attempt < MAX_RATE_LIMIT_RETRIES) {
        const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error("RATE_LIMITED");
    }
    if (result.status !== "done") throw new Error(`LLM ${result.status}: ${result.stderr?.slice(0, 200)}`);
    return { text: result.stdout.trim(), tokenUsage: result.tokenUsage };
  }
}

async function llmJson(prompt, opts) {
  const { text, tokenUsage } = await llmText(prompt, opts);
  return { data: extractJson(text), tokenUsage };
}

function extractJson(text) {
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch {}
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch {}
  }
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try { return JSON.parse(text.slice(arrayStart, arrayEnd + 1)); } catch {}
  }
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(text.slice(objStart, objEnd + 1)); } catch {}
  }
  const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
  throw new Error(`Failed to extract JSON from LLM response: ${preview}`);
}

module.exports = {
  buildCommand,
  spawnLlm,
  llmText,
  llmJson,
  extractJson,
  killPidTree,
  sanitizeEnv,
  REASONING_EFFORTS,
};
