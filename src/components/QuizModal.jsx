import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { generateQuiz } from '../lib/geminiApi.js';
import { getQuizProgress, saveQuizQuestions, saveQuizAttempt } from '../lib/quizProgress.js';
import OpenExercisePlayer from './OpenExercisePlayer.jsx';
import styles from './QuizModal.module.css';

const markdownComponents = {
  p: ({ node, ...props }) => <p className={styles.mdP} {...props} />,
  // react-markdown v8+ no longer passes an `inline` prop to `code` — block
  // vs inline is instead distinguished purely in CSS via the `.mdPre .mdCode`
  // descendant selector below. `className` must come after `styles.mdCode`
  // (not before) so rehype's `language-xxx` class (set on fenced code with a
  // language tag) doesn't silently overwrite ours.
  code: ({ node, className, ...props }) => (
    <code className={[styles.mdCode, className].filter(Boolean).join(' ')} {...props} />
  ),
  pre: ({ node, ...props }) => <pre className={styles.mdPre} {...props} />,
};

const MODE_LABELS = { exercise: 'Exercices', interview: "Préparation d'entretien" };

function scoreMessage(score, total) {
  if (total === 0) return '';
  const pct = score / total;
  if (pct >= 0.8) return 'Excellent !';
  if (pct >= 0.5) return 'Pas mal !';
  return 'À revoir.';
}

/**
 * Full-screen QCM player, mounted from Reader.jsx. Loads a cached quiz for
 * (bookId, chapterHref, mode) if one exists, otherwise generates one via
 * Gemini and caches it immediately (before the user finishes playing).
 */
export default function QuizModal({ mode, bookId, chapterHref, chapterName, bookTitle, bookAuthor, pageText, onClose }) {
  const [phase, setPhase] = useState('loading'); // loading | start | playing | summary | error
  const [questions, setQuestions] = useState([]);
  const [progressEntry, setProgressEntry] = useState(null);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async (forceRegenerate) => {
    setPhase('loading');
    setError(null);
    try {
      const cached = !forceRegenerate ? await getQuizProgress(bookId, chapterHref, mode) : null;
      if (cached?.questions?.length) {
        setQuestions(cached.questions);
        setProgressEntry(cached);
        setPhase('start');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const generated = await generateQuiz({
        mode, pageText, bookTitle, bookAuthor, chapterName, signal: controller.signal,
      });
      await saveQuizQuestions(bookId, chapterHref, mode, generated);
      const fresh = await getQuizProgress(bookId, chapterHref, mode);
      setQuestions(generated);
      setProgressEntry(fresh);
      setPhase('start');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[QuizModal] generation error:', err);
      setError(err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK');
      setPhase('error');
    }
  }, [bookId, chapterHref, mode, bookTitle, bookAuthor, chapterName, pageText]);

  useEffect(() => {
    load(false);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterHref, mode]);

  const startPlaying = () => {
    setCurrent(0);
    setSelected(null);
    setAnswered(false);
    setScore(0);
    setPhase('playing');
  };

  const selectOption = (i) => {
    if (answered) return;
    setSelected(i);
    setAnswered(true);
    if (i === questions[current].correctIndex) setScore(s => s + 1);
  };

  const finish = useCallback((finalScore) => {
    setPhase('summary');
    saveQuizAttempt(bookId, chapterHref, mode, { score: finalScore, total: questions.length })
      .then(() => getQuizProgress(bookId, chapterHref, mode))
      .then(setProgressEntry)
      .catch(err => console.error('[QuizModal] save attempt error:', err));
  }, [bookId, chapterHref, mode, questions.length]);

  const nextQuestion = () => {
    const isLast = current + 1 >= questions.length;
    if (isLast) {
      finish(score);
      return;
    }
    setCurrent(c => c + 1);
    setSelected(null);
    setAnswered(false);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            {MODE_LABELS[mode]} — {chapterName || bookTitle}
          </span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          {phase === 'loading' && (
            <div className={styles.centerState}>
              <span className={styles.loadingDot} />
              <p className={styles.stateText}>Génération du quiz…</p>
            </div>
          )}

          {phase === 'error' && (
            <div className={styles.centerState}>
              <p className={styles.stateText}>
                {error === 'NO_API_KEY'
                  ? 'Clé API Gemini manquante côté serveur (GEMINI_API_KEY).'
                  : error === 'NO_PAGE_TEXT'
                  ? 'Pas assez de texte sur cette page pour générer un quiz.'
                  : `Erreur : ${error}`}
              </p>
              <button className={styles.primaryBtn} onClick={() => load(false)}>Réessayer</button>
            </div>
          )}

          {phase === 'start' && (
            <div className={styles.centerState}>
              <p className={styles.quizTitle}>{questions.length} {mode === 'interview' ? 'questions' : 'exercices'}</p>
              {progressEntry?.attempts > 0 && (
                <p className={styles.bestScore}>
                  Déjà complété — meilleur score {progressEntry.bestScore}/{progressEntry.total}
                </p>
              )}
              <div className={styles.startActions}>
                <button className={styles.primaryBtn} onClick={startPlaying}>
                  {progressEntry?.attempts > 0 ? 'Rejouer' : 'Commencer'}
                </button>
                <button className={styles.secondaryBtn} onClick={() => load(true)}>
                  Régénérer
                </button>
              </div>
            </div>
          )}

          {phase === 'playing' && mode === 'interview' && questions[current] && (
            <div className={styles.playing}>
              <div className={styles.progressRow}>
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ width: `${(current / questions.length) * 100}%` }} />
                </div>
                <span className={styles.progressCount}>{current + 1}/{questions.length}</span>
              </div>

              <div className={styles.questionText}>
                <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeHighlight]}>
                  {questions[current].question}
                </ReactMarkdown>
              </div>

              <div className={styles.options}>
                {questions[current].options.map((opt, i) => {
                  const isCorrect = i === questions[current].correctIndex;
                  const isSelected = i === selected;
                  const cls = [
                    styles.option,
                    answered && isCorrect ? styles.optionCorrect : '',
                    answered && isSelected && !isCorrect ? styles.optionWrong : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <button key={i} className={cls} onClick={() => selectOption(i)} disabled={answered}>
                      <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeHighlight]}>
                        {opt}
                      </ReactMarkdown>
                    </button>
                  );
                })}
              </div>

              {answered && (
                <div className={styles.explanation}>
                  <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeHighlight]}>
                    {questions[current].explanation}
                  </ReactMarkdown>
                </div>
              )}

              {answered && (
                <button className={styles.primaryBtn} onClick={nextQuestion}>
                  {current + 1 >= questions.length ? 'Voir les résultats' : 'Suivant'}
                </button>
              )}
            </div>
          )}

          {phase === 'playing' && mode === 'exercise' && (
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
              <div className={styles.startActions}>
                <button className={styles.primaryBtn} onClick={startPlaying}>Rejouer</button>
                <button className={styles.secondaryBtn} onClick={onClose}>Fermer</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
