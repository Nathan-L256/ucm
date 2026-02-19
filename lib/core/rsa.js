const { spawn } = require("child_process");
const { buildCommand, sanitizeEnv } = require("./llm");

const MODEL_MAP = {
  claude: { light: "sonnet", heavy: "opus" },
  codex: { light: "medium", heavy: "high" },
};

function modelFor(provider, complexity) {
  const entry = MODEL_MAP[provider];
  return entry ? entry[complexity] : undefined;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

function classify(prompt, { provider = "claude", cwd }) {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd: spawnCwd } = buildCommand({
      provider,
      model: provider === "claude" ? "sonnet" : modelFor(provider, "light"),
      cwd,
      allowTools: provider === "claude" ? "" : undefined,
      skipPermissions: true,
      sessionPersistence: false,
    });
    const child = spawn(cmd, args, {
      cwd: spawnCwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizeEnv(),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.end(
      `다음 작업을 두 축으로 분류하세요.\n\n` +
      `복잡도:\n` +
      `  light — 단순 텍스트 생성, 요약, 번역, 포맷 변환 등\n` +
      `  heavy — 코드 분석, 아키텍처 설계, 복잡한 추론, 다단계 의사결정 등\n\n` +
      `취합 전략:\n` +
      `  converge — 분석, 문서화, 팩트 기반 작업 (공통점 선별, 이상치 제거)\n` +
      `  diverge — 설계, 전략, 창의적 작업 (정반합, 새 관점 도출)\n\n` +
      `반드시 JSON만 출력: {"complexity":"light|heavy","strategy":"converge|diverge"}\n\n` +
      `작업:\n${prompt}`
    );
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${provider} classify failed`));
      try {
        const parsed = extractJson(out);
        const { complexity, strategy } = parsed;
        if (!["light", "heavy"].includes(complexity)) throw new Error(`invalid complexity: ${complexity}`);
        if (!["converge", "diverge"].includes(strategy)) throw new Error(`invalid strategy: ${strategy}`);
        resolve({ complexity, strategy });
      } catch (e) {
        reject(new Error(`classify failed: ${e.message} (raw: ${out.trim().slice(0, 100)})`));
      }
    });
    child.on("error", reject);
  });
}

const STRATEGY = {
  converge: `당신은 여러 독립적인 작업 결과를 하나로 취합하는 편집자입니다.

## 입력

{{INPUT_DIR}} 디렉토리에 같은 작업을 독립적으로 수행한 여러 결과 파일이 있습니다. 모든 파일을 읽으세요.

## 원래 작업 지시

{{ORIGINAL_PROMPT}}

## 취합 방법

1. 모든 결과를 읽고 각 결과의 구조와 내용을 파악하세요.
2. 여러 결과에 공통으로 등장하는 내용은 신뢰도가 높으므로 반드시 포함하세요.
3. 하나의 결과에만 등장하는 내용은 근거가 충분하면 포함하고, 근거가 약하면 제외하세요.
4. 결과 간 상충하는 내용은 더 구체적인 근거를 가진 쪽을 택하세요.
5. 각 결과에서 가장 잘 작성된 표현과 구조를 선택하세요.
6. 최종 결과는 원래 작업 지시의 목적에 가장 부합해야 합니다.

## 주의사항

- 원본에 없는 내용을 추가하지 마세요.
- 취합 과정에서 세부 정보를 누락하지 마세요.
- 출처별로 구분하지 말고 하나의 일관된 문서로 작성하세요.`,

  diverge: `당신은 여러 독립적인 작업 결과를 종합하여 더 나은 결과를 만들어내는 사상가입니다.

## 입력

{{INPUT_DIR}} 디렉토리에 같은 작업을 독립적으로 수행한 여러 결과 파일이 있습니다. 모든 파일을 읽으세요.

## 원래 작업 지시

{{ORIGINAL_PROMPT}}

## 취합 방법

1. 모든 결과를 읽고 각 결과의 핵심 주장과 관점을 파악하세요.
2. 결과 간 상충하거나 대립하는 부분을 찾으세요. 이것이 가장 중요한 재료입니다.
3. 대립하는 관점들을 단순히 한쪽을 선택하지 말고, 양쪽을 아우르는 상위 관점을 도출하세요.
4. 어떤 결과에도 명시적으로 없지만 결과들의 조합에서 논리적으로 도출할 수 있는 새로운 인사이트를 추가하세요.
5. 최종 결과는 개별 결과 어느 것보다 더 깊고 포괄적이어야 합니다.

## 주의사항

- 단순히 내용을 합치거나 나열하지 마세요. 새로운 구조와 관점으로 재구성하세요.
- 원래 작업 지시의 목적을 벗어나지 마세요.
- 출처별로 구분하지 말고 하나의 일관된 문서로 작성하세요.`,

  refine: `당신은 초안을 검토하고 개선하는 편집자입니다.

## 초안

{{DRAFT_PATH}} 파일을 읽으세요. 이것은 이전 라운드에서 생성된 초안입니다.

## 원래 작업 지시

{{ORIGINAL_PROMPT}}

## 개선 방법

1. 초안을 꼼꼼히 읽고 원래 작업 지시의 목적에 비추어 평가하세요.
2. 빠진 내용, 논리적 약점, 구조적 문제를 찾아 보완하세요.
3. 불필요한 반복이나 장황한 표현을 정리하세요.
4. 더 정확한 표현이나 더 나은 구조가 있다면 적용하세요.

## 주의사항

- 초안의 좋은 부분은 유지하세요.
- 원래 작업 지시의 목적을 벗어나지 마세요.
- 개선 이유를 설명하지 말고, 개선된 최종 결과만 작성하세요.`,
};

module.exports = {
  MODEL_MAP,
  modelFor,
  extractJson,
  classify,
  STRATEGY,
};
