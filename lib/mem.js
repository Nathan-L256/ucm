#!/usr/bin/env node
const { spawn, execSync } = require("child_process");
const { readFile, writeFile, mkdir, access, readdir, unlink, rename, appendFile } = require("fs/promises");
const { randomUUID } = require("crypto");
const path = require("path");
const os = require("os");

const MEM_DIR = path.join(os.homedir(), ".mem");

const USAGE = `mem — 에이전트 메모리 정반합 결론 기반의 단순 기억 도구

Usage:
  cat transcript.md | mem save [options]
  mem save --file <file> [options]
  mem search <query> [options]
  mem boost <id>
  mem context [options]
  mem reindex [options]
  mem delete <id>
  mem gc [options]
  mem restore [<id>] [options]
  mem purge [options]
  mem reset

Commands:
  save                 기억 저장 (stdin 또는 --file)
  search <query>       기억 검색 (키워드 매칭 + grep fallback)
  boost <id>           기억 강화 (lastBoosted 갱신, boostCount++)
  context              LLM 기반 컨텍스트 브리핑 생성
  reindex              인덱스 재구축
  delete <id>          기억 삭제 (인덱스 + 요약 + 데몬 state, 재처리 가능)
  gc                   쇠퇴된 기억 아카이브 (파일 보존)
  restore [<id>]       아카이브된 기억 복원 (--all: 전체 복원)
  purge                아카이브된 기억의 파일까지 완전 삭제
  reset                데몬 state 초기화 (모든 세션 재처리 대상)

Options:
  --file <file>        save: 입력 파일 경로
  --project <name>     프로젝트명 (미지정 시 cwd git root basename)
  --limit <N>          context: 상위 N개 기억 (기본: 20)
  --rebuild            reindex: 전체 인덱스 삭제 후 재구축
  --threshold <N>      gc: GC 임계값 (기본: 0.05)
  --min-keep <N>       gc: 최소 보존 수 (기본: 10)
  --dry-run            gc/restore/purge: 실행 없이 목록만 출력
  --all                search/context: 전체 프로젝트 검색, restore: 전체 복원
  --provider <name>    실행 제공자 (claude|codex, 기본: LLM_PROVIDER 또는 claude)
  --help               도움말 출력`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { limit: "20", threshold: "0.05" };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": console.log(USAGE); process.exit(0);
      case "--file": opts.file = args[++i]; break;
      case "--project": opts.project = args[++i]; break;
      case "--limit": opts.limit = args[++i]; break;
      case "--rebuild": opts.rebuild = true; break;
      case "--threshold": opts.threshold = args[++i]; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--all": opts.all = true; break;
      case "--min-keep": opts.minKeep = args[++i]; break;
      case "--provider": opts.provider = args[++i]; break;
      default:
        if (args[i].startsWith("-")) {
          console.error(`알 수 없는 옵션: ${args[i]}\n`);
          console.error(USAGE);
          process.exit(1);
        }
        positional.push(args[i]);
    }
  }
  opts.command = positional[0];
  opts.query = positional.slice(1).join(" ");
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

function normalizeProvider(value) {
  if (!value) return DEFAULT_PROVIDER;
  return value.toLowerCase();
}

function detectProject() {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return path.basename(gitRoot);
  } catch {
    const cwd = process.cwd();
    if (cwd === os.homedir()) return null;
    return path.basename(cwd);
  }
}

async function loadConfig() {
  const configPath = path.join(MEM_DIR, "config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return { decayDays: 30, gcThreshold: 0.05, minKeep: 10 };
  }
}

async function validate(opts) {
  const errors = [];
  const commands = ["save", "search", "boost", "context", "reindex", "delete", "gc", "restore", "purge", "reset"];
  if (!opts.command) errors.push("커맨드 필수: " + commands.join("|"));
  else if (!commands.includes(opts.command)) errors.push(`알 수 없는 커맨드: ${opts.command}`);

  if (opts.command === "save") {
    if (opts.file) {
      try { await access(path.resolve(opts.file)); }
      catch { errors.push(`파일 없음: ${opts.file}`); }
    } else if (process.stdin.isTTY) {
      errors.push("--file <file> 또는 stdin 필수");
    }
  }

  if (opts.command === "search" && !opts.query) errors.push("검색어 필수");
  if (opts.command === "boost" && !opts.query) errors.push("기억 ID 필수");
  if (opts.command === "restore" && !opts.query && !opts.all) errors.push("기억 ID 또는 --all 필수");

  const limit = parseInt(opts.limit);
  if (isNaN(limit) || limit < 1) errors.push(`--limit 는 1 이상의 정수: ${opts.limit}`);

  const threshold = parseFloat(opts.threshold);
  if (isNaN(threshold) || threshold < 0 || threshold > 1) errors.push(`--threshold 는 0-1 사이: ${opts.threshold}`);

  if (opts.minKeep != null) {
    const mk = parseInt(opts.minKeep);
    if (isNaN(mk) || mk < 0) errors.push(`--min-keep 는 0 이상의 정수: ${opts.minKeep}`);
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

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

function isRateLimited(stderr) {
  return /rate.limit|429|quota/i.test(stderr);
}

function buildCommand({ provider, model }) {
  if (provider === "codex") {
    const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
    if (model) args.push("--model", model);
    args.push("-");
    return { cmd: "codex", args };
  }
  const args = ["-p", "--dangerously-skip-permissions", "--no-session-persistence", "--output-format", "text"];
  if (model) args.push("--model", model);
  return { cmd: "claude", args };
}

function spawnLlmJson(prompt, { provider } = {}) {
  provider = provider || DEFAULT_PROVIDER;
  return new Promise((resolve, reject) => {
    const { cmd, args } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : undefined,
    });
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
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

function spawnLlmText(prompt, { provider } = {}) {
  provider = provider || DEFAULT_PROVIDER;
  return new Promise((resolve, reject) => {
    const { cmd, args } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : undefined,
    });
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
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

function computeEffectiveScore(entry, decayDays) {
  const now = Date.now();
  const lastBoosted = new Date(entry.lastBoosted).getTime();
  const effectiveDecayDays = decayDays * (1 + Math.log(1 + entry.boostCount));
  return Math.exp(-(now - lastBoosted) / (effectiveDecayDays * 86400000));
}

async function loadIndex(indexPath) {
  try {
    const content = await readFile(indexPath, "utf-8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function saveIndex(indexPath, entries) {
  await mkdir(path.dirname(indexPath), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const tmpPath = indexPath + ".tmp";
  await writeFile(tmpPath, content);
  await rename(tmpPath, indexPath);
}

function projectDir(projectName) {
  const sanitized = path.basename(projectName);
  return path.join(MEM_DIR, "projects", sanitized);
}

function globalDir() {
  return path.join(MEM_DIR, "global");
}

// ── Split ──

const SPLIT_THRESHOLD_CHARS = 100 * 1024;
const SPLIT_TARGET_CHARS = 80 * 1024;

function splitTranscript(transcript) {
  const sections = transcript.split(/(?=^## User$)/m);
  const header = sections[0];
  const turns = sections.slice(1);

  if (turns.length === 0) return [transcript];

  const parts = [];
  let currentPart = header;

  for (const turn of turns) {
    if (currentPart.length + turn.length > SPLIT_TARGET_CHARS && currentPart.length > 0) {
      parts.push(currentPart);
      currentPart = header + turn;
    } else {
      currentPart += turn;
    }
  }
  if (currentPart.length > 0) parts.push(currentPart);

  return parts;
}

// ── save ──

function buildSavePrompt(existingMemories = [], { fromSummary, userMessages } = {}) {
  const tag = fromSummary ? "combined-summary" : "session";
  const description = fromSummary
    ? "아래는 대형 세션을 파트별로 요약한 결과를 합친 것입니다. 이 요약을 분석하여 메타데이터를 JSON으로 추출하세요."
    : "아래 세션 기록을 분석하여 메타데이터를 JSON으로 추출하는 작업입니다.";

  let prefix = `${description}
세션 내용에 대해 대화하거나 설명하지 마세요. 오직 지정된 JSON만 출력하세요.
`;

  // 대형 세션: 사용자 메시지를 토픽 힌트로 포함
  if (fromSummary && userMessages && userMessages.length > 0) {
    const hints = userMessages.map((m, i) => `${i + 1}. ${m.slice(0, 150)}`).join("\n");
    prefix += `
<user-messages>
아래는 원본 세션에서 사용자가 보낸 메시지 목록입니다.
주제 전환 시점을 파악하는 데 참고하세요 (요약만으로는 토픽 경계가 보이지 않을 수 있습니다):
${hints}
</user-messages>

`;
  }

  prefix += `<${tag}>
`;

  let suffix = `</${tag}>

위 ${fromSummary ? "요약" : "세션 기록"}을 분석하여 아래 JSON 형식으로만 응답하세요.
설명, 코멘트, 마크다운 없이 순수 JSON만 출력:

{"topics": [{"title": "...", "tags": ["..."], "updates": "existingMemoryId", "updateReason": "변경 사유"}], "scope": "project|global", "projectName": "..."}

규칙:
- title 형식: "<범위>: <핵심 주제>"
  - 범위 = 프로젝트명, 또는 여러 프로젝트면 "A↔B", 범용이면 "공통"
  - 핵심 주제 = 검색어로 바로 쓸 수 있는 구체적 기술 키워드
  - 예: "billing-service: 플랜 변경 시 CU 재계산 로직"
  - 예: "공통: Kotlin coroutine 예외 전파 패턴"
- "세션 요약", "작업 내역" 같은 일반적 제목은 절대 금지
- tags: 3-7개, 기술 키워드 위주
- scope: 단일 프로젝트 작업이면 "project", 프로젝트 간 관계나 범용이면 "global"
- projectName: scope가 "project"일 때 프로젝트명 (저장소/디렉토리 이름). scope가 "global"이면 null
`;

  if (fromSummary) {
    suffix += `
토픽 분리 규칙 (대형 세션):
- 기술적으로 독립된 주제가 있으면 분리 (같은 프로젝트라도 무관한 작업이면 분리)
- user-messages 목록에서 주제 전환 시점을 참고하여 판단
- 예: "webhook UI 개선" + "git hook PATH 설정" → 2개 토픽
- 예: "webhook 필터 빌더" + "webhook 테스트 모달" → 같은 기능의 연속 작업이면 1개
- 최대 3개까지만 분리
`;
  } else {
    suffix += `
토픽 분리 규칙:
- 같은 목표를 향한 연속 작업은 1개 토픽으로 유지
- 완전히 다른 주제(서로 다른 기능, 다른 시스템)를 다뤘을 때만 분리
- 대부분의 세션은 topics 1개여야 함. 무리하게 쪼개지 말 것
- 최대 3개까지만 분리
`;
  }

  suffix += `
업데이트(updates) 규칙:
- updates 사용 조건 (아래 중 하나라도 해당):
  1. 기존 기억의 정보가 틀리게 되었거나 대체됨 (예: "A 방식" → "B 방식으로 변경")
  2. 기존 기억과 **동일한 구체적 주제**에 대해 새 정보를 추가/보완 (예: 같은 기능의 후속 작업)
- updates 판별 핵심: 기존 기억의 제목에서 "핵심 주제" 부분이 이 세션의 주제와 같은가?
  - 같다면 → updates (기존 기억에 통합)
  - 다르다면 → 새 기억 (같은 시스템/영역이라도 주제가 다르면 분리)
  - 예: 기존 "webhook: quota 체크 로직" + 새 세션도 quota 체크 → updates ✅
  - 예: 기존 "webhook: quota 체크 로직" + 새 세션은 webhook 필터링 → 새 기억 ❌
- updateReason에 "무엇이 추가/변경되었는지" 구체적으로 기술
`;

  if (existingMemories.length > 0) {
    suffix += `\n기존 기억 목록 (최근순):\n`;
    for (const m of existingMemories) {
      const tags = m.tags ? ` [${m.tags.join(", ")}]` : "";
      suffix += `- [${m.id}] ${m.title}${tags}\n`;
    }
  }

  suffix += `\nJSON:\n`;
  return { prefix, suffix };
}

async function commandSave(opts) {
  const content = opts.file
    ? (await readFile(path.resolve(opts.file), "utf-8")).trim()
    : await readStdin();

  if (!content) {
    console.error("입력 내용이 비어있습니다.");
    process.exit(1);
  }

  const projectName = opts.project || detectProject();

  const isLarge = content.length >= SPLIT_THRESHOLD_CHARS;
  const existingMemories = await loadActiveMemories(projectName);

  let meta, topics, summaries, combinedSummary, parts;

  if (isLarge) {
    // Large transcript: per-part summary → combined → title/tags from summary
    const largeResult = await processLargeTranscript(content, { provider: opts.provider });
    parts = largeResult.parts;

    if (largeResult.skipped) {
      process.stderr.write("LLM이 재사용 가능한 지식 없음으로 판단\n");
      return;
    }
    combinedSummary = largeResult.combinedSummary;

    process.stderr.write("제목/태그/범위 생성 중...\n");
    const { prefix, suffix } = buildSavePrompt(existingMemories, { fromSummary: true });
    meta = await spawnLlmJson(prefix + combinedSummary + suffix, { provider: opts.provider });
  } else {
    // Small transcript: existing flow
    const { prefix, suffix } = buildSavePrompt(existingMemories);
    process.stderr.write("제목/태그/범위 생성 중...\n");
    meta = await spawnLlmJson(prefix + content + suffix, { provider: opts.provider });
  }

  if (meta.topics && Array.isArray(meta.topics)) {
    topics = meta.topics.filter(t => t.title && t.tags);
  } else if (meta.title && meta.tags) {
    topics = [{ title: meta.title, tags: meta.tags }];
  } else {
    console.error("LLM 응답에 title/tags 누락");
    process.exit(1);
  }

  if (isLarge) {
    if (topics.length > 1 && combinedSummary) {
      // Large + multi-topic: split combined summary into per-topic summaries
      process.stderr.write("토픽별 요약 분리 중...\n");
      try {
        const splitText = await spawnLlmText(buildSummaryPrompt(combinedSummary, topics), { provider: opts.provider });
        summaries = parseMultiTopicSummary(splitText, topics.length);
      } catch (e) {
        process.stderr.write(`토픽 분리 실패: ${e.message}, combined summary 사용\n`);
        summaries = topics.map(() => combinedSummary);
      }
    } else {
      summaries = topics.map(() => combinedSummary);
    }
  } else {
    summaries = topics.map(() => null);
    process.stderr.write("요약 생성 중...\n");
    try {
      const summaryText = await spawnLlmText(buildSummaryPrompt(content, topics), { provider: opts.provider });
      if (summaryText.trim().toUpperCase().startsWith("SKIP")) {
        process.stderr.write("LLM이 재사용 가능한 지식 없음으로 판단\n");
      } else {
        summaries = parseMultiTopicSummary(summaryText, topics.length);
      }
    } catch (e) {
      process.stderr.write(`요약 실패: ${e.message}\n`);
    }
  }

  const memoryId = randomUUID();
  const scope = !projectName ? "global" : "project";

  // Write part files for large transcripts
  if (isLarge && parts) {
    const baseDir = scope === "project" && projectName ? projectDir(projectName) : globalDir();
    const originalsDir = path.join(baseDir, "originals");
    await mkdir(originalsDir, { recursive: true });
    for (let i = 0; i < parts.length; i++) {
      await writeFile(path.join(originalsDir, `${memoryId}.part${i + 1}.md`), parts[i] + "\n");
    }
  }

  const { entries, baseDir } = await saveMemory({
    scope, projectName, memoryId, topics, content, summaries,
    partsCount: isLarge && parts ? parts.length : 1,
  });

  const scopeLabel = scope === "project" ? `project (${projectName})` : "global";
  for (const entry of entries) {
    console.log(`saved ${entry.id} → ${path.join(baseDir, entry.file)}`);
    console.log(`title: ${entry.title}`);
  }
  console.log(`scope: ${scopeLabel}`);

  // Conflict resolution
  const reconcileResults = await reconcileMemories(entries, projectName, { provider: opts.provider });
  for (const r of reconcileResults) {
    console.log(`reconcile: ${r.judgment} ${r.candidateId} — ${r.reason}`);
  }

}

// ── BM25 Search ──

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().split(/\s+/)
    .filter(t => t.length > 0);
}

function buildBm25Doc(entry, baseDir, summaryText) {
  const titleTokens = tokenize(entry.title || "");
  const tagsTokens = tokenize((entry.tags || []).join(" "));
  const summaryTokens = summaryText ? tokenize(summaryText) : [];
  return {
    id: entry.id,
    fields: { title: titleTokens, tags: tagsTokens, summary: summaryTokens },
    entry,
    baseDir,
  };
}

async function buildBm25IndexFromEntries(allEntries) {
  const docs = [];
  const totalLengths = { title: 0, tags: 0, summary: 0 };

  for (const { entry, baseDir } of allEntries) {
    let summaryText = "";
    if (entry.summaryFile) {
      try { summaryText = await readFile(path.join(baseDir, entry.summaryFile), "utf-8"); } catch {}
    }
    const doc = buildBm25Doc(entry, baseDir, summaryText);
    docs.push(doc);
    totalLengths.title += doc.fields.title.length;
    totalLengths.tags += doc.fields.tags.length;
    totalLengths.summary += doc.fields.summary.length;
  }

  const totalDocs = docs.length || 1;
  return {
    docs,
    avgFieldLengths: {
      title: totalLengths.title / totalDocs,
      tags: totalLengths.tags / totalDocs,
      summary: totalLengths.summary / totalDocs,
    },
    totalDocs,
  };
}

function computeDocumentFrequency(queryTokens, docs) {
  const df = {};
  for (const token of queryTokens) {
    let count = 0;
    for (const d of docs) {
      const allTokens = [...d.fields.title, ...d.fields.tags, ...d.fields.summary];
      if (allTokens.includes(token)) count++;
    }
    df[token] = count;
  }
  return df;
}

function bm25ScoreDoc(queryTokens, doc, index, df) {
  const k1 = 1.2;
  const b = 0.75;
  const fieldWeights = { title: 3.0, tags: 2.0, summary: 1.0 };

  let totalScore = 0;

  for (const [fieldName, weight] of Object.entries(fieldWeights)) {
    const fieldTokens = doc.fields[fieldName];
    const fieldLength = fieldTokens.length;
    const avgFieldLength = index.avgFieldLengths[fieldName] || 1;

    const tf = {};
    for (const token of fieldTokens) {
      tf[token] = (tf[token] || 0) + 1;
    }

    for (const queryToken of queryTokens) {
      const termFreq = tf[queryToken] || 0;
      if (termFreq === 0) continue;

      const docFreq = df[queryToken] || 0;
      const idf = Math.log((index.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const numerator = termFreq * (k1 + 1);
      const denominator = termFreq + k1 * (1 - b + b * (fieldLength / avgFieldLength));
      totalScore += weight * idf * (numerator / denominator);
    }
  }

  return totalScore;
}

function reciprocalRankFusion(rankings, k = 60) {
  const scores = {};
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i].id;
      scores[id] = (scores[id] || 0) + 1 / (k + i + 1);
    }
  }
  return scores;
}

// ── High-level API ──

async function loadActiveMemories(projectName, limit = 100) {
  const config = await loadConfig();
  const allEntries = [];

  if (projectName) {
    const entries = await loadIndex(path.join(projectDir(projectName), "index.jsonl"));
    for (const entry of entries) {
      allEntries.push(entry);
    }
  }

  const globalEntries = await loadIndex(path.join(globalDir(), "index.jsonl"));
  for (const entry of globalEntries) {
    allEntries.push(entry);
  }

  allEntries.sort((a, b) =>
    computeEffectiveScore(b, config.decayDays) - computeEffectiveScore(a, config.decayDays)
  );

  return allEntries.slice(0, limit).map(e => ({ id: e.id, title: e.title, tags: e.tags }));
}

async function buildSearchIndex() {
  const docs = [];
  const totalLengths = { title: 0, tags: 0, summary: 0 };

  async function indexDir(dirPath) {
    const indexPath = path.join(dirPath, "index.jsonl");
    const entries = await loadIndex(indexPath);
    for (const entry of entries) {
      let summaryText = "";
      if (entry.summaryFile) {
        try { summaryText = await readFile(path.join(dirPath, entry.summaryFile), "utf-8"); } catch {}
      }
      const doc = buildBm25Doc(entry, dirPath, summaryText);
      docs.push(doc);
      totalLengths.title += doc.fields.title.length;
      totalLengths.tags += doc.fields.tags.length;
      totalLengths.summary += doc.fields.summary.length;
    }
  }

  await indexDir(globalDir());

  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const project of projects) {
      await indexDir(projectDir(project));
    }
  } catch {}

  const totalDocs = docs.length || 1;
  return {
    docs,
    avgFieldLengths: {
      title: totalLengths.title / totalDocs,
      tags: totalLengths.tags / totalDocs,
      summary: totalLengths.summary / totalDocs,
    },
    totalDocs,
  };
}

function addToSearchIndex(index, entry, baseDir, summaryText) {
  if (!index) return;
  index.docs = index.docs.filter(d => d.id !== entry.id);
  const doc = buildBm25Doc(entry, baseDir, summaryText);
  index.docs.push(doc);
  const totalDocs = index.docs.length || 1;
  const totals = { title: 0, tags: 0, summary: 0 };
  for (const d of index.docs) {
    totals.title += d.fields.title.length;
    totals.tags += d.fields.tags.length;
    totals.summary += d.fields.summary.length;
  }
  index.avgFieldLengths = {
    title: totals.title / totalDocs,
    tags: totals.tags / totalDocs,
    summary: totals.summary / totalDocs,
  };
  index.totalDocs = totalDocs;
}


async function saveMemory({
  scope, projectName, memoryId, topics, content, summaries, partsCount, sourceSessionId,
}) {
  const baseDir = scope === "project" && projectName ? projectDir(projectName) : globalDir();
  const originalsDir = path.join(baseDir, "originals");
  const summariesDir = path.join(baseDir, "summaries");
  const indexPath = path.join(baseDir, "index.jsonl");

  await mkdir(originalsDir, { recursive: true });
  await mkdir(summariesDir, { recursive: true });

  // Write original file(s)
  let originalFile;
  if (partsCount && partsCount > 1) {
    // Parts already written by caller (memd.js splitTranscript)
    originalFile = `originals/${memoryId}.part1.md`;
  } else {
    const filePath = path.join(originalsDir, `${memoryId}.md`);
    await writeFile(filePath, content + "\n");
    originalFile = `originals/${memoryId}.md`;
  }

  const entries = await loadIndex(indexPath);
  const savedEntries = [];

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const topicSummary = summaries ? summaries[i] : null;
    const topicMemoryId = topics.length === 1 ? memoryId : `${memoryId}-topic-${i + 1}`;

    if (topicSummary) {
      let finalSummary = topicSummary;
      const summaryBytes = Buffer.byteLength(finalSummary, "utf-8");
      if (summaryBytes > MAX_SUMMARY_BYTES) {
        process.stderr.write(`warning: summary for "${topic.title}" is ${(summaryBytes / 1024).toFixed(1)}KB (limit ${MAX_SUMMARY_BYTES / 1024}KB), truncating\n`);
        const encoded = Buffer.from(finalSummary, "utf-8");
        finalSummary = encoded.subarray(0, MAX_SUMMARY_BYTES).toString("utf-8");
        const lastNewline = finalSummary.lastIndexOf("\n");
        if (lastNewline > MAX_SUMMARY_BYTES * 0.8) {
          finalSummary = finalSummary.slice(0, lastNewline);
        }
      }
      await writeFile(path.join(summariesDir, `${topicMemoryId}.md`), finalSummary + "\n");
    }

    const entry = {
      id: topicMemoryId,
      title: topic.title,
      tags: topic.tags,
      summaryFile: topicSummary ? `summaries/${topicMemoryId}.md` : undefined,
      originalFile,
      parts: partsCount || 1,
      sourceSessionId: sourceSessionId || undefined,
      bytes: Buffer.byteLength(content, "utf-8"),
      createdAt: new Date().toISOString(),
      lastBoosted: new Date().toISOString(),
      boostCount: 0,
      file: originalFile,
    };

    const existingIndex = entries.findIndex(e => e.id === topicMemoryId);
    if (existingIndex !== -1) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }

    savedEntries.push(entry);
  }

  await saveIndex(indexPath, entries);

  return { entries: savedEntries, baseDir };
}

async function updateMemory(targetId, { title, tags, summary, updateReason, sessionId }) {
  const locations = [path.join(globalDir(), "index.jsonl")];
  try {
    const projects = await readdir(path.join(MEM_DIR, "projects"));
    for (const p of projects) locations.push(path.join(projectDir(p), "index.jsonl"));
  } catch {}

  for (const indexPath of locations) {
    const entries = await loadIndex(indexPath);
    const entry = entries.find(e => e.id === targetId);
    if (!entry) continue;

    const baseDir = path.dirname(indexPath);

    if (title) entry.title = title;
    if (tags) entry.tags = tags;
    entry.lastBoosted = new Date().toISOString();

    if (!entry.amendments) entry.amendments = [];
    entry.amendments.push({
      at: new Date().toISOString(),
      reason: updateReason || null,
      sessionId: sessionId || null,
    });

    if (summary && !summary.trim().toUpperCase().startsWith("SKIP")) {
      const summaryBytes = Buffer.byteLength(summary, "utf-8");
      if (summaryBytes > MAX_SUMMARY_BYTES) {
        process.stderr.write(`warning: amendment summary ${(summaryBytes / 1024).toFixed(1)}KB exceeds ${MAX_SUMMARY_BYTES / 1024}KB limit, truncating P3 sections\n`);
        // Truncate to MAX_SUMMARY_BYTES by removing content from the end
        const encoded = Buffer.from(summary, "utf-8");
        summary = encoded.subarray(0, MAX_SUMMARY_BYTES).toString("utf-8");
        // Trim to last complete line
        const lastNewline = summary.lastIndexOf("\n");
        if (lastNewline > MAX_SUMMARY_BYTES * 0.8) {
          summary = summary.slice(0, lastNewline);
        }
      }
      const summariesDir = path.join(baseDir, "summaries");
      await mkdir(summariesDir, { recursive: true });
      const summaryFile = entry.summaryFile || `summaries/${targetId}.md`;
      await writeFile(path.join(baseDir, summaryFile), summary + "\n");
      entry.summaryFile = summaryFile;
    }

    await saveIndex(indexPath, entries);
    return { entry, baseDir };
  }
  return null;
}

// ── Conflict Resolution ──

async function findEntryById(entryId) {
  const locations = [globalDir()];
  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const p of projects) locations.push(projectDir(p));
  } catch {}
  for (const baseDir of locations) {
    const entries = await loadIndex(path.join(baseDir, "index.jsonl"));
    const entry = entries.find(e => e.id === entryId);
    if (entry) return { entry, baseDir };
  }
  return null;
}

function buildReconcilePrompt(newEntry, newSummary, candidates) {
  let prompt = `새로 저장된 기억과 기존 기억 후보들을 비교하여 충돌을 판정하세요.

<new-memory>
ID: ${newEntry.id}
제목: ${newEntry.title}
태그: ${(newEntry.tags || []).join(", ")}
요약:
${(newSummary || "").slice(0, 2000)}
</new-memory>

<candidates>
`;

  for (const { entry, summary } of candidates) {
    prompt += `--- [${entry.id}] ${entry.title} ---
태그: ${(entry.tags || []).join(", ")}
요약:
${(summary || "").slice(0, 1000)}

`;
  }

  prompt += `</candidates>

각 후보에 대해 판정하세요:
- MERGE: 새 기억과 후보가 같은 주제를 다루며 통합해야 함 (새 기억이 후보에 흡수됨)
- SUPERSEDE: 새 기억이 후보를 완전히 대체함 (후보를 아카이브)
- INDEPENDENT: 서로 다른 주제이거나 관련 없음

규칙:
- 같은 프로젝트의 같은 기능/주제를 다루면 MERGE
- 새 기억이 후보의 정보를 완전히 대체하면 SUPERSEDE
- 확신이 없으면 반드시 INDEPENDENT

JSON 배열로만 응답:
[{"candidateId":"...","judgment":"MERGE|SUPERSEDE|INDEPENDENT","reason":"판정 이유 한 줄"}]`;

  return prompt;
}

async function executeMerge(newEntry, candidateId, { provider } = {}) {
  const candidateResult = await findEntryById(candidateId);
  if (!candidateResult) throw new Error(`candidate not found: ${candidateId}`);

  const newResult = await findEntryById(newEntry.id);
  if (!newResult) throw new Error(`new entry not found: ${newEntry.id}`);

  let candidateSummary = "";
  if (candidateResult.entry.summaryFile) {
    try {
      candidateSummary = await readFile(
        path.join(candidateResult.baseDir, candidateResult.entry.summaryFile), "utf-8"
      );
    } catch {}
  }

  let newSummary = "";
  if (newResult.entry.summaryFile) {
    try {
      newSummary = await readFile(
        path.join(newResult.baseDir, newResult.entry.summaryFile), "utf-8"
      );
    } catch {}
  }

  const mergePrompt = `아래 두 기억 요약을 하나로 통합하세요.

<surviving-memory>
제목: ${candidateResult.entry.title}
${candidateSummary}
</surviving-memory>

<absorbed-memory>
제목: ${newEntry.title}
${newSummary}
</absorbed-memory>

${SUMMARY_INSTRUCTIONS}

두 요약의 내용을 통합하여 하나의 마크다운 요약으로 만드세요.
중복 제거하고, 최신 정보 우선. 10KB 이내.`;

  const mergedSummary = await spawnLlmText(mergePrompt, { provider });

  await updateMemory(candidateId, {
    summary: mergedSummary,
    updateReason: `reconcile:merge from ${newEntry.id}`,
  });

  // Delete new entry from index + summary file
  const newIndexPath = path.join(newResult.baseDir, "index.jsonl");
  const entries = await loadIndex(newIndexPath);
  const filtered = entries.filter(e => e.id !== newEntry.id);
  await saveIndex(newIndexPath, filtered);

  if (newResult.entry.summaryFile) {
    try {
      await unlink(path.join(newResult.baseDir, newResult.entry.summaryFile));
    } catch {}
  }
}

async function executeSupersede(candidateId) {
  const result = await findEntryById(candidateId);
  if (!result) throw new Error(`candidate not found: ${candidateId}`);

  const { entry, baseDir } = result;
  const indexPath = path.join(baseDir, "index.jsonl");
  const archivePath = path.join(baseDir, "archive.jsonl");

  entry.archivedAt = new Date().toISOString();
  const existingArchive = await loadIndex(archivePath);
  if (!existingArchive.some(e => e.id === candidateId)) {
    existingArchive.push(entry);
  }
  await saveIndex(archivePath, existingArchive);

  const entries = await loadIndex(indexPath);
  const filtered = entries.filter(e => e.id !== candidateId);
  await saveIndex(indexPath, filtered);
}

async function reconcileMemories(savedEntries, projectName, { provider, bm25Index, log: logFn } = {}) {
  const write = logFn || ((msg) => process.stderr.write(msg + "\n"));
  const results = [];

  for (const entry of savedEntries) {
    const searchQuery = entry.title + " " + (entry.tags || []).join(" ");
    const searchResults = await searchMemories(searchQuery, {
      project: projectName,
      topK: 5,
      bm25Index,
    });

    const candidateDetails = [];
    for (const result of searchResults) {
      if (result.id === entry.id) continue;
      const found = await findEntryById(result.id);
      if (!found) continue;
      if (entry.sourceSessionId && found.entry.sourceSessionId === entry.sourceSessionId) continue;
      let summary = "";
      try {
        summary = (await readFile(result.file, "utf-8")).slice(0, 1000);
      } catch {}
      candidateDetails.push({ entry: found.entry, summary });
    }

    if (candidateDetails.length === 0) continue;

    let newSummary = "";
    const baseDir = projectName ? projectDir(projectName) : globalDir();
    if (entry.summaryFile) {
      try {
        newSummary = (await readFile(path.join(baseDir, entry.summaryFile), "utf-8")).slice(0, 2000);
      } catch {}
    }

    let judgments;
    try {
      judgments = await spawnLlmJson(buildReconcilePrompt(entry, newSummary, candidateDetails), { provider });
    } catch (e) {
      write(`  reconcile LLM error: ${e.message}`);
      continue;
    }

    if (!Array.isArray(judgments)) continue;

    for (const judgment of judgments) {
      results.push({ ...judgment, sourceId: entry.id });
      if (judgment.judgment === "MERGE") {
        try {
          await executeMerge(entry, judgment.candidateId, { provider });
          write(`  merge: ${entry.id} → ${judgment.candidateId}`);
        } catch (e) {
          write(`  merge error: ${e.message}`);
        }
      } else if (judgment.judgment === "SUPERSEDE") {
        try {
          await executeSupersede(judgment.candidateId);
          write(`  supersede: ${judgment.candidateId}`);
        } catch (e) {
          write(`  supersede error: ${e.message}`);
        }
      }
    }
  }

  return results;
}

async function searchMemories(query, { project, topK, bm25Index } = {}) {
  topK = topK || 10;
  const queryTokens = tokenize(query);
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const config = await loadConfig();

  // Build or use provided BM25 index
  let index = bm25Index;
  if (!index) {
    const allEntries = [];
    if (project) {
      const entries = await loadIndex(path.join(projectDir(project), "index.jsonl"));
      for (const entry of entries) {
        allEntries.push({ entry, baseDir: projectDir(project) });
      }
    } else {
      // project 미지정 시 모든 프로젝트 검색
      const projectsBase = path.join(MEM_DIR, "projects");
      try {
        const dirs = await readdir(projectsBase);
        for (const dir of dirs) {
          const indexPath = path.join(projectsBase, dir, "index.jsonl");
          const entries = await loadIndex(indexPath);
          const base = path.join(projectsBase, dir);
          for (const entry of entries) {
            allEntries.push({ entry, baseDir: base });
          }
        }
      } catch {}
    }
    const globalEntries = await loadIndex(path.join(globalDir(), "index.jsonl"));
    for (const entry of globalEntries) {
      allEntries.push({ entry, baseDir: globalDir() });
    }
    if (allEntries.length === 0) return [];
    index = await buildBm25IndexFromEntries(allEntries);
  }

  // Filter docs by project scope if using full index
  let candidateDocs = index.docs;
  if (bm25Index && project) {
    const projBase = projectDir(project);
    const globalBase = globalDir();
    candidateDocs = index.docs.filter(d => d.baseDir === projBase || d.baseDir === globalBase);
  }

  if (candidateDocs.length === 0) return [];

  // Ranking 1: BM25
  const df = computeDocumentFrequency(queryTokens, index.docs);
  const bm25Ranked = candidateDocs
    .map(doc => ({ id: doc.id, score: bm25ScoreDoc(queryTokens, doc, index, df), doc }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // Ranking 2: keyword includes
  const keywordRanked = [];
  const docById = new Map(candidateDocs.map(d => [d.id, d]));
  for (const doc of candidateDocs) {
    const titleLower = (doc.entry.title || "").toLowerCase();
    const tagsLower = (doc.entry.tags || []).map(t => t.toLowerCase());
    const hit = keywords.some(kw => titleLower.includes(kw) || tagsLower.some(t => t.includes(kw)));
    if (hit) keywordRanked.push({ id: doc.id, doc });
  }

  // RRF fusion
  const rrfScores = reciprocalRankFusion([bm25Ranked, keywordRanked]);

  // Combine: RRF score × Ebbinghaus decay
  const results = [];

  for (const id of Object.keys(rrfScores)) {
    const doc = docById.get(id);
    if (!doc) continue;
    const decayScore = computeEffectiveScore(doc.entry, config.decayDays);
    const finalScore = rrfScores[id] * decayScore;
    results.push({
      id: doc.id,
      title: doc.entry.title,
      score: finalScore,
      createdAt: doc.entry.createdAt || "",
      file: path.join(doc.baseDir, doc.entry.summaryFile || doc.entry.file),
      boostCount: doc.entry.boostCount,
    });
  }

  results.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  return results.slice(0, topK);
}

async function boostMemory(id, project) {
  const locations = [];
  if (project) locations.push(path.join(projectDir(project), "index.jsonl"));

  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const p of projects) {
      const indexPath = path.join(projectDir(p), "index.jsonl");
      if (!locations.includes(indexPath)) locations.push(indexPath);
    }
  } catch {}

  locations.push(path.join(globalDir(), "index.jsonl"));

  for (const indexPath of locations) {
    const entries = await loadIndex(indexPath);
    const entry = entries.find((e) => e.id === id);
    if (entry) {
      entry.lastBoosted = new Date().toISOString();
      entry.boostCount++;
      await saveIndex(indexPath, entries);
      return { id, boostCount: entry.boostCount, title: entry.title };
    }
  }

  throw new Error(`기억을 찾을 수 없음: ${id}`);
}

async function gcMemories({ threshold, decayDays, minKeep, dryRun, onRemove } = {}) {
  const config = await loadConfig();
  threshold = threshold != null ? threshold : config.gcThreshold;
  decayDays = decayDays != null ? decayDays : config.decayDays;
  minKeep = minKeep != null ? minKeep : (config.minKeep != null ? config.minKeep : 10);

  async function gcDir(dirPath) {
    const indexPath = path.join(dirPath, "index.jsonl");
    const archivePath = path.join(dirPath, "archive.jsonl");
    const entries = await loadIndex(indexPath);
    if (entries.length === 0) return { archived: 0, kept: 0 };

    const scored = entries.map(entry => ({
      entry,
      score: computeEffectiveScore(entry, decayDays),
    }));
    scored.sort((a, b) => b.score - a.score);

    const keep = [];
    const archive = [];

    for (let i = 0; i < scored.length; i++) {
      if (scored[i].score >= threshold || keep.length < minKeep) {
        keep.push(scored[i].entry);
      } else {
        archive.push(scored[i]);
      }
    }

    if (archive.length === 0) return { archived: 0, kept: keep.length };

    for (const { entry, score } of archive) {
      if (onRemove) onRemove(entry, score);
    }

    if (!dryRun) {
      const existingArchive = await loadIndex(archivePath);
      const archivedIds = new Set(existingArchive.map(e => e.id));
      for (const { entry } of archive) {
        entry.archivedAt = new Date().toISOString();
        if (!archivedIds.has(entry.id)) {
          existingArchive.push(entry);
        }
      }
      await saveIndex(archivePath, existingArchive);
      await saveIndex(indexPath, keep);
    }

    return { archived: archive.length, kept: keep.length };
  }

  let totalArchived = 0;
  let totalKept = 0;

  const globalResult = await gcDir(globalDir());
  totalArchived += globalResult.archived;
  totalKept += globalResult.kept;

  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const project of projects) {
      const result = await gcDir(projectDir(project));
      totalArchived += result.archived;
      totalKept += result.kept;
    }
  } catch {}

  return { archived: totalArchived, kept: totalKept };
}

async function restoreMemories({ ids, all, dryRun, onRestore } = {}) {
  async function restoreDir(dirPath) {
    const indexPath = path.join(dirPath, "index.jsonl");
    const archivePath = path.join(dirPath, "archive.jsonl");
    const archived = await loadIndex(archivePath);
    if (archived.length === 0) return { restored: 0, remaining: 0 };

    const entries = await loadIndex(indexPath);
    const activeIds = new Set(entries.map(e => e.id));

    const toRestore = [];
    const toKeep = [];

    for (const entry of archived) {
      const shouldRestore = all || (ids && ids.includes(entry.id));
      if (shouldRestore) {
        toRestore.push(entry);
      } else {
        toKeep.push(entry);
      }
    }

    if (toRestore.length === 0) return { restored: 0, remaining: archived.length };

    for (const entry of toRestore) {
      if (onRestore) onRestore(entry);
    }

    if (!dryRun) {
      for (const entry of toRestore) {
        delete entry.archivedAt;
        entry.lastBoosted = new Date().toISOString();
        if (!activeIds.has(entry.id)) {
          entries.push(entry);
        }
      }
      await saveIndex(indexPath, entries);
      await saveIndex(archivePath, toKeep);
    }

    return { restored: toRestore.length, remaining: toKeep.length };
  }

  let totalRestored = 0;
  let totalRemaining = 0;

  const globalResult = await restoreDir(globalDir());
  totalRestored += globalResult.restored;
  totalRemaining += globalResult.remaining;

  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const project of projects) {
      const result = await restoreDir(projectDir(project));
      totalRestored += result.restored;
      totalRemaining += result.remaining;
    }
  } catch {}

  return { restored: totalRestored, remaining: totalRemaining };
}

async function purgeArchive({ dryRun, onPurge } = {}) {
  async function purgeDir(dirPath) {
    const archivePath = path.join(dirPath, "archive.jsonl");
    const indexPath = path.join(dirPath, "index.jsonl");
    const archived = await loadIndex(archivePath);
    if (archived.length === 0) return { purged: 0 };

    const activeEntries = await loadIndex(indexPath);
    const activeOriginalFiles = new Set();
    for (const entry of activeEntries) {
      if (entry.file) activeOriginalFiles.add(entry.file);
      if (entry.originalFile) activeOriginalFiles.add(entry.originalFile);
    }

    let purged = 0;
    for (const entry of archived) {
      if (onPurge) onPurge(entry);
      if (!dryRun) {
        const origFile = entry.file || entry.originalFile || `originals/${entry.id}.md`;
        if (!activeOriginalFiles.has(origFile)) {
          if (entry.parts && entry.parts > 1) {
            const baseId = entry.sourceSessionId || entry.id.replace(/-topic-\d+$/, "");
            for (let i = 1; i <= entry.parts; i++) {
              try { await unlink(path.join(dirPath, `originals/${baseId}.part${i}.md`)); } catch {}
            }
          } else {
            try { await unlink(path.join(dirPath, origFile)); } catch {}
          }
        }
        if (entry.summaryFile) {
          try { await unlink(path.join(dirPath, entry.summaryFile)); } catch {}
        }
      }
      purged++;
    }

    if (!dryRun) {
      await saveIndex(archivePath, []);
    }

    return { purged };
  }

  let totalPurged = 0;

  const globalResult = await purgeDir(globalDir());
  totalPurged += globalResult.purged;

  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const projects = await readdir(projectsBase);
    for (const project of projects) {
      const result = await purgeDir(projectDir(project));
      totalPurged += result.purged;
    }
  } catch {}

  return { purged: totalPurged };
}

// ── search ──

async function commandSearch(opts) {
  let projectName = opts.all ? null : (opts.project || detectProject());
  // 감지된 프로젝트 디렉토리가 실제 존재하지 않으면 전체 검색
  if (projectName && !opts.project) {
    try {
      await access(path.join(projectDir(projectName), "index.jsonl"));
    } catch {
      projectName = null;
    }
  }
  const results = await searchMemories(opts.query, { project: projectName });

  if (results.length === 0) {
    console.log("검색 결과 없음");
    return;
  }

  for (const result of results) {
    const boostLabel = result.boostCount > 0 ? ` (${result.boostCount}회 강화)` : "";
    console.log(`[${result.score.toFixed(4)}] ${result.title}${boostLabel}`);
    console.log(`       ${result.file}`);
    console.log();
  }
}

// ── boost ──

async function commandBoost(opts) {
  const projectName = opts.project || detectProject();
  try {
    const result = await boostMemory(opts.query, projectName);
    console.log(`boosted ${result.id} → boostCount: ${result.boostCount}`);
    console.log(`title: ${result.title}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// ── context ──

async function commandContext(opts) {
  const config = await loadConfig();
  const projectName = opts.all ? null : (opts.project || detectProject());
  const limit = parseInt(opts.limit);

  const allEntries = [];

  if (projectName) {
    const entries = await loadIndex(path.join(projectDir(projectName), "index.jsonl"));
    for (const entry of entries) {
      allEntries.push({ entry, baseDir: projectDir(projectName), source: `project (${projectName})` });
    }
  }

  const globalEntries = await loadIndex(path.join(globalDir(), "index.jsonl"));
  for (const entry of globalEntries) {
    allEntries.push({ entry, baseDir: globalDir(), source: "global" });
  }

  if (allEntries.length === 0) {
    console.log("기억이 없습니다.");
    return;
  }

  // 점수 계산 + 정렬
  const scored = allEntries.map(({ entry, baseDir, source }) => ({
    entry,
    baseDir,
    source,
    score: computeEffectiveScore(entry, config.decayDays),
  }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit);

  // 프로젝트/글로벌 분류
  const projectMemories = top.filter((s) => s.source.startsWith("project"));
  const globalMemories = top.filter((s) => s.source === "global");

  let promptText = `아래는 이 프로젝트 및 관련 글로벌 기억 목록입니다.
지금 세션을 시작하는 개발자에게 간결한 컨텍스트 브리핑을 작성하세요.

규칙:
- 최근 작업 흐름과 현재 상태를 3-5줄로 요약
- 진행 중이던 작업이 있으면 이어서 할 수 있게 힌트 제공
- 프로젝트 간 관련 지식이 있으면 연결 (글로벌 기억 참조)
- 반복적으로 강화된 기억(boostCount 높은 것)은 핵심 지식으로 강조
- 마지막에 관련 기억 ID + 파일 경로 목록 첨부
`;

  if (projectMemories.length > 0) {
    promptText += `\n[프로젝트 기억: ${projectName}]\n`;
    for (const { entry, score } of projectMemories) {
      const boostLabel = entry.boostCount > 0 ? `, ${entry.boostCount}회 강화` : "";
      promptText += `- ${entry.title} (점수 ${score.toFixed(2)}${boostLabel})\n`;
    }
  }

  if (globalMemories.length > 0) {
    promptText += `\n[글로벌 기억]\n`;
    for (const { entry, score } of globalMemories) {
      const boostLabel = entry.boostCount > 0 ? `, ${entry.boostCount}회 강화` : "";
      promptText += `- ${entry.title} (점수 ${score.toFixed(2)}${boostLabel})\n`;
    }
  }

  // 상위 3개 요약/원본 일부 첨부
  const topOriginals = top.slice(0, 3);
  if (topOriginals.length > 0) {
    promptText += `\n[최근 기억 (상위 ${topOriginals.length}개)]\n`;
    for (const { entry, baseDir } of topOriginals) {
      const summaryPath = entry.summaryFile ? path.join(baseDir, entry.summaryFile) : null;
      const originalPath = path.join(baseDir, entry.file);
      let content = null;
      if (summaryPath) {
        try { content = await readFile(summaryPath, "utf-8"); } catch {}
      }
      if (!content) {
        try { content = (await readFile(originalPath, "utf-8")).slice(0, 2000); } catch {}
      }
      if (content) {
        promptText += `\n--- ${entry.title} ---\n${content}\n`;
      }
    }
  }

  process.stderr.write("컨텍스트 브리핑 생성 중...\n");
  const briefing = await spawnLlmText(promptText, { provider: opts.provider });

  console.log(briefing);
  console.log();
  console.log("관련 기억:");
  for (const { entry, baseDir } of top.slice(0, 10)) {
    const shortId = entry.id.slice(0, 16);
    const filePath = path.join(baseDir, entry.file);
    console.log(`- ${shortId} ${filePath}`);
  }
}

// ── reindex ──

const MAX_SUMMARY_BYTES = 10 * 1024;

const SUMMARY_INSTRUCTIONS = `아래 세션 기록에서 나중에 재사용할 수 있는 지식을 추출하세요.

추출 우선순위 (P1부터 채우고, 크기 내에서 P2→P3 순으로 추가):
P1 — 최종 결정과 그 이유:
  - 설계/아키텍처 선택과 왜 그렇게 결정했는지
  - 버그의 근본 원인과 최종 해결법
  - API 스펙, 데이터 모델의 확정된 형태
  - 사용자 선호/거부 신호: 사용자가 거부하거나 수정을 요구한 접근 방식, 반복 지시한 사항, 답답해한 패턴
    (예: "아니 그거 말고...", "아까 말했는데...", "왜이리 오래 걸려" 등 불만/교정 반응에서 추출)
P2 — 구현 세부사항:
  - 변경된 파일 목록과 각 파일의 역할
  - 설정, 환경변수, 배포 관련 발견
  - 프로젝트 간 연동 포인트
  - 성공적으로 사용된 반복성 높은 명령어, 접속 정보, 환경별 엔드포인트 (실패한 명령어는 제외)
P3 — 맥락 정보:
  - 고려했으나 채택하지 않은 대안 (간단히)
  - 향후 주의할 제약사항이나 알려진 한계

포함하지 말 것:
- 단계별 디버깅 로그나 도구 사용 과정 (파일 읽기, 검색 등)
- 시행착오의 개별 단계 (단, "X를 시도했으나 Y 때문에 실패 → Z로 해결"처럼 교훈은 반드시 포함)
- 일반 상식이나 공식 문서에 있는 내용
- 프로덕션 환경의 비밀번호, API 키, 토큰 (비프로덕션 접속정보는 운영 지식으로 보존)

SKIP 기준 (아래 모두 해당할 때만):
- 단순 질답(설치 방법, 파일 내용 확인, 일반 상식)
- 프로젝트 고유 맥락이 전혀 없는 세션
- 실질적 구현이나 결정이 없었던 세션

출력: 마크다운 10KB 이내, 또는 "SKIP" 한 단어.`;

// backward compat alias
const SUMMARY_PROMPT = SUMMARY_INSTRUCTIONS + "\n\n세션 기록:\n";

function buildPartSummaryPrompt(part, partIndex, totalParts, previousSummary) {
  const perPartKB = Math.ceil(MAX_SUMMARY_BYTES / 1024 / totalParts);
  const budgetLabel = `${perPartKB}KB`;

  let prompt = `<session-part part="${partIndex + 1}" total="${totalParts}">
${part}
</session-part>

이 세션은 총 ${totalParts}개 파트 중 ${partIndex + 1}번째입니다.
이 파트의 요약 예산: ${budgetLabel} (전체 ${MAX_SUMMARY_BYTES / 1024}KB를 ${totalParts}파트로 배분)
`;

  if (previousSummary) {
    prompt += `
<previous-part-summary>
${previousSummary}
</previous-part-summary>

위는 직전 파트의 요약입니다. 이어지는 맥락이 있으면 참고하여 이 파트를 요약하세요.
`;
  }

  prompt += `\n${SUMMARY_INSTRUCTIONS}\n`;
  // 파트별이므로 전체 상한 대신 파트 예산으로 대체
  prompt = prompt.replace(/마크다운 10KB 이내/, `마크다운 ${budgetLabel} 이내`);
  return prompt;
}

async function processLargeTranscript(transcript, { provider, log } = {}) {
  const write = log || ((msg) => process.stderr.write(msg + "\n"));
  const parts = splitTranscript(transcript);
  write(`processing per-part summaries (${parts.length} parts)`);

  const partSummaries = [];
  let skippedCount = 0;

  for (let i = 0; i < parts.length; i++) {
    write(`  part ${i + 1}/${parts.length}...`);
    try {
      const previousSummary = partSummaries[i - 1] || null;
      const result = await spawnLlmText(buildPartSummaryPrompt(parts[i], i, parts.length, previousSummary), { provider });
      if (result.trim().toUpperCase().startsWith("SKIP")) {
        partSummaries.push(null);
        skippedCount++;
      } else {
        partSummaries.push(result.trim());
      }
    } catch (e) {
      if (e.message === "RATE_LIMITED") throw e;
      write(`  part ${i + 1} failed: ${e.message}`);
      partSummaries.push(null);
      skippedCount++;
    }
  }

  const validSummaries = partSummaries.filter(Boolean);
  if (validSummaries.length === 0) {
    return { skipped: true, parts, combinedSummary: null };
  }

  const combinedSummary = validSummaries.join("\n\n---\n\n");
  return { skipped: false, parts, combinedSummary };
}

function buildSummaryPrompt(transcript, topics, oldSummaries = []) {
  const content = transcript.slice(0, 80000);

  if (topics.length <= 1) {
    let suffix = `\n</session>\n\n${SUMMARY_INSTRUCTIONS}\n`;
    if (oldSummaries[0]) {
      suffix += `\n이전 기억 요약 (이 토픽이 업데이트하는 기존 기억):\n${oldSummaries[0]}\n\n위 내용과 새 세션을 통합하여 최신 상태를 반영하세요.
중요: 통합 결과는 반드시 10KB 이내여야 합니다. 기존 내용 중 새 세션으로 대체/무효화된 정보는 삭제하고, P3 우선순위 정보부터 축소하세요. 단순 누적이 아닌 통합입니다.\n`;
    }
    return `<session>\n${content}\n${suffix}`;
  }

  const perTopicKB = Math.ceil(MAX_SUMMARY_BYTES / 1024 / topics.length);

  let suffix = `\n</session>\n\n이 세션 기록에는 ${topics.length}개의 독립된 주제가 있습니다.
각 주제별로 나중에 재사용할 수 있는 지식을 추출하세요.
전체 예산 ${MAX_SUMMARY_BYTES / 1024}KB를 ${topics.length}개 주제로 배분합니다 (주제당 ~${perTopicKB}KB).

${SUMMARY_INSTRUCTIONS}

출력 형식 (주제별로 구분):
`;

  for (let i = 0; i < topics.length; i++) {
    suffix += `=== TOPIC ${i + 1}: ${topics[i].title} ===\n`;
    if (oldSummaries[i]) {
      suffix += `이전 기억 요약 (이 토픽이 업데이트하는 기존 기억):\n${oldSummaries[i]}\n위 내용과 새 세션을 통합하여 최신 상태를 반영하세요. 대체/무효화된 정보는 삭제하고 P3부터 축소하세요.\n`;
    }
    suffix += `마크다운 ${perTopicKB}KB 이내, 또는 "SKIP"\n\n`;
  }

  return `<session>\n${content}\n${suffix}`;
}

function parseMultiTopicSummary(summaryText, topicCount) {
  if (topicCount <= 1) {
    return [summaryText];
  }

  const summaries = [];
  for (let i = 1; i <= topicCount; i++) {
    const startMarker = `=== TOPIC ${i}`;
    const nextMarker = i < topicCount ? `=== TOPIC ${i + 1}` : null;

    const startIdx = summaryText.indexOf(startMarker);
    if (startIdx === -1) {
      summaries.push(null);
      continue;
    }

    const lineEnd = summaryText.indexOf("\n", startIdx);
    const contentStart = lineEnd !== -1 ? lineEnd + 1 : startIdx + startMarker.length;

    let contentEnd;
    if (nextMarker) {
      contentEnd = summaryText.indexOf(nextMarker);
      if (contentEnd === -1) contentEnd = summaryText.length;
    } else {
      contentEnd = summaryText.length;
    }

    const content = summaryText.slice(contentStart, contentEnd).trim();
    summaries.push(content && !content.toUpperCase().startsWith("SKIP") ? content : null);
  }

  return summaries;
}

async function reindexDir(dirPath, opts) {
  const originalsDir = path.join(dirPath, "originals");
  const summariesDir = path.join(dirPath, "summaries");
  const indexPath = path.join(dirPath, "index.jsonl");

  let files;
  try {
    files = (await readdir(originalsDir)).filter((f) => f.endsWith(".md") && !f.includes(".part")).sort();
  } catch {
    return { entries: 0 };
  }

  let entries = opts.rebuild ? [] : await loadIndex(indexPath);
  const existingIds = new Set(entries.map((e) => e.id));
  let count = 0;
  let summaryCount = 0;

  for (const file of files) {
    const id = file.replace(/\.md$/, "");
    if (existingIds.has(id)) continue;

    const filePath = path.join(originalsDir, file);
    const content = (await readFile(filePath, "utf-8")).trim();
    if (!content) continue;

    process.stderr.write(`인덱싱: ${file}...\n`);
    try {
      let meta, largeSummary;
      const isLarge = content.length >= SPLIT_THRESHOLD_CHARS;

      if (isLarge) {
        const largeResult = await processLargeTranscript(content, { provider: opts.provider });
        if (largeResult.skipped) {
          process.stderr.write(`  SKIP (large, all parts skipped)\n`);
          continue;
        }
        largeSummary = largeResult.combinedSummary;
        const { prefix, suffix } = buildSavePrompt(entries.map(e => ({ id: e.id, title: e.title, tags: e.tags })), { fromSummary: true });
        meta = await spawnLlmJson(prefix + largeSummary + suffix, { provider: opts.provider });
      } else {
        const { prefix, suffix } = buildSavePrompt(entries.map(e => ({ id: e.id, title: e.title, tags: e.tags })));
        meta = await spawnLlmJson(prefix + content + suffix, { provider: opts.provider });
      }

      let topics;
      if (meta.topics && Array.isArray(meta.topics)) {
        topics = meta.topics.filter(t => t.title && t.tags);
      } else if (meta.title && meta.tags) {
        topics = [{ title: meta.title, tags: meta.tags }];
      } else {
        process.stderr.write(`  title/tags 누락, 건너뜀\n`);
        continue;
      }

      for (let ti = 0; ti < topics.length; ti++) {
        const topicId = topics.length === 1 ? id : `${id}-topic-${ti + 1}`;
        const entry = {
          id: topicId,
          title: topics[ti].title,
          tags: topics[ti].tags,
          file: `originals/${file}`,
          bytes: Buffer.byteLength(content, "utf-8"),
          createdAt: new Date().toISOString(),
          lastBoosted: new Date().toISOString(),
          boostCount: 0,
        };
        if (isLarge && largeSummary) {
          const summaryFile = `summaries/${topicId}.md`;
          await mkdir(summariesDir, { recursive: true });
          await writeFile(path.join(dirPath, summaryFile), largeSummary + "\n");
          entry.summaryFile = summaryFile;
        }
        entries.push(entry);
        count++;
      }
    } catch (e) {
      process.stderr.write(`  실패: ${e.message}\n`);
    }
  }

  // Generate summaries for entries missing them
  await mkdir(summariesDir, { recursive: true });
  for (const entry of entries) {
    if (entry.summaryFile) continue;
    const filePath = path.join(dirPath, entry.file);
    let content;
    try { content = (await readFile(filePath, "utf-8")).trim(); } catch { continue; }
    if (!content) continue;

    process.stderr.write(`요약 생성: ${entry.id}...\n`);
    try {
      let summary;
      if (content.length >= SPLIT_THRESHOLD_CHARS) {
        const largeResult = await processLargeTranscript(content, { provider: opts.provider });
        if (largeResult.skipped) {
          process.stderr.write(`  SKIP (large, all parts skipped)\n`);
          continue;
        }
        summary = largeResult.combinedSummary;
      } else {
        summary = await spawnLlmText(`<session>\n${content.slice(0, 80000)}\n</session>\n\n${SUMMARY_INSTRUCTIONS}\n`, { provider: opts.provider });
      }
      const summaryFile = `summaries/${entry.id}.md`;
      await writeFile(path.join(dirPath, summaryFile), summary + "\n");
      entry.summaryFile = summaryFile;
      summaryCount++;
    } catch (e) {
      process.stderr.write(`  요약 실패: ${e.message}\n`);
    }
  }

  if (count > 0 || summaryCount > 0) {
    await saveIndex(indexPath, entries);
  }
  return { entries: count };
}

async function commandReindex(opts) {
  const projectName = opts.project || detectProject();
  let totalEntries = 0;

  async function accumulate(dirPath) {
    const result = await reindexDir(dirPath, opts);
    totalEntries += result.entries;
  }

  if (opts.project) {
    // 특정 프로젝트만
    await accumulate(projectDir(opts.project));
  } else {
    // 프로젝트 + 글로벌
    if (projectName) {
      await accumulate(projectDir(projectName));
    }

    // 모든 프로젝트 디렉토리
    const projectsDir = path.join(MEM_DIR, "projects");
    try {
      const projects = await readdir(projectsDir);
      for (const project of projects) {
        if (project === projectName) continue;
        await accumulate(projectDir(project));
      }
    } catch {}

    await accumulate(globalDir());
  }

  console.log(`reindex 완료: ${totalEntries}개 엔트리`);
}

// ── gc ──

async function commandGc(opts) {
  const threshold = parseFloat(opts.threshold);
  const minKeep = opts.minKeep != null ? parseInt(opts.minKeep) : undefined;
  const dryRun = opts.dryRun;

  if (dryRun) process.stderr.write("dry-run 모드\n\n");

  const result = await gcMemories({
    threshold,
    minKeep,
    dryRun,
    onRemove: (entry, score) => {
      console.log(`  [${score.toFixed(4)}] ${entry.title} (${entry.id})`);
    },
  });

  const action = dryRun ? "대상" : "아카이브";
  console.log(`\ngc 완료: ${result.archived}개 ${action}, ${result.kept}개 유지`);
}

// ── restore ──

async function commandRestore(opts) {
  const dryRun = opts.dryRun;
  const all = opts.all;
  const ids = !all && opts.query ? opts.query.split(/\s+/) : null;

  if (dryRun) process.stderr.write("dry-run 모드\n\n");

  const result = await restoreMemories({
    ids,
    all,
    dryRun,
    onRestore: (entry) => {
      const archivedLabel = entry.archivedAt ? ` (아카이브: ${entry.archivedAt.slice(0, 10)})` : "";
      console.log(`  ${entry.title} (${entry.id})${archivedLabel}`);
    },
  });

  const action = dryRun ? "대상" : "복원";
  console.log(`\nrestore 완료: ${result.restored}개 ${action}, ${result.remaining}개 아카이브 잔여`);
}

// ── delete ──

function isDaemonRunning() {
  const pidPath = path.join(MEM_DIR, "daemon", "memd.pid");
  try {
    const pid = parseInt(require("fs").readFileSync(pidPath, "utf-8").trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function stopDaemonSync(pid) {
  process.kill(pid, "SIGTERM");
  // 종료 대기 (최대 3초)
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    execSync("sleep 0.1");
  }
  return false;
}

function startDaemonAsync() {
  const memdPath = path.join(__dirname, "memd.js");
  const child = spawn("node", [memdPath, "start"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function commandDelete(opts) {
  const targetId = opts.query;
  if (!targetId) {
    console.error("삭제할 기억 ID 필수\n사용법: node mem.js delete <id>");
    process.exit(1);
  }

  // 데몬이 실행 중이면 중지 (인메모리 state 덮어쓰기 방지)
  const daemonPid = isDaemonRunning();
  if (daemonPid) {
    console.log(`데몬 중지 (pid: ${daemonPid})...`);
    if (!stopDaemonSync(daemonPid)) {
      console.error("데몬 중지 실패. 수동으로 중지 후 다시 시도하세요.");
      process.exit(1);
    }
  }

  // 모든 인덱스에서 검색
  const locations = [path.join(globalDir(), "index.jsonl")];
  const projectsBase = path.join(MEM_DIR, "projects");
  try {
    const dirs = await readdir(projectsBase);
    for (const d of dirs) locations.push(path.join(projectsBase, d, "index.jsonl"));
  } catch {}

  let found = false;
  for (const indexPath of locations) {
    const entries = await loadIndex(indexPath);
    const entry = entries.find(e => e.id === targetId);
    if (!entry) continue;
    found = true;

    const baseDir = path.dirname(indexPath);

    // 인덱스에서 제거
    const filtered = entries.filter(e => e.id !== targetId);
    await saveIndex(indexPath, filtered);
    console.log(`인덱스 제거: ${indexPath} (${entries.length} → ${filtered.length})`);

    // 요약 파일 삭제
    if (entry.summaryFile) {
      try {
        await unlink(path.join(baseDir, entry.summaryFile));
        console.log(`요약 삭제: ${entry.summaryFile}`);
      } catch {}
    }

    // 데몬 state에서 제거 (재처리 대상으로)
    const statePath = path.join(MEM_DIR, "daemon", "state.json");
    try {
      const state = JSON.parse(await readFile(statePath, "utf-8"));
      let removed = 0;
      const sessionId = entry.sourceSessionId || targetId;
      if (state.processedSessions[sessionId]) {
        delete state.processedSessions[sessionId];
        removed++;
      }
      // amendment로 연결된 세션도 제거
      for (const [sid, val] of Object.entries(state.processedSessions)) {
        const mid = val.memoryId;
        if (mid === targetId || (Array.isArray(mid) && mid.includes(targetId))) {
          delete state.processedSessions[sid];
          removed++;
        }
      }
      if (removed > 0) {
        await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
        console.log(`데몬 state 제거: ${removed}건 (재처리 대상)`);
      }
    } catch {}

    console.log(`\n삭제 완료: "${entry.title}"`);
    break;
  }

  if (!found) {
    console.error(`기억 "${targetId}" 를 찾을 수 없음`);
    // 데몬이 실행 중이었으면 복원
    if (daemonPid) {
      console.log("데몬 재시작...");
      startDaemonAsync();
    }
    process.exit(1);
  }

  // 데몬이 실행 중이었으면 재시작
  if (daemonPid) {
    console.log("데몬 재시작...");
    startDaemonAsync();
    console.log("해당 세션이 자동 재처리됩니다.");
  } else {
    console.log("데몬 시작 후 해당 세션이 재처리됩니다.");
  }
}

// ── purge ──

async function commandPurge(opts) {
  const dryRun = opts.dryRun;

  if (dryRun) process.stderr.write("dry-run 모드\n\n");

  const result = await purgeArchive({
    dryRun,
    onPurge: (entry) => {
      console.log(`  ${entry.title} (${entry.id})`);
    },
  });

  const action = dryRun ? "대상" : "삭제";
  console.log(`\npurge 완료: ${result.purged}개 ${action}`);
}

// ── reset ──

async function commandReset(opts) {
  // 데몬이 실행 중이면 먼저 종료
  let daemonWasRunning = false;
  try {
    execSync("memd stop", { stdio: "pipe" });
    daemonWasRunning = true;
    console.log("데몬 종료");
  } catch {}

  const statePath = path.join(MEM_DIR, "daemon", "state.json");
  try {
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    const count = Object.keys(state.processedSessions || {}).length;
    state.processedSessions = {};
    await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(`데몬 state 초기화: ${count}개 세션 → 재처리 대상`);
  } catch {
    console.log("데몬 state 없음 (이미 초기 상태)");
  }

  // 데몬이 실행 중이었으면 재시작
  if (daemonWasRunning) {
    try {
      execSync("memd start", { stdio: "pipe" });
      console.log("데몬 재시작");
    } catch (e) {
      console.error(`데몬 재시작 실패: ${e.message}`);
    }
  }
}

// ── main ──

async function main() {
  const opts = parseArgs(process.argv);
  await validate(opts);

  await mkdir(MEM_DIR, { recursive: true });

  switch (opts.command) {
    case "save": await commandSave(opts); break;
    case "search": await commandSearch(opts); break;
    case "boost": await commandBoost(opts); break;
    case "context": await commandContext(opts); break;
    case "reindex": await commandReindex(opts); break;
    case "delete": await commandDelete(opts); break;
    case "gc": await commandGc(opts); break;
    case "restore": await commandRestore(opts); break;
    case "purge": await commandPurge(opts); break;
    case "reset": await commandReset(opts); break;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = {
  run: () => main().catch((e) => { console.error(e.message); process.exit(1); }),
  MEM_DIR, projectDir, globalDir,
  loadConfig,
  loadIndex, saveIndex, computeEffectiveScore,
  tokenize, buildBm25Doc, computeDocumentFrequency, bm25ScoreDoc, reciprocalRankFusion,
  saveMemory, updateMemory, searchMemories, boostMemory, gcMemories, restoreMemories, purgeArchive,
  buildSearchIndex, addToSearchIndex,
  extractJson, isRateLimited, buildCommand, spawnLlmJson, spawnLlmText,
  MAX_SUMMARY_BYTES, SUMMARY_PROMPT, buildSavePrompt, buildSummaryPrompt, parseMultiTopicSummary,
  SPLIT_THRESHOLD_CHARS, SPLIT_TARGET_CHARS, splitTranscript,
  buildPartSummaryPrompt, processLargeTranscript,
  detectProject,
  loadActiveMemories,
  reconcileMemories,
};
