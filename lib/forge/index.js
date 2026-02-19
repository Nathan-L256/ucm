const { EventEmitter } = require("events");
const path = require("path");
const { mkdir } = require("fs/promises");
const { TaskDag, generateForgeId } = require("../core/task");
const { initArtifacts, createWorktrees, loadWorkspace, getWorktreeCwd, removeWorktrees, loadArtifact, saveArtifact } = require("../core/worktree");
const { FORGE_PIPELINES, STAGE_TIMEOUTS, STAGE_ARTIFACTS, FORGE_DIR } = require("../core/constants");

class ForgePipeline extends EventEmitter {
  constructor({ taskId, input, project, pipeline, autopilot = false, onQuestion, resumeFrom, tokenBudget } = {}) {
    super();
    this.taskId = taskId || generateForgeId();
    this.input = input;
    this.project = project;
    this.pipeline = pipeline;
    this.autopilot = autopilot;
    this.onQuestion = onQuestion || null;
    this.resumeFrom = resumeFrom || null;
    this.tokenBudget = tokenBudget || 0;
    this.dag = null;
    this.worktreeCwd = null;
    this.aborted = false;
  }

  emit(event, data) {
    return super.emit(event, { taskId: this.taskId, ...data });
  }

  async run() {
    const forgeDir = path.join(FORGE_DIR, this.taskId);
    await mkdir(forgeDir, { recursive: true });

    // resume 모드: 기존 DAG 로드
    if (this.resumeFrom) {
      this.dag = await TaskDag.load(this.taskId);
      this.pipeline = this.dag.pipeline;
    } else {
      this.dag = new TaskDag({
        id: this.taskId,
        status: "in_progress",
        pipeline: this.pipeline,
      });
    }

    this.dag.startedAt = this.dag.startedAt || new Date().toISOString();
    this.emit("pipeline:start", { pipeline: this.pipeline, input: this.input });

    try {
      if (this.resumeFrom) {
        // resume: 기존 workspace에서 worktree 복원
        await this.restoreWorktree();
        this.dag.status = "in_progress";
        await this.dag.save();
      } else if (this.pipeline) {
        // pipeline 미리 지정 → intake skip, artifact 초기화
        await initArtifacts(this.taskId, this.input || "");
      }

      const complexity = this.pipeline || await this.runIntake();
      let stages;
      if (FORGE_PIPELINES[complexity]) {
        stages = FORGE_PIPELINES[complexity];
      } else if (typeof complexity === "string" && complexity.includes(",")) {
        stages = complexity.split(",").map((s) => s.trim());
        if (!stages.includes("deliver")) stages.push("deliver");
      } else {
        throw new Error(`unknown pipeline: ${complexity}`);
      }

      this.dag.pipeline = complexity;
      await this.dag.save();

      // worktree 생성 (아직 없으면)
      if (this.project && !this.worktreeCwd) {
        await this.setupWorktree();
      }

      // resume 모드: resumeFrom 이전 stage는 skip
      let skipping = !!this.resumeFrom;

      let subtaskStagesRan = false;
      for (const stageName of stages) {
        if (this.aborted) break;

        if (skipping) {
          if (stageName === this.resumeFrom) {
            skipping = false;
          } else {
            continue;
          }
        }

        // subtask가 있으면 design/implement/verify/ux-review/polish를 runSubtaskStages로 한 번만 실행
        if ((stageName === "design" || stageName === "implement" || stageName === "verify" || stageName === "ux-review" || stageName === "polish") && this.dag.tasks.length > 0) {
          if (!subtaskStagesRan) {
            await this.runSubtaskStages();
            subtaskStagesRan = true;
          }
          continue;
        }

        await this.runStage(stageName);
      }

      if (skipping) {
        throw new Error(`resume stage "${this.resumeFrom}" not found in pipeline: ${stages.join(", ")}`);
      }

      if (!this.aborted) {
        // hivemind에 학습 축적
        await this.learnToHivemind();

        // deliver가 설정한 status를 존중 (auto_merged → done, review → review 유지)
        const finalStatus = this.dag.status === "auto_merged" ? "done" : this.dag.status;
        this.dag.status = finalStatus;
        this.dag.completedAt = new Date().toISOString();
        // deliver의 최종 status를 stageHistory에 보충 기록
        const lastStage = this.dag.stageHistory[this.dag.stageHistory.length - 1];
        if (lastStage && lastStage.stage === "deliver") {
          lastStage.finalStatus = finalStatus;
        }
        await this.dag.save();
        this.emit("pipeline:complete", { status: finalStatus });
      }
    } catch (error) {
      this.dag.status = "failed";
      this.dag.warnings.push(error.message);
      await this.dag.save();
      this.emit("pipeline:error", { error: error.message });
      throw error;
    }

    return this.dag;
  }

  async runIntake() {
    const startTime = Date.now();
    this.emit("stage:start", { stage: "intake", model: null });

    const intake = require("./intake");
    const result = await intake.run(this.input, {
      project: this.project,
      taskId: this.taskId,
      onLog: (line) => this.emit("agent:output", { stage: "intake", chunk: line }),
    });

    const durationMs = Date.now() - startTime;
    this.pipeline = result.complexity;
    this.dag.title = result.title;
    const tokenUsage = result.tokenUsage || null;
    this.dag.recordStage("intake", "pass", durationMs, tokenUsage);
    if (tokenUsage) {
      this.dag.addTokenUsage(tokenUsage.input, tokenUsage.output);
    }
    this.emit("stage:complete", { stage: "intake", durationMs, status: "pass" });
    return result.complexity;
  }

  async setupWorktree() {
    try {
      const projects = [{ name: path.basename(this.project), path: this.project, role: "primary" }];
      const workspace = await createWorktrees(this.taskId, projects, {
        log: (msg) => this.emit("agent:output", { stage: "worktree", chunk: msg }),
      });
      this.worktreeCwd = workspace.projects[0].path;
      this.emit("agent:output", { stage: "worktree", chunk: `[worktree] created at ${this.worktreeCwd}` });
    } catch (error) {
      // worktree 생성 실패 시 원본 프로젝트에서 직접 작업
      this.emit("agent:output", { stage: "worktree", chunk: `[worktree] fallback to project dir: ${error.message}` });
      this.worktreeCwd = this.project;
    }
  }

  async restoreWorktree() {
    if (!this.project) return;
    const workspace = await loadWorkspace(this.taskId);
    if (workspace) {
      this.worktreeCwd = getWorktreeCwd(this.taskId, workspace.projects);
    } else {
      // workspace가 정리되었으면 새로 생성
      await this.setupWorktree();
    }
  }

  async checkRequiredArtifacts(stageName) {
    const stageArtifacts = STAGE_ARTIFACTS[stageName];
    if (!stageArtifacts || stageArtifacts.requires.length === 0) return;

    const missing = [];
    for (const artifact of stageArtifacts.requires) {
      try {
        await loadArtifact(this.taskId, artifact);
      } catch {
        missing.push(artifact);
      }
    }
    if (missing.length > 0) {
      throw new Error(`missing required artifacts for ${stageName}: ${missing.join(", ")}`);
    }
  }

  async runStage(stageName, { subtask } = {}) {
    this.dag.currentStage = stageName;
    await this.dag.save();

    await this.checkRequiredArtifacts(stageName);

    const timeouts = STAGE_TIMEOUTS[stageName] || { idle: 5 * 60_000, hard: 20 * 60_000 };
    const startTime = Date.now();

    this.emit("stage:start", { stage: stageName, model: null });

    // implement/verify는 worktree에서, design은 worktree (또는 원본)에서 실행
    const stageProject = this.worktreeCwd || this.project;

    try {
      const stageModule = require(`./${stageName}`);
      const result = await stageModule.run({
        taskId: this.taskId,
        dag: this.dag,
        project: stageProject,
        autopilot: this.autopilot,
        subtask,
        timeouts,
        tokenBudget: this.tokenBudget,
        onQuestion: this.onQuestion,
        onLog: (line) => this.emit("agent:output", { stage: stageName, chunk: line }),
      });

      const durationMs = Date.now() - startTime;
      const stageTokenUsage = result?.tokenUsage || null;
      this.dag.recordStage(stageName, "pass", durationMs, stageTokenUsage);

      // 토큰 사용량 누적 (stage가 tokenUsage를 반환하면)
      if (stageTokenUsage) {
        this.dag.addTokenUsage(stageTokenUsage.input, stageTokenUsage.output);
      }

      await this.dag.save();
      this.emit("stage:complete", { stage: stageName, durationMs, status: "pass" });

      // 토큰 예산 경고 및 초과 체크
      if (this.tokenBudget > 0) {
        const used = this.dag.totalTokens();
        const percent = Math.round((used / this.tokenBudget) * 100);
        if (used > this.tokenBudget) {
          this.dag.warnings.push(`token budget exceeded: ${used}/${this.tokenBudget}`);
          this.emit("warning:budget", { used, budget: this.tokenBudget, percent });
          throw new Error(`token budget exceeded: ${used}/${this.tokenBudget}`);
        } else if (percent >= 90) {
          this.emit("warning:budget", { used, budget: this.tokenBudget, percent });
        } else if (percent >= 70) {
          this.emit("notice:budget", { used, budget: this.tokenBudget, percent });
        }
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.dag.recordStage(stageName, "fail", durationMs, null);
      await this.dag.save();
      this.emit("stage:complete", { stage: stageName, durationMs, status: "fail" });
      throw error;
    }
  }

  async runSubtaskStages() {
    const waves = this.dag.getWaves();
    for (const wave of waves) {
      if (this.aborted) break;

      // resume 시 이미 완료된 subtask는 스킵
      const pending = wave.filter((id) => {
        const t = this.dag.tasks.find((t) => t.id === id);
        return t && t.status !== "done";
      });

      if (pending.length === 0) continue;

      for (const subtaskId of pending) {
        this.dag.updateTaskStatus(subtaskId, "in_progress");
      }
      await this.dag.save();

      // subtask는 순차 실행 (같은 worktree를 공유하므로 병렬 시 git 충돌 발생)
      for (const subtaskId of pending) {
        const subtask = this.dag.tasks.find((t) => t.id === subtaskId);
        if (!subtask) {
          this.dag.warnings.push(`subtask not found: ${subtaskId}`);
          continue;
        }

        this.emit("subtask:start", { subtaskId, title: subtask.title });

        try {
          await this.runStage("design", { subtask });
          await this.runImplementVerifyLoop(subtask);

          // ux-review/polish가 파이프라인에 있으면 subtask에도 실행
          const pipelineKey = this.dag.pipeline;
          const pipelineStages = FORGE_PIPELINES[pipelineKey]
            || (typeof pipelineKey === "string" && pipelineKey.includes(",") ? pipelineKey.split(",").map((s) => s.trim()) : []);
          if (pipelineStages.includes("polish")) {
            await this.runStage("polish", { subtask });
          }

          this.dag.updateTaskStatus(subtaskId, "done");
          this.emit("subtask:complete", { subtaskId, title: subtask.title, status: "done" });
        } catch (error) {
          this.dag.updateTaskStatus(subtaskId, "failed");
          this.dag.warnings.push(`subtask ${subtaskId} failed: ${error.message}`);
          this.emit("subtask:complete", { subtaskId, title: subtask.title, status: "failed" });
        }
      }

      await this.dag.save();
    }
  }

  async runImplementVerifyLoop(subtask) {
    const maxIterations = 3;
    let feedback = null;

    // reject 피드백이 있으면 첫 iteration에 주입
    if (this.resumeFrom === "implement") {
      try {
        const { loadArtifact } = require("../core/worktree");
        feedback = await loadArtifact(this.taskId, "rejection-feedback.md");
      } catch {}
    }

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      this.emit("gate:iteration", { stage: "implement", iteration, maxIterations });

      const implStart = Date.now();
      this.emit("stage:start", { stage: "implement", model: null });

      let implResult;
      try {
        const implement = require("./implement");
        implResult = await implement.run({
          taskId: this.taskId,
          dag: this.dag,
          project: this.worktreeCwd || this.project,
          autopilot: this.autopilot,
          subtask,
          feedback,
          timeouts: STAGE_TIMEOUTS.implement,
          onLog: (line) => this.emit("agent:output", { stage: "implement", chunk: line }),
        });
      } catch (error) {
        const implDuration = Date.now() - implStart;
        this.dag.recordStage("implement", "fail", implDuration, null);
        this.emit("stage:complete", { stage: "implement", durationMs: implDuration, status: "fail" });
        throw error;
      }

      const implDuration = Date.now() - implStart;
      const implTokenUsage = implResult?.tokenUsage || null;
      this.dag.recordStage("implement", "pass", implDuration, implTokenUsage);
      if (implTokenUsage) {
        this.dag.addTokenUsage(implTokenUsage.input, implTokenUsage.output);
      }
      this.emit("stage:complete", { stage: "implement", durationMs: implDuration, status: "pass" });

      const verifyStart = Date.now();
      this.emit("stage:start", { stage: "verify", model: null });

      const verify = require("./verify");
      const verifyResult = await verify.run({
        taskId: this.taskId,
        dag: this.dag,
        project: this.worktreeCwd || this.project,
        subtask,
        timeouts: STAGE_TIMEOUTS.verify,
        onLog: (line) => this.emit("agent:output", { stage: "verify", chunk: line }),
      });

      const verifyDuration = Date.now() - verifyStart;
      const verifyTokenUsage = verifyResult?.tokenUsage || null;
      const verifyStatus = verifyResult.passed ? "pass" : "fail";
      this.dag.recordStage("verify", verifyStatus, verifyDuration, verifyTokenUsage);
      if (verifyTokenUsage) {
        this.dag.addTokenUsage(verifyTokenUsage.input, verifyTokenUsage.output);
      }
      this.emit("stage:complete", { stage: "verify", durationMs: verifyDuration, status: verifyStatus });

      this.emit("gate:result", { gate: "verify", result: verifyStatus, iteration });

      // 각 iteration 결과를 artifact로 저장
      const subtaskSuffix = subtask ? `-${subtask.id}` : "";
      await saveArtifact(this.taskId, `verify-iter-${iteration}${subtaskSuffix}.json`, JSON.stringify({
        iteration,
        passed: verifyResult.passed,
        feedback: verifyResult.feedback,
        report: verifyResult.report,
      }, null, 2));

      if (verifyResult.passed) {
        // ux-review가 파이프라인에 있으면 verify 통과 후 실행
        const pipelineKey = this.dag.pipeline;
        const pipelineStages = FORGE_PIPELINES[pipelineKey]
          || (typeof pipelineKey === "string" && pipelineKey.includes(",") ? pipelineKey.split(",").map((s) => s.trim()) : []);
        if (pipelineStages.includes("ux-review")) {
          const uxResult = await this.runStage("ux-review", { subtask });
          if (uxResult && !uxResult.passed && !uxResult.skipped) {
            this.emit("gate:result", { gate: "ux-review", result: "fail", iteration });
            feedback = uxResult.feedback;
            continue;
          }
        }
        return;
      }

      feedback = verifyResult.feedback;
    }

    // 마지막 실패 원인 분류
    const lastReport = feedback || "";
    const hasTestFailures = lastReport.includes("테스트 실패");
    const hasCriticalIssues = lastReport.includes("critical");
    const severity = hasCriticalIssues ? "critical" : hasTestFailures ? "test_failures" : "review_issues";
    this.dag.warnings.push(
      `verify loop exhausted after ${maxIterations} iterations (${severity}). Last feedback: ${lastReport.slice(0, 200)}`
    );
  }

  async learnToHivemind() {
    try {
      const store = require("../hivemind/store");
      const indexer = require("../hivemind/indexer");

      store.ensureDirectories();
      indexer.loadFromDisk();

      const title = this.dag.title || this.taskId;
      const { loadArtifact } = require("../core/worktree");

      let summary = "";
      try { summary = await loadArtifact(this.taskId, "summary.md"); } catch {}

      if (!summary) return;

      const body = `## ${title}\n\n${summary}\n\npipeline: ${this.dag.pipeline}\nstages: ${this.dag.stageHistory.map((s) => `${s.stage}(${s.status})`).join(", ")}\ntokens: ${this.dag.tokenUsage.input + this.dag.tokenUsage.output}`;

      const zettel = {
        id: store.generateUniqueId(),
        kind: "fleeting",
        title: `forge: ${title}`,
        body,
        keywords: {},
        links: [],
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        boostCount: 0,
      };
      store.saveZettel(zettel);
      indexer.indexZettel(zettel);
    } catch (e) {
      this.dag.warnings.push(`hivemind learning failed: ${e.message}`);
    }
  }

  async abort() {
    this.aborted = true;
    this.emit("pipeline:abort", {});

    // worktree 정리
    try {
      const workspace = await loadWorkspace(this.taskId);
      if (workspace) {
        await removeWorktrees(this.taskId, workspace.projects);
      }
    } catch {}

    // lock 파일 해제
    const { releaseLock } = require("../core/worktree");
    releaseLock(this.taskId);

    // DAG 상태 업데이트
    if (this.dag) {
      this.dag.status = "aborted";
      try { await this.dag.save(); } catch {}
    }
  }
}

function wireEvents(pipeline, onEvent) {
  const events = [
    "pipeline:start", "pipeline:complete", "pipeline:error", "pipeline:abort",
    "stage:start", "stage:complete",
    "agent:output", "gate:result", "gate:iteration",
    "subtask:start", "subtask:complete",
    "warning:budget", "notice:budget",
  ];
  for (const event of events) {
    pipeline.on(event, (d) => onEvent(event, d));
  }
}

async function forge(input, options = {}) {
  const pipeline = new ForgePipeline({
    input,
    project: options.project,
    pipeline: options.pipeline,
    autopilot: options.autopilot,
    onQuestion: options.onQuestion,
    tokenBudget: options.tokenBudget,
  });

  if (options.onEvent) {
    wireEvents(pipeline, options.onEvent);
  }

  return pipeline.run();
}

async function resume(taskId, options = {}) {
  if (!options.project) {
    throw new Error("resume requires --project option");
  }

  const dag = await TaskDag.load(taskId);

  const pipeline = new ForgePipeline({
    taskId,
    project: options.project,
    pipeline: dag.pipeline,
    autopilot: options.autopilot,
    onQuestion: options.onQuestion,
    tokenBudget: options.tokenBudget,
    resumeFrom: options.fromStage || lastFailedStage(dag) || "implement",
  });

  if (options.onEvent) {
    wireEvents(pipeline, options.onEvent);
  }

  return pipeline.run();
}

function lastFailedStage(dag) {
  for (let i = dag.stageHistory.length - 1; i >= 0; i--) {
    if (dag.stageHistory[i].status === "fail") {
      return dag.stageHistory[i].stage;
    }
  }
  return null;
}

module.exports = { ForgePipeline, forge, resume, wireEvents };
