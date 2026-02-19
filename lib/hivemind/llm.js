const { spawnLlm, llmJson, extractJson } = require("../llm-spawn");

const TIMEOUT_MS = 120_000;

async function callLlm(prompt, { model, timeoutMs = TIMEOUT_MS } = {}) {
  const result = await spawnLlm(prompt, {
    model,
    timeoutMs,
    outputFormat: "stream-json",
    skipPermissions: false,
  });
  if (result.status === "timeout") throw new Error("LLM timeout");
  if (result.status !== "done") throw new Error(`LLM exited with code ${result.exitCode}: ${result.stderr?.slice(0, 200)}`);
  return result.stdout;
}

async function callLlmJson(prompt, opts) {
  const text = await callLlm(prompt, opts);
  return extractJson(text);
}

module.exports = { callLlm, callLlmJson, extractJson };
