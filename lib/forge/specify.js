const path = require("path");
const { readFile } = require("fs/promises");
const { generateRequirements, validateRequirements, formatGapReport } = require("../core/spec");
const { runParallel } = require("../core/parallel");
const { llmText } = require("../core/llm");
const { saveArtifact, loadArtifact } = require("../core/worktree");
const { STAGE_MODELS, FORGE_DIR } = require("../core/constants");
const { parseDecisionsFile } = require("../core/qna");

const MAX_VALIDATION_RETRIES = 2;

async function run({ taskId, dag, project, timeouts, onLog = () => {} } = {}) {
  const pipeline = dag.pipeline;
  const provider = "claude";

  let decisionsContent = "";
  let decisions = [];
  try {
    const raw = await loadArtifact(taskId, "decisions.json");
    decisions = JSON.parse(raw);
  } catch {
    try {
      decisionsContent = await loadArtifact(taskId, "decisions.md");
      decisions = parseDecisionsFile(decisionsContent);
    } catch {}
  }

  if (decisions.length === 0) {
    try {
      const taskContent = await loadArtifact(taskId, "task.md");
      decisions = [{ area: "작업 목표", question: "요구사항", answer: taskContent, reason: "" }];
    } catch {}
  }

  const useRsa = pipeline === "medium" || pipeline === "large";

  const totalTokenUsage = { input: 0, output: 0 };

  let specContent;
  if (useRsa) {
    const rsaResult = await generateWithRsa(decisions, { project, provider, taskId, onLog });
    specContent = rsaResult.text;
    totalTokenUsage.input += rsaResult.tokenUsage.input;
    totalTokenUsage.output += rsaResult.tokenUsage.output;
  } else {
    const simpleResult = await generateSimple(decisions, { project, provider, onLog });
    specContent = simpleResult.text;
    totalTokenUsage.input += simpleResult.tokenUsage.input;
    totalTokenUsage.output += simpleResult.tokenUsage.output;
  }

  // Validation loop
  for (let attempt = 0; attempt < MAX_VALIDATION_RETRIES; attempt++) {
    onLog(`[specify] validating spec (attempt ${attempt + 1})...`);

    let validationResult;
    try {
      validationResult = await validateRequirements(specContent, { cwd: project, provider });
      totalTokenUsage.input += validationResult.tokenUsage.input;
      totalTokenUsage.output += validationResult.tokenUsage.output;
    } catch (e) {
      onLog(`[specify] validation error: ${e.message}`);
      break;
    }

    if (validationResult.data.pass) {
      onLog("[specify] validation passed");
      await saveArtifact(taskId, "validation.json", JSON.stringify(validationResult.data, null, 2));
      break;
    }

    const gaps = Array.isArray(validationResult.data.gaps) ? validationResult.data.gaps : [];
    onLog(`[specify] validation failed: ${gaps.length} gaps`);
    await saveArtifact(taskId, `gap-report-${attempt + 1}.md`, formatGapReport(gaps));

    if (attempt < MAX_VALIDATION_RETRIES - 1) {
      onLog("[specify] regenerating spec with gap feedback...");
      const gapFeedback = gaps.map((g) => `- ${g.criterion}: ${g.detail}`).join("\n");
      const regenResult = await regenerateWithFeedback(specContent, gapFeedback, { project, provider, onLog });
      specContent = regenResult.text;
      totalTokenUsage.input += regenResult.tokenUsage.input;
      totalTokenUsage.output += regenResult.tokenUsage.output;
    } else {
      onLog("[specify] max validation retries reached, proceeding with warnings");
      dag.warnings.push(`spec validation failed after ${MAX_VALIDATION_RETRIES} attempts`);
    }
  }

  await saveArtifact(taskId, "spec.md", specContent);
  onLog("[specify] spec saved");

  return { spec: specContent, tokenUsage: totalTokenUsage };
}

async function generateSimple(decisions, { project, provider, onLog }) {
  onLog("[specify] generating spec (single)...");
  return await generateRequirements(decisions, {
    cwd: project,
    provider,
  });
}

async function generateWithRsa(decisions, { project, provider, taskId, onLog }) {
  onLog("[specify] generating spec with RSA (3 parallel → 1 converge)...");

  const decisionsText = decisions.map((d) =>
    `- **[${d.area}] ${d.question}**\n  → ${d.answer}\n${d.reason ? `  (이유: ${d.reason})\n` : ""}`
  ).join("");

  const specPrompt = `아래 설계 결정을 바탕으로 요구사항 명세를 마크다운으로 작성하세요.
마크다운 본문만 출력하세요.

## 요구사항 명세 구조

### 1. 개요
### 2. 기능 요구사항 (EARS 표기법)
### 3. 비기능 요구사항
### 4. 범위 경계
### 5. 용어 정의

## 설계 결정

${decisionsText}`;

  const workerModel = STAGE_MODELS.specify.worker;
  const convergeModel = STAGE_MODELS.specify.converge;
  const outputDir = path.join(FORGE_DIR, taskId, "rsa-spec");

  const parallelResult = await runParallel(specPrompt, {
    cwd: project,
    count: 3,
    model: workerModel,
    provider,
    outputDir,
    onProgress: (event) => {
      if (event.type === "done") onLog(`[specify] worker ${event.id} done (${event.elapsed})`);
      else if (event.type === "failed") onLog(`[specify] worker ${event.id} failed`);
    },
  });

  if (parallelResult.done.length === 0) {
    throw new Error("all RSA workers failed");
  }

  // worker 결과를 직접 읽어서 converge 프롬프트에 인라인 주입
  onLog("[specify] reading worker outputs...");
  const workerOutputs = [];
  for (const id of parallelResult.done) {
    try {
      const content = await readFile(path.join(outputDir, `${id}.md`), "utf-8");
      workerOutputs.push({ id, content });
    } catch {}
  }

  if (workerOutputs.length === 0) {
    throw new Error("no worker outputs to converge");
  }

  onLog(`[specify] converging ${workerOutputs.length} results...`);

  const inlineResults = workerOutputs.map((w) =>
    `### Worker ${w.id}\n\n${w.content}`
  ).join("\n\n---\n\n");

  const convergePrompt = `당신은 여러 독립적인 작업 결과를 하나로 취합하는 편집자입니다.

## 원래 작업 지시

${specPrompt}

## 개별 결과

${inlineResults}

## 취합 방법

1. 모든 결과의 구조와 내용을 파악하세요.
2. 여러 결과에 공통으로 등장하는 내용은 반드시 포함하세요.
3. 하나의 결과에만 등장하는 내용은 근거가 충분하면 포함하세요.
4. 결과 간 상충하는 내용은 더 구체적인 근거를 가진 쪽을 택하세요.
5. 최종 결과는 하나의 일관된 마크다운 문서로 작성하세요.`;

  const { text: convergedSpec, tokenUsage } = await llmText(convergePrompt, {
    model: convergeModel,
    provider,
    allowTools: "",
  });

  return {
    text: convergedSpec,
    tokenUsage: {
      input: (parallelResult.tokenUsage?.input || 0) + (tokenUsage?.input || 0),
      output: (parallelResult.tokenUsage?.output || 0) + (tokenUsage?.output || 0),
    },
  };
}

async function regenerateWithFeedback(currentSpec, gapFeedback, { project, provider, onLog }) {
  const prompt = `아래 요구사항 명세에 부족한 부분이 있습니다. 보완하세요.

## 현재 명세

${currentSpec}

## 부족한 부분

${gapFeedback}

## 지시사항

위 gap을 해결하여 완성된 명세를 마크다운으로 작성하세요.
전체 명세를 출력하세요 (부족한 부분만이 아닌 전체).`;

  const { text, tokenUsage } = await llmText(prompt, {
    model: STAGE_MODELS.specify.converge,
    cwd: project,
    provider,
    allowTools: project ? "Read,Glob,Grep" : "",
  });
  return { text, tokenUsage };
}

module.exports = { run };
