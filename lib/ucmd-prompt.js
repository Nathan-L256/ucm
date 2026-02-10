const { readFile } = require("fs/promises");
const path = require("path");

const { TEMPLATES_DIR } = require("./ucmd-constants.js");

async function loadTemplate(stageName) {
  const templatePath = path.join(TEMPLATES_DIR, `ucm-${stageName}.md`);
  return readFile(templatePath, "utf-8");
}

async function buildStagePrompt(stage, context) {
  let template = await loadTemplate(stage);
  const vars = {
    "{{TASK_TITLE}}": context.title || "",
    "{{TASK_DESCRIPTION}}": context.description || "",
    "{{WORKSPACE}}": context.workspace || "",
    "{{ANALYZE_RESULT}}": context.analyzeResult || "",
    "{{FEEDBACK}}": context.feedback ? `\n## Feedback from Reviewer\n\n${context.feedback}\n\nAddress ALL feedback items above.` : "",
    "{{SPEC}}": context.spec || "",
    "{{TEST_FEEDBACK}}": context.testFeedback || "",
    "{{GATHER_RESULT}}": context.gatherResult || "",
    "{{LESSONS}}": context.lessons || "",
    "{{PREFERENCES}}": context.preferences || "",
    "{{STRUCTURE_METRICS}}": context.structureMetrics || "",
    "{{DOC_COVERAGE}}": context.docCoverage || "",
  };
  for (const [placeholder, value] of Object.entries(vars)) {
    template = template.split(placeholder).join(value);
  }
  return template;
}

module.exports = {
  loadTemplate,
  buildStagePrompt,
};
