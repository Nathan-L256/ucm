const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE;
const HIVEMIND_DIR = process.env.HIVEMIND_DIR || path.join(HOME, ".hivemind");
const ZETTEL_DIR = path.join(HIVEMIND_DIR, "zettel");
const INDEX_DIR = path.join(HIVEMIND_DIR, "index");
const ARCHIVE_DIR = path.join(HIVEMIND_DIR, "archive");
const SOURCES_DIR = path.join(HIVEMIND_DIR, "sources");
const DAEMON_DIR = path.join(HIVEMIND_DIR, "daemon");
const ADAPTERS_DIR = path.join(HIVEMIND_DIR, "adapters");
const CONFIG_PATH = path.join(HIVEMIND_DIR, "config.json");
const MASTER_PATH = path.join(INDEX_DIR, "master.jsonl");
const KEYWORDS_PATH = path.join(INDEX_DIR, "keywords.json");
const BM25_PATH = path.join(INDEX_DIR, "bm25.json");
const DB_PATH = path.join(INDEX_DIR, "hivemind.db");
const SOCK_PATH = path.join(DAEMON_DIR, "hm.sock");
const PID_PATH = path.join(DAEMON_DIR, "hmd.pid");
const LOG_PATH = path.join(DAEMON_DIR, "hmd.log");

const DEFAULT_CONFIG = {
  adapters: {
    claude: { enabled: true },
    codex: { enabled: true },
    document: { enabled: true, dirs: [] },
  },
  models: {
    retrieval: "claude-haiku-4-5-20251001",
    extraction: "claude-sonnet-4-6",
    dedup: "claude-haiku-4-5-20251001",
    consolidation: "claude-sonnet-4-6",
  },
  decayDays: 30,
  decayWeight: 0.2,
  gcThreshold: 0.05,
  minKeep: 50,
};

function ensureDirectories() {
  for (const dir of [HIVEMIND_DIR, ZETTEL_DIR, INDEX_DIR, ARCHIVE_DIR, SOURCES_DIR, DAEMON_DIR, ADAPTERS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function validateConfig(config) {
  const warnings = [];
  const validModelPattern = /^claude-/;
  const knownAdapters = new Set(["claude", "codex", "document"]);
  const numericFields = { decayDays: [1, 365], decayWeight: [0, 1], gcThreshold: [0, 1], minKeep: [1, 10000] };

  if (config.models && typeof config.models === "object") {
    for (const [slot, model] of Object.entries(config.models)) {
      if (typeof model !== "string" || !validModelPattern.test(model)) {
        warnings.push(`models.${slot}: invalid model "${model}"`);
      }
    }
  }

  if (config.adapters && typeof config.adapters === "object") {
    for (const name of Object.keys(config.adapters)) {
      if (!knownAdapters.has(name)) {
        warnings.push(`adapters.${name}: unknown adapter`);
      }
    }
  }

  for (const [field, [min, max]] of Object.entries(numericFields)) {
    if (config[field] !== undefined) {
      if (typeof config[field] !== "number" || config[field] < min || config[field] > max) {
        warnings.push(`${field}: expected number ${min}-${max}, got "${config[field]}"`);
      }
    }
  }

  return warnings;
}

function loadConfig() {
  ensureDirectories();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  // Deep merge models
  if (JSON.parse(raw).models) {
    config.models = { ...DEFAULT_CONFIG.models, ...JSON.parse(raw).models };
  }
  return config;
}

function saveConfig(config) {
  ensureDirectories();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

let lastIdTimestamp = "";
let idSequence = 0;

function generateUniqueId() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const base = (
    pad(now.getFullYear(), 4) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );

  if (base === lastIdTimestamp) {
    idSequence++;
  } else {
    lastIdTimestamp = base;
    idSequence = 0;
  }

  const id = idSequence === 0 ? base : `${base}${pad(idSequence)}`;

  // Final safety check
  const zettelPath = path.join(ZETTEL_DIR, `${id}.md`);
  if (fs.existsSync(zettelPath)) {
    return `${base}${pad(Math.floor(Math.random() * 900) + 100, 3)}`;
  }
  return id;
}

// --- YAML frontmatter parsing (minimal, no deps) ---

function parseYamlValue(value) {
  value = value.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "") return null;
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseYaml(text) {
  const result = {};
  const lines = text.split("\n");
  let currentKey = null;
  let currentMap = null;
  let currentList = null;

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const listItemInMap = line.match(/^    (\w[\w-]*): (.+)$/);
    if (listItemInMap && currentList) {
      const lastItem = currentList[currentList.length - 1];
      if (typeof lastItem === "object" && lastItem !== null) {
        lastItem[listItemInMap[1]] = parseYamlValue(listItemInMap[2]);
      }
      continue;
    }

    const listItem = line.match(/^  - (.+)$/);
    if (listItem && currentList) {
      const val = listItem[1].trim();
      if (val.includes(": ")) {
        const obj = {};
        const parts = val.split(": ");
        obj[parts[0].trim()] = parseYamlValue(parts.slice(1).join(": "));
        currentList.push(obj);
      } else {
        currentList.push(parseYamlValue(val));
      }
      continue;
    }

    // Map entry: support quoted keys ("key with spaces") and unquoted keys (ASCII, Korean, hyphens)
    const mapEntry = line.match(/^  (?:"([^"]+)"|([\w가-힣][\w가-힣 .-]*?)): (.+)$/);
    if (mapEntry && currentMap !== null) {
      const key = mapEntry[1] || mapEntry[2];
      currentMap[key] = parseYamlValue(mapEntry[3]);
      continue;
    }

    const topLevel = line.match(/^([\w-]+):(.*)$/);
    if (topLevel) {
      currentKey = topLevel[1];
      const val = topLevel[2].trim();
      currentMap = null;
      currentList = null;

      if (val === "") {
        // Could be map or list — determined by next line
        const lineIdx = lines.indexOf(line);
        const nextLineIdx = lineIdx + 1;
        if (nextLineIdx < lines.length) {
          const nextLine = lines[nextLineIdx];
          if (nextLine.match(/^  - /)) {
            currentList = [];
            result[currentKey] = currentList;
          } else if (nextLine.match(/^  [\w가-힣"]/)) {
            currentMap = {};
            result[currentKey] = currentMap;
          } else {
            // Next line is a top-level key or blank — empty value
            result[currentKey] = null;
          }
        } else {
          result[currentKey] = null;
        }
      } else {
        result[currentKey] = parseYamlValue(val);
      }
    }
  }
  return result;
}

function serializeYaml(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${key}: {}`);
        continue;
      }
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "object" && !Array.isArray(v) && v !== null) {
          lines.push(`  ${k}:`);
          for (const [k2, v2] of Object.entries(v)) {
            lines.push(`    ${k2}: ${JSON.stringify(v2)}`);
          }
        } else {
          const needsKeyQuote = /[^\w-]/.test(k);
          const displayKey = needsKeyQuote ? `"${k}"` : k;
          lines.push(`  ${displayKey}: ${typeof v === "string" && v.includes(":") ? JSON.stringify(v) : v}`);
        }
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          const entries = Object.entries(item);
          lines.push(`  - ${entries[0][0]}: ${JSON.stringify(entries[0][1])}`);
          for (let i = 1; i < entries.length; i++) {
            lines.push(`    ${entries[i][0]}: ${JSON.stringify(entries[i][1])}`);
          }
        } else {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
    } else {
      const needsQuote = typeof value === "string" && (value.includes(":") || value.includes("#") || /^\d+$/.test(value));
      const val = needsQuote ? JSON.stringify(value) : value;
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join("\n");
}

// --- Zettel file I/O ---

function parseZettelFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const meta = parseYaml(match[1]);
  const body = match[2].trim();

  // Normalize: id and links must be strings
  if (meta.id != null) meta.id = String(meta.id);
  if (Array.isArray(meta.links)) meta.links = meta.links.map(String);

  return { ...meta, body };
}

function serializeZettel(zettel) {
  const { body, ...meta } = zettel;
  if (meta.id != null) meta.id = String(meta.id);
  if (Array.isArray(meta.links)) meta.links = meta.links.map((l) => String(l));
  return `---\n${serializeYaml(meta)}\n---\n\n${body}\n`;
}

function saveZettel(zettel) {
  ensureDirectories();
  const filePath = path.join(ZETTEL_DIR, `${zettel.id}.md`);
  fs.writeFileSync(filePath, serializeZettel(zettel));
  return filePath;
}

function loadZettel(id) {
  const filePath = path.join(ZETTEL_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) return null;
  return parseZettelFile(filePath);
}

function deleteZettel(id) {
  const filePath = path.join(ZETTEL_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

function archiveZettel(id) {
  const src = path.join(ZETTEL_DIR, `${id}.md`);
  const dst = path.join(ARCHIVE_DIR, `${id}.md`);
  if (!fs.existsSync(src)) return false;
  fs.renameSync(src, dst);
  return true;
}

function restoreZettel(id) {
  const src = path.join(ARCHIVE_DIR, `${id}.md`);
  const dst = path.join(ZETTEL_DIR, `${id}.md`);
  if (!fs.existsSync(src)) return false;
  fs.renameSync(src, dst);
  return true;
}

function listZettels({ kind, limit } = {}) {
  ensureDirectories();
  const files = fs.readdirSync(ZETTEL_DIR).filter((f) => f.endsWith(".md")).sort().reverse();
  const results = [];
  for (const file of files) {
    const zettel = parseZettelFile(path.join(ZETTEL_DIR, file));
    if (!zettel) continue;
    if (kind && zettel.kind !== kind) continue;
    results.push(zettel);
    if (limit && results.length >= limit) break;
  }
  return results;
}

function listArchivedZettels() {
  ensureDirectories();
  const files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".md")).sort().reverse();
  return files.map((f) => {
    const zettel = parseZettelFile(path.join(ARCHIVE_DIR, f));
    return zettel;
  }).filter(Boolean);
}

function updateZettelAccess(id) {
  const zettel = loadZettel(id);
  if (!zettel) return null;
  zettel.lastAccessed = new Date().toISOString();
  saveZettel(zettel);
  return zettel;
}

function boostZettel(id) {
  const zettel = loadZettel(id);
  if (!zettel) return null;
  zettel.lastAccessed = new Date().toISOString();
  zettel.boostCount = (zettel.boostCount || 0) + 1;
  saveZettel(zettel);
  return zettel;
}

function addLink(id1, id2) {
  const z1 = loadZettel(id1);
  const z2 = loadZettel(id2);
  if (!z1 || !z2) return false;
  if (!z1.links) z1.links = [];
  if (!z2.links) z2.links = [];
  z1.links = z1.links.map(String);
  z2.links = z2.links.map(String);
  if (!z1.links.includes(String(id2))) z1.links.push(String(id2));
  if (!z2.links.includes(String(id1))) z2.links.push(String(id1));
  saveZettel(z1);
  saveZettel(z2);
  return true;
}

// --- Source state ---

function loadSourceState(adapterName) {
  const filePath = path.join(SOURCES_DIR, `${adapterName}.json`);
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveSourceState(adapterName, state) {
  ensureDirectories();
  const filePath = path.join(SOURCES_DIR, `${adapterName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n");
}

module.exports = {
  HIVEMIND_DIR, ZETTEL_DIR, INDEX_DIR, ARCHIVE_DIR, SOURCES_DIR, DAEMON_DIR, ADAPTERS_DIR,
  CONFIG_PATH, MASTER_PATH, KEYWORDS_PATH, BM25_PATH, DB_PATH, SOCK_PATH, PID_PATH, LOG_PATH,
  DEFAULT_CONFIG,
  ensureDirectories, loadConfig, saveConfig, generateUniqueId,
  parseZettelFile, serializeZettel, saveZettel, loadZettel, deleteZettel,
  archiveZettel, restoreZettel, listZettels, listArchivedZettels,
  updateZettelAccess, boostZettel, addLink,
  loadSourceState, saveSourceState,
  validateConfig,
};
