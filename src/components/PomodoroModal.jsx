import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { generateSessionExercises } from '../lib/geminiApi.js';
import { recordCompletedCycle } from '../lib/pomodoroLog.js';
import styles from './PomodoroModal.module.css';

const BREAK_MINUTES = 5;

const markdownComponents = {
  p: ({ node, ...props }) => <p className={styles.mdP} {...props} />,
  code: ({ node, className, ...props }) => (
    <code className={[styles.mdCode, className].filter(Boolean).join(' ')} {...props} />
  ),
  pre: ({ node, ...props }) => <pre className={styles.mdPre} {...props} />,
};

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
export default function PomodoroModal({ bookId, bookTitle, bookAuthor, cycleMinutes, chapters, onCycleFinished }) {
  const [phase, setPhase] = useState('generating'); // generating | playing | summary | break | error
  const [questions, setQuestions] = useState([]);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [error, setError] = useState(null);
  const [breakSecondsLeft, setBreakSecondsLeft] = useState(BREAK_MINUTES * 60);
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
      setCurrent(0);
      setSelected(null);
      setAnswered(false);
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

  const selectOption = (i) => {
    if (answered) return;
    setSelected(i);
    setAnswered(true);
    if (i === questions[current].correctIndex) setScore(s => s + 1);
  };

  const finish = useCallback((finalScore) => {
    setPhase('summary');
    recordCompletedCycle(bookId, {
      durationMinutes: cycleMinutes,
      exercisesAnswered: questions.length,
      exercisesCorrect: finalScore,
    }).catch(err => console.error('[PomodoroModal] record cycle error:', err));
  }, [bookId, cycleMinutes, questions.length]);

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

  const startBreak = useCallback(() => {
    breakEndAtRef.current = Date.now() + BREAK_MINUTES * 60_000;
    setBreakSecondsLeft(BREAK_MINUTES * 60);
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
  }, [onCycleFinished]);

  useEffect(() => () => clearInterval(breakTimerRef.current), []);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Session Pomodoro — {chapterName || bookTitle}</span>
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
              <button className={styles.primaryBtn} onClick={load}>Réessayer</button>
            </div>
          )}

          {phase === 'playing' && questions[current] && (
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
