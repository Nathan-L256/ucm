const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");

const NOISE_TYPES = new Set(["progress", "queue-operation", "file-history-snapshot"]);
const MIN_MESSAGES = 4;
const MIN_CHARS = 1500;
const MAX_CHUNK_SIZE = 60_000;
const STACK_TRACE_RE = /^\s+at\s/;
const TRIVIAL_USER_RE = /^(ㅇㅇ|ㅇ|응|네|넵|그래|좋아|ok|yes|y|확인|커밋|푸시|해줘)\s*[.!?]?$/i;

// --- Scan ---

module.exports = {
  name: "claude",

  async scan(state) {
    const processed = state.processed || {};
    const items = [];

    if (!fs.existsSync(CLAUDE_PROJECTS)) return items;

    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(CLAUDE_PROJECTS, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;

      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const stat = fs.statSync(filePath);
        const ref = `${projectDir}/${file}`;

        if (processed[ref] && processed[ref] >= stat.mtimeMs) continue;

        items.push({
          ref,
          path: filePath,
          mtime: stat.mtimeMs,
          project: projectDir,
        });
      }
    }

    return items.sort((a, b) => b.mtime - a.mtime);
  },

  // --- Read & preprocess ---

  async read(item) {
    const content = fs.readFileSync(item.path, "utf8");
    const lines = content.split("\n").filter(Boolean);

    const messages = parseMessages(lines);

    if (messages.length < MIN_MESSAGES) return [];
    const totalChars = messages.reduce((s, m) => s + m.text.length, 0);
    if (totalChars < MIN_CHARS) return [];

    // Compress and annotate
    const compressed = compressMessages(messages);

    // Smart chunking at turn boundaries
    return chunkAtTurnBoundaries(compressed, item);
  },
};

// --- Message parsing ---

function parseMessages(lines) {
  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (NOISE_TYPES.has(entry.type)) continue;

      if (entry.type === "user" && entry.message?.content) {
        const text = typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content.map((b) => b.text || "").join("\n");
        if (text.trim()) messages.push({ role: "user", text: text.trim() });
      }

      if (entry.type === "assistant" && entry.message?.content) {
        const blocks = entry.message.content;
        const textParts = [];
        const toolSummaries = [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) textParts.push(block.text);
          if (block.type === "tool_use") {
            const name = block.name;
            const input = block.input || {};
            toolSummaries.push(summarizeTool(name, input));
          }
        }
        const text = textParts.join("\n").trim();
        const tools = toolSummaries.filter(Boolean);
        if (text || tools.length > 0) {
          messages.push({ role: "assistant", text, tools });
        }
      }
    } catch {}
  }
  return messages;
}

function summarizeTool(name, input) {
  if (name === "Read") return `[Read: ${basename(input.file_path)}]`;
  if (name === "Write") return `[Write: ${basename(input.file_path)}]`;
  if (name === "Edit") return `[Edit: ${basename(input.file_path)}]`;
  if (name === "Bash") {
    const cmd = (input.command || "").slice(0, 80);
    return `[Bash: ${cmd}]`;
  }
  if (name === "Grep" || name === "Glob") return null; // search noise
  return null;
}

function basename(filepath) {
  return filepath ? path.basename(filepath) : "";
}

// --- Compression ---

function compressMessages(messages) {
  const result = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Drop trivial confirmations that carry no information
      if (TRIVIAL_USER_RE.test(msg.text.trim())) continue;
      result.push(msg);
    } else {
      // Assistant: compress
      let text = msg.text;

      // Compress stack traces: keep first line + count
      text = compressStackTraces(text);

      // Compress long code blocks: keep first/last few lines
      text = compressCodeBlocks(text);

      // Drop empty assistant messages
      if (!text.trim() && (!msg.tools || msg.tools.length === 0)) continue;

      // Collapse consecutive tool-only turns into summary
      const lastResult = result[result.length - 1];
      if (!text.trim() && msg.tools?.length > 0 && lastResult?.role === "assistant" && !lastResult.text?.trim()) {
        lastResult.tools = [...(lastResult.tools || []), ...msg.tools];
        continue;
      }

      result.push({ ...msg, text });
    }
  }

  return result;
}

function compressStackTraces(text) {
  const lines = text.split("\n");
  const output = [];
  let stackCount = 0;

  for (const line of lines) {
    if (STACK_TRACE_RE.test(line)) {
      if (stackCount === 0) output.push(line); // keep first
      stackCount++;
    } else {
      if (stackCount > 1) {
        output.push(`  ... (${stackCount - 1} more stack frames)`);
      }
      stackCount = 0;
      output.push(line);
    }
  }
  if (stackCount > 1) {
    output.push(`  ... (${stackCount - 1} more stack frames)`);
  }
  return output.join("\n");
}

function compressCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split("\n");
    if (lines.length <= 10) return block;
    const header = lines.slice(0, 3).join("\n");
    const footer = lines.slice(-2).join("\n");
    return `${header}\n  ... (${lines.length - 5} lines omitted)\n${footer}`;
  });
}

// --- Smart chunking ---

function chunkAtTurnBoundaries(messages, item) {
  const chunks = [];
  let currentMessages = [];
  let currentSize = 0;

  for (const msg of messages) {
    const formatted = formatMessage(msg);
    const msgSize = formatted.length;

    // Start new chunk at user turn boundary when approaching limit
    if (currentSize + msgSize > MAX_CHUNK_SIZE && msg.role === "user" && currentMessages.length > 0) {
      chunks.push(buildChunk(currentMessages, item, chunks.length));
      currentMessages = [];
      currentSize = 0;
    }

    currentMessages.push(msg);
    currentSize += msgSize;
  }

  if (currentMessages.length > 0) {
    chunks.push(buildChunk(currentMessages, item, chunks.length));
  }

  return chunks;
}

function formatMessage(msg) {
  let text = `[${msg.role}]\n`;
  if (msg.tools?.length > 0) text += msg.tools.join("\n") + "\n";
  if (msg.text) text += msg.text;
  return text + "\n\n";
}

function buildChunk(messages, item, index) {
  const text = messages.map(formatMessage).join("");
  return {
    text,
    metadata: {
      adapter: "claude",
      ref: index === 0 ? item.ref : `${item.ref}#chunk${index}`,
      project: item.project,
      timestamp: new Date(item.mtime).toISOString(),
    },
  };
}
