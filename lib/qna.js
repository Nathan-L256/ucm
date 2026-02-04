#!/usr/bin/env node
const { spawn } = require("child_process");
const { readFile, writeFile, mkdir, access, appendFile } = require("fs/promises");
const path = require("path");
const readline = require("readline");

const USAGE = `qna — 템플릿 기반 객관식 Q&A로 설계 결정 수집

Usage:
  node qna.js [options]
  node qna.js --template <file> [options]
  node qna.js --resume <file> [options]

Options:
  --template <file>    설계 템플릿 파일 (없으면 일반 소프트웨어 설계 질문)
  --resume <file>      이전 decisions.md 이어서 진행 (--template 과 동시 사용 불가)
  --project <dir>      프로젝트 디렉토리 (브라운필드: LLM이 코드 스캔)
  --feedback <text>    추가 컨텍스트/피드백
  --output <dir>       결과 저장 디렉토리 (기본: /tmp/qna-<timestamp>/)
  --provider <name>    실행 제공자 (claude|codex, 기본: LLM_PROVIDER 또는 claude)
  --help               도움말 출력`;

const MAX_ROUNDS = 20;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--template": opts.template = args[++i]; break;
      case "--resume": opts.resume = args[++i]; break;
      case "--project": opts.project = args[++i]; break;
      case "--feedback": opts.feedback = args[++i]; break;
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
  if (opts.template && opts.resume) errors.push("--template 과 --resume 동시 사용 불가");
  if (opts.template) {
    try { await access(path.resolve(opts.template)); }
    catch { errors.push(`템플릿 파일 없음: ${opts.template}`); }
  }
  if (opts.resume) {
    try { await access(path.resolve(opts.resume)); }
    catch { errors.push(`resume 파일 없음: ${opts.resume}`); }
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

function spawnLlmJson(prompt, { cwd, provider, allowTools }) {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : undefined,
      cwd,
      allowTools: provider === "claude" ? (allowTools ?? (cwd ? "Read,Glob,Grep" : "")) : undefined,
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

function spawnLlmText(prompt, { cwd, provider, allowTools }) {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : undefined,
      cwd,
      allowTools: provider === "claude" ? (allowTools ?? (cwd ? "Read,Glob,Grep" : "")) : undefined,
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
      resolve(out.trim());
    });
    child.on("error", reject);
  });
}

const EXPECTED_GREENFIELD = { "제품 정의": 4, "핵심 기능": 2, "기술 스택": 1, "설계 결정": 2 };
const EXPECTED_BROWNFIELD = { "작업 목표": 2, "변경 범위": 2, "설계 결정": 2 };

function computeCoverage(decisions, isBrownfield) {
  const expected = isBrownfield ? EXPECTED_BROWNFIELD : EXPECTED_GREENFIELD;
  const coverage = {};
  for (const [area, count] of Object.entries(expected)) {
    const answered = decisions.filter((d) => d.area === area).length;
    coverage[area] = Math.min(1.0, answered / count);
  }
  return coverage;
}

function isFullyCovered(coverage) {
  return Object.values(coverage).every((v) => v >= 1.0);
}

function buildQuestionPrompt(template, decisions, feedback, { isResume, isBrownfield, coverage, repoContext }) {
  const expected = isBrownfield ? EXPECTED_BROWNFIELD : EXPECTED_GREENFIELD;
  const areas = Object.keys(expected);

  let prompt = `당신은 소프트웨어 설계 의사결정을 돕는 인터뷰어입니다.
사용자에게 객관식 질문을 하나씩 제시하여 핵심 설계 결정을 수집합니다.

## 규칙

1. 한 번에 질문 하나만 합니다.
2. 각 질문에 3-4개 선택지를 제공합니다. 각 선택지에 이유를 포함합니다.
3. 이미 수집된 결정을 반드시 확인하고, 같은 내용이나 이미 답변에서 언급된 내용을 다시 묻지 마세요.
4. 사용자의 이전 답변에 포함된 정보(도구명, 방식, 제약사항 등)를 기억하고 활용하세요.
5. "직접 입력하겠습니다" 같은 메타 선택지를 만들지 마세요. 사용자는 항상 번호 대신 자유 텍스트를 입력할 수 있습니다.
6. 규모가 "프로토타입" 또는 "개인 프로젝트"이면 설계 결정 영역은 최대 2-3개 질문으로 끝냅니다.
7. 아래 현재 커버리지를 보고, 부족한 영역을 우선 질문하세요.
8. 모든 영역이 충분히 커버되었다고 판단하면 done: true로 응답합니다.

## 고정 영역

${areas.map((a) => `- ${a} (기대 질문 수: ${expected[a]})`).join("\n")}

이 영역 이름만 사용하세요. 다른 이름을 만들지 마세요.

## 현재 커버리지

${Object.entries(coverage).map(([a, v]) => `- ${a}: ${Math.round(v * 100)}%`).join("\n")}

## 응답 형식 (JSON만 출력)

{
  "question": "질문 텍스트",
  "options": [
    { "label": "선택지 텍스트", "reason": "이 선택이 적합한 이유" }
  ],
  "area": "위 고정 영역 중 하나",
  "done": false
}

모든 영역이 충분히 커버되었으면:
{ "done": true }`;

  if (isBrownfield) {
    prompt += `\n\n## 브라운필드 모드

이 프로젝트는 기존 코드베이스가 있습니다.
`;

    if (repoContext) {
      prompt += `
### 스캔 요약 (이미 수행됨)

아래 요약을 참고하여 질문을 생성하세요.
**추가 스캔/파일 읽기를 하지 마세요.**

${repoContext}
`;
    } else {
      prompt += `
### 코드 스캔 (필수)

질문을 생성하기 전에 반드시:
1. Glob 도구로 프로젝트의 파일 구조를 확인하세요.
2. Read 도구로 핵심 파일(README, package.json, 주요 소스 등)을 읽으세요.
3. 기존 기술 스택, 아키텍처, 패턴을 파악하세요.
`;
    }

    prompt += `
### 질문 흐름 (엄수)

1. **Q1 — 작업 대상 (작업 목표)**: 코드 스캔에서 발견한 모듈/파일을 선택지로 나열.
   예: "어떤 모듈을 작업하시나요?" → 선택지: "prl.js (병렬 실행)", "rsa.js (파이프라인)", ...
2. **Q2 — 작업 유형 (작업 목표)**: 선택된 모듈에 대해 구체적으로 무엇을 할 건지.
   예: "prl.js에서 어떤 작업을 하시나요?" → 선택지: "에러 처리 개선", "새 옵션 추가", ...
3. **Q3~ — 변경 범위**: 해당 모듈의 어떤 부분을, 얼마나 바꿀 건지.
   선택지에 실제 함수명, 패턴명 등 코드에서 읽은 구체적 정보를 포함하세요.
4. **설계 결정**: 변경 범위가 확정된 후, 구현 방식에 대한 질문.

### 금지사항

- "무엇을 만드는가"를 묻지 마세요. 코드를 읽으면 알 수 있습니다.
- 기술 스택은 코드에서 읽은 것을 사실로 취급하고 묻지 마세요.
- 추상적 선택지 금지. 선택지에 반드시 코드에서 발견한 구체적 이름(파일, 함수, 패턴)을 포함하세요.
- 작업 목표 영역에 3개 이상 질문 금지. 목표 확인은 1-2개 질문으로 끝내세요.`;
  }

  if (template) {
    prompt += `\n\n## 설계 템플릿\n\n${template}`;
  } else {
    prompt += `\n\n## 템플릿 없음\n\n일반적인 소프트웨어 설계 영역에 대해 질문하세요.`;
  }

  if (decisions.length > 0) {
    prompt += `\n\n## 지금까지 수집된 결정 (절대 같은 내용을 다시 묻지 마세요)\n\n`;
    for (const d of decisions) {
      prompt += `- **[${d.area}]** ${d.question} → ${d.answer}\n`;
    }
  }

  if (feedback) {
    prompt += `\n\n## 추가 컨텍스트\n\n${feedback}`;
  }

  prompt += `\n\n반드시 JSON만 출력하세요.`;
  return prompt;
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

function formatDecisions(decisions, coverage) {
  const byArea = {};
  for (const d of decisions) {
    if (!byArea[d.area]) byArea[d.area] = [];
    byArea[d.area].push(d);
  }

  let md = `# 설계 결정\n\n`;

  if (coverage && Object.keys(coverage).length > 0) {
    md += `## 커버리지\n\n`;
    for (const [area, value] of Object.entries(coverage)) {
      const pct = Math.round(value * 100);
      const bar = "█".repeat(Math.round(value * 10)) + "░".repeat(10 - Math.round(value * 10));
      md += `- ${area}: ${bar} ${pct}%\n`;
    }
    md += `\n`;
  }

  md += `## 결정 사항\n\n`;
  for (const [area, items] of Object.entries(byArea)) {
    md += `### ${area}\n\n`;
    for (const d of items) {
      md += `- **Q:** ${d.question}\n`;
      md += `  - **A:** ${d.answer}\n`;
      if (d.reason) {
        md += `  - **이유:** ${d.reason}\n`;
      }
    }
    md += `\n`;
  }

  return md;
}

function createReader() {
  const isPipe = !process.stdin.isTTY;

  if (isPipe) {
    const lines = [];
    let lineIndex = 0;
    const linesReady = new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => lines.push(line));
      rl.on("close", () => resolve());
    });
    return {
      async ask(question, options) {
        await linesReady;
        displayQuestion(question, options);
        const input = lineIndex < lines.length ? lines[lineIndex++] : "/done";
        process.stderr.write(`  > ${input}\n`);
        return parseAnswer(input, options);
      },
      close() {},
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return {
    ask(question, options) {
      return new Promise((resolve) => {
        displayQuestion(question, options);
        rl.question("  > ", (input) => resolve(parseAnswer(input, options)));
      });
    },
    close() { rl.close(); },
  };
}

function displayQuestion(question, options) {
  process.stderr.write(`\n${question}\n\n`);
  options.forEach((opt, i) => {
    process.stderr.write(`  ${i + 1}) ${opt.label}\n`);
    process.stderr.write(`     ${opt.reason}\n`);
  });
  process.stderr.write(`\n  번호 선택, 직접 입력, 또는 /done\n`);
}

function parseAnswer(input, options) {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === "/done") return { type: "done" };
  const num = parseInt(trimmed);
  if (num >= 1 && num <= options.length) {
    return { type: "choice", value: options[num - 1].label, reason: options[num - 1].reason };
  }
  if (trimmed.length > 0) return { type: "custom", value: trimmed, reason: "" };
  return { type: "choice", value: options[0].label, reason: options[0].reason };
}

function printCoverage(coverage) {
  if (!coverage || Object.keys(coverage).length === 0) return;
  process.stderr.write("\n  커버리지:\n");
  for (const [area, value] of Object.entries(coverage)) {
    const pct = Math.round(value * 100);
    const bar = "█".repeat(Math.round(value * 10)) + "░".repeat(10 - Math.round(value * 10));
    process.stderr.write(`    ${area}: ${bar} ${pct}%\n`);
  }
}

async function saveProgress(outputDir, decisions, coverage) {
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "decisions.md");
  await writeFile(outputPath, formatDecisions(decisions, coverage));
  return outputPath;
}

async function appendLog(logPath, entry) {
  await appendFile(logPath, JSON.stringify(entry) + "\n");
}

async function loadRepoContext({ cwd, provider, outputDir, resumePath }) {
  const candidates = [];
  if (resumePath) candidates.push(path.join(path.dirname(resumePath), "repo-context.md"));
  candidates.push(path.join(outputDir, "repo-context.md"));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      const content = (await readFile(candidate, "utf-8")).trim();
      if (content.length > 0) return content;
    } catch {}
  }

  const prompt = `당신은 코드베이스를 요약하는 분석가입니다.
로컬 저장소를 **한 번만** 스캔하여 아래 형식으로 요약하세요. 과도하게 길게 쓰지 마세요.

## 출력 형식 (Markdown)
- Summary: 프로젝트 성격과 범위를 3~5문장으로 요약
- Tech Stack: 언어/프레임워크/빌드/테스트/배포 관련 핵심만 나열
- Key Files: README, 설정 파일, 주요 엔트리포인트 등 핵심 파일 목록
- Module/Area Candidates: 질문 선택지로 쓸 수 있는 모듈/폴더/파일 후보 8~15개

규칙:
- 근거가 되는 파일 경로를 괄호로 표시
- 추측은 “추정”으로 표시
- 결과는 한국어로 작성`;

  const context = await spawnLlmText(prompt, {
    cwd,
    provider,
    allowTools: "Read,Glob,Grep",
  });

  const outPath = path.join(outputDir, "repo-context.md");
  await writeFile(outPath, context + "\n");
  return context;
}

async function main() {
  const opts = parseArgs(process.argv);
  await validate(opts);
  const provider = opts.provider;

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = opts.output ? path.resolve(opts.output) : path.join("/tmp", `qna-${runId}`);
  await mkdir(outputDir, { recursive: true });

  const logPath = path.join(outputDir, "conversation.jsonl");

  let template = null;
  if (opts.template) {
    const content = (await readFile(path.resolve(opts.template), "utf-8")).trim();
    if (content.length > 0) template = content;
  }

  let decisions = [];
  if (opts.resume) {
    const content = await readFile(path.resolve(opts.resume), "utf-8");
    decisions = parseDecisionsFile(content);
    process.stderr.write(`${decisions.length}개 기존 결정 로드됨\n`);
  }

  const isBrownfield = !!opts.project;
  const cwd = opts.project ? path.resolve(opts.project) : null;
  process.stderr.write(`output: ${outputDir}/\n`);

  await appendLog(logPath, { type: "start", timestamp: new Date().toISOString(), template: opts.template || null, project: opts.project || null, feedback: opts.feedback || null, resumeDecisions: decisions.length });

  let repoContext = null;
  if (isBrownfield) {
    process.stderr.write(`스캔 컨텍스트 준비 중...\n`);
    try {
      repoContext = await loadRepoContext({
        cwd,
        provider,
        outputDir,
        resumePath: opts.resume ? path.resolve(opts.resume) : null,
      });
      await appendLog(logPath, { type: "repo_context", timestamp: new Date().toISOString(), length: repoContext.length });
    } catch (e) {
      process.stderr.write(`컨텍스트 생성 실패: ${e.message}\n`);
    }
  }

  const handleInterrupt = async () => {
    process.stderr.write("\n\n중단됨. 진행 상황 저장 중...\n");
    await appendLog(logPath, { type: "interrupt", timestamp: new Date().toISOString() });
    const savedPath = await saveProgress(outputDir, decisions, computeCoverage(decisions, isBrownfield));
    process.stderr.write(`저장 완료: ${savedPath}\n`);
    process.stderr.write(`이어서 진행하려면:\n  node qna.js --resume ${savedPath}\n`);
    process.exit(0);
  };
  process.on("SIGINT", handleInterrupt);

  const reader = createReader();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const coverage = computeCoverage(decisions, isBrownfield);

    if (isFullyCovered(coverage)) {
      process.stderr.write("\n모든 주요 설계 영역이 커버되었습니다.\n");
      printCoverage(coverage);
      break;
    }

    const prompt = buildQuestionPrompt(template, decisions, opts.feedback, { isResume: !!opts.resume, isBrownfield, coverage, repoContext });

    process.stderr.write(`\n── 질문 ${round + 1} 생성 중... ──\n`);

    let response;
    try {
      response = await spawnLlmJson(prompt, {
        cwd,
        provider,
        allowTools: repoContext ? "" : undefined,
      });
    } catch (e) {
      if (e.message === "RATE_LIMITED") {
        process.stderr.write("\nrate limit 감지. 진행 상황 저장 중...\n");
        await appendLog(logPath, { type: "rate_limited", timestamp: new Date().toISOString() });
        const savedPath = await saveProgress(outputDir, decisions, computeCoverage(decisions, isBrownfield));
        process.stderr.write(`저장 완료: ${savedPath}\n`);
        process.stderr.write(`이어서 진행하려면:\n  node qna.js --resume ${savedPath}\n`);
        reader.close();
        process.exit(1);
      }
      throw e;
    }

    const responseType = provider === "claude" ? "claude_response" : "llm_response";
    await appendLog(logPath, { type: responseType, provider, round: round + 1, timestamp: new Date().toISOString(), response });

    if (response.done) {
      process.stderr.write("\nLLM이 충분히 커버되었다고 판단했습니다.\n");
      printCoverage(coverage);
      break;
    }

    if (!response.question || !response.options || response.options.length < 2) {
      process.stderr.write("유효하지 않은 응답, 재시도...\n");
      continue;
    }

    const answer = await reader.ask(response.question, response.options);

    await appendLog(logPath, { type: "user_answer", round: round + 1, timestamp: new Date().toISOString(), question: response.question, answer });

    if (answer.type === "done") {
      process.stderr.write("\n사용자 종료.\n");
      break;
    }

    decisions.push({
      area: response.area || "기타",
      question: response.question,
      answer: answer.value,
      reason: answer.reason || "",
    });

    printCoverage(computeCoverage(decisions, isBrownfield));
  }

  reader.close();

  const finalCoverage = computeCoverage(decisions, isBrownfield);
  const decisionsPath = await saveProgress(outputDir, decisions, finalCoverage);
  await appendLog(logPath, { type: "decisions_saved", timestamp: new Date().toISOString(), decisionsCount: decisions.length, outputPath: decisionsPath });
  process.stderr.write(`\n결과 저장: ${decisionsPath}\n`);

  console.log(decisionsPath);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
