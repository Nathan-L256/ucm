const store = require("./store");
const indexer = require("./indexer");
const { callLlmJson } = require("./llm");

const EXTRACTION_PROMPT_PRE = `너는 기억 시스템이다. 아래 <source>의 텍스트에서 **나중에 기억할 가치가 있는 것만** 추출하라.
텍스트는 대화 로그, 기술 문서, 메모 등 어떤 형태든 될 수 있다.

## 원칙
- 한 노트 = 한 아이디어 (원자성). 여러 주제를 하나에 섞지 마라.
- 각 노트는 다른 노트 없이 단독으로 이해 가능해야 한다.
- "이것을 기억하면 나중에 도움이 되는가?" — Yes일 때만 추출.

## 추출 대상
1. **사용자 패턴** (type: "pattern"): 사용자의 행동/선호/습관/실수 패턴. 반드시 추출하라:
   - 작업 스타일: git workflow, 커밋 습관, 코드 리뷰 방식, 네이밍 선호
   - 반복되는 실수나 시행착오
   - 감정 신호: 짜증("아니", "제발"), 놀람("오?", "!"), 거부("그건 아니야"), 강한 선호("항상", "절대")
   - 의사결정 패턴: 어떤 선택지를 선호하는지, 무엇을 거부하는지
   - 도구/환경 선호: 특정 도구, 설정, 워크플로에 대한 고집
2. **고유 지식** (type: "project"): 특정 프로젝트/환경/팀에서만 통하는 설정, 컨벤션, 아키텍처 결정, 배포 방식.
3. **비자명한 발견** (type: "discovery"): 예상과 달랐던 동작, 디버깅으로 알게 된 것, 문서에 없는 정보. 단, 하나의 사건에서 파생되는 여러 측면을 별도 노트로 분리하지 마라 — 핵심 발견 하나로 통합.
4. **에피소드** (type: "episode"): 무엇을 했는지 작업 목록을 간결히 나열 (소스가 대화 로그일 때만, 최대 1개).

## 추출 금지
- AI 모델이 이미 아는 일반 지식 (프레임워크 사용법, 디자인 패턴, 언어 문법, 교과서 내용)
- 단순 지시/확인 ("커밋해줘", "파일 읽어줘")

## 출력 형식
각 노트:
- type: "pattern" | "project" | "discovery" | "episode"
- title: 핵심을 담은 한 문장
- body: 맥락 포함 설명 (markdown, 150자 이상)
- keywords: [{term, weight}] 배열 (weight 3: 핵심 3-5개, weight 2: 동의어/번역 2-3개, 최대 8개)
- attention: 왜 기억할 가치가 있는지 한 문장

JSON 배열만 출력. 기억할 것이 없으면 빈 배열 []. JSON 외 텍스트 금지.

<source>
`;
const EXTRACTION_PROMPT_POST = `
</source>`;

const DEDUP_PROMPT = `두 노트가 같은 지식을 담고 있는지 판단하라.

기존 노트:
제목: {EXISTING_TITLE}
본문: {EXISTING_BODY}

새 노트:
제목: {NEW_TITLE}
본문: {NEW_BODY}

판정:
- MERGE: 새 노트의 정보가 기존 노트와 같은 주제이며 통합해야 함
- SUPERSEDE: 새 노트가 기존 노트의 더 정확하거나 완전한 버전
- INDEPENDENT: 같은 키워드를 공유하지만 별개의 지식

JSON만 출력: {"verdict": "MERGE|SUPERSEDE|INDEPENDENT", "reason": "..."}
`;

// --- Title similarity (Jaccard) ---

function titleTokens(title) {
  return new Set(
    title.toLowerCase().replace(/[^\w\s가-힣-]/g, " ").split(/\s+/).filter((w) => w.length > 1)
  );
}

function jaccardSimilarity(setA, setB) {
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function charBigrams(text) {
  const clean = text.toLowerCase().replace(/[^\w가-힣]/g, "");
  const bigrams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    bigrams.add(clean.slice(i, i + 2));
  }
  return bigrams;
}

// --- Body overlap detection ---

function paragraphTokens(text) {
  return new Set(
    text.toLowerCase().replace(/[^\w\s가-힣-]/g, " ").split(/\s+/).filter((w) => w.length > 1)
  );
}

function bodyOverlap(existingBody, newBody) {
  const existingParas = existingBody.split(/\n{2,}/).map((p) => p.replace(/^---$/, "").trim()).filter((p) => p.length > 30);
  const newParas = newBody.split(/\n{2,}/).map((p) => p.replace(/^---$/, "").trim()).filter((p) => p.length > 30);
  if (newParas.length === 0) return 1;

  let overlapping = 0;
  for (const np of newParas) {
    const newTokens = paragraphTokens(np);
    for (const ep of existingParas) {
      if (jaccardSimilarity(newTokens, paragraphTokens(ep)) > 0.5) {
        overlapping++;
        break;
      }
    }
  }
  return overlapping / newParas.length;
}

function deduplicateBody(body) {
  const sections = body.split(/\n\n---\n\n/);
  if (sections.length <= 1) return body;

  const kept = [sections[0].trim()];
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i].trim();
    if (section.length < 30) continue;
    const sectionTokens = paragraphTokens(section);
    let isDup = false;
    for (const existing of kept) {
      if (jaccardSimilarity(sectionTokens, paragraphTokens(existing)) > 0.5) {
        isDup = true;
        break;
      }
    }
    if (!isDup) kept.push(section);
  }
  return kept.join("\n\n");
}

// --- Keyword extraction from text ---

function extractKeywordsFromText(title, body) {
  const stopwords = new Set([
    "the", "is", "at", "in", "on", "for", "to", "of", "and", "or", "a", "an",
    "this", "that", "with", "from", "by", "as", "it", "be", "are", "was",
    "이", "그", "저", "을", "를", "에", "의", "가", "는", "은", "도", "로",
    "한", "수", "등", "및", "때", "시", "후", "위", "대", "중", "더",
  ]);

  const text = `${title} ${title} ${body}`.toLowerCase(); // title weighted 2x
  const words = text
    .replace(/[^\w\s가-힣-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopwords.has(w));

  // Frequency count
  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }

  // Top keywords by frequency
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

// --- Extraction ---

async function extractZettels(text, source, { log, model } = {}) {
  const logFn = log || (() => {});

  logFn("Extracting memories...");
  const prompt = EXTRACTION_PROMPT_PRE + text.slice(0, 80_000) + EXTRACTION_PROMPT_POST;
  let rawZettels;
  try {
    rawZettels = await callLlmJson(prompt, { model });
  } catch (e) {
    logFn(`Extraction failed: ${e.message}`);
    return [];
  }

  if (!Array.isArray(rawZettels) || rawZettels.length === 0) {
    logFn("No memories extracted");
    return [];
  }
  logFn(`Extracted ${rawZettels.length} memories`);

  const typeToKind = { pattern: "literature", project: "literature", discovery: "literature", episode: "literature" };
  const results = [];
  for (const raw of rawZettels) {
    const keywords = {};
    for (const entry of (raw.keywords || [])) {
      if (entry && entry.term) {
        keywords[entry.term.toLowerCase()] = entry.weight || 2;
      }
    }

    // Fallback: supplement from title + body if too few core keywords
    const coreCount = Object.values(keywords).filter((w) => w >= 3).length;
    if (coreCount < 3) {
      const fallbackWords = extractKeywordsFromText(raw.title || "", raw.body || "");
      let added = 0;
      for (const word of fallbackWords) {
        if (!keywords[word]) {
          keywords[word] = coreCount === 0 ? 3 : 2;
          added++;
        }
      }
      if (added > 0) {
        logFn(`  Keyword supplement for "${(raw.title || "").slice(0, 40)}": +${added} from text`);
      }
    }

    // Cap at 8 keywords (keep highest weight first)
    const sortedKws = Object.entries(keywords).sort((a, b) => b[1] - a[1]);
    if (sortedKws.length > 8) {
      for (const [k] of sortedKws.slice(8)) {
        delete keywords[k];
      }
    }

    const memoryType = raw.type || "discovery";
    const now = new Date().toISOString();
    results.push({
      id: store.generateUniqueId(),
      kind: typeToKind[memoryType] || "literature",
      memoryType,
      attention: raw.attention || null,
      title: raw.title,
      body: raw.body || "",
      keywords,
      links: [],
      source: source || null,
      createdAt: now,
      lastAccessed: now,
      boostCount: 0,
    });
  }

  return results;
}

// --- Intra-batch dedup (same session, no LLM) ---

function deduplicateBatch(zettels, { log } = {}) {
  const logFn = log || (() => {});
  if (zettels.length <= 1) return zettels;

  const kept = [];
  const removed = new Set();

  for (let i = 0; i < zettels.length; i++) {
    if (removed.has(i)) continue;

    let survivor = zettels[i];
    const survivorTokens = titleTokens(survivor.title || "");
    const survivorCore = new Set(coreKeywords(survivor.keywords));

    for (let j = i + 1; j < zettels.length; j++) {
      if (removed.has(j)) continue;

      const candidate = zettels[j];
      const candidateTokens = titleTokens(candidate.title || "");
      const candidateCore = new Set(coreKeywords(candidate.keywords));

      const titleSim = jaccardSimilarity(survivorTokens, candidateTokens);
      const coreOverlap = [...survivorCore].filter((k) => candidateCore.has(k)).length;

      if (titleSim >= 0.4 && coreOverlap >= 1) {
        // Keep the one with longer body, merge keywords
        const keep = (survivor.body || "").length >= (candidate.body || "").length ? survivor : candidate;
        const discard = keep === survivor ? candidate : survivor;

        for (const [kw, w] of Object.entries(discard.keywords || {})) {
          if (!keep.keywords[kw] || keep.keywords[kw] < w) {
            keep.keywords[kw] = w;
          }
        }

        logFn(`  Intra-dedup: "${discard.title.slice(0, 50)}" → "${keep.title.slice(0, 50)}"`);
        removed.add(j);
        if (keep !== survivor) {
          removed.add(i);
          survivor = keep;
        }
      }
    }

    if (!removed.has(i)) {
      kept.push(survivor);
    }
  }

  if (removed.size > 0) {
    logFn(`Intra-batch dedup: ${zettels.length} → ${kept.length} (removed ${removed.size})`);
  }
  return kept;
}

// --- Dedup ---

function coreKeywords(keywords) {
  return Object.entries(keywords || {}).filter(([, w]) => w >= 3).map(([k]) => k);
}

function normalizedKwSet(keywords) {
  const tokens = new Set();
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    tokens.add(lower.replace(/\s+/g, ""));
    for (const t of lower.replace(/[^\w\s가-힣]/g, " ").split(/\s+/)) {
      if (t.length >= 2) tokens.add(t);
    }
  }
  return tokens;
}

async function checkDuplicate(newZettel, { model } = {}) {
  const newCoreKws = new Set(coreKeywords(newZettel.keywords));
  if (newCoreKws.size === 0) return { verdict: "INDEPENDENT" };

  // Find candidates with 1+ core keyword overlap or 3+ total keyword overlap
  const allEntries = indexer.getAllEntries();
  const newAllKws = new Set(Object.keys(newZettel.keywords || {}).map((k) => k.toLowerCase()));
  const candidates = [];
  for (const entry of allEntries) {
    if (entry.id === newZettel.id) continue;
    const entryCoreKws = new Set(coreKeywords(entry.keywords));
    const coreOverlap = [...newCoreKws].filter((k) => entryCoreKws.has(k));
    if (coreOverlap.length >= 1) {
      candidates.push({ id: entry.id, title: entry.title, overlapRatio: coreOverlap.length / newCoreKws.size });
      continue;
    }
    // Cross-implementation detection: different core keywords but many shared context keywords
    const entryAllKws = new Set(Object.keys(entry.keywords || {}).map((k) => k.toLowerCase()));
    const allOverlap = [...newAllKws].filter((k) => entryAllKws.has(k));
    if (allOverlap.length >= 3) {
      candidates.push({ id: entry.id, title: entry.title, overlapRatio: allOverlap.length / newAllKws.size });
    }
  }
  if (candidates.length === 0) return { verdict: "INDEPENDENT" };

  // Pre-filter: title similarity
  const newTitleTokens = titleTokens(newZettel.title || "");
  let bestCandidate = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candidateTitleTokens = titleTokens(candidate.title || "");
    const titleSim = jaccardSimilarity(newTitleTokens, candidateTitleTokens);
    const score = titleSim * 0.6 + candidate.overlapRatio * 0.4;
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  // Only call LLM if similarity is high enough
  if (!bestCandidate || bestScore < 0.15) return { verdict: "INDEPENDENT" };

  const existing = store.loadZettel(bestCandidate.id);
  if (!existing) return { verdict: "INDEPENDENT" };

  const prompt = DEDUP_PROMPT
    .replace("{EXISTING_TITLE}", existing.title)
    .replace("{EXISTING_BODY}", existing.body.slice(0, 500))
    .replace("{NEW_TITLE}", newZettel.title)
    .replace("{NEW_BODY}", newZettel.body.slice(0, 500));

  try {
    const result = await callLlmJson(prompt, { model });
    return { ...result, existingId: bestCandidate.id };
  } catch {
    return { verdict: "INDEPENDENT" };
  }
}

// --- Link generation ---

async function generateLinks(zettel, { maxCandidates = 5 } = {}) {
  const candidates = indexer.findByKeywordOverlap(zettel.keywords, 2);
  const links = [];
  for (const candidate of candidates.slice(0, maxCandidates)) {
    if (candidate.id === zettel.id) continue;
    links.push(candidate.id);
  }
  return links;
}

// --- Save with dedup ---

async function processAndSave(zettels, { log, skipDedup = false, model, dedupModel } = {}) {
  const logFn = log || (() => {});
  const saved = [];

  for (const zettel of zettels) {
    // Dedup check
    if (!skipDedup) {
      const dedup = await checkDuplicate(zettel, { model: dedupModel || model });
      if (dedup.verdict === "MERGE") {
        logFn(`  MERGE: "${zettel.title.slice(0, 50)}" → ${dedup.existingId} (${dedup.reason || ""})`);
        const existing = store.loadZettel(dedup.existingId);
        if (existing) {
          const overlap = bodyOverlap(existing.body, zettel.body);
          if (overlap < 0.7) {
            existing.body = existing.body + "\n\n---\n\n" + zettel.body;
          }
          for (const [kw, w] of Object.entries(zettel.keywords)) {
            if (!existing.keywords[kw] || existing.keywords[kw] < w) {
              existing.keywords[kw] = w;
            }
          }
          store.saveZettel(existing);
          indexer.indexZettel(existing);
          saved.push(existing);
        }
        continue;
      }
      if (dedup.verdict === "SUPERSEDE") {
        logFn(`  SUPERSEDE: "${zettel.title.slice(0, 50)}" replaces ${dedup.existingId}`);
        if (!zettel.links.includes(dedup.existingId)) {
          zettel.links.push(dedup.existingId);
        }
        const existing = store.loadZettel(dedup.existingId);
        if (existing) {
          existing.supersededBy = zettel.id;
          store.saveZettel(existing);
          indexer.indexZettel(existing);
        }
      }
    }

    // Generate links
    const links = await generateLinks(zettel);
    for (const linkId of links) {
      if (!zettel.links.includes(linkId)) zettel.links.push(linkId);
    }

    // Deduplicate links
    zettel.links = [...new Set(zettel.links.map(String))];

    // Save
    store.saveZettel(zettel);
    indexer.indexZettel(zettel);
    logFn(`  Saved: ${zettel.id} "${zettel.title.slice(0, 60)}"`);

    // Add backlinks
    for (const linkId of zettel.links) {
      const linked = store.loadZettel(linkId);
      if (!linked) continue;
      if (!linked.links) linked.links = [];
      linked.links = linked.links.map(String);
      if (!linked.links.includes(String(zettel.id))) {
        linked.links.push(String(zettel.id));
        store.saveZettel(linked);
        indexer.indexZettel(linked);
      }
    }

    saved.push(zettel);
  }

  return saved;
}

module.exports = {
  extractZettels, deduplicateBatch, checkDuplicate, generateLinks, processAndSave, extractKeywordsFromText,
  titleTokens, jaccardSimilarity, charBigrams, coreKeywords, normalizedKwSet, bodyOverlap, deduplicateBody,
};
