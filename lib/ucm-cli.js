#!/usr/bin/env node
const { spawn, execFileSync } = require("child_process");
const { readFile, writeFile, mkdir, rm, cp } = require("fs/promises");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");

const {
  SOCK_PATH, PID_PATH, LOG_PATH, UCM_DIR, TASKS_DIR, SOURCE_ROOT,
  SOCKET_READY_TIMEOUT_MS, SOCKET_POLL_INTERVAL_MS, CLIENT_TIMEOUT_MS,
  parseTaskFile, cleanStaleFiles, readPid, isProcessAlive,
} = require("./ucmd.js");
const { createSocketClient } = require("./socket-client.js");

const DAEMON_DIR = path.join(UCM_DIR, "daemon");

const USAGE = `ucm — UCM CLI

Usage:
  ucm submit <file.md>                         태스크 파일 제출
  ucm submit --project <dir> --title "..."     인라인 태스크 제출 (stdin으로 본문)
  ucm list [--status <s>] [--project <dir>]    태스크 목록
  ucm status <task-id>                         태스크 상태 조회
  ucm approve <task-id>                        태스크 승인 (merge)
  ucm reject <task-id> [--feedback "..."]      태스크 반려
  ucm cancel <task-id>                         태스크 취소
  ucm diff <task-id>                           변경사항 조회
  ucm logs <task-id> [--lines N]               로그 조회
  ucm pause                                    데몬 일시정지
  ucm resume                                   데몬 재개
  ucm stats                                    통계 조회
  ucm observe                                  수동 관찰 트리거
  ucm observe --status                         마지막 관찰 사이클 정보
  ucm proposals [--status <s>]                 제안 목록
  ucm proposal approve <id>                    제안 승인
  ucm proposal reject <id>                     제안 거부
  ucm proposal up <id>                         제안 우선순위 올림
  ucm proposal down <id>                       제안 우선순위 내림
  ucm proposal eval <id>                       제안 평가 결과 조회
  ucm chat                                     대화형 AI 관리 모드
  ucm ui [--port N] [--dev]                    대시보드 UI 서버 시작
  ucm release                                  릴리즈 배포 (~/.ucm/release/)

Options:
  --status <s>       필터: pending, running, review, done, failed
  --project <dir>    프로젝트 디렉토리
  --title "..."      태스크 제목
  --priority <N>     우선순위 (기본: 0)
  --feedback "..."   반려 시 피드백
  --lines <N>        로그 출력 줄 수 (기본: 100)
  --port <N>         UI 서버 포트 (기본: 17172)
  --dev              프론트엔드 개발 모드
  --help             도움말`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (args[i] === "--status") { opts.status = args[++i]; }
    else if (args[i] === "--project") { opts.project = args[++i]; }
    else if (args[i] === "--title") { opts.title = args[++i]; }
    else if (args[i] === "--priority") { opts.priority = parseInt(args[++i]) || 0; }
    else if (args[i] === "--feedback") { opts.feedback = args[++i]; }
    else if (args[i] === "--lines") { opts.lines = parseInt(args[++i]) || 100; }
    else if (args[i] === "--score") { opts.score = parseInt(args[++i]); }
    else if (args[i] === "--port") { opts.port = parseInt(args[++i]) || 17172; }
    else if (args[i] === "--dev") { opts.dev = true; }
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

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

// ── Socket Communication ──

const socketRequest = createSocketClient(SOCK_PATH, CLIENT_TIMEOUT_MS);

async function ensureDaemon() {
  try {
    await socketRequest({ method: "stats", params: {} });
    return;
  } catch (e) {
    if (e.code !== "ECONNREFUSED" && e.code !== "ENOENT" && e.message !== "TIMEOUT") {
      throw e;
    }
  }

  // start daemon
  await cleanStaleFiles();
  await mkdir(DAEMON_DIR, { recursive: true });

  const ucmdPath = path.join(__dirname, "ucmd.js");
  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  await writeFile(PID_PATH, String(child.pid));

  // wait for socket
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await socketRequest({ method: "stats", params: {} });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
    }
  }

  throw new Error("daemon failed to start");
}

// ── Command Handlers ──

async function cmdSubmit(opts) {
  await ensureDaemon();

  const fileArg = opts.positional[0];

  if (fileArg) {
    // submit from file
    const content = await readFile(path.resolve(fileArg), "utf-8");
    const result = await socketRequest({
      method: "submit",
      params: { taskFile: content },
    });
    console.log(`submitted: ${result.id} — ${result.title}`);
    return;
  }

  // inline submit
  if (!opts.title) {
    console.error("--title 필수 (또는 태스크 파일 지정)");
    process.exit(1);
  }
  if (!opts.project) {
    console.error("--project 필수");
    process.exit(1);
  }

  const body = await readStdin();
  const result = await socketRequest({
    method: "submit",
    params: {
      title: opts.title,
      body,
      project: path.resolve(opts.project),
      priority: opts.priority,
    },
  });
  console.log(`submitted: ${result.id} — ${result.title}`);
}

async function cmdList(opts) {
  await ensureDaemon();

  const tasks = await socketRequest({
    method: "list",
    params: {
      status: opts.status,
      project: opts.project,
    },
  });

  if (tasks.length === 0) {
    console.log("(no tasks)");
    return;
  }

  // group by state
  const grouped = {};
  for (const task of tasks) {
    const state = task.state || task.status || "unknown";
    if (!grouped[state]) grouped[state] = [];
    grouped[state].push(task);
  }

  for (const [state, stateTasks] of Object.entries(grouped)) {
    console.log(`\n[${state}]`);
    for (const task of stateTasks) {
      const project = task.project ? ` (${path.basename(task.project)})` : "";
      console.log(`  ${task.id}  ${task.title}${project}`);
    }
  }
}

async function cmdStatus(opts) {
  await ensureDaemon();

  const taskId = opts.positional[0];
  if (!taskId) {
    // daemon status
    const status = await socketRequest({ method: "status", params: {} });
    console.log(`pid:          ${status.pid}`);
    console.log(`uptime:       ${formatUptime(status.uptime)}`);
    console.log(`status:       ${status.daemonStatus}`);
    if (status.pausedAt) console.log(`paused at:    ${status.pausedAt}`);
    if (status.pauseReason) console.log(`pause reason: ${status.pauseReason}`);
    console.log(`active tasks: ${status.activeTasks.length}`);
    console.log(`queue:        ${status.queueLength}`);
    console.log(`completed:    ${status.tasksCompleted}`);
    console.log(`failed:       ${status.tasksFailed}`);
    console.log(`total spawns: ${status.totalSpawns}`);
    return;
  }

  const task = await socketRequest({ method: "status", params: { taskId } });
  console.log(`id:      ${task.id}`);
  console.log(`title:   ${task.title}`);
  console.log(`status:  ${task.state || task.status}`);
  if (task.project) console.log(`project: ${task.project}`);
  if (task.created) console.log(`created: ${task.created}`);
  if (task.startedAt) console.log(`started: ${task.startedAt}`);
  if (task.completedAt) console.log(`done:    ${task.completedAt}`);
}

async function cmdApprove(opts) {
  await ensureDaemon();

  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const params = { taskId };
  if (opts.score !== undefined) params.score = opts.score;
  const result = await socketRequest({ method: "approve", params });
  console.log(`approved: ${result.id} → ${result.status}`);
}

async function cmdReject(opts) {
  await ensureDaemon();

  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const result = await socketRequest({
    method: "reject",
    params: { taskId, feedback: opts.feedback },
  });
  console.log(`rejected: ${result.id} → ${result.status}`);
}

async function cmdCancel(opts) {
  await ensureDaemon();

  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const result = await socketRequest({ method: "cancel", params: { taskId } });
  console.log(`cancelled: ${result.id}`);
}

async function cmdDiff(opts) {
  await ensureDaemon();

  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const diffs = await socketRequest({ method: "diff", params: { taskId } });
  for (const entry of diffs) {
    console.log(`\n=== ${entry.project} ===\n`);
    console.log(entry.diff);
  }
}

async function cmdLogs(opts) {
  await ensureDaemon();

  const taskId = opts.positional[0];
  if (!taskId) { console.error("task-id 필수"); process.exit(1); }

  const logs = await socketRequest({
    method: "logs",
    params: { taskId, lines: opts.lines },
  });
  console.log(logs);
}

async function cmdPause() {
  await ensureDaemon();
  const result = await socketRequest({ method: "pause", params: {} });
  console.log(`daemon ${result.status}`);
}

async function cmdResume() {
  await ensureDaemon();
  const result = await socketRequest({ method: "resume", params: {} });
  console.log(`daemon ${result.status}`);
}

async function cmdStats() {
  await ensureDaemon();
  const stats = await socketRequest({ method: "stats", params: {} });
  console.log(`pid:          ${stats.pid}`);
  console.log(`uptime:       ${formatUptime(stats.uptime)}`);
  console.log(`status:       ${stats.daemonStatus}`);
  console.log(`active tasks: ${stats.activeTasks.length}`);
  console.log(`queue:        ${stats.queueLength}`);
  console.log(`completed:    ${stats.tasksCompleted}`);
  console.log(`failed:       ${stats.tasksFailed}`);
  console.log(`total spawns: ${stats.totalSpawns}`);
}

async function cmdObserve(opts) {
  await ensureDaemon();

  if (opts.status) {
    const status = await socketRequest({ method: "observe_status", params: {} });
    console.log(`cycle:          ${status.cycle}`);
    console.log(`last run:       ${status.lastRunAt || "(never)"}`);
    console.log(`enabled:        ${status.observerConfig.enabled}`);
    console.log(`interval:       ${status.observerConfig.intervalMs / 1000}s`);
    console.log(`task trigger:   ${status.observerConfig.taskCountTrigger}`);
    if (status.latestSnapshot) {
      console.log(`\nlatest snapshot:`);
      console.log(`  timestamp:    ${status.latestSnapshot.timestamp}`);
      console.log(`  tasks:        ${status.latestSnapshot.taskCount ?? "-"}`);
      console.log(`  success rate: ${status.latestSnapshot.successRate != null ? (status.latestSnapshot.successRate * 100).toFixed(1) + "%" : "-"}`);
    }
    return;
  }

  console.log("running observer...");
  const result = await socketRequest({ method: "observe", params: {} });
  console.log(`cycle ${result.cycle}: ${result.proposalCount} proposal(s) created`);
  if (result.error) console.log(`error: ${result.error}`);
}

async function cmdProposals(opts) {
  await ensureDaemon();

  const proposals = await socketRequest({
    method: "proposals",
    params: { status: opts.status },
  });

  if (proposals.length === 0) {
    console.log("(no proposals)");
    return;
  }

  const grouped = {};
  for (const proposal of proposals) {
    const status = proposal.status || "unknown";
    if (!grouped[status]) grouped[status] = [];
    grouped[status].push(proposal);
  }

  for (const [status, statusProposals] of Object.entries(grouped)) {
    console.log(`\n[${status}]`);
    for (const proposal of statusProposals) {
      const priority = proposal.priority ? ` (priority: ${proposal.priority})` : "";
      const project = proposal.project ? ` → ${path.basename(proposal.project)}` : "";
      const verdict = proposal.evaluation?.verdict ? ` [${proposal.evaluation.verdict}]` : "";
      console.log(`  ${proposal.id}  [${proposal.category}/${proposal.risk}] ${proposal.title}${project}${priority}${verdict}`);
    }
  }
}

async function cmdProposal(opts) {
  await ensureDaemon();

  const subcommand = opts.positional[0];
  const proposalId = opts.positional[1];

  if (!subcommand || !proposalId) {
    console.error("usage: ucm proposal <approve|reject|up|down|eval> <id>");
    process.exit(1);
  }

  switch (subcommand) {
    case "eval": {
      const result = await socketRequest({
        method: "proposal_evaluate",
        params: { proposalId },
      });
      console.log(`proposal: ${result.proposalId} (${result.status})`);
      if (result.evaluation) {
        console.log(`verdict:  ${result.evaluation.verdict} (score: ${result.evaluation.score})`);
        const d = result.evaluation.delta;
        if (d) {
          if (d.successRate != null) console.log(`  successRate:  ${d.successRate > 0 ? "+" : ""}${(d.successRate * 100).toFixed(1)}%`);
          if (d.firstPassRate != null) console.log(`  firstPassRate: ${d.firstPassRate > 0 ? "+" : ""}${(d.firstPassRate * 100).toFixed(1)}%`);
          if (d.avgPipelineDurationMs != null) console.log(`  avgDuration:  ${d.avgPipelineDurationMs > 0 ? "+" : ""}${d.avgPipelineDurationMs}ms`);
        }
      } else {
        console.log("(no evaluation yet)");
      }
      break;
    }
    case "approve": {
      const result = await socketRequest({
        method: "proposal_approve",
        params: { proposalId },
      });
      console.log(`approved: ${result.proposalId}`);
      if (result.taskId) console.log(`task created: ${result.taskId}`);
      break;
    }
    case "reject": {
      const result = await socketRequest({
        method: "proposal_reject",
        params: { proposalId },
      });
      console.log(`rejected: ${result.proposalId}`);
      break;
    }
    case "up": {
      const result = await socketRequest({
        method: "proposal_priority",
        params: { proposalId, delta: 10 },
      });
      console.log(`${result.proposalId}: priority → ${result.priority}`);
      break;
    }
    case "down": {
      const result = await socketRequest({
        method: "proposal_priority",
        params: { proposalId, delta: -10 },
      });
      console.log(`${result.proposalId}: priority → ${result.priority}`);
      break;
    }
    default:
      console.error(`알 수 없는 서브커맨드: ${subcommand}`);
      console.error("usage: ucm proposal <approve|reject|up|down> <id>");
      process.exit(1);
  }
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// ── Release ──

async function cmdRelease() {
  const releaseDir = path.join(os.homedir(), ".ucm", "release");
  const releaseSockPath = path.join(os.homedir(), ".ucm", "daemon", "ucm.sock");

  console.log(`릴리즈 배포: ${releaseDir}`);

  // clean and recreate release dir
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  // copy source directories and files
  const items = ["bin", "lib", "templates", "skill", "scripts", "package.json", "package-lock.json"];
  for (const item of items) {
    const src = path.join(SOURCE_ROOT, item);
    const dst = path.join(releaseDir, item);
    try {
      await cp(src, dst, { recursive: true });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  console.log("파일 복사 완료");

  // npm install --production
  execFileSync("npm", ["install", "--production"], {
    cwd: releaseDir,
    stdio: "inherit",
  });
  console.log("npm install 완료");

  // shutdown existing release daemon if running
  try {
    await new Promise((resolve, reject) => {
      const conn = net.createConnection(releaseSockPath);
      conn.on("connect", () => {
        conn.write(JSON.stringify({ id: "shutdown", method: "shutdown", params: {} }) + "\n");
        conn.end();
        resolve();
      });
      conn.on("error", () => resolve());
      setTimeout(() => { conn.destroy(); resolve(); }, 2000);
    });
    // wait for old daemon to exit
    await new Promise((r) => setTimeout(r, 2000));
  } catch {}

  // start new daemon
  const daemonDir = path.join(os.homedir(), ".ucm", "daemon");
  await mkdir(daemonDir, { recursive: true });

  const logPath = path.join(daemonDir, "ucmd.log");
  const logFd = fs.openSync(logPath, "a");
  const ucmdPath = path.join(releaseDir, "lib", "ucmd.js");
  const child = spawn(process.execPath, [ucmdPath, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  console.log(`데몬 시작 (pid: ${child.pid})`);

  // wait for socket ready
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const client = createSocketClient(releaseSockPath, 3000);
      await client({ method: "stats", params: {} });
      console.log("릴리즈 배포 완료");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
    }
  }

  console.log("릴리즈 배포 완료 (데몬 소켓 대기 초과)");
}

// ── Chat ──

async function cmdChat() {
  const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
  const CHAT_DIR = path.join(UCM_DIR, "chat");
  const CHAT_NOTES_PATH = path.join(CHAT_DIR, "notes.md");

  const template = await readFile(path.join(TEMPLATES_DIR, "ucm-chat-system.md"), "utf-8");
  const systemPrompt = template
    .replace(/\{\{CWD\}\}/g, process.cwd())
    .replace("{{NOTES_PATH}}", CHAT_NOTES_PATH);

  const child = spawn("claude", ["--system-prompt", systemPrompt, "--dangerously-skip-permissions"], {
    stdio: "inherit",
  });

  await new Promise((resolve, reject) => {
    child.on("close", (code) => resolve(code));
    child.on("error", reject);
  });
}

// ── Main ──

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.command) {
    console.log(USAGE);
    process.exit(1);
  }

  switch (opts.command) {
    case "submit": await cmdSubmit(opts); break;
    case "list": await cmdList(opts); break;
    case "status": await cmdStatus(opts); break;
    case "approve": await cmdApprove(opts); break;
    case "reject": await cmdReject(opts); break;
    case "cancel": await cmdCancel(opts); break;
    case "diff": await cmdDiff(opts); break;
    case "logs": await cmdLogs(opts); break;
    case "pause": await cmdPause(); break;
    case "resume": await cmdResume(); break;
    case "stats": await cmdStats(); break;
    case "observe": await cmdObserve(opts); break;
    case "proposals": await cmdProposals(opts); break;
    case "proposal": await cmdProposal(opts); break;
    case "chat": await cmdChat(); break;
    case "ui": {
      const { startUiServer } = require("./ucm-ui-server.js");
      await startUiServer(opts);
      break;
    }
    case "release": await cmdRelease(); break;
    default:
      console.error(`알 수 없는 커맨드: ${opts.command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
