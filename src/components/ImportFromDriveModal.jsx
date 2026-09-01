import { useState, useCallback, useRef } from 'react';
import { loadData, getNotesheetFolderId } from '../lib/driveStorage.js';
import { downloadFile, listFiles } from '../lib/driveApi.js';
import { saveBook, extractCover } from '../utils/storage.js';
import { saveProgress, flushProgress } from '../lib/progress.js';
import { savePrompt, deletePrompt } from '../lib/customPrompts.js';
import { saveQuizQuestions, saveQuizAttempt } from '../lib/quizProgress.js';
import { getPomodoroStats, recordCompletedCycle } from '../lib/pomodoroLog.js';
import { saveNotesheet } from '../lib/revisionSheets.js';
import styles from './ImportFromDriveModal.module.css';

const STATUS_LABEL = {
  pending: 'En attente…',
  'in-progress': 'Import…',
  done: 'Importé ✓',
  error: 'Échec',
};

let logSeq = 0;

/**
 * One-time import of a user's legacy Drive data into the new backend (see
 * MIGRATION_PLAN.md phase 5). Deliberately runs client-side, in the browser
 * the user is already signed into — reuses the Drive read path
 * (driveStorage.js/driveApi.js, still intact but otherwise unused by the
 * live app since phase 3) and the *new* backend's write path (saveBook,
 * saveProgress, etc., already wired since phases 2-3) rather than a separate
 * Node script, which would need its own OAuth handling and can't run epubjs
 * (browser-only) for cover extraction.
 *
 * Re-running is broadly safe: books dedupe by title+author server-side,
 * progress/quiz simply overwrite to the same end state, pomodoro history
 * skips books it already has an entry for. Revision-sheet notes are the one
 * exception — the backend has no natural key for them, so a second run will
 * duplicate them (surfaced as a warning in the UI below).
 */
export default function ImportFromDriveModal({ onClose, onImported }) {
  const [phase, setPhase] = useState('setup'); // setup | loading | importing | done | error
  const [items, setItems] = useState([]); // one per Drive book
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);

  const pushLog = useCallback((level, message) => {
    (level === 'error' ? console.error : console.warn)(`[ImportFromDriveModal] ${message}`);
    setLogs(prev => [...prev, { id: logSeq++, level, message }]);
  }, []);

  const handleClose = useCallback(() => {
    cancelRef.current = true;
    onClose();
  }, [onClose]);

  const handleStart = useCallback(async () => {
    setPhase('loading');
    setError(null);
    setLogs([]);
    setStats(null);
    cancelRef.current = false;

    let driveData;
    try {
      driveData = await loadData();
    } catch (err) {
      console.error('[ImportFromDriveModal] loadData error:', err);
      setError(err.message || 'NETWORK');
      setPhase('error');
      return;
    }

    const books = driveData.books || [];
    setItems(books.map(b => ({ id: b.id, title: b.title, author: b.author, status: 'pending' })));
    setPhase('importing');

    // ── 1. Books — the only step with a natural, verifiable identity
    // (title+author), so it also drives idMap for every step below. ──
    const idMap = new Map(); // Drive file id -> new backend book id
    let booksImported = 0, booksSkipped = 0;

    for (const book of books) {
      if (cancelRef.current) return;
      setItems(prev => prev.map(it => (it.id === book.id ? { ...it, status: 'in-progress' } : it)));
      try {
        const data = await downloadFile(book.id);
        const cover = await extractCover(data.slice(0));
        const newId = await saveBook({ title: book.title, author: book.author, cover, data, addedAt: book.addedAt });
        idMap.set(book.id, newId);
        booksImported++;
        setItems(prev => prev.map(it => (it.id === book.id ? { ...it, status: 'done' } : it)));
      } catch (err) {
        booksSkipped++;
        pushLog('error', `Livre "${book.title}" : échec (${err.message || 'NETWORK'})`);
        setItems(prev => prev.map(it => (it.id === book.id ? { ...it, status: 'error', errorMessage: err.message } : it)));
      }
    }

    if (cancelRef.current) return;

    // ── 2. Reading progress — legacy Drive blob may still hold the old
    // bare-CFI string format, normalised the same way progress.js used to. ──
    for (const [driveId, raw] of Object.entries(driveData.progress || {})) {
      const newId = idMap.get(driveId);
      if (!newId) continue;
      const cfi = typeof raw === 'string' ? raw : raw.cfi;
      const pct = typeof raw === 'string' ? 0 : (raw.pct ?? 0);
      await saveProgress(newId, cfi, pct);
    }
    flushProgress();

    if (cancelRef.current) return;

    // ── 3. Custom prompts (including "this default was deleted" markers) ──
    for (const prompt of driveData.customPrompts || []) {
      try { await savePrompt(prompt); } catch (err) { pushLog('warn', `Prompt "${prompt.title}" non migré (${err.message})`); }
    }
    for (const id of driveData.deletedDefaultPromptIds || []) {
      try { await deletePrompt(id); } catch (err) { pushLog('warn', `Suppression de prompt par défaut "${id}" non migrée (${err.message})`); }
    }

    if (cancelRef.current) return;

    // ── 4. Quiz progress — restores the cached question set for each
    // book/chapter/mode, then seeds one attempt with the historical best
    // score (the exact attempt count isn't preserved, just the best score). ──
    let quizzesImported = 0;
    for (const [driveId, chapters] of Object.entries(driveData.quizProgress || {})) {
      const newId = idMap.get(driveId);
      if (!newId) continue;
      for (const [chapterHref, modes] of Object.entries(chapters || {})) {
        for (const mode of ['exercise', 'interview']) {
          const entry = modes?.[mode];
          if (!entry?.questions?.length) continue;
          try {
            await saveQuizQuestions(newId, chapterHref, mode, entry.questions);
            if (entry.completed && typeof entry.bestScore === 'number') {
              await saveQuizAttempt(newId, chapterHref, mode, { score: entry.bestScore, total: entry.total ?? entry.questions.length });
            }
            quizzesImported++;
          } catch (err) {
            pushLog('warn', `Quiz "${chapterHref}" (${mode}) non migré (${err.message})`);
          }
        }
      }
    }

    if (cancelRef.current) return;

    // ── 5. Pomodoro log — collapses the whole imported history into one
    // entry (sessionsCompleted becomes 1) but preserves the true totals
    // (minutes, exercises answered/correct). Skips books that already have
    // an entry, so re-running the import never double-counts. ──
    let pomodoroImported = 0;
    for (const [driveId, entry] of Object.entries(driveData.pomodoroLog || {})) {
      const newId = idMap.get(driveId);
      if (!newId || !entry) continue;
      try {
        const existing = await getPomodoroStats(newId);
        if (existing) continue;
        await recordCompletedCycle(newId, {
          durationMinutes: entry.totalMinutes ?? 0,
          exercisesAnswered: entry.exercisesAnswered ?? 0,
          exercisesCorrect: entry.exercisesCorrect ?? 0,
        });
        pomodoroImported++;
      } catch (err) {
        pushLog('warn', `Historique pomodoro non migré pour un livre (${err.message})`);
      }
    }

    if (cancelRef.current) return;

    // ── 6. Revision sheets — no natural key server-side, so this is the one
    // step that duplicates on a second run (see component doc comment). ──
    let notesImported = 0;
    try {
      const folderId = await getNotesheetFolderId();
      const files = await listFiles(folderId);
      for (const file of files) {
        try {
          const buffer = await downloadFile(file.id);
          const content = new TextDecoder('utf-8').decode(buffer);
          const title = file.name.replace(/\.md$/i, '');
          await saveNotesheet(title, content);
          notesImported++;
        } catch (err) {
          pushLog('warn', `Fiche "${file.name}" non migrée (${err.message})`);
        }
      }
    } catch (err) {
      pushLog('warn', `Liste des fiches de révision inaccessible (${err.message})`);
    }

    setStats({ booksImported, booksSkipped, quizzesImported, pomodoroImported, notesImported });
    setPhase('done');
    onImported?.();
  }, [pushLog, onImported]);

  const busy = phase === 'loading' || phase === 'importing';
  const doneCount = items.filter(it => it.status === 'done' || it.status === 'error').length;

  return (
    <div className={styles.overlay} onClick={busy ? undefined : handleClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <p className={styles.title}>Importer depuis Google Drive</p>
          {!busy && <button className={styles.closeBtn} onClick={handleClose} aria-label="Fermer">✕</button>}
        </div>

        {phase === 'setup' && (
          <div className={styles.body}>
            <p className={styles.hint}>
              Lit tes anciennes données Google Drive (livres, progression, prompts, quiz, historique pomodoro, fiches de révision) et les copie vers le nouveau backend. À lancer une seule fois.
            </p>
            <p className={styles.hint}>
              Peut être relancé sans risque pour les livres, la progression, les prompts et les quiz (rien n'est dupliqué). Les fiches de révision, en revanche, seront dupliquées si tu relances après un premier import réussi.
            </p>
            <button className={styles.primaryBtn} onClick={handleStart}>Lancer l'import</button>
          </div>
        )}

        {phase === 'loading' && (
          <div className={styles.body}>
            <p className={styles.progressLabel}>Lecture des données Drive…</p>
          </div>
        )}

        {phase === 'importing' && (
          <div className={styles.body}>
            <div className={styles.progressHeader}>
              <p className={styles.progressLabel}>Import en cours — {doneCount}/{items.length} livres</p>
            </div>

            <div className={styles.progressBarTrack}>
              <div
                className={styles.progressBarFill}
                style={{ width: `${items.length ? Math.round((doneCount / items.length) * 100) : 0}%` }}
              />
            </div>

            <ul className={styles.itemList}>
              {items.map((it) => (
                <li key={it.id} className={styles[`status_${it.status}`] || ''}>
                  <span className={styles.itemLabel}>{it.title}</span>
                  <span className={styles.itemStatusLabel}>{STATUS_LABEL[it.status] || it.status}</span>
                </li>
              ))}
            </ul>

            {logs.length > 0 && (
              <details className={styles.logPanel}>
                <summary>Journal ({logs.length})</summary>
                <ul className={styles.logList}>
                  {logs.map(l => (
                    <li key={l.id} className={l.level === 'error' ? styles.logError : styles.logWarn}>{l.message}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {phase === 'done' && stats && (
          <div className={styles.body}>
            <p className={styles.successText}>Import terminé.</p>
            <ul className={styles.estimateList}>
              <li><span>Livres importés</span><span>{stats.booksImported}</span></li>
              {stats.booksSkipped > 0 && <li><span>Livres en échec</span><span>{stats.booksSkipped}</span></li>}
              <li><span>Quiz restaurés</span><span>{stats.quizzesImported}</span></li>
              <li><span>Historiques pomodoro</span><span>{stats.pomodoroImported}</span></li>
              <li><span>Fiches de révision</span><span>{stats.notesImported}</span></li>
            </ul>
            {logs.length > 0 && (
              <details className={styles.logPanel}>
                <summary>Journal ({logs.length})</summary>
                <ul className={styles.logList}>
                  {logs.map(l => (
                    <li key={l.id} className={l.level === 'error' ? styles.logError : styles.logWarn}>{l.message}</li>
                  ))}
                </ul>
              </details>
            )}
            <button className={styles.primaryBtn} onClick={handleClose}>Fermer</button>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.body}>
            <p className={styles.errorText}>Erreur : {error}</p>
            <div className={styles.actions}>
              <button className={styles.secondaryBtn} onClick={handleClose}>Fermer</button>
              <button className={styles.primaryBtn} onClick={() => setPhase('setup')}>Réessayer</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
