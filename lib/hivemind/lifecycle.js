const store = require("./store");
const indexer = require("./indexer");
const { callLlmJson } = require("./llm");
const { decayScore } = require("./search");

const CONSOLIDATION_PROMPT = `다음 literature 노트들은 같은 주제 클러스터에 속한다.
이들을 종합하여 하나의 permanent 노트를 작성하라.

규칙:
- 자신의 말로 재작성 (원문 복사 금지)
- 핵심 인사이트만 추출하여 응고화
- 원본에 없는 내용 추가 금지

출력 JSON:
{
  "title": "종합 제목",
  "body": "markdown 본문",
  "keywords": [{"term": "키워드", "weight": 3}, ...] (weight 3: 핵심 3-5개, weight 2: 번역/동의어 2-3개, 총 최대 8개)
}

노트들:
`;

function computeAllScores(config) {
  const entries = indexer.getAllEntries();
  const scored = entries.map((entry) => {
    const decay = decayScore(entry.lastAccessed, entry.boostCount, config.decayDays);
    return { ...entry, decay };
  });
  return scored;
}

function runGc({ dryRun = false, log } = {}) {
  const logFn = log || (() => {});
  const config = store.loadConfig();
  const scored = computeAllScores(config);
  const total = scored.length;

  if (total <= config.minKeep) {
    logFn(`Total zettels (${total}) <= minKeep (${config.minKeep}), skipping GC`);
    return { archived: 0, total };
  }

  const candidates = scored
    .filter((s) => s.kind !== "permanent" && s.decay < config.gcThreshold)
    .sort((a, b) => a.decay - b.decay);

  const maxArchive = total - config.minKeep;
  const toArchive = candidates.slice(0, maxArchive);

  logFn(`GC: ${toArchive.length} candidates (total=${total}, threshold=${config.gcThreshold})`);

  if (dryRun) {
    for (const entry of toArchive) {
      logFn(`  [dry-run] would archive: ${entry.id} "${entry.title}" (decay=${entry.decay.toFixed(4)})`);
    }
    return { archived: 0, wouldArchive: toArchive.length, total };
  }

  let archived = 0;
  for (const entry of toArchive) {
    if (store.archiveZettel(entry.id)) {
      indexer.unindexZettel(entry.id);
      logFn(`  Archived: ${entry.id} "${entry.title}"`);
      archived++;
    }
  }

  return { archived, total: total - archived };
}

async function findConsolidationClusters() {
  const keywordIndex = indexer.getKeywordIndex();
  const entries = indexer.getAllEntries();
  const literatureEntries = entries.filter((e) => e.kind === "literature");

  // Group literature zettels by keyword clusters
  // Find keywords that appear in 5+ literature zettels
  const clusters = {};
  for (const [keyword, refs] of Object.entries(keywordIndex)) {
    const literatureRefs = refs.filter((r) => {
      const entry = indexer.getMasterEntry(r.id);
      return entry && entry.kind === "literature";
    });
    if (literatureRefs.length >= 5) {
      clusters[keyword] = literatureRefs.map((r) => r.id);
    }
  }

  // Merge overlapping clusters
  const merged = [];
  const seen = new Set();
  for (const [keyword, ids] of Object.entries(clusters)) {
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    const clusterSet = new Set(ids);
    // Find other keywords with significant overlap
    for (const [otherKeyword, otherIds] of Object.entries(clusters)) {
      if (seen.has(otherKeyword)) continue;
      const overlap = otherIds.filter((id) => clusterSet.has(id)).length;
      if (overlap >= 3) {
        seen.add(otherKeyword);
        for (const id of otherIds) clusterSet.add(id);
      }
    }
    if (clusterSet.size >= 5) {
      merged.push([...clusterSet]);
    }
  }

  return merged;
}

async function consolidate({ log, model } = {}) {
  const logFn = log || (() => {});
  const clusters = await findConsolidationClusters();
  logFn(`Found ${clusters.length} consolidation candidates`);

  const created = [];
  for (const clusterIds of clusters) {
    // Check if a permanent zettel already covers this cluster
    const allEntries = indexer.getAllEntries();
    const permanentZettels = allEntries.filter((e) => e.kind === "permanent");
    const clusterKeywords = new Set();
    for (const id of clusterIds) {
      const entry = indexer.getMasterEntry(id);
      if (entry?.keywords) {
        for (const kw of Object.keys(entry.keywords)) clusterKeywords.add(kw);
      }
    }

    let alreadyCovered = false;
    for (const perm of permanentZettels) {
      const permKeywords = new Set(Object.keys(perm.keywords || {}));
      const overlap = [...clusterKeywords].filter((k) => permKeywords.has(k)).length;
      if (overlap >= 3) {
        alreadyCovered = true;
        break;
      }
    }
    if (alreadyCovered) continue;

    // Build prompt
    const notes = [];
    for (const id of clusterIds.slice(0, 10)) {
      const zettel = store.loadZettel(id);
      if (zettel) {
        notes.push({ title: zettel.title, body: zettel.body });
      }
    }

    if (notes.length < 5) continue;

    logFn(`Consolidating cluster of ${notes.length} notes...`);
    try {
      const result = await callLlmJson(CONSOLIDATION_PROMPT + JSON.stringify(notes, null, 2), { model });
      const now = new Date().toISOString();
      const keywords = {};
      for (const entry of (result.keywords || [])) {
        if (entry && entry.term) {
          keywords[entry.term.toLowerCase()] = entry.weight || 2;
        }
      }

      const permanent = {
        id: store.generateUniqueId(),
        kind: "permanent",
        title: result.title,
        body: result.body,
        keywords,
        links: clusterIds.slice(0, 10),
        createdAt: now,
        lastAccessed: now,
        boostCount: 0,
      };

      store.saveZettel(permanent);
      indexer.indexZettel(permanent);
      logFn(`Created permanent: ${permanent.id} "${permanent.title}"`);
      created.push(permanent);
    } catch (e) {
      logFn(`Consolidation failed: ${e.message}`);
    }
  }

  return created;
}

// --- Cross-zettel dedup (heuristic, no LLM) ---

function dedupAll({ log } = {}) {
  const { titleTokens, jaccardSimilarity, charBigrams, coreKeywords, normalizedKwSet, bodyOverlap } = require("./extract");
  const logFn = log || (() => {});
  const entries = indexer.getAllEntries();
  logFn(`Dedup scan: ${entries.length} zettels`);

  const merged = new Set();
  let mergeCount = 0;

  for (let i = 0; i < entries.length; i++) {
    if (merged.has(entries[i].id)) continue;

    const entry = entries[i];
    const entryTitleBigrams = charBigrams(entry.title || "");
    const entryKwSet = normalizedKwSet(coreKeywords(entry.keywords));
    if (entryKwSet.size === 0) continue;

    for (let j = i + 1; j < entries.length; j++) {
      if (merged.has(entries[j].id)) continue;

      const candidate = entries[j];
      const candidateTitleBigrams = charBigrams(candidate.title || "");
      const candidateKwSet = normalizedKwSet(coreKeywords(candidate.keywords));

      const titleCharSim = jaccardSimilarity(entryTitleBigrams, candidateTitleBigrams);
      const kwSim = jaccardSimilarity(entryKwSet, candidateKwSet);

      if (titleCharSim >= 0.35 && kwSim >= 0.3) {
        const z1 = store.loadZettel(entry.id);
        const z2 = store.loadZettel(candidate.id);
        if (!z1 || !z2) continue;

        const keep = (z1.body || "").length >= (z2.body || "").length ? z1 : z2;
        const discard = keep === z1 ? z2 : z1;

        // Merge keywords
        if (!keep.keywords) keep.keywords = {};
        for (const [kw, w] of Object.entries(discard.keywords || {})) {
          if (!keep.keywords[kw] || keep.keywords[kw] < w) {
            keep.keywords[kw] = w;
          }
        }

        // Only append non-overlapping body
        const overlap = bodyOverlap(keep.body, discard.body);
        if (overlap < 0.7) {
          keep.body = keep.body + "\n\n---\n\n" + discard.body;
        }

        // Merge links
        const allLinks = new Set([...(keep.links || []).map(String), ...(discard.links || []).map(String)]);
        allLinks.delete(keep.id);
        allLinks.delete(discard.id);
        keep.links = [...allLinks];

        store.saveZettel(keep);
        indexer.indexZettel(keep);
        store.archiveZettel(discard.id);
        indexer.unindexZettel(discard.id);

        merged.add(discard.id);
        mergeCount++;
        logFn(`  Merged: "${discard.title.slice(0, 50)}" → "${keep.title.slice(0, 50)}"`);
      }
    }
  }

  logFn(`Dedup complete: ${mergeCount} merges, ${entries.length - merged.size} remaining`);
  return { merged: mergeCount, remaining: entries.length - merged.size };
}

// --- Cleanup existing zettels (body dedup + keyword cap) ---

function cleanupAll({ log } = {}) {
  const { deduplicateBody } = require("./extract");
  const logFn = log || (() => {});
  const entries = indexer.getAllEntries();
  let bodyFixed = 0;
  let kwFixed = 0;

  for (const entry of entries) {
    const zettel = store.loadZettel(entry.id);
    if (!zettel) continue;
    let changed = false;

    // Deduplicate body sections
    const cleanBody = deduplicateBody(zettel.body || "");
    if (cleanBody !== zettel.body) {
      zettel.body = cleanBody;
      bodyFixed++;
      changed = true;
    }

    // Cap keywords at 8
    const kwEntries = Object.entries(zettel.keywords || {});
    if (kwEntries.length > 8) {
      const sorted = kwEntries.sort((a, b) => b[1] - a[1]);
      zettel.keywords = {};
      for (const [k, w] of sorted.slice(0, 8)) {
        zettel.keywords[k] = w;
      }
      kwFixed++;
      changed = true;
    }

    if (changed) {
      store.saveZettel(zettel);
      indexer.indexZettel(zettel);
    }
  }

  logFn(`Cleanup: ${bodyFixed} bodies deduped, ${kwFixed} keyword sets capped`);
  return { total: entries.length, bodyFixed, kwFixed };
}

module.exports = { runGc, consolidate, computeAllScores, findConsolidationClusters, dedupAll, cleanupAll };
