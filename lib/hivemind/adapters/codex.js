const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE;
const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");

const MIN_MESSAGES = 4;
const MIN_CHARS = 1500;
const MAX_CHUNK_SIZE = 30_000;

module.exports = {
  name: "codex",

  async scan(state) {
    const processed = state.processed || {};
    const items = [];

    if (!fs.existsSync(CODEX_SESSIONS)) return items;

    // Walk year/month/day directories
    const years = fs.readdirSync(CODEX_SESSIONS).filter((d) => /^\d{4}$/.test(d));
    for (const year of years) {
      const yearPath = path.join(CODEX_SESSIONS, year);
      const months = fs.readdirSync(yearPath).filter((d) => /^\d{2}$/.test(d));
      for (const month of months) {
        const monthPath = path.join(yearPath, month);
        const days = fs.readdirSync(monthPath).filter((d) => /^\d{2}$/.test(d));
        for (const day of days) {
          const dayPath = path.join(monthPath, day);
          if (!fs.statSync(dayPath).isDirectory()) continue;
          const files = fs.readdirSync(dayPath).filter((f) => f.endsWith(".jsonl"));
          for (const file of files) {
            const filePath = path.join(dayPath, file);
            const stat = fs.statSync(filePath);
            const ref = `${year}/${month}/${day}/${file}`;

            if (processed[ref] && processed[ref] >= stat.mtimeMs) continue;

            items.push({ ref, path: filePath, mtime: stat.mtimeMs });
          }
        }
      }
    }

    return items.sort((a, b) => b.mtime - a.mtime);
  },

  async read(item) {
    const content = fs.readFileSync(item.path, "utf8");
    const lines = content.split("\n").filter(Boolean);

    const messages = [];
    let sessionId = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "session_meta") {
          sessionId = entry.payload?.id;
          continue;
        }

        if (entry.type === "user_message") {
          const text = entry.payload?.content;
          if (text) messages.push({ role: "user", text });
        }

        if (entry.type === "response_item") {
          const payload = entry.payload;
          if (payload?.type === "message" && payload.content) {
            const textParts = payload.content
              .filter((c) => c.type === "output_text")
              .map((c) => c.text);
            if (textParts.length > 0) {
              messages.push({ role: "assistant", text: textParts.join("\n") });
            }
          }
        }

        if (entry.type === "agent_reasoning") {
          const text = entry.payload?.content;
          if (text) messages.push({ role: "reasoning", text });
        }
      } catch {}
    }

    if (messages.length < MIN_MESSAGES) return [];
    const totalChars = messages.reduce((s, m) => s + m.text.length, 0);
    if (totalChars < MIN_CHARS) return [];

    const conversationText = messages
      .map((m) => `[${m.role}]\n${m.text}`)
      .join("\n\n");

    const chunks = [];
    if (conversationText.length <= MAX_CHUNK_SIZE) {
      chunks.push({
        text: conversationText,
        metadata: {
          adapter: "codex",
          ref: item.ref,
          sessionId,
          timestamp: new Date(item.mtime).toISOString(),
        },
      });
    } else {
      let offset = 0;
      let chunkIndex = 0;
      while (offset < conversationText.length && chunkIndex < 10) {
        chunks.push({
          text: conversationText.slice(offset, offset + MAX_CHUNK_SIZE),
          metadata: {
            adapter: "codex",
            ref: `${item.ref}#chunk${chunkIndex}`,
            sessionId,
            timestamp: new Date(item.mtime).toISOString(),
          },
        });
        offset += MAX_CHUNK_SIZE;
        chunkIndex++;
      }
    }

    return chunks;
  },
};
