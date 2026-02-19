#!/usr/bin/env node
const { readFile, writeFile, mkdir, access, appendFile } = require("fs/promises");
const path = require("path");
const readline = require("readline");
const { llmText, llmJson } = require("./llm-spawn");
const {
  EXPECTED_GREENFIELD, EXPECTED_BROWNFIELD,
  computeCoverage, isFullyCovered,
  buildQuestionPrompt, formatDecisions, parseDecisionsFile,
} = require("./qna-core.js");

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

function qnaLlmOpts({ cwd, provider, allowTools }) {
  return {
    provider,
    model: provider === "claude" ? "sonnet" : undefined,
    cwd,
    allowTools: provider === "claude" ? (allowTools ?? (cwd ? "Read,Glob,Grep" : "")) : undefined,
  };
}

function spawnLlmJson(prompt, opts) {
  return llmJson(prompt, qnaLlmOpts(opts));
}

function spawnLlmText(prompt, opts) {
  return llmText(prompt, qnaLlmOpts(opts));
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
