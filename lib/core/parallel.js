const { writeFile, mkdir } = require("fs/promises");
const crypto = require("crypto");
const path = require("path");
const { spawnLlm } = require("./llm");

const DEFAULT_TIMEOUT = 30 * 60 * 1000;
const MAX_RETRIES = 1;

function elapsed(startMs) {
  const sec = Math.round((Date.now() - startMs) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

async function runParallel(prompt, {
  cwd,
  count = 3,
  model,
  provider = "claude",
  timeoutMs = DEFAULT_TIMEOUT,
  outputDir,
  onProgress,
} = {}) {
  if (!count || count < 1) count = 1;
  if (count > 10) count = 10;

  if (!outputDir) {
    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const nonce = crypto.randomBytes(3).toString("hex");
    outputDir = path.join("/tmp", `prl-${runId}-${nonce}`);
  }
  const logDir = path.join(outputDir, "logs");
  await mkdir(logDir, { recursive: true });

  const startTime = Date.now();
  const results = { total: count, done: [], failed: [], rateLimited: [], timedOut: [], tokenUsage: { input: 0, output: 0 } };

  async function saveLog(id, result) {
    const writes = [];
    if (result.stdout) writes.push(writeFile(path.join(logDir, `${id}.stdout.log`), result.stdout));
    if (result.stderr) writes.push(writeFile(path.join(logDir, `${id}.stderr.log`), result.stderr));
    await Promise.all(writes);
  }

  async function runInstance(id, retriesLeft) {
    const instanceStart = Date.now();
    const text = `${prompt}\n\n결과를 ${path.join(outputDir, `${id}.md`)} 파일에 작성하세요.`;

    const result = await spawnLlm(text, {
      provider, model, cwd, timeoutMs,
      onStderr: (chunk) => {
        if (onProgress) onProgress({ type: "stderr", id, chunk: chunk.trim() });
      },
    });

    await saveLog(id, result);

    if (result.tokenUsage) {
      results.tokenUsage.input += result.tokenUsage.input || 0;
      results.tokenUsage.output += result.tokenUsage.output || 0;
    }

    if (result.status === "done") {
      if (onProgress) onProgress({ type: "done", id, elapsed: elapsed(instanceStart) });
      results.done.push(id);
      return "done";
    }
    if (result.status === "timeout") {
      if (onProgress) onProgress({ type: "timeout", id, elapsed: elapsed(instanceStart) });
      results.timedOut.push(id);
      return "timeout";
    }
    if (result.status === "rate_limited") {
      if (onProgress) onProgress({ type: "rate_limited", id, elapsed: elapsed(instanceStart) });
      results.rateLimited.push(id);
      return "rate_limited";
    }
    if (retriesLeft > 0) {
      if (onProgress) onProgress({ type: "retry", id, error: result.stderr?.slice(0, 200) });
      return runInstance(id, retriesLeft - 1);
    }
    if (onProgress) onProgress({ type: "failed", id, elapsed: elapsed(instanceStart), error: result.stderr?.slice(0, 200) });
    results.failed.push(id);
    return "failed";
  }

  const promises = Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    if (onProgress) onProgress({ type: "spawn", id });
    return runInstance(id, MAX_RETRIES);
  });

  await Promise.all(promises);

  const statusPath = path.join(outputDir, "status.json");
  const status = {
    ...results,
    elapsed: elapsed(startTime),
    finished: true,
  };
  await writeFile(statusPath, JSON.stringify(status, null, 2) + "\n");

  return { outputDir, ...results, elapsed: elapsed(startTime) };
}

module.exports = { runParallel };
