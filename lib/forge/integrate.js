const { spawnAgent } = require("../core/agent");
const { mergeWorktrees, loadWorkspace, getWorktreeDiff, saveArtifact } = require("../core/worktree");
const { STAGE_MODELS, STAGE_TIMEOUTS } = require("../core/constants");

async function run({ taskId, dag, project, timeouts, onLog = () => {} } = {}) {
  if (!dag.tasks || dag.tasks.length <= 1) {
    onLog("[integrate] skipping (single task or no subtasks)");
    return { skipped: true };
  }

  const effectiveTimeouts = timeouts || STAGE_TIMEOUTS.integrate;
  const workspace = await loadWorkspace(taskId);

  if (!workspace) {
    onLog("[integrate] no workspace found, skipping merge");
    return { skipped: true };
  }

  const failedTasks = dag.tasks.filter((t) => t.status === "failed");
  const doneTasks = dag.tasks.filter((t) => t.status === "done");

  if (doneTasks.length === 0) {
    const failedIds = failedTasks.map((t) => t.id).join(", ");
    dag.warnings.push(`all subtasks failed: ${failedIds}`);
    onLog(`[integrate] all subtasks failed, skipping merge: ${failedIds}`);
    return { skipped: true, allFailed: true };
  }

  if (failedTasks.length > 0) {
    const failedIds = failedTasks.map((t) => t.id).join(", ");
    dag.warnings.push(`integrating with failed subtasks: ${failedIds}`);
    onLog(`[integrate] warning: ${failedTasks.length} subtask(s) failed: ${failedIds}`);
  }

  onLog("[integrate] merging worktrees...");

  try {
    await mergeWorktrees(taskId, workspace.projects, {
      log: (msg) => onLog(`[integrate] ${msg}`),
    });
    onLog("[integrate] merge complete");
  } catch (error) {
    if (error.message.includes("CONFLICT") || error.message.includes("merge failed")) {
      onLog("[integrate] merge conflict detected, attempting LLM resolution...");

      try {
        const originPath = workspace.projects[0]?.origin || project;
        await resolveConflicts(taskId, originPath, { effectiveTimeouts, onLog });
        onLog("[integrate] conflict resolution complete");
      } catch (resolveError) {
        dag.warnings.push(`merge conflict unresolved: ${resolveError.message}`);
        onLog(`[integrate] conflict resolution failed: ${resolveError.message}`);
        onLog("[integrate] manual resolution needed:");
        onLog(`  1. cd ${project}`);
        onLog(`  2. git status  # 충돌 파일 확인`);
        onLog(`  3. # 충돌 해결 후: git add <files> && git commit`);
        onLog(`  4. ucm resume ${taskId} --from integrate`);
        throw new Error(
          `merge conflict requires manual resolution. worktree preserved at ${project}. ` +
          `After resolving: ucm resume ${taskId} --from integrate`
        );
      }
    } else {
      throw error;
    }
  }

  // Run integration tests
  onLog("[integrate] running integration tests...");

  const testResult = await spawnAgent(
    `프로젝트의 전체 테스트를 실행하세요. 결과를 보고하세요.`,
    {
      cwd: project,
      model: STAGE_MODELS.verify,
      idleTimeoutMs: effectiveTimeouts.idle,
      hardTimeoutMs: effectiveTimeouts.hard,
      taskId,
      stage: "integrate-test",
      onLog,
    },
  );

  if (testResult.status !== "done") {
    dag.warnings.push("integration tests may have issues");
    onLog("[integrate] integration test warning: " + testResult.status);
  }

  await saveArtifact(taskId, "integrate-result.json", JSON.stringify({
    merged: true,
    testStatus: testResult.status,
    failedSubtasks: failedTasks.map((t) => t.id),
  }, null, 2));

  return { merged: true, testStatus: testResult.status, tokenUsage: testResult.tokenUsage };
}

async function resolveConflicts(taskId, project, { effectiveTimeouts, onLog }) {
  const result = await spawnAgent(
    `Git merge conflict가 발생했습니다.
충돌 파일을 확인하고 해결하세요.

1. git status로 충돌 파일을 확인하세요.
2. 각 충돌 파일을 읽고 양쪽의 의도를 파악하세요.
3. 충돌을 해결하세요.
4. git add로 해결된 파일을 스테이징하세요.
5. git commit으로 merge를 완료하세요.`,
    {
      cwd: project,
      model: STAGE_MODELS.integrate,
      idleTimeoutMs: effectiveTimeouts.idle,
      hardTimeoutMs: effectiveTimeouts.hard,
      taskId,
      stage: "integrate-resolve",
      onLog,
    },
  );

  if (result.status !== "done") {
    throw new Error(`conflict resolution failed: ${result.status}`);
  }
}

module.exports = { run };
