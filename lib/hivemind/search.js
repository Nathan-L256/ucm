const store = require("./store");
const indexer = require("./indexer");
const { callLlmJson } = require("./llm");

const QUERY_EXPAND_PROMPT = `검색 쿼리: "{QUERY}"

이 쿼리로 지식을 찾으려는 사람이 실제로 원하는 것을 분석하고,
검색어를 확장하라:
- keywords: 쿼리의 핵심 검색 용어들
- synonyms: 동의어, 약어, 한/영 등가
- related: 관련 개념, 이 주제를 찾을 때 함께 검색할 만한 용어

JSON: {"keywords": [...], "synonyms": [...], "related": [...]}
`;

const { tokenize } = indexer;

// --- Decay ---

function decayScore(lastAccessed, boostCount, decayDays) {
  const now = Date.now();
  const accessed = new Date(lastAccessed).getTime();
  const daysSince = (now - accessed) / (86400_000);
  const effectiveHalfLife = decayDays * (1 + Math.log(1 + (boostCount || 0)));
  return Math.exp(-daysSince / effectiveHalfLife);
}

// --- RRF Fusion ---

function rrfScore(rank) {
  return 1 / (30 + rank);
}

function fuseRankings(rankings) {
  const scores = {};
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i].id;
      scores[id] = (scores[id] || 0) + rrfScore(i + 1);
    }
  }
  return scores;
}

// --- Main search ---

async function expandQuery(query, { model } = {}) {
  const prompt = QUERY_EXPAND_PROMPT.replace("{QUERY}", query);
  try {
    return await callLlmJson(prompt, { model });
  } catch {
    const terms = tokenize(query);
    return { keywords: terms, synonyms: [], related: [] };
  }
}

async function search(query, { limit = 10, noExpand = false, dryRun = false } = {}) {
  const config = store.loadConfig();
  const allEntries = indexer.getAllEntries();
  if (allEntries.length === 0) return [];

  // Step 1: Query expansion
  let expanded;
  if (noExpand) {
    expanded = { keywords: tokenize(query), synonyms: [], related: [] };
  } else {
    expanded = await expandQuery(query, { model: config.models?.retrieval });
  }

  const allQueryTerms = [
    ...(expanded.keywords || []),
    ...(expanded.synonyms || []),
    ...(expanded.related || []),
  ].map((t) => t.toLowerCase());

  const coreTerms = [
    ...(expanded.keywords || []),
    ...(expanded.synonyms || []),
  ].map((t) => t.toLowerCase());

  // Step 2: Reverse index lookup with query term weighting
  const queryTermWeights = {};
  for (const t of (expanded.keywords || [])) queryTermWeights[t.toLowerCase()] = 3;
  for (const t of (expanded.synonyms || [])) {
    const key = t.toLowerCase();
    if (!queryTermWeights[key]) queryTermWeights[key] = 2;
  }
  for (const t of (expanded.related || [])) {
    const key = t.toLowerCase();
    if (!queryTermWeights[key]) queryTermWeights[key] = 1;
  }
  const reverseResults = indexer.lookupKeywordsWeighted(allQueryTerms, queryTermWeights);

  // Step 3: BM25 via FTS5
  const bm25Results = indexer.bm25Search(coreTerms, 50);

  // Step 4: RRF fusion
  const rrfScores = fuseRankings([reverseResults, bm25Results]);

  // Step 5: Apply decay (softened by decayWeight exponent)
  const { decayWeight = 1 } = config;
  const finalResults = [];
  for (const [id, rrf] of Object.entries(rrfScores)) {
    const entry = indexer.getMasterEntry(id);
    if (!entry) continue;
    const rawDecay = decayScore(entry.lastAccessed, entry.boostCount, config.decayDays);
    const decay = Math.pow(rawDecay, decayWeight);
    const superseded = entry.supersededBy ? 0.5 : 1;
    finalResults.push({
      id,
      score: rrf * decay * superseded,
      rrf,
      decay,
      title: entry.title,
      kind: entry.kind,
      keywords: entry.keywords,
      createdAt: entry.createdAt,
      supersededBy: entry.supersededBy,
    });
  }

  finalResults.sort((a, b) => b.score - a.score);

  const topResults = finalResults.slice(0, limit);

  if (!dryRun) {
    for (const r of topResults) {
      store.updateZettelAccess(r.id);
      indexer.updateAccess(r.id);
    }
  }

  return topResults;
}

module.exports = { search, expandQuery, tokenize, decayScore };
