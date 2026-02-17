const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const store = require("./store");

let db = null;
let stmts = null;

function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s가-힣]/g, " ").split(/\s+/).filter(Boolean);
}

// --- DB initialization ---

function getDb() {
  if (db) return db;

  store.ensureDirectories();
  db = new Database(store.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS zettels (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      title         TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '{}',
      links_json    TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL,
      last_accessed TEXT NOT NULL,
      boost_count   INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT
    );

    CREATE TABLE IF NOT EXISTS keywords (
      keyword   TEXT NOT NULL,
      zettel_id TEXT NOT NULL,
      weight    REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (keyword, zettel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);
    CREATE INDEX IF NOT EXISTS idx_keywords_zettel ON keywords(zettel_id);

    CREATE TABLE IF NOT EXISTS keyword_tokens (
      token     TEXT NOT NULL,
      keyword   TEXT NOT NULL,
      zettel_id TEXT NOT NULL,
      weight    REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (token, keyword, zettel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_kt_token ON keyword_tokens(token);
  `);

  // FTS5 virtual table (cannot use IF NOT EXISTS directly)
  const hasFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='zettels_fts'"
  ).get();
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE zettels_fts USING fts5(
        zettel_id UNINDEXED,
        title,
        keywords_text,
        body,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
  }

  prepareStatements();
  return db;
}

function prepareStatements() {
  stmts = {
    insertZettel: db.prepare(`
      INSERT OR REPLACE INTO zettels (id, kind, title, keywords_json, links_json, created_at, last_accessed, boost_count, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteZettel: db.prepare("DELETE FROM zettels WHERE id = ?"),
    selectZettel: db.prepare("SELECT * FROM zettels WHERE id = ?"),
    selectAllZettels: db.prepare("SELECT * FROM zettels"),
    countZettels: db.prepare("SELECT COUNT(*) AS count FROM zettels"),

    insertKeyword: db.prepare("INSERT OR REPLACE INTO keywords (keyword, zettel_id, weight) VALUES (?, ?, ?)"),
    deleteKeywords: db.prepare("DELETE FROM keywords WHERE zettel_id = ?"),
    selectKeyword: db.prepare("SELECT zettel_id AS id, weight AS w FROM keywords WHERE keyword = ?"),
    selectAllKeywords: db.prepare("SELECT keyword, zettel_id AS id, weight AS w FROM keywords"),
    countKeywords: db.prepare("SELECT COUNT(DISTINCT keyword) AS count FROM keywords"),

    insertKeywordToken: db.prepare("INSERT OR REPLACE INTO keyword_tokens (token, keyword, zettel_id, weight) VALUES (?, ?, ?, ?)"),
    deleteKeywordTokens: db.prepare("DELETE FROM keyword_tokens WHERE zettel_id = ?"),
    insertFts: db.prepare("INSERT INTO zettels_fts (zettel_id, title, keywords_text, body) VALUES (?, ?, ?, ?)"),
    deleteFts: db.prepare("DELETE FROM zettels_fts WHERE zettel_id = ?"),

    bm25Search: db.prepare(`
      SELECT zettel_id AS id, bm25(zettels_fts, 0, -4.0, -3.0, -1.0) AS score
      FROM zettels_fts WHERE zettels_fts MATCH ?
      ORDER BY score LIMIT ?
    `),

    updateAccess: db.prepare("UPDATE zettels SET last_accessed = ? WHERE id = ?"),
    updateBoost: db.prepare("UPDATE zettels SET last_accessed = ?, boost_count = boost_count + 1 WHERE id = ?"),

    selectKeywordsLike: db.prepare("SELECT DISTINCT keyword FROM keywords WHERE keyword LIKE '%' || ? || '%'"),
    selectTokenExcluding: db.prepare("SELECT keyword, zettel_id AS id, weight AS w FROM keyword_tokens WHERE token = ? AND keyword != ?"),
  };
}

// --- Zettel insert (transaction) ---

function insertZettelRow(zettel) {
  getDb();
  const keywords = zettel.keywords || {};
  const keywordsJson = JSON.stringify(keywords);
  const linksJson = JSON.stringify(zettel.links || []);

  // Delete existing rows
  stmts.deleteKeywords.run(zettel.id);
  stmts.deleteKeywordTokens.run(zettel.id);
  stmts.deleteFts.run(zettel.id);
  stmts.deleteZettel.run(zettel.id);

  // Insert zettel
  stmts.insertZettel.run(
    zettel.id,
    zettel.kind,
    zettel.title,
    keywordsJson,
    linksJson,
    zettel.createdAt,
    zettel.lastAccessed,
    zettel.boostCount || 0,
    zettel.supersededBy || null,
  );

  // Insert keywords + tokens
  for (const [keyword, weight] of Object.entries(keywords)) {
    const normalized = keyword.toLowerCase();
    stmts.insertKeyword.run(normalized, zettel.id, weight);

    // Split compound keywords into tokens for partial matching
    const parts = normalized.split(/[\s\-_]+/).filter((t) => t.length >= 2);
    if (parts.length > 1) {
      for (const part of parts) {
        stmts.insertKeywordToken.run(part, normalized, zettel.id, weight);
      }
    }
  }

  // Insert FTS
  const keywordsText = Object.keys(keywords).map((k) => k.toLowerCase()).join(" ");
  stmts.insertFts.run(zettel.id, zettel.title || "", keywordsText, zettel.body || "");
}

// --- Public API ---

function buildFromDisk() {
  const d = getDb();

  // Clear all tables
  d.exec("DELETE FROM keywords");
  d.exec("DELETE FROM keyword_tokens");
  d.exec("DELETE FROM zettels_fts");
  d.exec("DELETE FROM zettels");

  store.ensureDirectories();
  const files = fs.readdirSync(store.ZETTEL_DIR).filter((f) => f.endsWith(".md")).sort();

  const insertAll = d.transaction(() => {
    for (const file of files) {
      const zettel = store.parseZettelFile(path.join(store.ZETTEL_DIR, file));
      if (!zettel) continue;
      insertZettelRow(zettel);
    }
  });
  insertAll();

  const zettelCount = stmts.countZettels.get().count;
  const keywordCount = stmts.countKeywords.get().count;
  return { zettels: zettelCount, keywords: keywordCount };
}

function loadFromDisk() {
  getDb();
  const count = stmts.countZettels.get().count;
  if (count === 0) {
    store.ensureDirectories();
    const hasFiles = fs.readdirSync(store.ZETTEL_DIR).some((f) => f.endsWith(".md"));
    if (hasFiles) {
      return buildFromDisk();
    }
  }
  const keywordCount = stmts.countKeywords.get().count;
  return { zettels: count, keywords: keywordCount };
}

function flushToDisk() {
  // no-op: SQLite writes are immediate
}

function indexZettel(zettel) {
  const d = getDb();
  const tx = d.transaction(() => insertZettelRow(zettel));
  tx();
}

function unindexZettel(id) {
  getDb();
  stmts.deleteKeywords.run(id);
  stmts.deleteKeywordTokens.run(id);
  stmts.deleteFts.run(id);
  stmts.deleteZettel.run(id);
}

function rowToEntry(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    keywords: JSON.parse(row.keywords_json),
    links: JSON.parse(row.links_json),
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    boostCount: row.boost_count,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
  };
}

function getMasterEntry(id) {
  getDb();
  const row = stmts.selectZettel.get(id);
  return row ? rowToEntry(row) : null;
}

function getAllEntries() {
  getDb();
  return stmts.selectAllZettels.all().map(rowToEntry);
}

function getKeywordIndex() {
  getDb();
  const rows = stmts.selectAllKeywords.all();
  const index = {};
  for (const row of rows) {
    if (!index[row.keyword]) index[row.keyword] = [];
    index[row.keyword].push({ id: row.id, w: row.w });
  }
  return index;
}

function lookupKeyword(keyword) {
  getDb();
  return stmts.selectKeyword.all(keyword.toLowerCase());
}

function lookupKeywords(keywords) {
  getDb();
  const scores = {};
  for (const keyword of keywords) {
    const entries = stmts.selectKeyword.all(keyword.toLowerCase());
    for (const { id, w } of entries) {
      scores[id] = (scores[id] || 0) + w;
    }
  }
  return Object.entries(scores)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function lookupKeywordsWeighted(keywords, queryWeights) {
  getDb();
  const scores = {};
  const seen = new Set();

  for (const keyword of keywords) {
    const lower = keyword.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const queryWeight = (queryWeights && queryWeights[lower]) || 1;

    // 1. Exact keyword match
    const entries = stmts.selectKeyword.all(lower);
    for (const { id, w } of entries) {
      scores[id] = (scores[id] || 0) + w * queryWeight;
    }

    // 2. Token-level partial match (keyword_tokens table)
    const queryTokens = lower.split(/[\s\-_]+/).filter((t) => t.length >= 2);
    for (const token of queryTokens) {
      const tokenRows = stmts.selectTokenExcluding.all(token, lower);
      for (const { id, w } of tokenRows) {
        scores[id] = (scores[id] || 0) + w * queryWeight * 0.5;
      }
    }

    // 3. Korean compound noun matching
    const hasKorean = /[가-힣]/.test(lower);
    if (hasKorean && lower.length >= 2) {
      const likeRows = stmts.selectKeywordsLike.all(lower);
      for (const row of likeRows) {
        if (row.keyword === lower) continue;
        // Get all zettel_ids for this matched keyword
        const kwEntries = stmts.selectKeyword.all(row.keyword);
        for (const { id, w } of kwEntries) {
          scores[id] = (scores[id] || 0) + w * queryWeight * 0.3;
        }
      }
    }
  }

  return Object.entries(scores)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function findByKeywordOverlap(keywords, minOverlap = 3) {
  getDb();
  const keywordSet = new Set(Object.keys(keywords).map((k) => k.toLowerCase()));
  const allEntries = stmts.selectAllZettels.all();
  const candidates = [];

  for (const row of allEntries) {
    const entryKeywords = new Set(Object.keys(JSON.parse(row.keywords_json)).map((k) => k.toLowerCase()));
    const overlap = [...keywordSet].filter((k) => entryKeywords.has(k));
    if (overlap.length >= minOverlap) {
      candidates.push({ id: row.id, overlap: overlap.length, sharedKeywords: overlap });
    }
  }

  return candidates.sort((a, b) => b.overlap - a.overlap);
}

function updateAccess(id) {
  getDb();
  stmts.updateAccess.run(new Date().toISOString(), id);
}

function updateBoost(id) {
  getDb();
  stmts.updateBoost.run(new Date().toISOString(), id);
}

function updateEntry(id, changes) {
  const d = getDb();
  const setClauses = [];
  const values = [];

  if (changes.lastAccessed !== undefined) {
    setClauses.push("last_accessed = ?");
    values.push(changes.lastAccessed);
  }
  if (changes.boostCount !== undefined) {
    setClauses.push("boost_count = ?");
    values.push(changes.boostCount);
  }
  if (changes.supersededBy !== undefined) {
    setClauses.push("superseded_by = ?");
    values.push(changes.supersededBy);
  }

  if (setClauses.length === 0) return;
  values.push(id);
  d.prepare(`UPDATE zettels SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

function bm25Search(terms, limit = 50) {
  getDb();
  if (!terms || terms.length === 0) return [];

  // Escape FTS5 special characters in terms
  const escaped = terms.map((t) => {
    // Remove characters that are FTS5 operators
    const cleaned = t.replace(/['"*(){}:^~\-]/g, "").trim();
    return cleaned;
  }).filter(Boolean);

  if (escaped.length === 0) return [];

  const matchQuery = escaped.join(" OR ");
  try {
    const rows = stmts.bm25Search.all(matchQuery, limit);
    // bm25() returns negative scores (lower = more relevant), convert to positive descending
    return rows.map((r) => ({ id: r.id, score: -r.score }));
  } catch {
    return [];
  }
}

function getKeywordCount() {
  getDb();
  return stmts.countKeywords.get().count;
}

function close() {
  if (db) {
    db.close();
    db = null;
    stmts = null;
  }
}

module.exports = {
  buildFromDisk, loadFromDisk, flushToDisk,
  indexZettel, unindexZettel,
  lookupKeyword, lookupKeywords, lookupKeywordsWeighted,
  getMasterEntry, getAllEntries, getKeywordIndex,
  findByKeywordOverlap,
  updateAccess, updateBoost, updateEntry,
  bm25Search, tokenize, getKeywordCount, close,
};
