import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Epub from 'epubjs';
import { getBook } from '../utils/storage.js';
import { getProgress, saveProgress, clearProgress, flushProgress } from '../lib/progress.js';
import { getAllQuizProgress } from '../lib/quizProgress.js';
import { getPomodoroSettings } from '../lib/pomodoroSettings.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import styles from './Reader.module.css';
import ChatPanel from '../components/ChatPanel.jsx';
import QuizModal from '../components/QuizModal.jsx';
import PomodoroModal from '../components/PomodoroModal.jsx';
import UserMenu from '../components/UserMenu.jsx';

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const THEMES = {
  night: {
    label: 'Night',
    bg: '#0d0b09',
    text: '#ddd0bc',
    bodyBg: '#0d0b09',
    bodyColor: '#ddd0bc',
  },
  sepia: {
    label: 'Sepia',
    bg: '#f5ead6',
    text: '#3a2e26',
    bodyBg: '#f5ead6',
    bodyColor: '#3a2e26',
  },
  day: {
    label: 'Day',
    bg: '#fafaf8',
    text: '#1c1c1a',
    bodyBg: '#fafaf8',
    bodyColor: '#1c1c1a',
  },
};

// Preserves section boundaries when capturePageText() flattens the chapter
// DOM to plain text, so the AI context keeps heading structure instead of
// an undifferentiated wall of paragraphs.
const HEADING_PREFIX = { H1: '# ', H2: '## ', H3: '### ', H4: '#### ', H5: '##### ', H6: '###### ' };

function flattenToc(toc, depth = 0) {
  const out = [];
  for (const item of toc) {
    out.push({ ...item, depth });
    if (item.subitems?.length) out.push(...flattenToc(item.subitems, depth + 1));
  }
  return out;
}

export default function Reader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut } = useAuth();
  // Locked for the whole reading session at mount — no mid-session toggle.
  // Falls back to free reading if router state is missing (page refresh,
  // direct URL): never silently force learning mode without an explicit choice.
  const [isLearningMode] = useState(() => location.state?.mode === 'learning');

  const viewerRef = useRef(null);
  const viewerWrapperRef = useRef(null);
  const bookRef = useRef(null);
  const renditionRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [toc, setToc] = useState([]);
  const [progress, setProgress] = useState(0);
  const [currentChapter, setCurrentChapter] = useState('');
  const [currentChapterHref, setCurrentChapterHref] = useState('');
  const [showQuizPicker, setShowQuizPicker] = useState(false);
  const [activeQuizMode, setActiveQuizMode] = useState(null); // null | 'exercise' | 'interview'
  const [quizTarget, setQuizTarget] = useState(null); // { href, label, pageText } for the active quiz
  const [quizProgressMap, setQuizProgressMap] = useState({}); // { [chapterHref]: { exercise, interview } }
  const [chapterNudge, setChapterNudge] = useState(null); // { href, label, pageText } | null
  const [theme, setTheme] = useState('night');
  const [fontSize, setFontSize] = useState(18);
  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChrome, setShowChrome] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [pageChangeSignal, setPageChangeSignal] = useState(0);
  const [locDebug, setLocDebug] = useState('');
  const hideTimer = useRef(null);
  const pageTextRef = useRef('');
  const locationsReadyRef = useRef(false);
  const preFullscreenCfiRef = useRef(null);
  const prevChapterRef = useRef(null); // { href, label } of the chapter before the current one
  const nudgedChaptersRef = useRef(new Set());
  const nudgeTimerRef = useRef(null);

  // ── Pomodoro learning mode ──
  const currentChapterRef = useRef({ href: '', label: '' }); // mirrors currentChapter/currentChapterHref, read from the cycle timer's interval closure so it never goes stale
  const activeQuizModeRef = useRef(null); // mirrors activeQuizMode, same reason
  const cycleChaptersRef = useRef(new Map()); // Map<href, {label, text, startLoc, endLoc}> read during the active cycle, cleared each cycle
  const chapterLocRangeRef = useRef(new Map()); // Map<href, {startLoc, endLoc}>, updated on every relocate — first/last epubjs location number seen in each chapter this cycle
  const cycleTimerRef = useRef(null);
  const cycleEndAtRef = useRef(null);
  const cycleDueRef = useRef(false); // cycle timer fired but modal display was deferred (a manual quiz was open)
  const pausedRemainingMsRef = useRef(null); // time left when paused, so resuming restores the same deadline offset instead of resetting it
  const [pomodoroSettings, setPomodoroSettings] = useState(null); // { cycleMinutes, breakMinutes }, loaded once from the backend
  const [cycleSecondsLeft, setCycleSecondsLeft] = useState(25 * 60); // placeholder until the first cycle actually starts
  const [pomodoroModalOpen, setPomodoroModalOpen] = useState(false);
  const [cyclePaused, setCyclePaused] = useState(false);

  useEffect(() => {
    getPomodoroSettings().then(setPomodoroSettings);
  }, []);

  const applyTheme = useCallback((rendition, t, size) => {
    const th = THEMES[t];
    rendition.themes.register('current', {
      'html': {
        'background-color': `${th.bodyBg} !important`,
        'translate': 'no',
      },
      'body': {
        'background-color': `${th.bodyBg} !important`,
        color: `${th.bodyColor} !important`,
        'font-family': '"Libre Baskerville", Georgia, serif !important',
        'font-size': `${size}px !important`,
        'line-height': '1.85 !important',
        'padding': '0 2em !important',
        'margin': '0 !important',
      },
      'p': {
        color: `${th.bodyColor} !important`,
        'font-family': '"Libre Baskerville", Georgia, serif !important',
      },
      'h1, h2, h3, h4, h5, h6': {
        color: `${th.bodyColor} !important`,
      },
      'a': {
        color: `${t === 'night' ? '#c8a96e' : '#8B5E3C'} !important`,
      },
    });
    rendition.themes.select('current');
  }, []);

  // `fraction` (0-1) truncates the returned text to that proportion of the
  // chapter's elements — epubjs's paginated flow loads the WHOLE section into
  // the iframe and paginates it purely via CSS columns, so without this the
  // full chapter (including content far past what's been read) is always
  // present in the DOM from the moment the chapter loads. Element-count
  // truncation (not exact) rather than a DOM Range/CFI cut: cheap, can't
  // throw, and precise enough — CFI range math is already documented
  // elsewhere in this file as fragile after in-place DOM translation.
  const capturePageText = useCallback((fraction = 1) => {
    try {
      const iframe = viewerRef.current?.querySelector('iframe');
      const doc = iframe?.contentDocument;
      if (!doc?.body) return '';
      const elements = Array.from(
        doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre')
      );
      const cutoff = fraction >= 1 ? elements.length : Math.ceil(elements.length * Math.max(0, fraction));
      return elements
        .slice(0, cutoff)
        .map(el => {
          const text = el.textContent.trim();
          if (el.tagName === 'PRE') return `\n\`\`\`\n${text}\n\`\`\``;
          const prefix = HEADING_PREFIX[el.tagName];
          return prefix ? `\n${prefix}${text}` : text;
        })
        .filter(t => t.length > 2)
        .join('\n');
    } catch {
      return '';
    }
  }, []);

  const getPageText = useCallback(() => pageTextRef.current, []);

  const refreshQuizProgress = useCallback(() => {
    getAllQuizProgress(id).then(setQuizProgressMap).catch(() => {});
  }, [id]);

  // Reset per-book chapter-transition tracking and (re)load quiz progress
  // whenever the book id changes.
  useEffect(() => {
    prevChapterRef.current = null;
    nudgedChaptersRef.current = new Set();
    setChapterNudge(null);
    refreshQuizProgress();
  }, [id, refreshQuizProgress]);

  const openQuiz = useCallback((mode, target) => {
    setQuizTarget(target);
    setActiveQuizMode(mode);
    setShowQuizPicker(false);
    setChapterNudge(null);
  }, []);

  useEffect(() => { activeQuizModeRef.current = activeQuizMode; }, [activeQuizMode]);

  // Fires when the wall-clock deadline is reached. A manual pause clears the
  // timer entirely (see pauseCycle below) so this never fires while paused.
  // If a manual quiz happens to be open right now, only the modal's *display*
  // is deferred (see the effect below) so the two full-screen overlays never
  // stack.
  const onCycleComplete = useCallback(() => {
    const { href, label } = currentChapterRef.current;
    if (href) {
      cycleChaptersRef.current.set(href, { label, text: pageTextRef.current, ...chapterLocRangeRef.current.get(href) });
    }
    cycleDueRef.current = true;
    if (!activeQuizModeRef.current) {
      setShowChat(false);
      setPomodoroModalOpen(true);
    }
  }, []);

  // Deadline-based (recomputed from Date.now() each tick), not a decrementing
  // tick counter — stays correct after a backgrounded/throttled tab or sleep,
  // where a naive counter would drift or fire a burst of stale ticks on wake.
  const runCycleTimer = useCallback(() => {
    clearInterval(cycleTimerRef.current);
    cycleTimerRef.current = setInterval(() => {
      const remaining = cycleEndAtRef.current - Date.now();
      if (remaining <= 0) {
        clearInterval(cycleTimerRef.current);
        onCycleComplete();
      } else {
        setCycleSecondsLeft(Math.ceil(remaining / 1000));
      }
    }, 1000);
  }, [onCycleComplete]);

  const startCycle = useCallback(() => {
    const cycleMinutes = pomodoroSettings?.cycleMinutes ?? 25;
    cycleChaptersRef.current = new Map();
    chapterLocRangeRef.current = new Map();
    cycleDueRef.current = false;
    pausedRemainingMsRef.current = null;
    setCyclePaused(false);
    cycleEndAtRef.current = Date.now() + cycleMinutes * 60_000;
    setCycleSecondsLeft(cycleMinutes * 60);
    runCycleTimer();
  }, [runCycleTimer, pomodoroSettings]);

  const pauseCycle = useCallback(() => {
    if (cyclePaused) return;
    pausedRemainingMsRef.current = Math.max(0, cycleEndAtRef.current - Date.now());
    clearInterval(cycleTimerRef.current);
    setCyclePaused(true);
  }, [cyclePaused]);

  const resumeCycle = useCallback(() => {
    if (!cyclePaused) return;
    cycleEndAtRef.current = Date.now() + (pausedRemainingMsRef.current ?? 0);
    runCycleTimer();
    setCyclePaused(false);
  }, [cyclePaused, runCycleTimer]);

  // Opens the deferred modal once the manual quiz that was blocking it closes.
  useEffect(() => {
    if (cycleDueRef.current && !activeQuizMode && !pomodoroModalOpen) {
      cycleDueRef.current = false;
      setShowChat(false);
      setPomodoroModalOpen(true);
    }
  }, [activeQuizMode, pomodoroModalOpen]);

  // Starts the first cycle once the book is ready and the user's cycle-length
  // setting has loaded. Only runs once (startCycle has a stable identity while
  // pomodoroSettings is unchanged) — restarting subsequent cycles is driven by
  // PomodoroModal's onCycleFinished calling startCycle() directly, not by this effect.
  useEffect(() => {
    if (!isLearningMode || !ready || !pomodoroSettings) return;
    startCycle();
    return () => clearInterval(cycleTimerRef.current);
  }, [isLearningMode, ready, pomodoroSettings, startCycle]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const bookData = await getBook(id);
      if (cancelled) return;
      if (!bookData) { setNotFound(true); return; }

      const book = Epub(bookData.data.slice(0));
      bookRef.current = book;

      await book.ready;
      if (cancelled) { book.destroy(); return; }

      const meta = await book.loaded.metadata;
      if (!cancelled) setMetadata(meta);

      const nav = await book.loaded.navigation;
      if (!cancelled) setToc(flattenToc(nav.toc));

      const rendition = book.renderTo(viewerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
        allowScriptedContent: false,
      });
      renditionRef.current = rendition;

      applyTheme(rendition, 'night', 18);

      // Helper: attach all event handlers to a rendition instance.
      // Called on the initial rendition and again if we have to rebuild it
      // after a CFI queue crash.
      const attachHandlers = (r) => {
        locationsReadyRef.current = false;
        r.on('relocated', (loc) => {
          if (cancelled || !locationsReadyRef.current) return;
          const cfi = loc.start.cfi;
          let pct = 0;
          let locNum = null;
          if (book.locations.length()) {
            try { pct = Math.round(book.locations.percentageFromCfi(cfi) * 100); }
            catch { /* CFI out of bounds after DOM translation */ }
            if (book.locations.total) {
              try {
                locNum = book.locations.locationFromCfi(cfi);
                setLocDebug(`${locNum ?? '?'} / ${book.locations.total}`);
              } catch { /* ignore */ }
            }
          }
          setProgress(pct);
          saveProgress(id, cfi, pct);
          // loc.start.href is the reliable section href epubjs already
          // resolved for this location — CFIs are spine-index/manifest-id
          // based and never contain the filename, so matching against them
          // (as done previously) only worked by coincidence.
          const newHref = loc.start.href || '';
          const match = flattenToc(nav.toc).find(
            (item) => item.href && item.href.split('#')[0] === newHref
          );
          const newLabel = match?.label?.trim() || '';

          // Tracks the min/max epubjs location number seen in each chapter
          // during the active cycle, so the Pomodoro modal can show a "page
          // X–Y" range alongside the chapter name (see cycleChaptersRef below).
          // Min/max (not first/last) because a relocate can fire out of order
          // (backward navigation within the chapter, or a reflow-triggered
          // rerender) — using "last seen" for endLoc let the range shrink.
          if (isLearningMode && newHref && locNum != null) {
            const prevRange = chapterLocRangeRef.current.get(newHref);
            const range = prevRange
              ? { startLoc: Math.min(prevRange.startLoc, locNum), endLoc: Math.max(prevRange.endLoc, locNum) }
              : { startLoc: locNum, endLoc: locNum };
            chapterLocRangeRef.current.set(newHref, range);
          }

          // Chapter transition detected: pageTextRef still holds the text of
          // the chapter we're leaving (the RAF below hasn't overwritten it
          // yet) — snapshot it now so the end-of-chapter nudge (free reading)
          // or the pomodoro cycle accumulator (learning mode) can use the
          // right content even after the iframe has moved on. The two are
          // mutually exclusive: the nudge would be redundant with — and
          // frequently collide with — the pomodoro end-of-cycle exercises.
          if (newHref && prevChapterRef.current?.href && prevChapterRef.current.href !== newHref) {
            const leftHref = prevChapterRef.current.href;
            if (isLearningMode) {
              cycleChaptersRef.current.set(leftHref, {
                label: prevChapterRef.current.label,
                text: pageTextRef.current,
                ...chapterLocRangeRef.current.get(leftHref),
              });
            } else if (!nudgedChaptersRef.current.has(leftHref)) {
              nudgedChaptersRef.current.add(leftHref);
              setChapterNudge({
                href: leftHref,
                label: prevChapterRef.current.label,
                pageText: pageTextRef.current,
              });
              clearTimeout(nudgeTimerRef.current);
              nudgeTimerRef.current = setTimeout(() => setChapterNudge(null), 9000);
            }
          }
          if (newHref) prevChapterRef.current = { href: newHref, label: newLabel };

          currentChapterRef.current = { href: newHref, label: newLabel };
          setCurrentChapter(newLabel);
          setCurrentChapterHref(newHref);
          // Only capture up through the page currently displayed — not the
          // whole chapter — so AI features never see content further ahead
          // than what's actually been read (see capturePageText above).
          const displayed = loc.end?.displayed;
          const readFraction = displayed?.total ? displayed.page / displayed.total : 1;
          requestAnimationFrame(() => { if (!cancelled) pageTextRef.current = capturePageText(readFraction); });
          setPageChangeSignal(n => n + 1);
        });
        r.on('keyup', (e) => {
          if (e.key === 'ArrowRight') renditionRef.current?.next();
          if (e.key === 'ArrowLeft') renditionRef.current?.prev();
        });
      };

      // Wire up event handlers BEFORE any display() call so no events are missed.
      attachHandlers(rendition);

      if (cancelled) { book.destroy(); return; }
      const saved = await getProgress(id);

      // A corrupted CFI (e.g. "offset 85 doesn't exist") causes epubjs to throw
      // IndexSizeError SYNCHRONOUSLY inside its render-queue processor. epubjs
      // doesn't wrap the call in try/catch, so the queue dies and every subsequent
      // display() hangs → black screen.
      //
      // Strategy: listen for that synchronous error via window.onerror. If it fires
      // (or the Promise times out), rebuild the rendition with a fresh queue and
      // start from page 1. For the common case of a valid CFI, nothing changes.
      let cfiCrashed = false;
      const onQueueError = (evt) => {
        if (evt.error?.name === 'IndexSizeError' || evt.message?.includes('IndexSizeError')) {
          cfiCrashed = true;
          evt.preventDefault(); // suppress "Uncaught" in console
        }
      };
      window.addEventListener('error', onQueueError);
      try {
        await Promise.race([
          rendition.display(saved || undefined),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cfi-timeout')), 5000)),
        ]);
      } catch { cfiCrashed = true; }
      window.removeEventListener('error', onQueueError);

      if (cfiCrashed && !cancelled) {
        // The queue is dead. Wipe the corrupt progress, clear the DOM, rebuild.
        clearProgress(id).catch(() => {});
        viewerRef.current.innerHTML = '';
        const r2 = book.renderTo(viewerRef.current, {
          width: '100%', height: '100%',
          spread: 'none', flow: 'paginated',
          allowScriptedContent: false,
        });
        renditionRef.current = r2;
        applyTheme(r2, 'night', 18);
        attachHandlers(r2);
        await r2.display(undefined);
      }

      if (!cancelled) setReady(true);

      await book.locations.generate(1600);

      // After the location index is ready, recompute the percentage and update
      // the progress bar + saved record — but do NOT call display() again.
      // The first display() above already placed the user on the correct page;
      // a second display() would cause a visible 2-3 second page jump.
      if (!cancelled && renditionRef.current && book.locations.length()) {
        let pct = 0;
        if (!cfiCrashed && saved) {
          // Recompute percentage from the original saved CFI — this is the position
          // that was actually displayed in phase 1, so it stays authoritative.
          try { pct = Math.round(book.locations.percentageFromCfi(saved) * 100); }
          catch { /* CFI out of bounds — leave pct at 0 */ }
          setProgress(pct);
          saveProgress(id, saved, pct);
        } else {
          // New book (no saved position) or crash recovery: read the current page.
          const loc = renditionRef.current.currentLocation();
          if (loc?.start?.cfi) {
            try { pct = Math.round(book.locations.percentageFromCfi(loc.start.cfi) * 100); }
            catch { /* ignore */ }
            setProgress(pct);
            saveProgress(id, loc.start.cfi, pct);
          }
        }
      }
      locationsReadyRef.current = true;
    }

    init().catch(() => { if (!cancelled) setNotFound(true); });

    return () => {
      cancelled = true;
      flushProgress();
      renditionRef.current = null;
      if (bookRef.current) {
        bookRef.current.destroy();
        bookRef.current = null;
      }
    };
  }, [id, applyTheme]);

  const toggleFullscreen = useCallback(() => {
    // Save position before the viewport changes so we can restore it after
    preFullscreenCfiRef.current = renditionRef.current?.currentLocation()?.start?.cfi ?? null;
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
      // Wait for the browser to settle its new layout, then resize + restore position
      setTimeout(() => {
        if (!renditionRef.current) return;
        renditionRef.current.resize('100%', '100%');
        if (preFullscreenCfiRef.current) {
          renditionRef.current.display(preFullscreenCfiRef.current);
        }
      }, 100);
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Flush pending progress save when user hides/closes the tab
  useEffect(() => {
    const handler = () => { if (document.visibilityState === 'hidden') flushProgress(); };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') renditionRef.current?.next();
      if (e.key === 'ArrowLeft') renditionRef.current?.prev();
      if (e.key === 'Escape') {
        setShowToc(false);
        setShowSettings(false);
        setShowChat(false);
        setShowQuizPicker(false);
      }
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keyup', handler);
    return () => window.removeEventListener('keyup', handler);
  }, [toggleFullscreen]);

  // Resize epubjs when chat panel opens/closes, triggered by transitionend for correct timing
  useEffect(() => {
    const el = viewerWrapperRef.current;
    if (!el) return;
    const doResize = () => renditionRef.current?.resize('100%', '100%');
    el.addEventListener('transitionend', doResize, { once: true });
    const fallback = setTimeout(doResize, 500);
    return () => {
      el.removeEventListener('transitionend', doResize);
      clearTimeout(fallback);
    };
  }, [showChat]);

  // Auto-hide chrome on inactivity
  const resetHideTimer = useCallback(() => {
    setShowChrome(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!showToc && !showSettings && !showChat && !showQuizPicker) setShowChrome(false);
    }, 3500);
  }, [showToc, showSettings, showChat, showQuizPicker]);

  useEffect(() => {
    resetHideTimer();
    return () => clearTimeout(hideTimer.current);
  }, [resetHideTimer]);

  const changeTheme = (t) => {
    setTheme(t);
    if (renditionRef.current) applyTheme(renditionRef.current, t, fontSize);
  };

  const changeFontSize = (delta) => {
    const next = Math.min(26, Math.max(13, fontSize + delta));
    setFontSize(next);
    if (renditionRef.current) applyTheme(renditionRef.current, theme, next);
  };

  const goToChapter = (href) => {
    renditionRef.current?.display(href);
    setShowToc(false);
  };

  if (notFound) {
    return (
      <div className={styles.error}>
        <p className={styles.errorMsg}>Book not found.</p>
        <button className={styles.backLink} onClick={() => navigate('/')}>
          ← Back to library
        </button>
      </div>
    );
  }

  const th = THEMES[theme];
  const hasQuizProgress = (href) => {
    const entry = quizProgressMap[href];
    return !!(entry && (entry.exercise?.completed || entry.interview?.completed));
  };
  const completedChapterCount = toc.filter(item => hasQuizProgress(item.href)).length;

  return (
    <div
      className={styles.reader}
      style={{ background: th.bg, color: th.text }}
      onMouseMove={resetHideTimer}
      onClick={() => {
        resetHideTimer();
        setShowToc(false);
        setShowSettings(false);
        setShowChat(false);
        setShowQuizPicker(false);
      }}
    >
      {/* Progress bar */}
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Top chrome */}
      <header
        className={`${styles.topBar} ${showChrome ? styles.visible : ''}`}
        style={{ background: th.bg + 'ee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className={styles.backBtn} onClick={() => navigate('/')} style={{ color: th.text }}>
          <span className={styles.backArrow}>←</span>
          <span className={styles.backLabel}>Library</span>
        </button>
        <div className={styles.topTitle} style={{ color: th.text }}>
          {metadata?.title}
        </div>
        {isLearningMode && !pomodoroModalOpen && (
          <span className={styles.pomodoroPill} style={{ color: th.text, borderColor: `${th.text}30` }} title={cyclePaused ? 'Session Pomodoro en pause' : 'Session Pomodoro en cours'}>
            <button
              className={styles.pomodoroPauseBtn}
              onClick={(e) => { e.stopPropagation(); cyclePaused ? resumeCycle() : pauseCycle(); }}
              title={cyclePaused ? 'Reprendre' : 'Mettre en pause'}
              style={{ color: th.text }}
            >
              {cyclePaused ? '▶' : '❚❚'}
            </button>
            Pomodoro · {formatClock(cycleSecondsLeft)}{cyclePaused ? ' · pause' : ''}
          </span>
        )}
        <div className={styles.topActions}>
          <button
            className={`${styles.iconBtn} ${showChat ? styles.active : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowChat(v => !v); }}
            title="Reading assistant"
            style={{ color: th.text }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 2h12a1 1 0 011 1v7a1 1 0 01-1 1H9l-3 3v-3H2a1 1 0 01-1-1V3a1 1 0 011-1z"
                    stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className={`${styles.iconBtn} ${showQuizPicker ? styles.active : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowQuizPicker(v => !v); setShowSettings(false); setShowToc(false); }}
            disabled={!currentChapterHref}
            title={currentChapterHref ? 'Quiz' : 'Quiz (chapitre en cours de détection…)'}
            style={{ color: th.text }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 8.3l2 2 4-4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className={`${styles.iconBtn} ${isFullscreen ? styles.active : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
            title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            style={{ color: th.text }}
          >
            {isFullscreen ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M1 5H5V1M15 5H11V1M1 11H5V15M15 11H11V15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 1H1V4M12 1H15V4M4 15H1V12M12 15H15V12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <button
            className={`${styles.iconBtn} ${showSettings ? styles.active : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowSettings(v => !v); setShowToc(false); setShowQuizPicker(false); }}
            title="Settings"
            style={{ color: th.text }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M11.54 4.46l-1.41 1.41M4.95 11.54l-1.41 1.41" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`${styles.iconBtn} ${showToc ? styles.active : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowToc(v => !v); setShowSettings(false); setShowQuizPicker(false); }}
            title="Table of contents"
            style={{ color: th.text }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="2" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <UserMenu user={user} onSignOut={signOut} />
        </div>
      </header>

      {/* Quiz picker popover */}
      {showQuizPicker && (
        <div
          className={styles.quizPicker}
          style={{ background: th.bg + 'f5', borderColor: `${th.text}25` }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className={styles.quizPickerChapter} style={{ color: th.text }}>
            {currentChapter || 'Chapitre'}
          </p>
          {['exercise', 'interview'].map((m) => {
            const entry = quizProgressMap[currentChapterHref]?.[m];
            return (
              <button
                key={m}
                className={styles.quizPickerRow}
                style={{ color: th.text }}
                onClick={() => openQuiz(m, { href: currentChapterHref, label: currentChapter, pageText: pageTextRef.current })}
              >
                <span>{m === 'exercise' ? 'Exercices' : 'Entretien'}</span>
                {entry?.attempts > 0 && (
                  <span className={styles.quizPickerScore}>{entry.bestScore}/{entry.total}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* End-of-chapter quiz nudge — deliberately not theme-colored (th.*),
          see .chapterNudge comment in Reader.module.css. Never set while in
          learning mode (see relocated handler above), guarded here too. */}
      {!isLearningMode && chapterNudge && (
        <div className={styles.chapterNudge} onClick={(e) => e.stopPropagation()}>
          <span className={styles.chapterNudgeText}>
            Chapitre terminé — tester tes connaissances sur « {chapterNudge.label || 'ce chapitre'} » ?
          </span>
          <div className={styles.chapterNudgeActions}>
            <button className={styles.chapterNudgeBtn} onClick={() => openQuiz('exercise', chapterNudge)}>
              Exercices
            </button>
            <button className={styles.chapterNudgeBtn} onClick={() => openQuiz('interview', chapterNudge)}>
              Entretien
            </button>
            <button className={styles.chapterNudgeClose} onClick={() => setChapterNudge(null)}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Viewer */}
      <div ref={viewerWrapperRef} className={styles.viewerWrapper} style={showChat ? { paddingBottom: '50vh' } : undefined}>
        <button
          className={`${styles.navArrow} ${styles.navPrev} ${showChrome ? styles.visible : ''}`}
          onClick={(e) => { e.stopPropagation(); renditionRef.current?.prev(); }}
          style={{ color: th.text }}
          aria-label="Previous page"
        >
          ‹
        </button>

        <div ref={viewerRef} className={styles.viewer} translate="no" style={{ pointerEvents: showChat ? 'none' : 'auto' }} />

        <button
          className={`${styles.navArrow} ${styles.navNext} ${showChrome ? styles.visible : ''}`}
          onClick={(e) => { e.stopPropagation(); renditionRef.current?.next(); }}
          style={{ color: th.text }}
          aria-label="Next page"
        >
          ›
        </button>

        {/* Mobile tap zones — always present, invisible */}
        {!showChat && (
          <div className={styles.tapZones} aria-hidden="true">
            <div
              className={styles.tapZoneLeft}
              onClick={(e) => { e.stopPropagation(); renditionRef.current?.prev(); }}
            />
            <div
              className={styles.tapZoneCenter}
              onClick={(e) => {
                e.stopPropagation();
                if (showChrome) {
                  clearTimeout(hideTimer.current);
                  setShowChrome(false);
                } else {
                  resetHideTimer();
                }
              }}
            />
            <div
              className={styles.tapZoneRight}
              onClick={(e) => { e.stopPropagation(); renditionRef.current?.next(); }}
            />
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <footer
        className={`${styles.bottomBar} ${showChrome ? styles.visible : ''}`}
        style={{ background: th.bg + 'ee', borderTopColor: `${th.text}15` }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className={styles.chapterLabel} style={{ color: th.text + '80' }}>
          {currentChapter}
        </span>
        {locDebug && (
          <span className={styles.locDebug} style={{ color: th.text + '40' }}>
            loc {locDebug}
          </span>
        )}
        <span className={styles.progressLabel} style={{ color: th.text + '60' }}>
          {progress}%
        </span>
      </footer>

      {/* TOC Sidebar */}
      <aside
        className={`${styles.sidebar} ${showToc ? styles.sidebarOpen : ''}`}
        style={{ background: th.bg, borderRightColor: `${th.text}18` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.sidebarHeader} style={{ borderBottomColor: `${th.text}15` }}>
          <span className={styles.sidebarTitle} style={{ color: th.text }}>
            Table of Contents
          </span>
          <button className={styles.sidebarClose} onClick={() => setShowToc(false)} style={{ color: th.text }}>
            ✕
          </button>
        </div>
        {toc.length > 0 && (
          <p className={styles.quizProgressSummary} style={{ color: th.text }}>
            Progression quiz : {completedChapterCount}/{toc.length} chapitres
          </p>
        )}
        <nav className={styles.tocList}>
          {toc.map((item, i) => (
            <button
              key={i}
              className={styles.tocItem}
              style={{
                paddingLeft: `${1.25 + item.depth * 1}rem`,
                color: th.text + (item.depth > 0 ? '80' : 'cc'),
                borderLeftColor: item.depth === 0 ? '#c8a96e40' : 'transparent',
              }}
              onClick={() => goToChapter(item.href)}
            >
              <span>{item.label}</span>
              {hasQuizProgress(item.href) && (
                <span className={styles.tocItemBadge} title="Quiz complété">✓</span>
              )}
            </button>
          ))}
        </nav>
      </aside>

      {/* Settings Panel */}
      <aside
        className={`${styles.settings} ${showSettings ? styles.settingsOpen : ''}`}
        style={{ background: th.bg, borderLeftColor: `${th.text}18` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.sidebarHeader} style={{ borderBottomColor: `${th.text}15` }}>
          <span className={styles.sidebarTitle} style={{ color: th.text }}>
            Display
          </span>
          <button className={styles.sidebarClose} onClick={() => setShowSettings(false)} style={{ color: th.text }}>
            ✕
          </button>
        </div>

        <div className={styles.settingsBody}>
          {/* Themes */}
          <div className={styles.settingsGroup}>
            <p className={styles.settingsLabel} style={{ color: th.text + '60' }}>Theme</p>
            <div className={styles.themeRow}>
              {Object.entries(THEMES).map(([key, val]) => (
                <button
                  key={key}
                  className={`${styles.themeBtn} ${theme === key ? styles.themeBtnActive : ''}`}
                  onClick={() => changeTheme(key)}
                  style={{
                    background: val.bg,
                    color: val.text,
                    borderColor: theme === key ? '#c8a96e' : `${th.text}20`,
                  }}
                >
                  {val.label}
                </button>
              ))}
            </div>
          </div>

          {/* Font size */}
          <div className={styles.settingsGroup}>
            <p className={styles.settingsLabel} style={{ color: th.text + '60' }}>Font size</p>
            <div className={styles.fontSizeRow}>
              <button
                className={styles.fontSizeBtn}
                onClick={() => changeFontSize(-1)}
                disabled={fontSize <= 13}
                style={{ color: th.text, borderColor: `${th.text}20` }}
              >
                A−
              </button>
              <span className={styles.fontSizeVal} style={{ color: th.text }}>
                {fontSize}px
              </span>
              <button
                className={styles.fontSizeBtn}
                onClick={() => changeFontSize(1)}
                disabled={fontSize >= 26}
                style={{ color: th.text, borderColor: `${th.text}20` }}
              >
                A+
              </button>
            </div>
          </div>

          {/* Progress */}
          <div className={styles.settingsGroup}>
            <p className={styles.settingsLabel} style={{ color: th.text + '60' }}>Progress</p>
            <p className={styles.progressBig} style={{ color: th.text }}>
              {progress}<span style={{ fontSize: '0.7em', opacity: 0.5 }}>%</span>
            </p>
          </div>

          {/* Restart */}
          <div className={styles.settingsGroup}>
            <button
              className={styles.restartBtn}
              style={{ color: th.text, borderColor: `${th.text}20` }}
              onClick={async () => {
                await clearProgress(id);
                renditionRef.current?.display(undefined);
                setShowSettings(false);
              }}
            >
              Restart from beginning
            </button>
          </div>
        </div>
      </aside>

      {/* Chat drawer */}
      <ChatPanel
        isOpen={showChat}
        onClose={() => setShowChat(false)}
        themeColors={th}
        bookTitle={metadata?.title || ''}
        bookAuthor={metadata?.creator || ''}
        chapterName={currentChapter}
        getPageText={getPageText}
        pageChangeSignal={pageChangeSignal}
      />

      {/* Quiz overlay */}
      {activeQuizMode && quizTarget && (
        <QuizModal
          mode={activeQuizMode}
          bookId={id}
          chapterHref={quizTarget.href}
          chapterName={quizTarget.label}
          bookTitle={metadata?.title || ''}
          bookAuthor={metadata?.creator || ''}
          pageText={quizTarget.pageText}
          onClose={() => {
            setActiveQuizMode(null);
            setQuizTarget(null);
            refreshQuizProgress();
          }}
        />
      )}

      {/* Pomodoro end-of-cycle overlay */}
      {isLearningMode && pomodoroModalOpen && (
        <PomodoroModal
          bookId={id}
          bookTitle={metadata?.title || ''}
          bookAuthor={metadata?.creator || ''}
          cycleMinutes={pomodoroSettings?.cycleMinutes ?? 25}
          breakMinutes={pomodoroSettings?.breakMinutes ?? 5}
          chapters={Array.from(cycleChaptersRef.current.values())}
          totalLocations={bookRef.current?.locations?.total}
          onCycleFinished={() => {
            setPomodoroModalOpen(false);
            startCycle();
          }}
        />
      )}

      {/* Loading overlay */}
      {!ready && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner} />
          <p className={styles.loadingText}>Opening book…</p>
        </div>
      )}
    </div>
  );
}
