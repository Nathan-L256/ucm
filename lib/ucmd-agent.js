const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { LOGS_DIR, RATE_LIMIT_RE } = require("./ucmd-constants.js");

let deps = {};

function setDeps(d) { deps = d; }

function buildCommand({ provider, model, cwd }) {
  if (provider === "codex") {
    const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
    if (model) args.push("--model", model);
    if (cwd) args.push("--cd", cwd);
    args.push("-");
    return { cmd: "codex", args, cwd };
  }
  // claude (default)
  const args = ["-p", "--dangerously-skip-permissions", "--no-session-persistence", "--output-format", "stream-json"];
  if (model) args.push("--model", model);
  return { cmd: "claude", args, cwd };
}

function spawnAgent(prompt, { cwd, provider, model, timeoutMs, taskId, stage }) {
  return new Promise((resolve) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({ provider, model, cwd });
    const effectiveCwd = spawnCwd || cwd;
    const child = spawn(cmd, args, {
      cwd: effectiveCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    deps.activeChildren.set(taskId, child);
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;

    const taskLogPath = path.join(LOGS_DIR, `${taskId}.log`);
    const taskLogStream = fs.createWriteStream(taskLogPath, { flags: "a" });
    const stageStartLine = `--- ${stage} started at ${new Date().toISOString()} (cwd: ${effectiveCwd}) ---`;
    taskLogStream.write(`\n${stageStartLine}\n`);
    deps.broadcastWs("task:log", { taskId, line: stageStartLine });

    if (timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      }, timeoutMs);
    }

    let stdoutBuf = "";
    let resultText = "";
    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
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
                const line = block.text.slice(0, 200);
                taskLogStream.write(line + "\n");
                deps.broadcastWs("task:log", { taskId, line });
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
                const line = `[tool] ${block.name}${detail ? " — " + detail : ""}`;
                taskLogStream.write(line + "\n");
                deps.broadcastWs("task:log", { taskId, line });
              }
            }
          } else if (event.type === "result") {
            resultText = event.result || "";
          }
        } catch {}
      }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
    });

    child.stdin.end(prompt);

    child.on("close", (code) => {
      deps.activeChildren.delete(taskId);
      if (killTimer) clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;
      const stageEndLine = `--- ${stage} ended (code=${code}, ${durationMs}ms) ---`;
      taskLogStream.write(`\n${stageEndLine}\n`);
      deps.broadcastWs("task:log", { taskId, line: stageEndLine });
      taskLogStream.end();

      const output = resultText || stdout;
      if (timedOut) return resolve({ status: "timeout", stdout: output, stderr, exitCode: code, durationMs });
      if (code === 0) return resolve({ status: "done", stdout: output, stderr, exitCode: 0, durationMs });
      if (RATE_LIMIT_RE.test(stderr)) return resolve({ status: "rate_limited", stdout: output, stderr, exitCode: code, durationMs });
      resolve({ status: "failed", stdout: output, stderr, exitCode: code, durationMs });
    });

    child.on("error", (e) => {
      if (killTimer) clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;
      const spawnErrorLine = `--- ${stage} spawn error: ${e.message} ---`;
      taskLogStream.write(`\n${spawnErrorLine}\n`);
      deps.broadcastWs("task:log", { taskId, line: spawnErrorLine });
      taskLogStream.end();
      resolve({ status: "failed", stdout, stderr: e.message, exitCode: -1, durationMs });
    });
  });
}

module.exports = { setDeps, buildCommand, spawnAgent };
