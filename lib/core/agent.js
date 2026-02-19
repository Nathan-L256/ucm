const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildCommand, killPidTree, sanitizeEnv } = require("./llm");
const { RATE_LIMIT_RE, LOGS_DIR } = require("./constants");
const { sanitizeContent } = require("./worktree");

function spawnAgent(prompt, {
  cwd,
  provider = "claude",
  model,
  idleTimeoutMs,
  hardTimeoutMs,
  taskId,
  stage,
  logDir,
  onLog,
  onToolUse,
}) {
  return new Promise((resolve) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider, model, cwd, outputFormat: "stream-json",
      skipPermissions: true,
      sessionPersistence: false,
    });
    const effectiveCwd = spawnCwd || cwd;
    const child = spawn(cmd, args, {
      cwd: effectiveCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizeEnv(),
      detached: true,
    });

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutKind = null;

    const effectiveLogDir = logDir || LOGS_DIR;
    const taskLogPath = path.join(effectiveLogDir, `${taskId}.log`);

    // stage별 개별 로그 파일
    const stageLogDir = path.join(effectiveLogDir, taskId);
    const stageLogPath = path.join(stageLogDir, `${stage}.log`);

    let taskLogStream;
    let stageLogStream;
    try {
      fs.mkdirSync(effectiveLogDir, { recursive: true });
      taskLogStream = fs.createWriteStream(taskLogPath, { flags: "a" });
      taskLogStream.on("error", () => {
        try { taskLogStream.end(); } catch {}
        taskLogStream = null;
      });
    } catch {
      taskLogStream = null;
    }
    try {
      fs.mkdirSync(stageLogDir, { recursive: true });
      stageLogStream = fs.createWriteStream(stageLogPath, { flags: "a" });
      stageLogStream.on("error", () => {
        try { stageLogStream.end(); } catch {}
        stageLogStream = null;
      });
    } catch {
      stageLogStream = null;
    }

    function writeLog(line) {
      if (taskLogStream) taskLogStream.write(line + "\n");
      if (stageLogStream) stageLogStream.write(line + "\n");
    }

    const stageStartLine = `--- ${stage} started at ${new Date().toISOString()} (cwd: ${effectiveCwd}) ---`;
    writeLog(`\n${stageStartLine}`);
    if (onLog) onLog(stageStartLine);

    let idleTimer = null;
    let hardTimer = null;

    let resolved = false;

    function closeStreams() {
      if (taskLogStream) { try { taskLogStream.end(); } catch {} taskLogStream = null; }
      if (stageLogStream) { try { stageLogStream.end(); } catch {} stageLogStream = null; }
    }

    function killChild(kind) {
      if (killed) return;
      killed = true;
      timeoutKind = kind;
      killPidTree(child.pid);

      // safety net: if child doesn't exit within 3s, force resolve
      const safetyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearTimers();
          closeStreams();
          resolve({
            status: "timeout",
            stdout: resultText || stdout,
            stderr,
            exitCode: null,
            timeoutKind: kind + "_forced",
            durationMs: Date.now() - startTime,
            tokenUsage,
          });
        }
      }, 3000);
      safetyTimer.unref();
    }

    if (idleTimeoutMs) {
      idleTimer = setTimeout(() => killChild("idle"), idleTimeoutMs);
    }
    if (hardTimeoutMs) {
      hardTimer = setTimeout(() => killChild("hard"), hardTimeoutMs);
    }

    function clearTimers() {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    }

    function resetIdleTimer() {
      if (idleTimeoutMs && idleTimer && !killed) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killChild("idle"), idleTimeoutMs);
      }
    }

    let stdoutBuf = "";
    let resultText = "";
    let tokenUsage = { input: 0, output: 0 };

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      resetIdleTimer();

      stdoutBuf += chunk;
      let newlineIdx;
      while ((newlineIdx = stdoutBuf.indexOf("\n")) !== -1) {
        const jsonLine = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (!jsonLine) continue;
        try {
          const event = JSON.parse(jsonLine);
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                const line = sanitizeContent(block.text.slice(0, 200));
                writeLog(line);
                if (onLog) onLog(line);
              } else if (block.type === "tool_use") {
                const input = block.input || {};
                let detail = "";
                if (block.name === "Read") detail = input.file_path || "";
                else if (block.name === "Write") detail = input.file_path || "";
                else if (block.name === "Edit") detail = input.file_path || "";
                else if (block.name === "Glob") detail = input.pattern || "";
                else if (block.name === "Grep") detail = input.pattern || "";
                else if (block.name === "Bash") detail = (input.command || "").slice(0, 120);
                else if (block.name === "Task") detail = input.description || "";
                else {
                  const first = Object.values(input)[0];
                  if (typeof first === "string") detail = first.slice(0, 80);
                }
                const line = sanitizeContent(`[tool] ${block.name}${detail ? " — " + detail : ""}`);
                writeLog(line);
                if (onLog) onLog(line);
                if (onToolUse) onToolUse({ name: block.name, detail });
              }
            }
          } else if (event.type === "result") {
            resultText = event.result || "";
            if (event.usage) {
              tokenUsage.input += event.usage.input_tokens || 0;
              tokenUsage.output += event.usage.output_tokens || 0;
            }
          }
        } catch {}
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdin.end(prompt);

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      const durationMs = Date.now() - startTime;
      const stageEndLine = `--- ${stage} ended (code=${code}, ${durationMs}ms) ---`;
      writeLog(`\n${stageEndLine}`);
      closeStreams();
      if (onLog) onLog(stageEndLine);

      const output = resultText || stdout;
      if (killed) return resolve({ status: "timeout", stdout: output, stderr, exitCode: code, timeoutKind, durationMs, tokenUsage });
      if (code === 0) return resolve({ status: "done", stdout: output, stderr, exitCode: 0, timeoutKind: null, durationMs, tokenUsage });
      if (RATE_LIMIT_RE.test(stderr)) return resolve({ status: "rate_limited", stdout: output, stderr, exitCode: code, timeoutKind: null, durationMs, tokenUsage });
      resolve({ status: "failed", stdout: output, stderr, exitCode: code, timeoutKind: null, durationMs, tokenUsage });
    });

    child.on("error", (e) => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      const durationMs = Date.now() - startTime;
      const spawnErrorLine = `--- ${stage} spawn error: ${e.message} ---`;
      writeLog(`\n${spawnErrorLine}`);
      closeStreams();
      if (onLog) onLog(spawnErrorLine);
      resolve({ status: "failed", stdout, stderr: e.message, exitCode: -1, timeoutKind: null, durationMs, tokenUsage });
    });
  });
}

module.exports = { spawnAgent };
