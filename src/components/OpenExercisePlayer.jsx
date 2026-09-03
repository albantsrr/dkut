import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { gradeExercise } from '../lib/geminiApi.js';
import styles from './OpenExercisePlayer.module.css';

const markdownComponents = {
  p: ({ node, ...props }) => <p className={styles.mdP} {...props} />,
  code: ({ node, className, ...props }) => (
    <code className={[styles.mdCode, className].filter(Boolean).join(' ')} {...props} />
  ),
  pre: ({ node, ...props }) => <pre className={styles.mdPre} {...props} />,
};

const TYPE_LABELS = { code: 'Code', math: 'Calcul', written: 'Question ouverte' };
const VERDICT_LABELS = { correct: 'Correct', partial: 'Partiellement correct', incorrect: 'Incorrect' };
const VERDICT_WEIGHTS = { correct: 1, partial: 0.5, incorrect: 0 };

function insertTab(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const { selectionStart, selectionEnd, value } = e.target;
  e.target.value = `${value.slice(0, selectionStart)}\t${value.slice(selectionEnd)}`;
  e.target.selectionStart = e.target.selectionEnd = selectionStart + 1;
}

/**
 * Renders one open-ended exercise at a time (code/math/written — see
 * OPEN_EXERCISE_SCHEMA in server/src/gemini.js), collects a free-text
 * answer, submits it for AI grading, then shows a verdict + feedback before
 * advancing. Mounted inside QuizModal's (mode: 'exercise') and
 * PomodoroModal's existing overlay/header/phase chrome — this component only
 * owns the "play through N exercises" body, not the surrounding modal.
 */
export default function OpenExercisePlayer({ exercises, pageText, bookTitle, bookAuthor, chapterName, onAllGraded }) {
  const [current, setCurrent] = useState(0);
  const [answer, setAnswer] = useState('');
  const [phase, setPhase] = useState('answering'); // answering | grading | graded | error
  const [result, setResult] = useState(null); // { verdict, feedback }
  const [error, setError] = useState(null);
  const [hintsShown, setHintsShown] = useState(false);
  const [mathCheck, setMathCheck] = useState(null); // { checking: bool, pass: bool|null, error: string|null }
  const scoreRef = useRef(0);
  const abortRef = useRef(null);

  const exercise = exercises[current];
  // A pooled review session (KnowledgeTestModal) mixes exercises from
  // different chapters/cycles — each item can carry its own grounding
  // context via these underscore-prefixed fields, falling back to the
  // component-level props used by QuizModal/PomodoroModal (single chapter).
  const exerciseChapterName = exercise?._chapterName ?? chapterName;
  const exercisePageText = exercise?._pageText ?? pageText;

  useEffect(() => {
    setAnswer(exercise?.starterCode || '');
    setPhase('answering');
    setResult(null);
    setError(null);
    setHintsShown(false);
    setMathCheck(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const checkMathAnswer = useCallback(async () => {
    if (!answer.trim() || !exercise?.expectedResult) return;
    setMathCheck({ checking: true, pass: null, error: null });
    try {
      const { evaluate } = await import('mathjs');
      const actual = evaluate(answer);
      const expected = evaluate(exercise.expectedResult.valueExpr);
      const tolerance = exercise.expectedResult.tolerance ?? 1e-6;
      const pass = Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
      setMathCheck({ checking: false, pass, error: null });
    } catch {
      setMathCheck({ checking: false, pass: null, error: 'Expression non reconnue.' });
    }
  }, [answer, exercise]);

  const submit = useCallback(async () => {
    if (!answer.trim() || phase === 'grading') return;
    setPhase('grading');
    setError(null);
    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const graded = await gradeExercise({
        exercise, pageText: exercisePageText, userAnswer: answer, bookTitle, bookAuthor, chapterName: exerciseChapterName, signal: controller.signal,
      });
      setResult(graded);
      setPhase('graded');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[OpenExercisePlayer] grading error:', err);
      setError(err.message || 'NETWORK');
      setPhase('error');
    }
  }, [answer, phase, exercise, exercisePageText, bookTitle, bookAuthor, exerciseChapterName]);

  const next = () => {
    scoreRef.current += VERDICT_WEIGHTS[result.verdict] ?? 0;
    const isLast = current + 1 >= exercises.length;
    if (isLast) {
      onAllGraded(Math.round(scoreRef.current));
      return;
    }
    setCurrent(c => c + 1);
  };

  if (!exercise) return null;

  return (
    <div className={styles.playing}>
      <div className={styles.progressRow}>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${(current / exercises.length) * 100}%` }} />
        </div>
        <span className={styles.progressCount}>{current + 1}/{exercises.length}</span>
      </div>

      <span className={styles.typeBadge}>
        {TYPE_LABELS[exercise.type]}{exercise.language ? ` · ${exercise.language}` : ''}
      </span>

      <div className={styles.promptText}>
        <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}>
          {exercise.prompt}
        </ReactMarkdown>
      </div>

      {phase !== 'graded' && (
        <textarea
          className={exercise.type === 'code' ? styles.answerCode : styles.answerText}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={exercise.type === 'code' ? insertTab : undefined}
          placeholder={exercise.type === 'written' || exercise.type === 'math' ? 'Ta réponse (LaTeX accepté pour les formules)…' : 'Ton code…'}
          disabled={phase === 'grading'}
          spellCheck={exercise.type !== 'code'}
        />
      )}

      {phase !== 'graded' && exercise.type === 'math' && exercise.expectedResult && (
        <div className={styles.mathCheckRow}>
          <button
            type="button"
            className={styles.hintBtn}
            onClick={checkMathAnswer}
            disabled={!answer.trim() || mathCheck?.checking}
          >
            {mathCheck?.checking ? 'Vérification…' : 'Vérifier'}
          </button>
          {mathCheck && !mathCheck.checking && (
            <span className={mathCheck.error ? styles.mathCheckError : (mathCheck.pass ? styles.mathCheckPass : styles.mathCheckFail)}>
              {mathCheck.error || (mathCheck.pass ? '✓ Correct' : '✗ Incorrect')}
            </span>
          )}
        </div>
      )}

      {phase !== 'graded' && exercise.hints?.length > 0 && (
        hintsShown ? (
          <div className={styles.hints}>
            {exercise.hints.map((hint, i) => (
              <div key={i} className={styles.hintItem}>
                <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}>
                  {hint}
                </ReactMarkdown>
              </div>
            ))}
          </div>
        ) : (
          <button type="button" className={styles.hintBtn} onClick={() => setHintsShown(true)}>
            💡 Indice
          </button>
        )
      )}

      {phase === 'error' && (
        <p className={styles.errorText}>
          {error === 'NO_API_KEY'
            ? 'Clé API Gemini manquante côté serveur (GEMINI_API_KEY).'
            : error === 'EMPTY_ANSWER'
            ? 'Réponse vide.'
            : `Erreur : ${error}`}
        </p>
      )}

      {phase === 'graded' && result && (
        <div className={`${styles.verdict} ${styles[`verdict_${result.verdict}`]}`}>
          <span className={styles.verdictLabel}>{VERDICT_LABELS[result.verdict]}</span>
          <div className={styles.feedbackText}>
            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}>
              {result.feedback}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {phase === 'graded' ? (
        <button className={styles.primaryBtn} onClick={next}>
          {current + 1 >= exercises.length ? 'Voir les résultats' : 'Suivant'}
        </button>
      ) : (
        <button className={styles.primaryBtn} onClick={submit} disabled={!answer.trim() || phase === 'grading'}>
          {phase === 'grading' ? 'Correction…' : 'Soumettre'}
        </button>
      )}
    </div>
  );
}
