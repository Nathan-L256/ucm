const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE;

function expandPath(p) {
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

module.exports = {
  name: "document",

  async scan(state, config) {
    const processed = state.processed || {};
    const items = [];
    const dirs = (config && config.dirs) || [];

    for (const dir of dirs) {
      const dirPath = expandPath(dir);
      if (!fs.existsSync(dirPath)) continue;

      const walkDir = (currentPath) => {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const fullPath = path.join(currentPath, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (entry.name.endsWith(".md")) {
            const stat = fs.statSync(fullPath);
            if (stat.size === 0) continue;
            const ref = path.relative(dirPath, fullPath);
            if (processed[ref] && processed[ref] >= stat.mtimeMs) continue;
            items.push({ ref, path: fullPath, mtime: stat.mtimeMs });
          }
        }
      };
      walkDir(dirPath);
    }

    return items.sort((a, b) => b.mtime - a.mtime);
  },

  async read(item) {
    const content = fs.readFileSync(item.path, "utf8");
    if (!content.trim()) return [];

    // Split by ## headers
    const sections = [];
    const lines = content.split("\n");
    let currentTitle = path.basename(item.path, ".md");
    let currentLines = [];

    for (const line of lines) {
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        if (currentLines.length > 0) {
          const text = currentLines.join("\n").trim();
          if (text.length > 100) {
            sections.push({ title: currentTitle, text });
          }
        }
        currentTitle = headerMatch[1];
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    // Last section
    if (currentLines.length > 0) {
      const text = currentLines.join("\n").trim();
      if (text.length > 100) {
        sections.push({ title: currentTitle, text });
      }
    }

    // If no sections found (no ## headers), treat whole file as one chunk
    if (sections.length === 0 && content.trim().length > 100) {
      sections.push({
        title: path.basename(item.path, ".md"),
        text: content.trim(),
      });
    }

    return sections.map((section) => ({
      text: `# ${section.title}\n\n${section.text}`,
      metadata: {
        adapter: "document",
        ref: item.ref,
        section: section.title,
        timestamp: new Date(item.mtime).toISOString(),
      },
    }));
  },
};
