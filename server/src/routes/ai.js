import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import * as gemini from '../gemini.js';

const router = Router();

// Ties an AbortController to the request's own lifecycle so an in-flight
// Gemini call is actually cancelled server-side when the client disconnects
// (tab closed, explicit stop, navigation away) — not just abandoned.
function abortOnClose(req) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  return controller.signal;
}

function errorStatus(message) {
  return message === 'NO_API_KEY' ? 503 : message === 'NO_PAGE_TEXT' ? 400 : 500;
}

router.post('/ai/chat', requireAuth, async (req, res) => {
  const { userMessage, pageText, bookTitle, bookAuthor, chapterName, history } = req.body ?? {};
  const signal = abortOnClose(req);

  let started = false;
  try {
    const stream = gemini.streamChatMessage({
      userMessage, pageText, bookTitle, bookAuthor, chapterName, history, signal,
    });
    for await (const chunk of stream) {
      if (!started) {
        started = true;
        res.status(200).type('text/plain; charset=utf-8');
      }
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('[ai/chat]', err);
    if (started) { res.end(); return; }
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

router.post('/ai/revision-sheet', requireAuth, async (req, res) => {
  const { pageText, bookTitle, bookAuthor, chapterName } = req.body ?? {};
  try {
    const text = await gemini.generateRevisionSheet({ pageText, bookTitle, bookAuthor, chapterName });
    res.json({ text });
  } catch (err) {
    console.error('[ai/revision-sheet]', err);
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

// Standalone (mirrors generateSheetForConcept in gemini.js) so a single
// failed card in a revision-set can be retried without re-running the plan.
router.post('/ai/revision-sheet-concept', requireAuth, async (req, res) => {
  const { pageText, bookTitle, bookAuthor, chapterName, sheet } = req.body ?? {};
  const signal = abortOnClose(req);
  try {
    const text = await gemini.generateSheetForConcept({ pageText, bookTitle, bookAuthor, chapterName, sheet, signal });
    res.json({ text });
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('[ai/revision-sheet-concept]', err);
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

// NDJSON stream: one JSON object per line, same event shapes as
// gemini.js's generateRevisionSet() generator — see src/lib/geminiApi.js on
// the frontend for the consumer that turns this back into an async generator.
router.post('/ai/revision-set', requireAuth, async (req, res) => {
  const { pageText, bookTitle, bookAuthor, chapterName } = req.body ?? {};
  const signal = abortOnClose(req);

  let started = false;
  try {
    for await (const event of gemini.generateRevisionSet({ pageText, bookTitle, bookAuthor, chapterName, signal })) {
      if (!started) {
        started = true;
        res.status(200).type('application/x-ndjson');
      }
      res.write(JSON.stringify(event) + '\n');
    }
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('[ai/revision-set]', err);
    if (started) { res.end(); return; }
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

router.post('/ai/quiz', requireAuth, async (req, res) => {
  const { mode, pageText, bookTitle, bookAuthor, chapterName } = req.body ?? {};
  const signal = abortOnClose(req);
  try {
    const questions = await gemini.generateQuiz({ mode, pageText, bookTitle, bookAuthor, chapterName, signal });
    res.json({ questions });
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('[ai/quiz]', err);
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

router.post('/ai/session-exercises', requireAuth, async (req, res) => {
  const { pageText, bookTitle, bookAuthor, chapterName } = req.body ?? {};
  const signal = abortOnClose(req);
  try {
    const questions = await gemini.generateSessionExercises({ pageText, bookTitle, bookAuthor, chapterName, signal });
    res.json({ questions });
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('[ai/session-exercises]', err);
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

router.post('/ai/translate-segments', requireAuth, async (req, res) => {
  const { segments, targetLangLabel } = req.body ?? {};
  const signal = abortOnClose(req);
  try {
    const translations = await gemini.translateSegments({ segments, targetLangLabel, signal });
    res.json({ translations });
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('[ai/translate-segments]', err);
    res.status(errorStatus(err.message)).json({ error: err.message || 'NETWORK' });
  }
});

export default router;
