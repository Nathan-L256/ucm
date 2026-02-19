const { llmJson } = require("../core/llm");
const { loadArtifact, saveArtifact } = require("../core/worktree");
const { STAGE_MODELS } = require("../core/constants");

const DECOMPOSE_PROMPT = `당신은 소프트웨어 태스크 분해 전문가입니다.
아래 명세를 분석하여 독립적으로 구현 가능한 sub-task 목록을 생성하세요.

## 규칙

1. 각 sub-task는 독립적으로 구현/테스트 가능해야 합니다.
2. 의존성(blockedBy)을 명확히 지정하세요.
3. 의존성이 없는 task들은 동시 실행 가능합니다.
4. sub-task는 2~8개 범위로 유지하세요.
5. 각 task에 예상 영향 파일을 나열하세요.

## 응답 형식 (JSON만 출력)

{
  "tasks": [
    {
      "id": "t1",
      "title": "태스크 제목",
      "description": "구체적인 구현 내용",
      "blockedBy": [],
      "estimatedFiles": ["파일1.js", "파일2.js"]
    },
    {
      "id": "t2",
      "title": "태스크 제목",
      "description": "구체적인 구현 내용",
      "blockedBy": ["t1"],
      "estimatedFiles": ["파일3.js"]
    }
  ]
}`;

async function run({ taskId, dag, project, timeouts, onLog = () => {} } = {}) {
  if (dag.pipeline !== "large") {
    onLog("[decompose] skipping (not large pipeline)");
    return { skipped: true };
  }

  const model = STAGE_MODELS.decompose;

  let specContent = "";
  try {
    specContent = await loadArtifact(taskId, "spec.md");
  } catch {
    try {
      specContent = await loadArtifact(taskId, "task.md");
    } catch {}
  }

  let designContent = "";
  try {
    designContent = await loadArtifact(taskId, "design.md");
  } catch {}

  const prompt = `${DECOMPOSE_PROMPT}

## 명세

${specContent}

${designContent ? `## 설계\n\n${designContent}` : ""}`;

  onLog("[decompose] analyzing spec for task decomposition...");

  const { data: result, tokenUsage } = await llmJson(prompt, {
    model,
    cwd: project,
    allowTools: project ? "Read,Glob,Grep" : "",
  });

  const tasks = result.tasks || [];
  if (tasks.length === 0) {
    onLog("[decompose] no subtasks generated, proceeding as single task");
    return { skipped: true };
  }

  for (const task of tasks) {
    dag.addTask({
      id: String(task.id),
      title: task.title || "",
      description: task.description || "",
      blockedBy: (task.blockedBy || []).map(String),
      estimatedFiles: task.estimatedFiles || [],
    });
  }

  dag.validateDeps();
  await dag.save();
  await saveArtifact(taskId, "tasks.json", JSON.stringify(dag.tasks, null, 2));

  const waves = dag.getWaves();
  onLog(`[decompose] ${tasks.length} subtasks in ${waves.length} wave(s)`);
  for (let i = 0; i < waves.length; i++) {
    const waveTaskIds = waves[i];
    const waveTasks = waveTaskIds.map((id) => {
      const t = dag.tasks.find((t) => t.id === id);
      return t ? `${t.id}: ${t.title}` : id;
    });
    onLog(`  wave ${i + 1}: ${waveTasks.join(", ")}`);
  }

  return { tasks: dag.tasks, waves, tokenUsage };
}

module.exports = { run };
