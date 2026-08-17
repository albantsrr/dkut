import Epub from 'epubjs';
import { translateSegments } from './geminiApi.js';
import { languageLabel } from './languages.js';

// Translatable block-level elements. Deliberately excludes `pre` — code
// blocks are never selected as translation units themselves (mirrors
// Reader.jsx#translatePage, which also skips `pre`).
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dd, dt, figcaption';
// Elements masked out (as ⟦N⟧ tokens) before a block's text is sent to
// Gemini, then spliced back verbatim afterwards — this is what keeps code
// and math untouched by translation even when nested inside a paragraph.
const MASK_SELECTOR = 'code, pre, math';

const CHARS_PER_BATCH = 5000; // headroom for French running ~15-20% longer than English
const MAX_SEGMENTS_PER_BATCH = 60; // guards against chapters with hundreds of short list items

// ── Cost estimate (approximate — no official client-side tokenizer for
// Gemini, so this is a heuristic, not a billed count) ──
const CHARS_PER_TOKEN = 4; // common rule-of-thumb for Latin-script text
// buildTranslationSystemInstruction()'s fixed cost, in src/lib/geminiApi.js — it
// has no chat/context caching, so this whole instruction is re-sent on EVERY
// single batch call, not once per book.
const SYSTEM_INSTRUCTION_TOKENS = 210;
const JSON_OVERHEAD_CHARS_PER_SEGMENT = 24; // {"id":"...","text":"..."} scaffolding, both request and reply
const OUTPUT_EXPANSION_FACTOR = 1.2; // translated text tends to run longer than source (esp. into French)
// gemini-3.5-flash-lite paid-tier pricing, per ai.google.dev/gemini-api/docs/pricing
// (checked 2026-08). The model is also available free of charge on the free
// tier — these prices only apply if the configured API key is on a paid tier.
const PRICE_PER_1M_INPUT_TOKENS = 0.30;
const PRICE_PER_1M_OUTPUT_TOKENS = 2.50;

function estimateCost({ totalChars, totalSegments, estimatedCalls }) {
  const inputChars = totalChars + totalSegments * JSON_OVERHEAD_CHARS_PER_SEGMENT;
  const outputChars = totalChars * OUTPUT_EXPANSION_FACTOR + totalSegments * JSON_OVERHEAD_CHARS_PER_SEGMENT;
  const estimatedInputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN) + estimatedCalls * SYSTEM_INSTRUCTION_TOKENS;
  const estimatedOutputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  const estimatedCostUsd =
    (estimatedInputTokens / 1e6) * PRICE_PER_1M_INPUT_TOKENS +
    (estimatedOutputTokens / 1e6) * PRICE_PER_1M_OUTPUT_TOKENS;
  return { estimatedInputTokens, estimatedOutputTokens, estimatedCostUsd };
}

// ── DOM parsing / serialization ──

function parseXhtml(rawText) {
  const parser = new DOMParser();
  let doc = parser.parseFromString(rawText, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) {
    doc = parser.parseFromString(rawText, 'text/html');
  }
  return doc;
}

function serializeXhtml(doc, originalRawText) {
  let out = new XMLSerializer().serializeToString(doc);
  if (originalRawText.trimStart().startsWith('<?xml') && !out.trimStart().startsWith('<?xml')) {
    out = '<?xml version="1.0" encoding="utf-8"?>\n' + out;
  }
  return out;
}

// Matches Archive.getText()'s own path decoding (node_modules/epubjs/lib/archive.js),
// so writes land on the exact same JSZip entry reads came from.
function zipKeyFromUrl(url) {
  return decodeURIComponent(url.startsWith('/') ? url.slice(1) : url);
}

// ── Segmentation & masking ──

function collectBlocks(doc) {
  if (!doc.body) return [];
  const all = Array.from(doc.body.querySelectorAll(BLOCK_SELECTOR));
  return all
    .filter(el => !all.some(other => other !== el && other.contains(el)))
    .filter(el => !el.closest('pre'));
}

// EPUB3 nav.xhtml: every <a> label. EPUB2 NCX: every <text> inside <navLabel>.
function collectNavLabelElements(doc, isNcx) {
  if (isNcx) return Array.from(doc.getElementsByTagName('text'));
  return Array.from(doc.querySelectorAll('a'));
}

// Clones the element, replaces every code/pre/math descendant with a ⟦N⟧
// token, and keeps the actual removed node (not a re-parsed HTML string) so
// it can be spliced back byte-for-byte with no HTML/XML re-parsing risk.
function maskInlineNodes(el) {
  const clone = el.cloneNode(true);
  const placeholders = [];
  Array.from(clone.querySelectorAll(MASK_SELECTOR)).forEach(node => {
    const token = `⟦${placeholders.length}⟧`;
    placeholders.push({ token, node });
    node.replaceWith(clone.ownerDocument.createTextNode(token));
  });
  return { text: clone.textContent, placeholders };
}

function buildSegments(elements, idPrefix, minLen = 2) {
  return elements
    .map((el, i) => ({ id: `${idPrefix}${i}`, ...maskInlineNodes(el), el }))
    .filter(seg => seg.text.trim().length >= minLen);
}

// Rebuilds el's content from translated text: plain runs become text nodes,
// ⟦N⟧ tokens are replaced by the original masked node (cloned again, since
// each token is only guaranteed to appear once in a well-formed reply).
function applyTranslation(el, translatedText, placeholders) {
  const doc = el.ownerDocument;
  while (el.firstChild) el.removeChild(el.firstChild);
  const tokenRe = /⟦(\d+)⟧/g;
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(translatedText)) !== null) {
    if (match.index > lastIndex) {
      el.appendChild(doc.createTextNode(translatedText.slice(lastIndex, match.index)));
    }
    const ph = placeholders[Number(match[1])];
    if (ph) el.appendChild(ph.node.cloneNode(true));
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < translatedText.length) {
    el.appendChild(doc.createTextNode(translatedText.slice(lastIndex)));
  }
}

function hasReservedTokenCollision(rawText) {
  return rawText.includes('⟦') || rawText.includes('⟧');
}

// ── Batching ──

function makeBatches(segments) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const seg of segments) {
    if (current.length > 0 && (currentChars + seg.text.length > CHARS_PER_BATCH || current.length >= MAX_SEGMENTS_PER_BATCH)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(seg);
    currentChars += seg.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ── Validation (never trust the model's structure blindly) ──

function extractTokenSet(text) {
  const set = new Set();
  const re = /⟦(\d+)⟧/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return set;
}

function tokensEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function validateBatch(requestSegments, rawTranslations) {
  if (!Array.isArray(rawTranslations)) return { ok: false, reason: 'NOT_ARRAY' };
  if (rawTranslations.length !== requestSegments.length) return { ok: false, reason: 'LENGTH_MISMATCH' };

  const reqIds = new Set(requestSegments.map(s => s.id));
  const map = new Map();
  for (const t of rawTranslations) {
    if (!t || typeof t.id !== 'string' || typeof t.text !== 'string') return { ok: false, reason: 'MALFORMED' };
    if (!reqIds.has(t.id) || map.has(t.id)) return { ok: false, reason: 'UNKNOWN_OR_DUPLICATE_ID' };
    map.set(t.id, t.text);
  }
  if (map.size !== reqIds.size) return { ok: false, reason: 'MISSING_ID' };

  for (const seg of requestSegments) {
    if (!tokensEqual(extractTokenSet(seg.text), extractTokenSet(map.get(seg.id)))) {
      return { ok: false, reason: 'TOKEN_MISMATCH' };
    }
  }
  return { ok: true, map };
}

async function attemptBatch(segs, { apiKey, targetLangLabel, signal }) {
  const raw = await translateSegments({
    apiKey,
    segments: segs.map(s => ({ id: s.id, text: s.text })),
    targetLangLabel,
    signal,
  });
  return validateBatch(segs, raw);
}

// Retry cascade: whole batch once more, then per-segment singleton calls
// (smaller surface = more reliable structured output). A segment that still
// fails keeps its original, untranslated (but token-intact) text — never a
// fabricated translation — and is counted in fallbackIds. `logs` collects
// human-readable diagnostics for every retry/fallback, so callers can surface
// *why* a batch or segment needed a fallback, not just that it did.
async function translateBatchWithRetry({ apiKey, batch, targetLangLabel, signal, cache, targetLang }) {
  const result = new Map();
  const toRequest = [];
  const logs = [];
  for (const seg of batch) {
    const cacheKey = `${targetLang}\0${seg.text}`;
    if (cache.has(cacheKey)) result.set(seg.id, cache.get(cacheKey));
    else toRequest.push(seg);
  }
  if (toRequest.length === 0) return { map: result, fallbackIds: [], logs };

  const tryOnce = async (segs) => {
    try {
      return await attemptBatch(segs, { apiKey, targetLangLabel, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return { ok: false, reason: err.message || 'CALL_ERROR' };
    }
  };

  let validation = await tryOnce(toRequest);
  if (!validation.ok) {
    logs.push({ level: 'warn', message: `Lot de ${toRequest.length} segment(s) rejeté (${validation.reason}) — nouvel essai` });
    validation = await tryOnce(toRequest);
  }

  const fallbackIds = [];
  if (validation.ok) {
    for (const seg of toRequest) {
      const text = validation.map.get(seg.id);
      result.set(seg.id, text);
      cache.set(`${targetLang}\0${seg.text}`, text);
    }
    return { map: result, fallbackIds, logs };
  }

  logs.push({ level: 'warn', message: `Lot toujours invalide (${validation.reason}) — repli sur ${toRequest.length} appel(s) individuel(s)` });
  for (const seg of toRequest) {
    if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const single = await tryOnce([seg]);
    if (single.ok) {
      const text = single.map.get(seg.id);
      result.set(seg.id, text);
      cache.set(`${targetLang}\0${seg.text}`, text);
    } else {
      result.set(seg.id, seg.text);
      fallbackIds.push(seg.id);
      logs.push({ level: 'error', message: `Segment "${seg.id}" laissé non traduit après échec répété (${single.reason})` });
    }
  }
  return { map: result, fallbackIds, logs };
}

// Async generator so chapter-level progress (one event per Gemini batch) can
// be surfaced to the UI instead of only knowing "chapter done" after
// potentially many sequential calls with no feedback in between.
async function* runSegments(segments, opts) {
  const batches = makeBatches(segments);
  if (batches.length === 0) {
    yield { type: 'segments-done', segmentCount: 0, translatedCount: 0, fallbackCount: 0 };
    return;
  }
  let translatedCount = 0;
  let fallbackCount = 0;
  for (let b = 0; b < batches.length; b++) {
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const batch = batches[b];
    const { map, fallbackIds, logs } = await translateBatchWithRetry({ ...opts, batch });
    for (const seg of batch) {
      const translated = map.get(seg.id);
      if (translated !== undefined) {
        applyTranslation(seg.el, translated, seg.placeholders);
        translatedCount++;
      }
    }
    fallbackCount += fallbackIds.length;
    for (const log of logs) yield { type: 'log', ...log };
    yield { type: 'batch-done', batchIndex: b, batchTotal: batches.length, translatedSoFar: translatedCount };
  }
  yield { type: 'segments-done', segmentCount: segments.length, translatedCount, fallbackCount };
}

// ── Navigation (TOC) ──

function getNavInfo(book) {
  const navPath = book.packaging?.navPath;
  const ncxPath = book.packaging?.ncxPath;
  if (navPath) return { url: book.resolve(navPath), isNcx: false };
  if (ncxPath) return { url: book.resolve(ncxPath), isNcx: true };
  return null;
}

// ── OPF metadata ──

// dc:title/dc:creator are deliberately never touched — only dc:language is
// rewritten, to avoid any risk of a hallucinated/mistranslated title.
function patchOpfLanguage(opfText, langCode) {
  const doc = new DOMParser().parseFromString(opfText, 'application/xml');
  let langEl = doc.getElementsByTagName('language')[0] || doc.getElementsByTagNameNS('*', 'language')[0];
  if (langEl) {
    langEl.textContent = langCode;
  } else {
    const metadataEl = doc.getElementsByTagName('metadata')[0] || doc.getElementsByTagNameNS('*', 'metadata')[0];
    if (metadataEl) {
      langEl = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
      langEl.textContent = langCode;
      metadataEl.appendChild(langEl);
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

// ── Public: dry-run estimate (no Gemini calls) ──

/**
 * Walks the whole book without calling Gemini, to preview cost before
 * committing to a real run: { totalChapters, chapters, totalSegments,
 * totalChars, estimatedCalls, estimatedInputTokens, estimatedOutputTokens,
 * estimatedCostUsd }. Token/cost figures are a heuristic (chars/4, no real
 * tokenizer available client-side) — treat as an order of magnitude, not a
 * bill. Free-tier API keys pay $0 regardless of this estimate.
 */
export async function estimateTranslation({ arrayBuffer }) {
  const book = Epub(arrayBuffer.slice(0));
  try {
    await book.ready;
    const chapters = [];
    let totalSegments = 0;
    let totalChars = 0;
    let estimatedCalls = 0;

    for (const section of book.spine.spineItems) {
      let segments = [];
      try {
        const raw = await book.archive.getText(section.url);
        if (raw != null && !hasReservedTokenCollision(raw)) {
          segments = buildSegments(collectBlocks(parseXhtml(raw)), 's');
        }
      } catch { /* count as an empty chapter */ }
      totalSegments += segments.length;
      totalChars += segments.reduce((sum, s) => sum + s.text.length, 0);
      estimatedCalls += makeBatches(segments).length;
      chapters.push({ index: chapters.length, href: section.href, segmentCount: segments.length });
    }

    const navInfo = getNavInfo(book);
    if (navInfo) {
      try {
        const raw = await book.archive.getText(navInfo.url);
        if (raw != null && !hasReservedTokenCollision(raw)) {
          const navSegments = buildSegments(collectNavLabelElements(parseXhtml(raw), navInfo.isNcx), 'n', 1);
          totalSegments += navSegments.length;
          totalChars += navSegments.reduce((sum, s) => sum + s.text.length, 0);
          estimatedCalls += makeBatches(navSegments).length;
        }
      } catch { /* nav estimate is best-effort */ }
    }

    return {
      totalChapters: chapters.length,
      chapters,
      totalSegments,
      totalChars,
      estimatedCalls,
      ...estimateCost({ totalChars, totalSegments, estimatedCalls }),
    };
  } finally {
    book.destroy();
  }
}

// ── Public: full translation run ──

/**
 * Translates an entire EPUB to `targetLang` via Gemini, preserving code/math
 * and archive structure (images, fonts, CSS pass through untouched). Async
 * generator yielding progress events:
 *   { type: 'loading' }
 *   { type: 'plan', chapters: [{ index, href }], totalChapters }
 *   { type: 'chapter-start', index, href }
 *   { type: 'chapter-progress', index, href, batchIndex, batchTotal } — one per Gemini batch within the chapter
 *   { type: 'chapter-done', index, segmentCount, translatedCount, fallbackCount }
 *   { type: 'chapter-error', index, error }
 *   { type: 'nav-start' } / { type: 'nav-progress', batchIndex, batchTotal } / { type: 'nav-done' } / { type: 'nav-error', error }
 *   { type: 'metadata-done' } / { type: 'metadata-error', error }
 *   { type: 'log', level: 'warn'|'error', message } — a retry/fallback diagnostic, in call order
 *   { type: 'building' }
 *   { type: 'done', blob, stats }
 *   { type: 'aborted', fromIndex? }
 */
export async function* translateEpub({ apiKey, arrayBuffer, targetLang = 'fr', signal }) {
  if (!apiKey) throw new Error('NO_API_KEY');
  yield { type: 'loading' };

  const targetLangLabel = languageLabel(targetLang);
  const cache = new Map();
  const stats = { translatedSegments: 0, fallbackSegments: 0, skippedChapters: 0 };
  const book = Epub(arrayBuffer.slice(0));

  try {
    await book.ready;
    const zip = book.archive.zip;
    const sections = book.spine.spineItems;

    const plan = sections.map((s, i) => ({ index: i, href: s.href }));
    yield { type: 'plan', chapters: plan, totalChapters: plan.length };

    for (let i = 0; i < sections.length; i++) {
      if (signal?.aborted) { yield { type: 'aborted', fromIndex: i }; return; }
      const section = sections[i];
      yield { type: 'chapter-start', index: i, href: section.href };
      try {
        const raw = await book.archive.getText(section.url);
        if (raw == null) throw new Error('CHAPTER_NOT_FOUND');
        if (hasReservedTokenCollision(raw)) {
          stats.skippedChapters++;
          yield { type: 'chapter-error', index: i, error: 'RESERVED_TOKEN_COLLISION' };
          continue;
        }
        const doc = parseXhtml(raw);
        const segments = buildSegments(collectBlocks(doc), 's');
        let segmentCount = 0, translatedCount = 0, fallbackCount = 0;
        for await (const evt of runSegments(segments, { apiKey, targetLang, targetLangLabel, signal, cache })) {
          if (evt.type === 'batch-done') {
            yield { type: 'chapter-progress', index: i, href: section.href, batchIndex: evt.batchIndex, batchTotal: evt.batchTotal };
          } else if (evt.type === 'log') {
            yield { type: 'log', level: evt.level, message: `[${section.href}] ${evt.message}` };
          } else if (evt.type === 'segments-done') {
            ({ segmentCount, translatedCount, fallbackCount } = evt);
          }
        }
        zip.file(zipKeyFromUrl(section.url), serializeXhtml(doc, raw));
        stats.translatedSegments += translatedCount;
        stats.fallbackSegments += fallbackCount;
        yield { type: 'chapter-done', index: i, segmentCount, translatedCount, fallbackCount };
      } catch (err) {
        if (err.name === 'AbortError') { yield { type: 'aborted', fromIndex: i }; return; }
        yield { type: 'chapter-error', index: i, error: err.message || 'NETWORK' };
      }
    }

    yield { type: 'nav-start' };
    try {
      const navInfo = getNavInfo(book);
      if (navInfo) {
        const raw = await book.archive.getText(navInfo.url);
        if (raw != null && !hasReservedTokenCollision(raw)) {
          const doc = parseXhtml(raw);
          const navSegments = buildSegments(collectNavLabelElements(doc, navInfo.isNcx), 'n', 1);
          for await (const evt of runSegments(navSegments, { apiKey, targetLang, targetLangLabel, signal, cache })) {
            if (evt.type === 'batch-done') {
              yield { type: 'nav-progress', batchIndex: evt.batchIndex, batchTotal: evt.batchTotal };
            } else if (evt.type === 'log') {
              yield { type: 'log', level: evt.level, message: `[TOC] ${evt.message}` };
            }
          }
          zip.file(zipKeyFromUrl(navInfo.url), serializeXhtml(doc, raw));
        }
      }
      yield { type: 'nav-done' };
    } catch (err) {
      if (err.name === 'AbortError') { yield { type: 'aborted' }; return; }
      yield { type: 'nav-error', error: err.message || 'NETWORK' };
    }

    try {
      // container.packagePath is already zip-root-relative (the raw
      // full-path from META-INF/container.xml) — unlike spine/nav hrefs,
      // it must NOT go through book.resolve(), which by this point resolves
      // relative to the OPF's own directory (book.path is set to the OPF
      // path during opening) and would double-prefix it, e.g.
      // "OEBPS/content.opf" -> "OEBPS/OEBPS/content.opf". Verified empirically.
      const opfKey = decodeURIComponent(book.container.packagePath);
      const opfEntry = zip.file(opfKey);
      const opfText = opfEntry ? await opfEntry.async('string') : null;
      if (opfText != null) {
        zip.file(opfKey, patchOpfLanguage(opfText, targetLang));
      }
      yield { type: 'metadata-done' };
    } catch (err) {
      yield { type: 'metadata-error', error: err.message || 'NETWORK' };
    }

    yield { type: 'building' };
    if (zip.file('mimetype')) {
      zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    }
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    yield { type: 'done', blob, stats };
  } finally {
    book.destroy();
  }
}
