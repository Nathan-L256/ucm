#!/usr/bin/env node
const { spawn } = require("child_process");
const { mkdir, readFile, writeFile, access } = require("fs/promises");
const path = require("path");

const USAGE = `prl — 같은 프롬프트를 N개 Claude 인스턴스로 병렬 실행

Usage:
  node prl.js --project <dir> --prompt <file> [options]
  echo "프롬프트" | node prl.js --project <dir> [options]

Required:
  --project <dir>    프로젝트 디렉토리 (LLM 작업 디렉토리)

Prompt (둘 중 하나):
  --prompt <file>    프롬프트 파일 경로
  stdin              파이프로 프롬프트 전달

Options:
  --count <N>        병렬 인스턴스 수 (기본: 3)
  --model <model>    모델 (codex는 model 또는 reasoning effort)
  --output <dir>     결과 저장 디렉토리 (기본: /tmp/prl-<timestamp>/)
  --provider <name>  실행 제공자 (claude|codex, 기본: LLM_PROVIDER 또는 claude)
  --help             도움말 출력`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { count: "3" };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--project": opts.project = args[++i]; break;
      case "--prompt": opts.prompt = args[++i]; break;
      case "--count": opts.count = args[++i]; break;
      case "--model": opts.model = args[++i]; break;
      case "--output": opts.output = args[++i]; break;
      case "--provider": opts.provider = args[++i]; break;
      default:
        console.error(`알 수 없는 옵션: ${args[i]}\n`);
        console.error(USAGE);
        process.exit(1);
    }
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

const PROVIDERS = ["claude", "codex"];
const DEFAULT_PROVIDER = (process.env.LLM_PROVIDER || "claude").toLowerCase();
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function normalizeProvider(value) {
  if (!value) return DEFAULT_PROVIDER;
  return value.toLowerCase();
}

async function validate(opts) {
  const errors = [];
  if (!opts.project) errors.push("--project 필수");
  if (!opts.prompt && process.stdin.isTTY) errors.push("--prompt <file> 또는 stdin 필수");
  if (opts.project) {
    try { await access(path.resolve(opts.project)); }
    catch { errors.push(`프로젝트 디렉토리 없음: ${opts.project}`); }
  }
  if (opts.prompt) {
    try { await access(path.resolve(opts.prompt)); }
    catch { errors.push(`프롬프트 파일 없음: ${opts.prompt}`); }
  }
  const count = parseInt(opts.count);
  if (isNaN(count) || count < 1) errors.push(`--count 는 1 이상의 정수: ${opts.count}`);
  const provider = normalizeProvider(opts.provider);
  if (!PROVIDERS.includes(provider)) errors.push(`--provider 는 ${PROVIDERS.join("|")}: ${opts.provider || ""}`);
  opts.provider = provider;
  if (errors.length) {
    console.error(errors.join("\n") + "\n");
    console.error(USAGE);
    process.exit(1);
  }
}

const TIMEOUT = 30 * 60 * 1000;
const MAX_RETRIES = 1;

function isRateLimited(stderr) {
  return /rate.limit|429|quota/i.test(stderr);
}

function buildCommand({ provider, model, cwd }) {
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
  const args = ["-p", "--dangerously-skip-permissions", "--no-session-persistence", "--output-format", "text"];
  if (model) args.push("--model", model);
  return { cmd: "claude", args, cwd };
}

function spawnLLM(text, { id, cwd, model, provider, timeoutMs }) {
  return new Promise((resolve) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({ provider, model, cwd });
    const child = spawn(cmd, args, { cwd: spawnCwd || undefined, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    let timedOut = false;
    let killTimer;
    if (timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      }, timeoutMs);
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      const line = d.toString().trim();
      if (line) process.stderr.write(`  [${id}] ${line}\n`);
    });
    child.stdin.end(text);
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) return resolve({ status: "timeout", stdout: out, stderr: err, error: "timeout" });
      if (code === 0) return resolve({ status: "done", stdout: out, stderr: err });
      if (isRateLimited(err)) return resolve({ status: "rate_limited", stdout: out, stderr: err, error: err.slice(0, 200) });
      resolve({ status: "failed", stdout: out, stderr: err, error: err.slice(0, 200) });
    });
    child.on("error", (e) => resolve({ status: "failed", stdout: out, stderr: err, error: e.message }));
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  await validate(opts);

  const cwd = path.resolve(opts.project);
  const count = parseInt(opts.count);
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = opts.output ? path.resolve(opts.output) : path.join("/tmp", `prl-${runId}`);
  const prompt = opts.prompt
    ? (await readFile(path.resolve(opts.prompt), "utf-8")).trim()
    : await readStdin();

  const logDir = path.join(outputDir, "logs");
  await mkdir(logDir, { recursive: true });
  console.error(`prl: ${count} instances${opts.model ? ` (${opts.model})` : ""} [${opts.provider}] → ${outputDir}/\n`);

  const start = Date.now();

  function elapsed(startMs) {
    const sec = Math.round((Date.now() - startMs) / 1000);
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  }

  async function saveLog(id, result) {
    const writes = [];
    if (result.stdout) writes.push(writeFile(path.join(logDir, `${id}.stdout.log`), result.stdout));
    if (result.stderr) writes.push(writeFile(path.join(logDir, `${id}.stderr.log`), result.stderr));
    await Promise.all(writes);
  }

  const statusPath = path.join(outputDir, "status.json");
  const allIds = Array.from({ length: count }, (_, i) => i + 1);
  const status = { total: count, running: [...allIds], done: [], failed: [], rateLimited: [], timedOut: [], startedAt: new Date().toISOString(), finished: false };
  async function writeStatus() {
    status.elapsed = elapsed(start);
    await writeFile(statusPath, JSON.stringify(status, null, 2) + "\n");
  }
  await writeStatus();

  async function updateStatus(id, result) {
    status.running = status.running.filter((x) => x !== id);
    status[result].push(id);
    await writeStatus();
  }

  async function runInstance(id, retriesLeft) {
    const instanceStart = Date.now();
    const text = `${prompt}\n\n결과를 ${path.join(outputDir, `${id}.md`)} 파일에 작성하세요.`;
    const result = await spawnLLM(text, { id, cwd, model: opts.model, provider: opts.provider, timeoutMs: TIMEOUT });
    await saveLog(id, result);
    if (result.status === "done") {
      console.error(`  [${id}] done (${elapsed(instanceStart)})`);
      await updateStatus(id, "done");
      return "done";
    }
    if (result.status === "timeout") {
      console.error(`  [${id}] timeout (${elapsed(instanceStart)}) — 프로세스 종료됨`);
      await updateStatus(id, "timedOut");
      return "timeout";
    }
    if (result.status === "rate_limited") {
      console.error(`  [${id}] rate_limited (${elapsed(instanceStart)}) — 쿼타 초과`);
      await updateStatus(id, "rateLimited");
      return "rate_limited";
    }
    if (retriesLeft > 0) {
      console.error(`  [${id}] failed, retrying... (${result.error || ""})`);
      return runInstance(id, retriesLeft - 1);
    }
    console.error(`  [${id}] failed (${elapsed(instanceStart)}): ${result.error || ""}`);
    await updateStatus(id, "failed");
    return "failed";
  }

  const promises = Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    console.error(`  [${id}] spawned`);
    return runInstance(id, MAX_RETRIES);
  });

  const results = await Promise.all(promises);

  status.finished = true;
  await writeStatus();

  const doneCount = results.filter((r) => r === "done").length;
  const rateLimited = results.filter((r) => r === "rate_limited").length;
  const timedOut = results.filter((r) => r === "timeout").length;
  console.error(`\ndone. ${doneCount}/${count} succeeded. (${elapsed(start)})`);
  if (rateLimited > 0) console.error(`  ${rateLimited}개 인스턴스 쿼타 초과로 중단됨.`);
  if (timedOut > 0) console.error(`  ${timedOut}개 인스턴스 타임아웃으로 종료됨.`);
  if (doneCount === 0) process.exit(1);
  console.log(outputDir);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
