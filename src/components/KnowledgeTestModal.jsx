import { useState, useEffect, useCallback } from 'react';
import { getPracticePool } from '../lib/practicePool.js';
import OpenExercisePlayer from './OpenExercisePlayer.jsx';
import styles from './KnowledgeTestModal.module.css';

const COUNT_STEPS = [5, 10];

function scoreMessage(score, total) {
  if (total === 0) return '';
  const pct = score / total;
  if (pct >= 0.8) return 'Excellent !';
  if (pct >= 0.5) return 'Pas mal !';
  return 'À revoir.';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Per-book "Tester ses connaissances" — replays exercises already seen for
 * this book (manual "Exercices" mode + Pomodoro cycles, combined and
 * deduplicated server-side by server/src/routes/practicePool.js), mixed
 * across the whole book rather than one chapter. Deliberately scoreless: no
 * call to saveQuizQuestions/saveQuizAttempt/recordCompletedCycle anywhere
 * here — a pooled session has no natural (chapter_href, mode) or cycle key
 * to attribute a score to, so this stays free-form practice.
 */
export default function KnowledgeTestModal({ book, onClose }) {
  const [phase, setPhase] = useState('loading'); // loading | empty | start | playing | summary | error
  const [pool, setPool] = useState([]);
  const [count, setCount] = useState(5);
  const [exercises, setExercises] = useState([]);
  const [score, setScore] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    getPracticePool(book.id)
      .then(({ pool: items }) => {
        setPool(items);
        setCount(Math.min(5, items.length));
        setPhase(items.length === 0 ? 'empty' : 'start');
      })
      .catch(err => {
        console.error('[KnowledgeTestModal] pool fetch error:', err);
        setError(err.message || 'NETWORK');
        setPhase('error');
      });
  }, [book.id]);

  // pageText is deliberately empty here — a pooled session mixes exercises
  // from different chapters/cycles, so no single chapter text is coherent
  // context for grading; the exercise's own expectedApproach (already a
  // self-contained rubric) keeps grading functional without it.
  const sample = useCallback((n) => shuffle(pool).slice(0, n).map(({ exercise, sourceLabel }) => ({
    ...exercise,
    _chapterName: sourceLabel,
    _pageText: '',
  })), [pool]);

  const startPlaying = () => {
    setExercises(sample(count));
    setPhase('playing');
  };

  const finish = (finalScore) => {
    setScore(finalScore);
    setPhase('summary');
  };

  const replay = () => {
    setExercises(sample(count));
    setPhase('playing');
  };

  const countChoices = COUNT_STEPS.filter(n => n < pool.length);
  if (!countChoices.includes(pool.length)) countChoices.push(pool.length);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Tester mes connaissances — {book.title}</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fermer">✕</button>
        </div>

        <div className={styles.body}>
          {phase === 'loading' && (
            <div className={styles.centerState}>
              <span className={styles.loadingDot} />
              <p className={styles.stateText}>Chargement des exercices déjà vus…</p>
            </div>
          )}

          {phase === 'error' && (
            <div className={styles.centerState}>
              <p className={styles.stateText}>Erreur : {error}</p>
              <button className={styles.secondaryBtn} onClick={onClose}>Fermer</button>
            </div>
          )}

          {phase === 'empty' && (
            <div className={styles.centerState}>
              <p className={styles.stateText}>
                Pas encore d'exercices vus pour ce livre — fais d'abord des exercices ou une session Pomodoro pour pouvoir les rejouer ici.
              </p>
              <button className={styles.secondaryBtn} onClick={onClose}>Fermer</button>
            </div>
          )}

          {phase === 'start' && (
            <div className={styles.centerState}>
              <p className={styles.poolSize}>
                {pool.length} exercice{pool.length > 1 ? 's' : ''} déjà vu{pool.length > 1 ? 's' : ''}, tout le livre confondu
              </p>
              <div className={styles.countRow}>
                {countChoices.map(n => (
                  <button
                    key={n}
                    className={n === count ? styles.countBtnActive : styles.countBtn}
                    onClick={() => setCount(n)}
                  >
                    {n === pool.length ? 'Tout' : n}
                  </button>
                ))}
              </div>
              <button className={styles.primaryBtn} onClick={startPlaying}>Commencer</button>
            </div>
          )}

          {phase === 'playing' && exercises.length > 0 && (
            <OpenExercisePlayer
              exercises={exercises}
              bookTitle={book.title}
              bookAuthor={book.author}
              onAllGraded={finish}
            />
          )}

          {phase === 'summary' && (
            <div className={styles.centerState}>
              <p className={styles.scoreBig}>{score}/{exercises.length}</p>
              <p className={styles.scoreMessage}>{scoreMessage(score, exercises.length)}</p>
              <div className={styles.startActions}>
                <button className={styles.primaryBtn} onClick={replay}>Rejouer avec d'autres exercices</button>
                <button className={styles.secondaryBtn} onClick={onClose}>Fermer</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
