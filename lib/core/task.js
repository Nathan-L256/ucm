const crypto = require("crypto");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const { FORGE_DIR } = require("./constants");

function generateForgeId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = crypto.randomBytes(2).toString("hex");
  return `forge-${date}-${rand}`;
}

class TaskDag {
  constructor({ id, status = "pending", pipeline, spec, title, tasks = [], createdAt, startedAt, completedAt, updatedAt, tokenUsage } = {}) {
    this.id = id || generateForgeId();
    this.status = status;
    this.pipeline = pipeline;
    this.title = title || null;
    this.spec = spec || null;
    this.tasks = tasks;
    this.createdAt = createdAt || new Date().toISOString();
    this.startedAt = startedAt || null;
    this.completedAt = completedAt || null;
    this.updatedAt = updatedAt || this.createdAt;
    this.currentStage = null;
    this.stageHistory = [];
    this.warnings = [];
    this.tokenUsage = tokenUsage || { input: 0, output: 0 };
  }

  addTask({ id, title, description, blockedBy = [], estimatedFiles = [] }) {
    if (this.tasks.some((t) => t.id === id)) {
      throw new Error(`duplicate task id: ${id}`);
    }
    const existingIds = new Set(this.tasks.map((t) => t.id));
    const invalidDeps = blockedBy.filter((depId) => depId !== id && !existingIds.has(depId));
    if (invalidDeps.length > 0) {
      this.warnings.push(`task ${id}: unresolved blockedBy refs: ${invalidDeps.join(", ")}`);
    }
    this.tasks.push({
      id,
      title,
      description: description || "",
      status: "pending",
      blockedBy,
      estimatedFiles,
      startedAt: null,
      completedAt: null,
      worktreeCwd: null,
    });
  }

  updateTaskStatus(taskId, status) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    task.status = status;
    if (status === "in_progress" && !task.startedAt) {
      task.startedAt = new Date().toISOString();
    }
    if (status === "done" || status === "failed") {
      task.completedAt = new Date().toISOString();
    }
  }

  addTokenUsage(input, output) {
    this.tokenUsage.input += input || 0;
    this.tokenUsage.output += output || 0;
  }

  totalTokens() {
    return this.tokenUsage.input + this.tokenUsage.output;
  }

  isOverBudget(budget) {
    if (!budget || budget <= 0) return false;
    return this.totalTokens() > budget;
  }

  getReadyTasks() {
    return this.tasks.filter((task) => {
      if (task.status !== "pending") return false;
      return task.blockedBy.every((depId) => {
        const dep = this.tasks.find((t) => t.id === depId);
        return dep && dep.status === "done";
      });
    });
  }

  getWaves() {
    const waves = [];
    const completed = new Set();
    const remaining = new Set(this.tasks.map((t) => t.id));

    while (remaining.size > 0) {
      const wave = [];
      for (const taskId of remaining) {
        const task = this.tasks.find((t) => t.id === taskId);
        const ready = task.blockedBy.every((depId) => completed.has(depId));
        if (ready) wave.push(taskId);
      }
      if (wave.length === 0) {
        const cycleIds = [...remaining].join(", ");
        throw new Error(`cycle detected in task DAG: ${cycleIds}`);
      }
      waves.push(wave);
      for (const taskId of wave) {
        remaining.delete(taskId);
        completed.add(taskId);
      }
    }

    return waves;
  }

  validateDeps() {
    const ids = new Set(this.tasks.map((t) => t.id));
    const dangling = [];
    for (const task of this.tasks) {
      for (const depId of task.blockedBy) {
        if (!ids.has(depId)) dangling.push({ task: task.id, dep: depId });
      }
    }
    if (dangling.length > 0) {
      const details = dangling.map((d) => `${d.task} → ${d.dep}`).join(", ");
      throw new Error(`dangling blockedBy references: ${details}`);
    }
  }

  allDone() {
    return this.tasks.every((t) => t.status === "done");
  }

  anyFailed() {
    return this.tasks.some((t) => t.status === "failed");
  }

  recordStage(stage, status, durationMs, stageTokenUsage) {
    this.stageHistory.push({
      stage,
      status,
      durationMs,
      timestamp: new Date().toISOString(),
      tokenUsage: stageTokenUsage || null,
    });
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      pipeline: this.pipeline,
      title: this.title,
      spec: this.spec,
      tasks: this.tasks,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      updatedAt: this.updatedAt,
      currentStage: this.currentStage,
      stageHistory: this.stageHistory,
      warnings: this.warnings,
      tokenUsage: this.tokenUsage,
    };
  }

  async save() {
    const prev = this._saving || Promise.resolve();
    const current = prev.catch(() => {}).then(() => this._doSave());
    this._saving = current;
    await current;
  }

  async _doSave() {
    this.updatedAt = new Date().toISOString();
    const dir = path.join(FORGE_DIR, this.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "task.json"),
      JSON.stringify(this.toJSON(), null, 2) + "\n",
    );
  }

  static async load(id) {
    const filePath = path.join(FORGE_DIR, id, "task.json");
    let data;
    try {
      data = JSON.parse(await readFile(filePath, "utf-8"));
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`task not found: ${id}`);
      throw new Error(`task load failed: ${id} (${e.message})`);
    }
    const dag = new TaskDag(data);
    dag.currentStage = data.currentStage || null;
    dag.stageHistory = data.stageHistory || [];
    dag.warnings = data.warnings || [];
    return dag;
  }

  static async list() {
    const { readdir } = require("fs/promises");
    try {
      const entries = await readdir(FORGE_DIR);
      const tasks = [];
      for (const entry of entries) {
        if (!entry.startsWith("forge-")) continue;
        try {
          const dag = await TaskDag.load(entry);
          tasks.push(dag);
        } catch {}
      }
      return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }
}

module.exports = { TaskDag, generateForgeId };
