#!/usr/bin/env node
const { spawn } = require("child_process");
const { readFile, writeFile, mkdir, access } = require("fs/promises");
const path = require("path");

const USAGE = `spec — decisions에서 EARS 요구사항 명세 생성 + 검증

Usage:
  node spec.js --decisions <file> [options]

Options:
  --decisions <file>   decisions.md 경로 (필수)
  --template <file>    요구사항 생성 템플릿 (없으면 기본 형식)
  --project <dir>      프로젝트 디렉토리 (브라운필드: LLM이 코드 참조)
  --output <dir>       결과 저장 디렉토리 (기본: /tmp/spec-<timestamp>/)
  --provider <name>    실행 제공자 (claude|codex, 기본: LLM_PROVIDER 또는 claude)
  --help               도움말 출력`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--decisions": opts.decisions = args[++i]; break;
      case "--template": opts.template = args[++i]; break;
      case "--project": opts.project = args[++i]; break;
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

const PROVIDERS = ["claude", "codex"];
const DEFAULT_PROVIDER = (process.env.LLM_PROVIDER || "claude").toLowerCase();

function normalizeProvider(value) {
  if (!value) return DEFAULT_PROVIDER;
  return value.toLowerCase();
}

async function validate(opts) {
  const errors = [];
  if (!opts.decisions) errors.push("--decisions 옵션 필수");
  if (opts.decisions) {
    try { await access(path.resolve(opts.decisions)); }
    catch { errors.push(`decisions 파일 없음: ${opts.decisions}`); }
  }
  if (opts.template) {
    try { await access(path.resolve(opts.template)); }
    catch { errors.push(`템플릿 파일 없음: ${opts.template}`); }
  }
  if (opts.project) {
    try { await access(path.resolve(opts.project)); }
    catch { errors.push(`프로젝트 디렉토리 없음: ${opts.project}`); }
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

function isRateLimited(stderr) {
  return /rate.limit|429|quota/i.test(stderr);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

function buildCommand({ provider, model, cwd, allowTools }) {
  if (provider === "codex") {
    const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
    if (model) args.push("--model", model);
    if (cwd) args.push("--cd", cwd);
    args.push("-");
    return { cmd: "codex", args, cwd };
  }
  const args = ["-p", "--dangerously-skip-permissions", "--no-session-persistence", "--output-format", "text"];
  if (model) args.push("--model", model);
  if (allowTools !== undefined) args.push("--allowedTools", allowTools);
  return { cmd: "claude", args, cwd };
}

function spawnLlmText(prompt, { cwd, provider }) {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : undefined,
      cwd,
      allowTools: provider === "claude" ? (cwd ? "Read,Glob,Grep" : "") : undefined,
    });
    const child = spawn(cmd, args, { cwd: spawnCwd || undefined, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(prompt);
    child.on("close", (code) => {
      if (code !== 0) {
        if (isRateLimited(err)) return reject(new Error("RATE_LIMITED"));
        return reject(new Error(`${provider} exit ${code}: ${err.slice(0, 200)}`));
      }
      resolve(stripCodeFence(out.trim()));
    });
    child.on("error", reject);
  });
}

function stripCodeFence(text) {
  const match = text.match(/^```\w*\n([\s\S]*?)```$/);
  return match ? match[1].trim() : text;
}

function spawnLlmJson(prompt, { cwd, provider }) {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : undefined,
      cwd,
      allowTools: provider === "claude" ? (cwd ? "Read,Glob,Grep" : "") : undefined,
    });
    const child = spawn(cmd, args, { cwd: spawnCwd || undefined, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(prompt);
    child.on("close", (code) => {
      if (code !== 0) {
        if (isRateLimited(err)) return reject(new Error("RATE_LIMITED"));
        return reject(new Error(`${provider} exit ${code}: ${err.slice(0, 200)}`));
      }
      try {
        resolve(extractJson(out));
      } catch (e) {
        reject(new Error(`JSON 파싱 실패: ${e.message} (raw: ${out.trim().slice(0, 200)})`));
      }
    });
    child.on("error", reject);
  });
}

function parseDecisionsFile(content) {
  const decisions = [];
  const lines = content.split("\n");
  let currentArea = "";
  for (const line of lines) {
    const areaMatch = line.match(/^### (.+)/);
    if (areaMatch) {
      currentArea = areaMatch[1];
      continue;
    }
    const decisionMatch = line.match(/^- \*\*Q:\*\* (.+)/);
    if (decisionMatch) {
      decisions.push({ area: currentArea, question: decisionMatch[1], answer: "", reason: "" });
      continue;
    }
    const answerMatch = line.match(/^\s+- \*\*A:\*\* (.+)/);
    if (answerMatch && decisions.length > 0) {
      decisions[decisions.length - 1].answer = answerMatch[1];
      continue;
    }
    const reasonMatch = line.match(/^\s+- \*\*이유:\*\* (.+)/);
    if (reasonMatch && decisions.length > 0) {
      decisions[decisions.length - 1].reason = reasonMatch[1];
    }
  }
  return decisions;
}

const DEFAULT_REQUIREMENTS_PROMPT = `아래 설계 결정을 바탕으로 요구사항 명세를 마크다운으로 작성하세요.
마크다운 본문만 출력하세요. 코드펜스(\`\`\`markdown)로 감싸지 마세요.

## 요구사항 명세 구조

### 1. 개요
- 프로젝트 목적, 대상 사용자, 규모

### 2. 기능 요구사항
EARS 표기법으로 작성:
  WHEN [조건/이벤트] THE SYSTEM SHALL [동작]

각 기능에 대해:
- 정상 동작 (happy path)
- 엣지 케이스 (경계값, 빈 입력, 대량 데이터 등)
- 에러 상황 (실패 시 동작)

### 3. 비기능 요구사항
- 성능, 보안, 호환성, 에러 처리 정책

### 4. 범위 경계
- 이 프로젝트가 하지 않는 것을 명시

### 5. 용어 정의
- 문서에서 사용하는 핵심 용어의 정의

## 규칙
- 설계 결정에 없는 기능을 임의로 추가하지 마세요.
- 결정되지 않은 사항은 [NEEDS CLARIFICATION: 설명] 으로 표시하세요.
- 도구를 사용하지 마세요. 마크다운 텍스트만 출력하세요.`;

const VALIDATION_PROMPT = `아래 요구사항 명세를 검증하세요.

## 검증 기준

1. 볼륨 충분성: 각 기능의 동작이 구현 가능할 만큼 구체적인가
2. 엣지 케이스: 실패, 경계 조건, 예외 상황이 명시되어 있는가
3. 인터페이스 명세: 입출력, 시그니처, 데이터 구조가 구체적인가
4. 범위 경계: "하지 않는 것"이 명시되어 있는가
5. 내적 일관성: 기능 간 모순, 용어 불일치가 없는가
6. 비기능 요구사항: 성능, 보안, 호환성, 에러 처리 정책이 있는가
7. 테스트 가능성: 각 기능의 성공/실패 기준이 명확하여 테스트 작성이 가능한가

## 응답 형식 (JSON만 출력)
{
  "pass": true/false,
  "gaps": [
    { "criterion": "기준 이름", "detail": "구체적으로 무엇이 부족한지" }
  ]
}

gaps가 없으면 pass: true.`;

async function generateRequirements(decisions, { template, cwd, provider }) {
  let prompt = template || DEFAULT_REQUIREMENTS_PROMPT;
  prompt += `\n\n## 설계 결정\n\n`;
  for (const d of decisions) {
    prompt += `- **[${d.area}] ${d.question}**\n  → ${d.answer}\n`;
    if (d.reason) prompt += `  (이유: ${d.reason})\n`;
  }
  return spawnLlmText(prompt, { cwd, provider });
}

async function validateRequirements(requirements, { cwd, provider }) {
  const prompt = VALIDATION_PROMPT + `\n\n## 요구사항 명세\n\n${requirements}`;
  return spawnLlmJson(prompt, { cwd, provider });
}

function formatGapReport(gaps) {
  let md = `# Gap Report\n\n검증 결과 아래 항목이 부족합니다.\n\n`;
  for (const gap of gaps) {
    md += `- **${gap.criterion}**: ${gap.detail}\n`;
  }
  md += `\n---\n\n이 파일을 피드백으로 사용하여 추가 Q&A를 진행하세요:\n`;
  md += `\`\`\`bash\nnode qna.js --resume <decisions.md> --feedback "$(cat gap-report.md)"\n\`\`\`\n`;
  return md;
}

async function main() {
  const opts = parseArgs(process.argv);
  await validate(opts);
  const provider = opts.provider;

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = opts.output ? path.resolve(opts.output) : path.join("/tmp", `spec-${runId}`);
  await mkdir(outputDir, { recursive: true });

  const decisionsContent = await readFile(path.resolve(opts.decisions), "utf-8");
  const decisions = parseDecisionsFile(decisionsContent);

  if (decisions.length === 0) {
    console.error("decisions.md에 설계 결정이 없습니다.");
    process.exit(1);
  }

  let template = null;
  if (opts.template) {
    const content = (await readFile(path.resolve(opts.template), "utf-8")).trim();
    if (content.length > 0) template = content;
  }

  const cwd = opts.project ? path.resolve(opts.project) : null;

  process.stderr.write(`output: ${outputDir}/\n`);
  process.stderr.write(`decisions: ${decisions.length}개\n`);

  // 1단계: 요구사항 생성
  process.stderr.write(`\n── 요구사항 생성 중... ──\n`);
  let requirements;
  try {
    requirements = await generateRequirements(decisions, { template, cwd, provider });
  } catch (e) {
    if (e.message === "RATE_LIMITED") {
      console.error("rate limit 감지. 나중에 다시 시도하세요.");
      process.exit(1);
    }
    throw e;
  }

  const requirementsPath = path.join(outputDir, "requirements.md");
  await writeFile(requirementsPath, requirements);
  process.stderr.write(`요구사항 저장: ${requirementsPath}\n`);

  // 2단계: 검증
  process.stderr.write(`\n── 검증 중... ──\n`);
  let validation;
  try {
    validation = await validateRequirements(requirements, { cwd, provider });
  } catch (e) {
    if (e.message === "RATE_LIMITED") {
      console.error("rate limit 감지. 검증 건너뜀.");
      console.log(requirementsPath);
      process.exit(0);
    }
    process.stderr.write(`검증 실패: ${e.message}\n`);
    console.log(requirementsPath);
    process.exit(0);
  }

  if (validation.pass) {
    process.stderr.write(`검증 통과\n`);
  } else {
    const gaps = Array.isArray(validation.gaps) ? validation.gaps : [];
    const gapReport = formatGapReport(gaps);
    const gapReportPath = path.join(outputDir, "gap-report.md");
    await writeFile(gapReportPath, gapReport);
    process.stderr.write(`검증 미통과. gap-report: ${gapReportPath}\n`);
  }

  console.log(requirementsPath);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
