#!/usr/bin/env node
const { spawn } = require("child_process");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const { access } = require("fs/promises");

const USAGE = `rsa — 분류 → 병렬 실행 → 취합 자동 파이프라인

Usage:
  node rsa.js --project <dir> --prompt <file> [options]
  echo "프롬프트" | node rsa.js --project <dir> [options]

Required:
  --project <dir>    프로젝트 디렉토리 (LLM 작업 디렉토리)

Prompt (둘 중 하나):
  --prompt <file>    프롬프트 파일 경로
  stdin              파이프로 프롬프트 전달

Options:
  --count <N>        병렬 인스턴스 수 (기본: 3)
  --rounds <N>       라운드 수 (기본: 1, 최대: 2)
  --provider <name>  실행 제공자 (claude|codex, 기본: LLM_PROVIDER 또는 claude)
  --help             도움말 출력`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { count: "3", rounds: "1" };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--project": opts.project = args[++i]; break;
      case "--prompt": opts.prompt = args[++i]; break;
      case "--count": opts.count = args[++i]; break;
      case "--rounds": opts.rounds = args[++i]; break;
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
  const rounds = parseInt(opts.rounds);
  if (isNaN(rounds) || rounds < 1 || rounds > 2) errors.push(`--rounds 는 1 또는 2: ${opts.rounds}`);
  const provider = normalizeProvider(opts.provider);
  if (!PROVIDERS.includes(provider)) errors.push(`--provider 는 ${PROVIDERS.join("|")}: ${opts.provider || ""}`);
  opts.provider = provider;
  if (errors.length) {
    console.error(errors.join("\n") + "\n");
    console.error(USAGE);
    process.exit(1);
  }
}

const prl = path.join(__dirname, "prl.js");

function runPrl({ project, prompt, count, model, output, provider }) {
  const args = [prl, "--project", project, "--prompt", prompt, "--count", String(count)];
  if (model) args.push("--model", model);
  if (provider) args.push("--provider", provider);
  if (output) args.push("--output", output);
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { stdio: ["inherit", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => { err += d; process.stderr.write(d); });
    child.on("close", (code) => code ? reject(new Error(err || `exit ${code}`)) : resolve(out.trim()));
    child.on("error", reject);
  });
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

function buildCommand({ provider, model, cwd, allowTools }) {
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
  if (allowTools !== undefined) args.push("--allowedTools", allowTools);
  if (model) args.push("--model", model);
  return { cmd: "claude", args, cwd };
}

function classify(prompt, { provider, cwd }) {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : modelFor(provider, "light"),
      cwd,
      allowTools: provider === "claude" ? "" : undefined,
    });
    const child = spawn(cmd, args, { cwd: spawnCwd || undefined, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.end(
      `다음 작업을 두 축으로 분류하세요.\n\n` +
      `복잡도:\n` +
      `  light — 단순 텍스트 생성, 요약, 번역, 포맷 변환 등\n` +
      `  heavy — 코드 분석, 아키텍처 설계, 복잡한 추론, 다단계 의사결정 등\n\n` +
      `취합 전략:\n` +
      `  converge — 분석, 문서화, 팩트 기반 작업 (공통점 선별, 이상치 제거)\n` +
      `  diverge — 설계, 전략, 창의적 작업 (정반합, 새 관점 도출)\n\n` +
      `반드시 JSON만 출력: {"complexity":"light|heavy","strategy":"converge|diverge"}\n\n` +
      `작업:\n${prompt}`
    );
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${provider} classify failed`));
      try {
        const parsed = extractJson(out);
        const { complexity, strategy } = parsed;
        if (!["light", "heavy"].includes(complexity)) throw new Error(`invalid complexity: ${complexity}`);
        if (!["converge", "diverge"].includes(strategy)) throw new Error(`invalid strategy: ${strategy}`);
        resolve({ complexity, strategy });
      } catch (e) {
        reject(new Error(`classify failed: ${e.message} (raw: ${out.trim().slice(0, 100)})`));
      }
    });
    child.on("error", reject);
  });
}

const MODEL_MAP = {
  claude: { light: "sonnet", heavy: "opus" },
  codex: { light: "medium", heavy: "high" },
};

function modelFor(provider, complexity) {
  const entry = MODEL_MAP[provider];
  if (!entry) return undefined;
  return entry[complexity];
}

const STRATEGY = {
  converge: `당신은 여러 독립적인 작업 결과를 하나로 취합하는 편집자입니다.

## 입력

{{INPUT_DIR}} 디렉토리에 같은 작업을 독립적으로 수행한 여러 결과 파일이 있습니다. 모든 파일을 읽으세요.

## 원래 작업 지시

{{ORIGINAL_PROMPT}}

## 취합 방법

1. 모든 결과를 읽고 각 결과의 구조와 내용을 파악하세요.
2. 여러 결과에 공통으로 등장하는 내용은 신뢰도가 높으므로 반드시 포함하세요.
3. 하나의 결과에만 등장하는 내용은 근거가 충분하면 포함하고, 근거가 약하면 제외하세요.
4. 결과 간 상충하는 내용은 더 구체적인 근거를 가진 쪽을 택하세요.
5. 각 결과에서 가장 잘 작성된 표현과 구조를 선택하세요.
6. 최종 결과는 원래 작업 지시의 목적에 가장 부합해야 합니다.

## 주의사항

- 원본에 없는 내용을 추가하지 마세요.
- 취합 과정에서 세부 정보를 누락하지 마세요.
- 출처별로 구분하지 말고 하나의 일관된 문서로 작성하세요.`,

  diverge: `당신은 여러 독립적인 작업 결과를 종합하여 더 나은 결과를 만들어내는 사상가입니다.

## 입력

{{INPUT_DIR}} 디렉토리에 같은 작업을 독립적으로 수행한 여러 결과 파일이 있습니다. 모든 파일을 읽으세요.

## 원래 작업 지시

{{ORIGINAL_PROMPT}}

## 취합 방법

1. 모든 결과를 읽고 각 결과의 핵심 주장과 관점을 파악하세요.
2. 결과 간 상충하거나 대립하는 부분을 찾으세요. 이것이 가장 중요한 재료입니다.
3. 대립하는 관점들을 단순히 한쪽을 선택하지 말고, 양쪽을 아우르는 상위 관점을 도출하세요.
4. 어떤 결과에도 명시적으로 없지만 결과들의 조합에서 논리적으로 도출할 수 있는 새로운 인사이트를 추가하세요.
5. 최종 결과는 개별 결과 어느 것보다 더 깊고 포괄적이어야 합니다.

## 주의사항

- 단순히 내용을 합치거나 나열하지 마세요. 새로운 구조와 관점으로 재구성하세요.
- 원래 작업 지시의 목적을 벗어나지 마세요.
- 출처별로 구분하지 말고 하나의 일관된 문서로 작성하세요.`,

  refine: `당신은 초안을 검토하고 개선하는 편집자입니다.

## 초안

{{DRAFT_PATH}} 파일을 읽으세요. 이것은 이전 라운드에서 생성된 초안입니다.

## 원래 작업 지시

{{ORIGINAL_PROMPT}}

## 개선 방법

1. 초안을 꼼꼼히 읽고 원래 작업 지시의 목적에 비추어 평가하세요.
2. 빠진 내용, 논리적 약점, 구조적 문제를 찾아 보완하세요.
3. 불필요한 반복이나 장황한 표현을 정리하세요.
4. 더 정확한 표현이나 더 나은 구조가 있다면 적용하세요.

## 주의사항

- 초안의 좋은 부분은 유지하세요.
- 원래 작업 지시의 목적을 벗어나지 마세요.
- 개선 이유를 설명하지 말고, 개선된 최종 결과만 작성하세요.`,
};

async function main() {
  const opts = parseArgs(process.argv);
  await validate(opts);
  const provider = opts.provider;

  const originalPrompt = opts.prompt
    ? (await readFile(path.resolve(opts.prompt), "utf-8")).trim()
    : await readStdin();
  const count = parseInt(opts.count);
  const rounds = parseInt(opts.rounds);
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseDir = path.join("/tmp", `rsa-${runId}`);
  await mkdir(baseDir, { recursive: true });
  console.error(`output: ${baseDir}/\n`);
  console.error(`provider: ${provider}\n`);

  // stdin으로 받은 경우 임시 프롬프트 파일 생성 (prl.js에 전달용)
  const promptPath = opts.prompt
    ? path.resolve(opts.prompt)
    : path.join(baseDir, "input-prompt.md");
  if (!opts.prompt) await writeFile(promptPath, originalPrompt);

  // phase 0: classify
  console.error("── phase 0: classify ──");
  const { complexity, strategy } = await classify(originalPrompt, { provider, cwd: path.resolve(opts.project) });
  const model = modelFor(provider, complexity);
  const modelLabel = model ? model : "default";
  console.error(`  ${complexity} → ${modelLabel}, ${strategy}\n`);

  // round 1: parallel → aggregate
  const r1Dir = path.join(baseDir, "round1");
  const r1AggDir = path.join(baseDir, "round1-agg");

  console.error(`── round 1: parallel (${count} instances) ──`);
  await runPrl({ project: opts.project, prompt: promptPath, count, model, output: r1Dir, provider });

  console.error(`\n── round 1: ${strategy} ──`);
  const r1AggPrompt = STRATEGY[strategy]
    .replace("{{INPUT_DIR}}", r1Dir)
    .replace("{{ORIGINAL_PROMPT}}", originalPrompt);
  const r1AggPromptPath = path.join(baseDir, "round1-agg-prompt.md");
  await writeFile(r1AggPromptPath, r1AggPrompt);
  await runPrl({ project: opts.project, prompt: r1AggPromptPath, count: 1, model: modelFor(provider, "heavy"), output: r1AggDir, provider });

  const r1Result = path.join(r1AggDir, "1.md");

  if (rounds < 2) {
    console.error(`\ndone. result: ${r1Result}`);
    return;
  }

  // round 2: refine parallel → aggregate
  const r2Dir = path.join(baseDir, "round2");
  const r2AggDir = path.join(baseDir, "round2-agg");

  console.error(`\n── round 2: refine (${count} instances) ──`);
  const refinePrompt = STRATEGY.refine
    .replace("{{DRAFT_PATH}}", r1Result)
    .replace("{{ORIGINAL_PROMPT}}", originalPrompt);
  const refinePromptPath = path.join(baseDir, "round2-refine-prompt.md");
  await writeFile(refinePromptPath, refinePrompt);
  await runPrl({ project: opts.project, prompt: refinePromptPath, count, model: modelFor(provider, "heavy"), output: r2Dir, provider });

  console.error(`\n── round 2: ${strategy} ──`);
  const r2AggPrompt = STRATEGY[strategy]
    .replace("{{INPUT_DIR}}", r2Dir)
    .replace("{{ORIGINAL_PROMPT}}", originalPrompt);
  const r2AggPromptPath = path.join(baseDir, "round2-agg-prompt.md");
  await writeFile(r2AggPromptPath, r2AggPrompt);
  await runPrl({ project: opts.project, prompt: r2AggPromptPath, count: 1, model: modelFor(provider, "heavy"), output: r2AggDir, provider });

  const r2Result = path.join(r2AggDir, "1.md");
  console.error(`\ndone. result: ${r2Result}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
