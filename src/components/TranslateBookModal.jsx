import { useState, useCallback, useEffect, useRef } from 'react';
import { getBook, saveTranslatedBook } from '../utils/storage.js';
import { estimateTranslation, translateEpub } from '../lib/epubTranslator.js';
import { LANGUAGES } from '../lib/languages.js';
import styles from './TranslateBookModal.module.css';

const STATUS_LABEL = {
  pending: 'En attente…',
  'in-progress': 'Traduction…',
  done: 'Traduit ✓',
  error: 'Échec',
  skipped: 'Jetons réservés — ignoré',
};

function safeFilename(title) {
  return (title || 'book').replace(/[^\w\s-]/g, '').trim() || 'book';
}

let logSeq = 0;

export default function TranslateBookModal({ book, allBooks, onClose, onTranslated }) {
  const [targetLang, setTargetLang] = useState('fr');
  const [phase, setPhase] = useState('setup'); // setup | estimating | review | translating | building | done | error
  const [estimate, setEstimate] = useState(null);
  const [chapterStatus, setChapterStatus] = useState([]);
  const [currentBatch, setCurrentBatch] = useState(null); // { scope, batchIndex, batchTotal } | null
  const [logs, setLogs] = useState([]); // [{ id, level, message }]
  const [stats, setStats] = useState(null);
  const [blob, setBlob] = useState(null);
  const [uploadState, setUploadState] = useState(null); // null | saving | saved | error
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const bookDataRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const pushLog = useCallback((level, message) => {
    (level === 'error' ? console.error : console.warn)(`[TranslateBookModal] ${message}`);
    setLogs(prev => [...prev, { id: logSeq++, level, message }]);
  }, []);

  const existing = allBooks?.find(b => b.translatedFrom === book.id && b.language === targetLang);

  const handleEstimate = useCallback(async () => {
    setPhase('estimating');
    setError(null);
    try {
      if (!bookDataRef.current) {
        const full = await getBook(book.id);
        bookDataRef.current = full.data;
      }
      const est = await estimateTranslation({ arrayBuffer: bookDataRef.current });
      setEstimate(est);
      setPhase('review');
    } catch (err) {
      console.error('[TranslateBookModal] estimate error:', err);
      setError(err.message || 'NETWORK');
      setPhase('error');
    }
  }, [book.id]);

  const handleSave = useCallback(async (savedBlob) => {
    setUploadState('saving');
    try {
      const arrayBuffer = await savedBlob.arrayBuffer();
      // Distinct from the source title so the two cards are told apart in the
      // grid (also a defense-in-depth against any future title-based logic —
      // getAllBooks() itself now dedupes by Drive id, not title+author).
      const langLabel = LANGUAGES.find(l => l.code === targetLang)?.label || targetLang;
      const id = await saveTranslatedBook({
        title: `${book.title} (${langLabel})`,
        author: book.author,
        data: arrayBuffer,
        sourceId: book.id,
        language: targetLang,
      });
      setUploadState('saved');
      onTranslated?.(id);
    } catch (err) {
      console.error('[TranslateBookModal] upload error:', err);
      setUploadState('error');
    }
  }, [book, targetLang, onTranslated]);

  const handleStart = useCallback(async () => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    setPhase('translating');
    setError(null);
    setChapterStatus([]);
    setCurrentBatch(null);
    setLogs([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const event of translateEpub({
        apiKey, arrayBuffer: bookDataRef.current, targetLang, signal: controller.signal,
      })) {
        switch (event.type) {
          case 'plan':
            setChapterStatus(event.chapters.map(c => ({ ...c, status: 'pending' })));
            break;
          case 'chapter-start':
            setChapterStatus(prev => prev.map((c, i) => (i === event.index ? { ...c, status: 'in-progress' } : c)));
            setCurrentBatch({ scope: event.href, batchIndex: 0, batchTotal: null });
            break;
          case 'chapter-progress':
            setCurrentBatch({ scope: event.href, batchIndex: event.batchIndex + 1, batchTotal: event.batchTotal });
            break;
          case 'chapter-done':
            setChapterStatus(prev => prev.map((c, i) => (i === event.index ? { ...c, status: 'done' } : c)));
            setCurrentBatch(null);
            break;
          case 'chapter-error':
            setChapterStatus(prev => prev.map((c, i) => (
              i === event.index
                ? { ...c, status: event.error === 'RESERVED_TOKEN_COLLISION' ? 'skipped' : 'error', errorMessage: event.error }
                : c
            )));
            setCurrentBatch(null);
            if (event.error !== 'RESERVED_TOKEN_COLLISION') {
              pushLog('error', `Section ${event.href} : échec (${event.error})`);
            } else {
              pushLog('warn', `Section ${event.href} : ignorée (contient déjà le jeton ⟦⟧ réservé)`);
            }
            break;
          case 'nav-progress':
            setCurrentBatch({ scope: 'Table des matières', batchIndex: event.batchIndex + 1, batchTotal: event.batchTotal });
            break;
          case 'nav-error':
            pushLog('warn', `Table des matières non traduite (${event.error})`);
            break;
          case 'metadata-error':
            pushLog('warn', `Métadonnées (langue) non mises à jour (${event.error})`);
            break;
          case 'log':
            pushLog(event.level, event.message);
            break;
          case 'building':
            setCurrentBatch(null);
            setPhase('building');
            break;
          case 'done':
            setStats(event.stats);
            setBlob(event.blob);
            setPhase('done');
            handleSave(event.blob);
            break;
          case 'aborted':
            setCurrentBatch(null);
            setPhase('review');
            break;
          default:
            break;
        }
      }
    } catch (err) {
      console.error('[TranslateBookModal] translation error:', err);
      pushLog('error', `Erreur fatale : ${err.message || 'NETWORK'}`);
      setError(err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK');
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }, [targetLang, handleSave, pushLog]);

  const handleDownload = useCallback(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFilename(book.title)} (${targetLang}).epub`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [blob, book.title, targetLang]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const busy = phase === 'translating' || phase === 'building';
  const doneCount = chapterStatus.filter(c => c.status === 'done').length;

  return (
    <div className={styles.overlay} onClick={busy ? undefined : handleClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <p className={styles.title}>Traduire « {book.title} »</p>
          <button className={styles.closeBtn} onClick={handleClose} aria-label="Fermer">✕</button>
        </div>

        {(phase === 'setup' || phase === 'estimating') && (
          <div className={styles.body}>
            {existing && (
              <p className={styles.warning}>
                Une traduction en {LANGUAGES.find(l => l.code === targetLang)?.label} existe déjà pour ce livre dans la bibliothèque. Continuer en créera une nouvelle, distincte.
              </p>
            )}
            <label className={styles.field}>
              <span>Langue cible</span>
              <select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                disabled={phase === 'estimating'}
              >
                {LANGUAGES.map(({ code, label }) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            <button className={styles.primaryBtn} onClick={handleEstimate} disabled={phase === 'estimating'}>
              {phase === 'estimating' ? 'Analyse du livre…' : 'Estimer la traduction'}
            </button>
          </div>
        )}

        {phase === 'review' && estimate && (
          <div className={styles.body}>
            <ul className={styles.estimateList}>
              <li><span>Sections du fichier EPUB</span><span>{estimate.totalChapters}</span></li>
              <li><span>Segments à traduire</span><span>{estimate.totalSegments}</span></li>
              <li><span>Caractères</span><span>{estimate.totalChars.toLocaleString('fr-FR')}</span></li>
              <li><span>Appels Gemini estimés</span><span>~{estimate.estimatedCalls}</span></li>
              <li><span>Tokens estimés (entrée + sortie)</span><span>~{(estimate.estimatedInputTokens + estimate.estimatedOutputTokens).toLocaleString('fr-FR')}</span></li>
              <li><span>Coût estimé (palier payant)</span><span>~{estimate.estimatedCostUsd.toLocaleString('fr-FR', { style: 'currency', currency: 'USD', minimumFractionDigits: 3 })}</span></li>
            </ul>
            <p className={styles.hint}>
              Une « section » est un fichier du livre dans l'ordre de lecture (couverture, page de titre, table des matières, chaque chapitre, annexes…) — leur nombre ne correspond donc pas au nombre de chapitres numérotés du livre.
            </p>
            <p className={styles.hint}>
              Estimation approximative (règle empirique ~4 caractères/token, pas de tokenizer officiel côté client) basée sur le tarif payant de gemini-3.5-flash-lite (0,30 $ / 1M tokens en entrée, 2,50 $ / 1M en sortie). Si votre clé API est sur le palier gratuit, le coût réel est nul — seules les limites de débit du palier gratuit peuvent alors ralentir ou interrompre un gros livre.
            </p>
            <p className={styles.hint}>Le code et les formules mathématiques ne sont jamais envoyés à Gemini.</p>
            <div className={styles.actions}>
              <button className={styles.secondaryBtn} onClick={() => setPhase('setup')}>Retour</button>
              <button className={styles.primaryBtn} onClick={handleStart}>Lancer la traduction</button>
            </div>
          </div>
        )}

        {busy && (
          <div className={styles.body}>
            <div className={styles.progressHeader}>
              <p className={styles.progressLabel}>
                {phase === 'building'
                  ? 'Reconstruction du fichier EPUB…'
                  : `Traduction en cours — ${doneCount}/${chapterStatus.length} sections`}
              </p>
              {phase === 'translating' && (
                <button className={styles.stopBtn} onClick={() => abortRef.current?.abort()}>Stop</button>
              )}
            </div>

            <div className={styles.progressBarTrack}>
              <div
                className={styles.progressBarFill}
                style={{ width: `${chapterStatus.length ? Math.round((doneCount / chapterStatus.length) * 100) : 0}%` }}
              />
            </div>

            {currentBatch && (
              <p className={styles.currentBatchLabel}>
                {currentBatch.scope}
                {currentBatch.batchTotal ? ` — lot ${currentBatch.batchIndex}/${currentBatch.batchTotal}` : ''}
              </p>
            )}

            <ul className={styles.chapterList}>
              {chapterStatus.map((c, i) => (
                <li key={i} className={styles[`status_${c.status}`] || ''}>
                  <span className={styles.chapterHref}>{c.href}</span>
                  <span className={styles.chapterStatusLabel}>{STATUS_LABEL[c.status] || c.status}</span>
                </li>
              ))}
            </ul>

            {logs.length > 0 && (
              <details className={styles.logPanel} open={phase === 'error'}>
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

        {phase === 'done' && (
          <div className={styles.body}>
            <p className={styles.successText}>Traduction terminée.</p>
            {stats && (
              <p className={styles.hint}>
                {stats.translatedSegments} segments traduits
                {stats.fallbackSegments > 0 ? `, ${stats.fallbackSegments} laissés dans la langue d'origine (échec persistant)` : ''}
                {stats.skippedChapters > 0 ? `, ${stats.skippedChapters} section(s) ignorée(s)` : ''}.
              </p>
            )}
            <div className={styles.actions}>
              <button className={styles.secondaryBtn} onClick={handleDownload}>⬇ Télécharger</button>
              {uploadState === 'saving' && <span className={styles.hint}>Enregistrement sur Drive…</span>}
              {uploadState === 'saved' && <span className={styles.hint}>Enregistré dans la bibliothèque ✓</span>}
              {uploadState === 'error' && (
                <button className={styles.secondaryBtn} onClick={() => handleSave(blob)}>Réessayer l'enregistrement</button>
              )}
            </div>
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
            <p className={styles.errorText}>
              {error === 'NO_API_KEY' ? 'Clé API Gemini manquante.' : `Erreur : ${error}`}
            </p>
            {logs.length > 0 && (
              <details className={styles.logPanel} open>
                <summary>Journal ({logs.length})</summary>
                <ul className={styles.logList}>
                  {logs.map(l => (
                    <li key={l.id} className={l.level === 'error' ? styles.logError : styles.logWarn}>{l.message}</li>
                  ))}
                </ul>
              </details>
            )}
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
