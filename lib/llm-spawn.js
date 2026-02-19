const { spawn } = require("child_process");
const { RATE_LIMIT_RE } = require("./ucmd-constants.js");

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function sanitizeEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE")) delete env[key];
  }
  return env;
}

function killPidTree(pid) {
  if (!pid || pid <= 0) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  try { process.kill(pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(pid, 0); } catch { return; }
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }, 1200);
}

function buildCommand({
  provider = "claude",
  model,
  outputFormat = "text",
  allowTools,
  skipPermissions = true,
  sessionPersistence = false,
  cwd,
}) {
  if (provider === "codex") {
    const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
    if (model && REASONING_EFFORTS.has(model)) {
      args.push("-c", `model_reasoning_effort=${model}`);
    } else if (model) {
      args.push("--model", model);
    }
    if (cwd) args.push("--cd", cwd);
    args.push("-");
    return { cmd: "codex", args, cwd };
  }
  // claude
  const args = ["-p"];
  if (skipPermissions) args.push("--dangerously-skip-permissions");
  if (!sessionPersistence) args.push("--no-session-persistence");
  args.push("--output-format", outputFormat);
  if (model) args.push("--model", model);
  if (allowTools !== undefined) args.push("--allowedTools", allowTools);
  return { cmd: "claude", args, cwd };
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

    // stream-json parsing state
    let stdoutBuf = "";
    let resultText = "";

    // Timeout management
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
        return resolve({ status: "timeout", stdout: output, stderr, exitCode: code, timeoutKind, durationMs });
      }
      if (code === 0) {
        return resolve({ status: "done", stdout: output, stderr, exitCode: 0, timeoutKind: null, durationMs });
      }
      if (RATE_LIMIT_RE.test(stderr)) {
        return resolve({ status: "rate_limited", stdout: output, stderr, exitCode: code, timeoutKind: null, durationMs });
      }
      resolve({ status: "failed", stdout: output, stderr, exitCode: code, timeoutKind: null, durationMs });
    });

    child.on("error", (e) => {
      clearTimers();
      const durationMs = Date.now() - startTime;
      resolve({ status: "failed", stdout: "", stderr: e.message, exitCode: -1, timeoutKind: null, durationMs });
    });
  });
}

async function llmText(prompt, opts) {
  const result = await spawnLlm(prompt, { ...opts, outputFormat: "text" });
  if (result.status === "rate_limited") throw new Error("RATE_LIMITED");
  if (result.status !== "done") throw new Error(`LLM ${result.status}: ${result.stderr?.slice(0, 200)}`);
  return result.stdout.trim();
}

async function llmJson(prompt, opts) {
  const text = await llmText(prompt, opts);
  return extractJson(text);
}

function extractJson(text) {
  // 1. Try markdown code block first (most common LLM pattern)
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch {}
  }
  // 2. Try direct JSON parse
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch {}
  }
  // 3. Try to find JSON array (greedy match for outermost brackets)
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try { return JSON.parse(text.slice(arrayStart, arrayEnd + 1)); } catch {}
  }
  // 4. Try to find JSON object
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(text.slice(objStart, objEnd + 1)); } catch {}
  }
  throw new Error("Failed to extract JSON from LLM response");
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
