#!/usr/bin/env node
const { spawn } = require("child_process");
const { readFile, mkdir, access, unlink } = require("fs/promises");
const path = require("path");

const USAGE = `req — 설계 결정 수집 + 요구사항 명세 생성 워크플로

Usage:
  node req.js [options]

Options:
  --template <file>       Q&A 설계 템플릿
  --spec-template <file>  요구사항 생성 템플릿
  --project <dir>         프로젝트 디렉토리 (브라운필드)
  --output <dir>          결과 저장 디렉토리 (기본: /tmp/req-<timestamp>/)
  --max-rounds <n>        qna→spec 반복 최대 횟수 (기본: 3)
  --provider <name>       실행 제공자 (claude|codex, 기본: LLM_PROVIDER 또는 claude)
  --help                  도움말 출력`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--template": opts.template = args[++i]; break;
      case "--spec-template": opts.specTemplate = args[++i]; break;
      case "--project": opts.project = args[++i]; break;
      case "--output": opts.output = args[++i]; break;
      case "--max-rounds": opts.maxRounds = parseInt(args[++i]); break;
      case "--provider": opts.provider = args[++i]; break;
      default:
        console.error(`알 수 없는 옵션: ${args[i]}\n`);
        console.error(USAGE);
        process.exit(1);
    }
  }
  return opts;
}

const PROVIDERS = ["claude", "codex"];
const DEFAULT_PROVIDER = (process.env.LLM_PROVIDER || "claude").toLowerCase();

function normalizeProvider(value) {
  if (!value) return DEFAULT_PROVIDER;
  return value.toLowerCase();
}

async function validate(opts) {
  const errors = [];
  if (opts.template) {
    try { await access(path.resolve(opts.template)); }
    catch { errors.push(`템플릿 파일 없음: ${opts.template}`); }
  }
  if (opts.specTemplate) {
    try { await access(path.resolve(opts.specTemplate)); }
    catch { errors.push(`spec 템플릿 파일 없음: ${opts.specTemplate}`); }
  }
  if (opts.project) {
    try { await access(path.resolve(opts.project)); }
    catch { errors.push(`프로젝트 디렉토리 없음: ${opts.project}`); }
  }
  if (opts.maxRounds !== undefined && (isNaN(opts.maxRounds) || opts.maxRounds < 1)) {
    errors.push("--max-rounds 는 1 이상의 정수여야 합니다");
  }
  const provider = normalizeProvider(opts.provider);
  if (!PROVIDERS.includes(provider)) errors.push(`--provider 는 ${PROVIDERS.join("|")}: ${opts.provider || ""}`);
  opts.provider = provider;
  if (errors.length) {
    console.error(errors.join("\n") + "\n");
    console.error(USAGE);
    process.exit(1);
  }
}

function spawnTool(scriptPath, args, { interactive }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], {
      stdio: [
        interactive ? "inherit" : "pipe",
        "pipe",
        "inherit",
      ],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    if (!interactive) child.stdin.end();
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${path.basename(scriptPath)} exit ${code}`));
      resolve(out.trim());
    });
    child.on("error", reject);
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  await validate(opts);
  const provider = opts.provider;

  const maxRounds = opts.maxRounds || 3;
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = opts.output ? path.resolve(opts.output) : path.join("/tmp", `req-${runId}`);
  await mkdir(outputDir, { recursive: true });

  const baseDir = path.dirname(path.resolve(__filename));
  const qnaPath = path.join(baseDir, "qna.js");
  const specPath = path.join(baseDir, "spec.js");
  const gapReportPath = path.join(outputDir, "gap-report.md");

  process.stderr.write(`output: ${outputDir}/\n`);
  process.stderr.write(`max rounds: ${maxRounds}\n`);

  let feedback = null;
  let decisionsPath = null;
  let requirementsPath = null;

  for (let round = 0; round < maxRounds; round++) {
    process.stderr.write(`\n══ 라운드 ${round + 1}/${maxRounds} ══\n`);

    // gap-report.md 삭제 (이전 라운드 잔여물 방지)
    try { await unlink(gapReportPath); } catch {}

    // qna.js 실행
    process.stderr.write(`\n── qna.js 실행 ──\n`);
    const qnaArgs = [];
    if (round === 0) {
      if (opts.template) qnaArgs.push("--template", path.resolve(opts.template));
    } else {
      qnaArgs.push("--resume", decisionsPath);
      if (feedback) qnaArgs.push("--feedback", feedback);
    }
    if (opts.project) qnaArgs.push("--project", path.resolve(opts.project));
    if (provider) qnaArgs.push("--provider", provider);
    qnaArgs.push("--output", outputDir);

    try {
      decisionsPath = await spawnTool(qnaPath, qnaArgs, { interactive: true });
    } catch (e) {
      process.stderr.write(`qna.js 실패: ${e.message}\n`);
      process.exit(1);
    }

    // spec.js 실행
    process.stderr.write(`\n── spec.js 실행 ──\n`);
    const specArgs = ["--decisions", decisionsPath];
    if (opts.specTemplate) specArgs.push("--template", path.resolve(opts.specTemplate));
    if (opts.project) specArgs.push("--project", path.resolve(opts.project));
    if (provider) specArgs.push("--provider", provider);
    specArgs.push("--output", outputDir);

    try {
      requirementsPath = await spawnTool(specPath, specArgs, { interactive: false });
    } catch (e) {
      process.stderr.write(`spec.js 실패: ${e.message}\n`);
      process.exit(1);
    }

    // gap-report.md 확인
    try {
      await access(gapReportPath);
      const gapContent = await readFile(gapReportPath, "utf-8");
      feedback = gapContent;
      process.stderr.write(`gap 발견 → 다음 라운드에서 보완\n`);
    } catch {
      process.stderr.write(`검증 통과\n`);
      break;
    }

    if (round === maxRounds - 1) {
      process.stderr.write(`\n최대 라운드(${maxRounds}) 도달. 마지막 결과를 사용합니다.\n`);
    }
  }

  console.log(requirementsPath);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
