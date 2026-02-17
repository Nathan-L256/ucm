const { spawn } = require("child_process");

const TIMEOUT_MS = 120_000;

function callLlm(prompt, { model, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--no-session-persistence", "--output-format", "stream-json"];
    if (model) args.push("--model", model);

    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdoutBuf = "";
    let resultText = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;

    if (timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      }, timeoutMs);
    }

    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
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
    });

    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.stdin.on("error", () => {}); // Ignore EPIPE
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdin.end(prompt);

    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) return reject(new Error("LLM timeout"));
      if (code !== 0) return reject(new Error(`LLM exited with code ${code}: ${stderr.slice(0, 200)}`));
      resolve(resultText);
    });

    child.on("error", (e) => {
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`LLM spawn error: ${e.message}`));
    });
  });
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

async function callLlmJson(prompt, opts) {
  const text = await callLlm(prompt, opts);
  return extractJson(text);
}

module.exports = { callLlm, callLlmJson, extractJson };
