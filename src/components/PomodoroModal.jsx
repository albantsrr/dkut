import { useState, useEffect, useCallback, useRef } from 'react';
import { generateSessionExercises } from '../lib/geminiApi.js';
import { recordCompletedCycle } from '../lib/pomodoroLog.js';
import OpenExercisePlayer from './OpenExercisePlayer.jsx';
import styles from './PomodoroModal.module.css';

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function scoreMessage(score, total) {
  if (total === 0) return '';
  const pct = score / total;
  if (pct >= 0.8) return 'Excellent !';
  if (pct >= 0.5) return 'Pas mal !';
  return 'À revoir.';
}

/**
 * End-of-cycle modal for the Pomodoro learning mode, mounted from Reader.jsx.
 * Generates 2-3 exercises from the text read during the cycle that just
 * ended, plays them out, records the completed cycle, then runs an optional
 * skippable break before handing control back via onCycleFinished — which
 * both closes this modal and starts the next 25-minute cycle. There is no
 * onClose/dismiss affordance during generation or play: the exercises are
 * mandatory once triggered (only the break can be skipped), so leaving the
 * Reader entirely is the only way out of an active cycle — consistent with
 * an interrupted cycle never being counted (see pomodoroLog.js).
 */
// startLoc/endLoc are epubjs "location" indices (book.locations.generate(1600)
// slices the book into ~1600-char units) — not printed page numbers, hence
// "position" rather than "page" here to avoid implying real page numbers.
function formatChapterRange(chapter, totalLocations) {
  const { startLoc, endLoc } = chapter;
  if (startLoc == null || endLoc == null) return '';
  const range = startLoc === endLoc ? `position ${startLoc}` : `positions ${startLoc}–${endLoc}`;
  return totalLocations ? `${range} / ${totalLocations}` : range;
}

export default function PomodoroModal({ bookId, bookTitle, bookAuthor, cycleMinutes, breakMinutes = 5, chapters, totalLocations, onCycleFinished }) {
  const [phase, setPhase] = useState('generating'); // generating | playing | summary | break | error
  const [questions, setQuestions] = useState([]);
  const [score, setScore] = useState(0);
  const [error, setError] = useState(null);
  const [breakSecondsLeft, setBreakSecondsLeft] = useState(breakMinutes * 60);
  const abortRef = useRef(null);
  const breakTimerRef = useRef(null);
  const breakEndAtRef = useRef(null);

  const chapterName = chapters.map(c => c.label).filter(Boolean).join(' → ');
  const pageText = chapters.map(c => c.text).filter(Boolean).join('\n\n---\n\n');

  const load = useCallback(async () => {
    setPhase('generating');
    setError(null);
    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const generated = await generateSessionExercises({
        pageText, bookTitle, bookAuthor, chapterName, signal: controller.signal,
      });
      setQuestions(generated);
      setScore(0);
      setPhase('playing');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[PomodoroModal] generation error:', err);
      setError(err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK');
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback((finalScore) => {
    setScore(finalScore);
    setPhase('summary');
    recordCompletedCycle(bookId, {
      durationMinutes: cycleMinutes,
      exercisesAnswered: questions.length,
      exercisesCorrect: finalScore,
      exercises: questions,
      chapterLabel: chapterName,
    }).catch(err => console.error('[PomodoroModal] record cycle error:', err));
  }, [bookId, cycleMinutes, questions, chapterName]);

  const startBreak = useCallback(() => {
    breakEndAtRef.current = Date.now() + breakMinutes * 60_000;
    setBreakSecondsLeft(breakMinutes * 60);
    setPhase('break');
    clearInterval(breakTimerRef.current);
    breakTimerRef.current = setInterval(() => {
      const remaining = breakEndAtRef.current - Date.now();
      if (remaining <= 0) {
        clearInterval(breakTimerRef.current);
        onCycleFinished();
      } else {
        setBreakSecondsLeft(Math.ceil(remaining / 1000));
      }
    }, 1000);
  }, [onCycleFinished, breakMinutes]);

  useEffect(() => () => clearInterval(breakTimerRef.current), []);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Session Pomodoro</span>
          {chapters.length > 0 ? (
            <ul className={styles.headerChapters}>
              {chapters.map((c, i) => {
                const range = formatChapterRange(c, totalLocations);
                return (
                  <li key={i} className={styles.headerChapterItem}>
                    {c.label || bookTitle}{range && <span className={styles.headerChapterRange}> — {range}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className={styles.headerChapterItem}>{bookTitle}</span>
          )}
        </div>

        <div className={styles.body}>
          {phase === 'generating' && (
            <div className={styles.centerState}>
              <span className={styles.loadingDot} />
              <p className={styles.stateText}>Génération des exercices…</p>
            </div>
          )}

          {phase === 'error' && (
            <div className={styles.centerState}>
              <p className={styles.stateText}>
                {error === 'NO_API_KEY'
                  ? 'Clé API Gemini manquante côté serveur (GEMINI_API_KEY).'
                  : error === 'NO_PAGE_TEXT'
                  ? "Pas assez de texte lu pendant cette session pour générer des exercices."
                  : `Erreur : ${error}`}
              </p>
              <div className={styles.startActions}>
                <button className={styles.primaryBtn} onClick={load}>Réessayer</button>
                <button className={styles.secondaryBtn} onClick={onCycleFinished}>Fermer</button>
              </div>
            </div>
          )}

          {phase === 'playing' && questions.length > 0 && (
            <OpenExercisePlayer
              exercises={questions}
              pageText={pageText}
              bookTitle={bookTitle}
              bookAuthor={bookAuthor}
              chapterName={chapterName}
              onAllGraded={finish}
            />
          )}

          {phase === 'summary' && (
            <div className={styles.centerState}>
              <p className={styles.scoreBig}>{score}/{questions.length}</p>
              <p className={styles.scoreMessage}>{scoreMessage(score, questions.length)}</p>
              <button className={styles.primaryBtn} onClick={startBreak}>Continuer</button>
            </div>
          )}

          {phase === 'break' && (
            <div className={styles.centerState}>
              <p className={styles.breakLabel}>Pause</p>
              <p className={styles.breakClock}>{formatClock(breakSecondsLeft)}</p>
              <button className={styles.secondaryBtn} onClick={onCycleFinished}>Passer la pause</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
