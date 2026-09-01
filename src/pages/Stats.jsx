import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAllPomodoroStats } from '../lib/pomodoroLog.js';
import { getAllBooks } from '../utils/storage.js';
import styles from './Stats.module.css';

function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

export default function Stats() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]); // [{ book, stats }]

  useEffect(() => {
    setLoading(true);
    Promise.all([getAllPomodoroStats(), getAllBooks()])
      .then(([pomodoroLog, books]) => {
        const booksById = new Map(books.map(b => [b.id, b]));
        const combined = Object.entries(pomodoroLog)
          .map(([bookId, stats]) => ({ book: booksById.get(bookId), stats }))
          .filter(r => r.book) // drop entries for since-deleted books
          .sort((a, b) => new Date(b.stats.lastSessionAt) - new Date(a.stats.lastSessionAt));
        setRows(combined);
      })
      .catch((err) => setError(err.message ?? 'Failed to load stats.'))
      .finally(() => setLoading(false));
  }, []);

  const totals = rows.reduce((acc, r) => ({
    sessions: acc.sessions + r.stats.sessionsCompleted,
    minutes: acc.minutes + r.stats.totalMinutes,
    answered: acc.answered + r.stats.exercisesAnswered,
    correct: acc.correct + r.stats.exercisesCorrect,
  }), { sessions: 0, minutes: 0, answered: 0, correct: 0 });

  const accuracy = totals.answered > 0 ? Math.round((totals.correct / totals.answered) * 100) : null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.backLink} onClick={() => navigate('/')}>← Library</button>
        <div className={styles.ornament}>✦</div>
        <h1 className={styles.title}>Stats</h1>
        <p className={styles.subtitle}>sessions d'apprentissage</p>
      </header>

      {loading && <p className={styles.emptyHint}>Chargement…</p>}
      {error && <p className={styles.errorHint}>Erreur : {error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className={styles.emptyHint}>
          Aucune session Pomodoro terminée pour le moment — lance le mode apprentissage depuis un livre pour commencer.
        </p>
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <section className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{totals.sessions}</span>
              <span className={styles.tileLabel}>{totals.sessions > 1 ? 'sessions' : 'session'}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{formatMinutes(totals.minutes)}</span>
              <span className={styles.tileLabel}>temps total</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{totals.answered}</span>
              <span className={styles.tileLabel}>exercices répondus</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{accuracy !== null ? `${accuracy}%` : '—'}</span>
              <span className={styles.tileLabel}>précision</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{rows.length}</span>
              <span className={styles.tileLabel}>{rows.length > 1 ? 'livres pratiqués' : 'livre pratiqué'}</span>
            </div>
          </section>

          <section className={styles.bookList}>
            {rows.map(({ book, stats }) => {
              const bookAccuracy = stats.exercisesAnswered > 0
                ? Math.round((stats.exercisesCorrect / stats.exercisesAnswered) * 100)
                : null;
              return (
                <article key={book.id} className={styles.bookRow} onClick={() => navigate(`/read/${book.id}`)}>
                  <div className={styles.bookMeta}>
                    <p className={styles.bookTitle}>{book.title}</p>
                    <p className={styles.bookAuthor}>{book.author}</p>
                  </div>
                  <div className={styles.bookStats}>
                    <span>{stats.sessionsCompleted} {stats.sessionsCompleted > 1 ? 'sessions' : 'session'}</span>
                    <span>{formatMinutes(stats.totalMinutes)}</span>
                    <span>{bookAccuracy !== null ? `${bookAccuracy}% précision` : '—'}</span>
                  </div>
                </article>
              );
            })}
          </section>
        </>
      )}

      <footer className={styles.footer}>
        <span className={styles.footerOrnament}>✦</span>
      </footer>
    </div>
  );
}
