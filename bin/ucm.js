#!/usr/bin/env node
const path = require("path");
const net = require("net");
const fs = require("fs");
const readline = require("readline");
const { readFile, writeFile, mkdir } = require("fs/promises");

const { SOCK_PATH, PID_PATH, DAEMON_DIR, FORGE_DIR, LOGS_DIR } = require("../lib/core/constants");
const { TaskDag } = require("../lib/core/task");

const USAGE = `ucm — UCM Forge CLI

Usage:
  ucm forge <description> [options]       태스크 실행
  ucm forge --file <file.md> [options]    파일에서 태스크 실행
  ucm resume <id> [--from <stage>]        중단된 태스크 재실행
  ucm list [--status <s>]                 태스크 목록
  ucm status <id>                         태스크 상세 상태
  ucm diff <id>                           변경사항 조회
  ucm logs <id> [--lines N]              로그 조회
  ucm approve <id>                        머지 승인
  ucm reject <id> [--feedback "..."]      수정 요청
  ucm abort <id>                          실행 중인 태스크 중단
  ucm gc [--days N]                       오래된 태스크 정리
  ucm analyze [--project <dir>]            프로젝트 분석 및 제안 생성
  ucm research [--project <dir>]           프로젝트 리서치 및 전략 제안
  ucm proposals [--status <s>]             제안 목록 조회
  ucm proposals approve <id>               제안 승인 (태스크 자동 생성)
  ucm proposals reject <id>                제안 반려
  ucm dashboard                           브라우저에서 대시보드 열기
  ucm daemon start                        데몬 시작
  ucm daemon stop                         데몬 종료

Options:
  --project <dir>      프로젝트 디렉토리 (기본: cwd)
  --pipeline <name>    파이프라인 (trivial|small|medium|large 또는 "stage1,stage2,...")
  --autopilot          사람 개입 없이 실행
  --background, --bg   daemon에 위임하여 백그라운드 실행
  --verbose, -v        에이전트 상세 출력 표시
  --budget <N>         최대 토큰 예산 (예: 500000)
  --from <stage>       resume 시 시작 stage
  --status <s>         필터 (pending|in_progress|done|failed|review)
  --feedback "..."     반려 시 피드백
  --lines <N>          로그 줄 수 (기본: 100)
  --days <N>           gc 대상 일 수 (기본: 30)
  --help               도움말

Workflows:
  reject → resume:
    ucm reject <id> --feedback "수정 필요한 사항"
    ucm resume <id>                       # 자동으로 implement부터 재실행
    ucm resume <id> --from design         # design부터 재실행`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (args[i] === "--project") { opts.project = args[++i]; }
    else if (args[i] === "--pipeline") { opts.pipeline = args[++i]; }
    else if (args[i] === "--autopilot") { opts.autopilot = true; }
    else if (args[i] === "--file") { opts.file = args[++i]; }
    else if (args[i] === "--status") {
      const val = args[++i];
      const validStatuses = ["pending", "in_progress", "done", "failed", "review", "rejected", "aborted"];
      if (!validStatuses.includes(val)) {
        console.error(`유효하지 않은 상태: ${val}\n허용 값: ${validStatuses.join(", ")}`);
        process.exit(1);
      }
      opts.status = val;
    }
    else if (args[i] === "--feedback") { opts.feedback = args[++i]; }
    else if (args[i] === "--lines") { opts.lines = parseInt(args[++i]) || 100; }
    else if (args[i] === "--from") { opts.from = args[++i]; }
    else if (args[i] === "--budget") { opts.budget = parseInt(args[++i]) || 0; }
    else if (args[i] === "--days") { opts.days = parseInt(args[++i]) || 30; }
    else if (args[i] === "--follow" || args[i] === "-f") { opts.follow = true; }
    else if (args[i] === "--watch" || args[i] === "-w") { opts.watch = true; }
    else if (args[i] === "--background" || args[i] === "--bg") { opts.background = true; }
    else if (args[i] === "--verbose" || args[i] === "-v") { opts.verbose = true; }
    else if (args[i].startsWith("-")) {
      console.error(`알 수 없는 옵션: ${args[i]}`);
      process.exit(1);
    } else {
      positional.push(args[i]);
    }
  }
  opts.command = positional[0];
  opts.positional = positional.slice(1);
  return opts;
}

const CLIENT_TIMEOUT_MS = 60_000;

function formatTime(isoString) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

function socketRequest(request) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK_PATH);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("TIMEOUT"));
    }, CLIENT_TIMEOUT_MS);

    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        clearTimeout(timer);
        const line = buffer.slice(0, newlineIndex);
        try {
          const response = JSON.parse(line);
          if (response.ok) resolve(response.data);
          else reject(new Error(response.error || "unknown error"));
        } catch (e) {
          reject(new Error(`parse error: ${e.message}`));
        }
        conn.end();
      }
    });

    conn.on("error", (e) => {
      clearTimeout(timer);
      conn.destroy();
      reject(e);
    });
  });
}

async function ensureDaemon() {
  try {
    await socketRequest({ method: "stats", params: {} });
    return;
  } catch (e) {
    if (e.code !== "ECONNREFUSED" && e.code !== "ENOENT" && e.message !== "TIMEOUT") {
      throw e;
    }
  }

  await mkdir(DAEMON_DIR, { recursive: true });
  try { fs.unlinkSync(SOCK_PATH); } catch {}
  try { fs.unlinkSync(PID_PATH); } catch {}

  const { spawn } = require("child_process");
  const serverPath = path.join(__dirname, "..", "lib", "ucmd.js");
  const logPath = path.join(DAEMON_DIR, "ucmd.log");
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [serverPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(child.pid));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "stats", params: {} });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  throw new Error("daemon failed to start");
}

// Interactive clarify: 사용자에게 질문을 표시하고 응답을 받음
function createQuestionHandler() {
  return async function onQuestion({ area, question, options }) {
    console.error(`\n  [${area}] ${question}`);
    for (let i = 0; i < options.length; i++) {
      console.error(`    ${i + 1}. ${options[i].label}`);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise((resolve) => {
      rl.question("  선택 (번호 또는 직접 입력): ", (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });

    const num = parseInt(answer);
    if (num >= 1 && num <= options.length) {
      return options[num - 1].label;
    }
    return answer;
  };
}

function createEventHandler(opts) {
  const pipelineStart = Date.now();
  let stageIndex = 0;

  function elapsed() {
    const sec = Math.round((Date.now() - pipelineStart) / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m${sec % 60}s`;
  }

  const STAGE_EST = {
    intake: "~1-5min", clarify: "~3-10min", specify: "~3-15min", decompose: "~3-10min",
    design: "~5-20min", implement: "~10-45min", verify: "~5-20min", polish: "~10-60min", integrate: "~5-20min", deliver: "~1-5min",
  };

  return (event, data) => {
    if (event === "stage:start") {
      stageIndex++;
      const est = STAGE_EST[data.stage] || "";
      console.error(`\n── [${elapsed()}] ${data.stage} (step ${stageIndex})${est ? " " + est : ""} ──`);
    } else if (event === "stage:complete") {
      const sec = Math.round(data.durationMs / 1000);
      console.error(`  ${data.status} (${sec}s)`);
    } else if (event === "gate:result") {
      console.error(`  [${data.gate}] ${data.result} (iteration ${data.iteration})`);
    } else if (event === "subtask:start") {
      console.error(`\n  >> subtask: ${data.subtaskId} — ${data.title}`);
    } else if (event === "subtask:complete") {
      console.error(`  << subtask: ${data.subtaskId} ${data.status}`);
    } else if (event === "agent:output") {
      const chunk = data.chunk || "";
      if (opts.verbose) {
        console.error(`  ${chunk.slice(0, 200)}`);
      } else if (chunk.startsWith("[tool]") || chunk.startsWith("[") || chunk.startsWith("---")) {
        console.error(`  ${chunk.slice(0, 120)}`);
      }
    } else if (event === "warning:budget") {
      console.error(`\n  !! budget ${data.percent}%: ${data.used}/${data.budget} tokens`);
    } else if (event === "notice:budget") {
      console.error(`  [budget] ${data.percent}%: ${data.used}/${data.budget} tokens`);
    } else if (event === "pipeline:error") {
      console.error(`\n[${elapsed()}] error: ${data.error}`);
    } else if (event === "pipeline:complete") {
      console.error(`\n[${elapsed()}] complete: ${data.status}`);
    }
  };
}

async function cmdForge(opts) {
  let input;
  if (opts.file) {
    input = await readFile(path.resolve(opts.file), "utf-8");
  } else if (opts.positional.length > 0) {
    input = opts.positional.join(" ");
  } else {
    console.error("태스크 설명 필수: ucm forge \"설명\" 또는 ucm forge --file <file.md>");
    process.exit(1);
  }

  const project = opts.project ? path.resolve(opts.project) : process.cwd();

  if (opts.pipeline && !["trivial", "small", "medium", "large"].includes(opts.pipeline)) {
    if (opts.pipeline.includes(",")) {
      const { STAGE_ARTIFACTS } = require("../lib/core/constants");
      const validStages = new Set(Object.keys(STAGE_ARTIFACTS));
      const stages = opts.pipeline.split(",").map((s) => s.trim());
      const invalid = stages.filter((s) => !validStages.has(s));
      if (invalid.length > 0) {
        console.error(`유효하지 않은 stage: ${invalid.join(", ")}`);
        process.exit(1);
      }
    } else {
      console.error(`유효하지 않은 파이프라인: ${opts.pipeline}`);
      process.exit(1);
    }
  }

  console.error(`forge: "${input.slice(0, 80)}..."`);
  console.error(`project: ${project}`);
  if (opts.pipeline) console.error(`pipeline: ${opts.pipeline}`);
  if (opts.autopilot) console.error(`mode: autopilot`);

  // --background: daemon에 위임하여 백그라운드 실행
  if (opts.background) {
    try {
      await ensureDaemon();
      const result = await socketRequest({
        method: "forge",
        params: {
          input,
          project,
          pipeline: opts.pipeline,
          autopilot: opts.autopilot,
          tokenBudget: opts.budget || 0,
        },
      });
      console.log(result.taskId);
      console.error("background task started. Use `ucm status <id>` or `ucm logs <id>` to monitor.");
      return;
    } catch (e) {
      console.error(`daemon 위임 실패, foreground로 실행합니다: ${e.message}`);
    }
  }

  const { forge } = require("../lib/forge/index");

  const { DEFAULT_TOKEN_BUDGET } = require("../lib/core/constants");
  const dag = await forge(input, {
    project,
    pipeline: opts.pipeline,
    autopilot: opts.autopilot,
    tokenBudget: opts.budget || DEFAULT_TOKEN_BUDGET,
    onEvent: createEventHandler(opts),
    onQuestion: opts.autopilot ? null : createQuestionHandler(),
  });

  // 토큰 사용량 표시
  if (dag.tokenUsage && (dag.tokenUsage.input > 0 || dag.tokenUsage.output > 0)) {
    console.error(`\ntokens: ${dag.tokenUsage.input} in / ${dag.tokenUsage.output} out`);
  }

  console.log(dag.id);
}

async function cmdResume(opts) {
  const taskId = opts.positional[0];
  if (!taskId) {
    console.error("task-id 필수: ucm resume <id> [--from <stage>]");
    process.exit(1);
  }

  const project = opts.project ? path.resolve(opts.project) : process.cwd();

  console.error(`resume: ${taskId}`);
  if (opts.from) console.error(`from: ${opts.from}`);

  // --background: daemon에 위임하여 백그라운드 실행
  if (opts.background) {
    try {
      await ensureDaemon();
      const result = await socketRequest({
        method: "resume",
        params: {
          taskId,
          project,
          fromStage: opts.from,
          autopilot: opts.autopilot,
          tokenBudget: opts.budget || 0,
        },
      });
      console.log(result.taskId);
      console.error("background resume started. Use `ucm status <id>` or `ucm logs <id>` to monitor.");
      return;
    } catch (e) {
      console.error(`daemon 위임 실패, foreground로 실행합니다: ${e.message}`);
    }
  }

  const { resume } = require("../lib/forge/index");

  const { DEFAULT_TOKEN_BUDGET } = require("../lib/core/constants");
  const dag = await resume(taskId, {
    project,
    fromStage: opts.from,
    autopilot: opts.autopilot,
    tokenBudget: opts.budget || DEFAULT_TOKEN_BUDGET,
    onEvent: createEventHandler(opts),
    onQuestion: opts.autopilot ? null : createQuestionHandler(),
  });

  if (dag.tokenUsage && (dag.tokenUsage.input > 0 || dag.tokenUsage.output > 0)) {
    console.error(`\ntokens: ${dag.tokenUsage.input} in / ${dag.tokenUsage.output} out`);
  }

  console.log(dag.id);
}

async function cmdList(opts) {
  let tasks;
  try {
    const result = await socketRequest({ method: "list", params: { status: opts.status } });
    tasks = result;
  } catch {
    tasks = await TaskDag.list();
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
  }
  const filtered = tasks;

  if (filtered.length === 0) {
    console.log("(no tasks)");
    return;
  }

  const grouped = {};
  for (const task of filtered) {
    const status = task.status;
    if (!grouped[status]) grouped[status] = [];
    grouped[status].push(task);
  }

  for (const [status, statusTasks] of Object.entries(grouped)) {
    console.log(`\n[${status}]`);
    for (const task of statusTasks) {
      const stage = (task.currentStage || "-").padEnd(10);
      const pipeline = (task.pipeline || "?").padEnd(8);
      const warnCount = (task.warnings || []).length;
      const warnings = (warnCount > 0 ? `!${warnCount}` : "").padEnd(4);
      const tokens = task.tokenUsage && (task.tokenUsage.input + task.tokenUsage.output) > 0
        ? `${Math.round((task.tokenUsage.input + task.tokenUsage.output) / 1000)}k`
        : "";
      const tokStr = tokens.padEnd(6);
      const title = task.title || "";
      console.log(`  ${task.id}  ${pipeline} ${stage} ${warnings} ${tokStr} ${title}`);
    }
  }
}

async function cmdStatus(opts) {
  const taskId = opts.positional[0];
  if (!taskId) {
    console.error("task-id 필수");
    process.exit(1);
  }

  const dag = await TaskDag.load(taskId);
  console.log(`id:        ${dag.id}`);
  console.log(`status:    ${dag.status}`);
  console.log(`pipeline:  ${dag.pipeline}`);
  if (dag.title) console.log(`title:     ${dag.title}`);
  console.log(`stage:     ${dag.currentStage || "-"}`);
  console.log(`created:   ${formatTime(dag.createdAt)} (${dag.createdAt})`);
  if (dag.startedAt) console.log(`started:   ${formatTime(dag.startedAt)} (${dag.startedAt})`);
  if (dag.completedAt) console.log(`completed: ${formatTime(dag.completedAt)} (${dag.completedAt})`);
  console.log(`warnings:  ${dag.warnings.length}`);
  if (dag.tokenUsage) {
    console.log(`tokens:    ${dag.tokenUsage.input} in / ${dag.tokenUsage.output} out`);
  }

  if (dag.stageHistory.length > 0) {
    console.log(`\nstages:`);
    for (const s of dag.stageHistory) {
      const sec = Math.round(s.durationMs / 1000);
      const tok = s.tokenUsage
        ? ` [${Math.round((s.tokenUsage.input + s.tokenUsage.output) / 1000)}k tok]`
        : "";
      console.log(`  ${s.stage}: ${s.status} (${sec}s)${tok}`);
    }
  }

  if (dag.tasks.length > 0) {
    console.log(`\nsubtasks:`);
    for (const t of dag.tasks) {
      const deps = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(", ")}]` : "";
      console.log(`  ${t.id}: ${t.status} — ${t.title}${deps}`);
    }
  }

  if (dag.warnings.length > 0) {
    console.log(`\nwarnings:`);
    for (const w of dag.warnings) {
      console.log(`  - ${w}`);
    }
  }

  const nextAction = getNextAction(dag);
  if (nextAction) {
    console.log(`\nnext: ${nextAction}`);
  }
}

function getNextAction(dag) {
  switch (dag.status) {
    case "review": return `ucm approve ${dag.id}  또는  ucm reject ${dag.id} --feedback "..."`;
    case "rejected": return `ucm resume ${dag.id}`;
    case "failed": return `ucm resume ${dag.id} --from ${dag.currentStage || "implement"}`;
    case "in_progress": return `ucm logs ${dag.id}  (진행 중)`;
    default: return null;
  }
}

async function cmdLogs(opts) {
  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const logPath = path.join(LOGS_DIR, `${taskId}.log`);
  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n");
    const limit = opts.lines || 100;
    console.log(lines.slice(-limit).join("\n"));
  } catch {
    console.log("(no logs)");
  }
}

async function cmdDiff(opts) {
  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const { getWorktreeDiff, loadWorkspace } = require("../lib/core/worktree");
  const workspace = await loadWorkspace(taskId);
  if (!workspace) {
    console.log("(no workspace)");
    return;
  }

  const diffs = await getWorktreeDiff(taskId, workspace.projects);
  for (const entry of diffs) {
    console.log(`\n=== ${entry.project} ===\n`);
    console.log(entry.diff);
  }
}

async function cmdApprove(opts) {
  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const { approve } = require("../lib/forge/deliver");
  const result = await approve(taskId);
  console.log(`approved: ${taskId} → ${result.status}`);
}

async function cmdReject(opts) {
  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const { reject } = require("../lib/forge/deliver");
  const result = await reject(taskId, opts.feedback);
  console.log(`rejected: ${taskId} → ${result.status}`);
  console.log(`resume with: ucm resume ${taskId}`);
}

async function cmdAbort(opts) {
  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수: ucm abort <id>"); process.exit(1); }

  const dag = await TaskDag.load(taskId);
  if (dag.status !== "in_progress") {
    console.error(`중단 불가: 현재 상태 ${dag.status}`);
    process.exit(1);
  }

  // worktree 정리
  const { removeWorktrees, loadWorkspace } = require("../lib/core/worktree");
  try {
    const workspace = await loadWorkspace(taskId);
    if (workspace) {
      await removeWorktrees(taskId, workspace.projects);
    }
  } catch {}

  dag.status = "aborted";
  dag.warnings.push("manually aborted by user");
  await dag.save();
  console.log(`aborted: ${taskId}`);
}

async function cmdGc(opts) {
  const { gcTasks } = require("../lib/core/worktree");
  const maxAgeDays = opts.days || 30;
  console.error(`cleaning up tasks older than ${maxAgeDays} days...`);
  const cleaned = await gcTasks({ maxAgeDays });
  if (cleaned.length === 0) {
    console.log("(nothing to clean)");
  } else {
    for (const id of cleaned) {
      console.log(`  removed: ${id}`);
    }
    console.log(`cleaned ${cleaned.length} task(s)`);
  }
}

async function cmdAnalyze(opts) {
  await ensureDaemon();
  const project = opts.project ? path.resolve(opts.project) : process.cwd();
  console.error(`analyzing ${path.basename(project)}...`);
  const result = await socketRequest({
    method: "analyze_project",
    params: { project },
  });
  if (result.error) {
    console.error(`error: ${result.error}`);
    return;
  }
  console.log(`${result.proposalCount} proposals created for ${result.project}`);
  if (result.proposals && result.proposals.length > 0) {
    for (const p of result.proposals) {
      console.log(`  ${p.id}  [${p.category}/${p.risk}]  ${p.title}`);
    }
  }
}

async function cmdResearch(opts) {
  await ensureDaemon();
  const project = opts.project ? path.resolve(opts.project) : process.cwd();
  console.error(`researching ${path.basename(project)}...`);
  const result = await socketRequest({
    method: "research_project",
    params: { project },
  });
  if (result.error) {
    console.error(`error: ${result.error}`);
    return;
  }
  console.log(`${result.proposalCount} proposals created`);
}

async function cmdProposals(opts) {
  await ensureDaemon();
  const subcommand = opts.positional[0];
  if (subcommand === "approve") {
    const proposalId = opts.positional[1];
    if (!proposalId) {
      console.error("proposal-id 필수: ucm proposals approve <id>");
      process.exit(1);
    }
    const result = await socketRequest({
      method: "proposal_approve",
      params: { proposalId },
    });
    console.log(`approved: ${proposalId} → task ${result.taskId}`);
  } else if (subcommand === "reject") {
    const proposalId = opts.positional[1];
    if (!proposalId) {
      console.error("proposal-id 필수: ucm proposals reject <id>");
      process.exit(1);
    }
    await socketRequest({
      method: "proposal_reject",
      params: { proposalId },
    });
    console.log(`rejected: ${proposalId}`);
  } else {
    const result = await socketRequest({
      method: "proposals",
      params: { status: subcommand || opts.status },
    });
    if (!result || result.length === 0) {
      console.log("(no proposals)");
      return;
    }
    for (const p of result) {
      const priority = p.priority ? ` p:${p.priority}` : "";
      console.log(`  [${p.status}] ${p.id}  [${p.category}/${p.risk}${priority}]  ${p.title}`);
    }
  }
}

async function cmdDaemon(opts) {
  const subcommand = opts.positional[0];
  if (subcommand === "start") {
    await ensureDaemon();
    console.log("daemon started");
  } else if (subcommand === "stop") {
    try {
      await socketRequest({ method: "shutdown", params: {} });
      console.log("daemon stopped");
    } catch {
      console.log("daemon not running");
    }
  } else {
    console.error("usage: ucm daemon <start|stop>");
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.command) {
    console.log(USAGE);
    process.exit(1);
  }

  switch (opts.command) {
    case "forge": await cmdForge(opts); break;
    case "resume": await cmdResume(opts); break;
    case "list": await cmdList(opts); break;
    case "status": await cmdStatus(opts); break;
    case "logs": await cmdLogs(opts); break;
    case "diff": await cmdDiff(opts); break;
    case "approve": await cmdApprove(opts); break;
    case "reject": await cmdReject(opts); break;
    case "abort": await cmdAbort(opts); break;
    case "gc": await cmdGc(opts); break;
    case "analyze": await cmdAnalyze(opts); break;
    case "research": await cmdResearch(opts); break;
    case "proposals": await cmdProposals(opts); break;
    case "daemon": await cmdDaemon(opts); break;
    case "dashboard": {
      try {
        await ensureDaemon();
      } catch (e) {
        console.error(`daemon 시작 실패: ${e.message}`);
        console.error("hint: `ucm daemon start`로 수동 시작하세요.");
        process.exit(1);
      }
      const { exec } = require("child_process");
      exec("open http://localhost:17172");
      console.log("opening dashboard...");
      break;
    }
    default:
      console.error(`알 수 없는 커맨드: ${opts.command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

const ERROR_HINTS = {
  "ECONNREFUSED": "데몬이 실행 중이지 않습니다. `ucm daemon start`로 시작하세요.",
  "ENOENT": "파일 또는 경로를 찾을 수 없습니다. 프로젝트 경로를 확인하세요.",
  "RATE_LIMITED": "API 요청 제한에 도달했습니다. 잠시 후 자동 재시도됩니다.",
  "task not found": "태스크를 찾을 수 없습니다. `ucm list`로 태스크 목록을 확인하세요.",
  "token budget exceeded": "토큰 예산을 초과했습니다. `ucm resume <id> --budget <더큰값>`으로 재시도하세요.",
  "worktree locked": "다른 작업이 진행 중입니다. `ucm list --status in_progress`로 확인하세요.",
  "daemon failed to start": "데몬 시작에 실패했습니다. 로그를 확인하세요: ~/.ucm/daemon/ucmd.log",
  "missing required artifacts": "이전 stage의 산출물이 없습니다. `ucm resume <id> --from <이전stage>`로 재시도하세요.",
  "merge conflict": "머지 충돌이 발생했습니다. worktree에서 수동 해결 후 `ucm resume <id> --from integrate`하세요.",
  "merge failed": "머지에 실패했습니다. `ucm diff <id>`로 변경사항을 확인하세요.",
  "spawn error": "LLM CLI를 실행할 수 없습니다. claude 또는 codex가 설치되어 있는지 확인하세요.",
  "unknown pipeline": "파이프라인 이름이 올바르지 않습니다. trivial|small|medium|large 또는 커스텀(stage1,stage2,...)을 사용하세요.",
  "unknown provider": "지원하지 않는 provider입니다. claude 또는 codex를 사용하세요.",
  "concurrent task limit": "동시 실행 가능한 태스크 수를 초과했습니다. UCM_MAX_CONCURRENT 환경변수로 조정할 수 있습니다.",
};

main().catch(async (e) => {
  const msg = e.message || String(e);
  const hint = Object.entries(ERROR_HINTS).find(([key]) => msg.includes(key));
  if (hint) {
    console.error(`error: ${msg}\nhint: ${hint[1]}`);
  } else {
    console.error(`error: ${msg}`);
  }

  // U-2: 실패 시 복구 안내 — taskId를 추출하여 next action 제안
  const taskIdMatch = msg.match(/forge-\d{8}-[a-f0-9]+/);
  if (taskIdMatch) {
    try {
      const dag = await TaskDag.load(taskIdMatch[0]);
      const next = getNextAction(dag);
      if (next) console.error(`next: ${next}`);
    } catch {}
  }

  process.exit(1);
});
