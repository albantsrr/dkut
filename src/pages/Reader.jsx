import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Epub from 'epubjs';
import { getBook } from '../utils/storage.js';
import { getProgress, saveProgress, clearProgress, flushProgress } from '../lib/progress.js';
import styles from './Reader.module.css';
import ChatPanel from '../components/ChatPanel.jsx';

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

const LANGUAGES = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'zh-TW', label: '中文 (繁體)' },
  { code: 'ko', label: '한국어' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ar', label: 'العربية' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'sv', label: 'Svenska' },
  { code: 'da', label: 'Dansk' },
  { code: 'fi', label: 'Suomi' },
];

// Module-level cache persists across book navigation
const _translationCache = new Map();

async function fetchTranslation(text, lang) {
  const key = `${lang}\0${text}`;
  if (_translationCache.has(key)) return _translationCache.get(key);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const result = data[0].map(c => c[0]).join('');
  _translationCache.set(key, result);
  return result;
}

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
  const [theme, setTheme] = useState('night');
  const [fontSize, setFontSize] = useState(18);
  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChrome, setShowChrome] = useState(true);
  const [targetLang, setTargetLang] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [pageChangeSignal, setPageChangeSignal] = useState(0);
  const hideTimer = useRef(null);
  const targetLangRef = useRef('');
  const pageTextRef = useRef('');
  const locationsReadyRef = useRef(false);

  const applyTheme = useCallback((rendition, t, size) => {
    const th = THEMES[t];
    rendition.themes.register('current', {
      'html': {
        'background-color': `${th.bodyBg} !important`,
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

  const capturePageText = useCallback(() => {
    try {
      const iframe = viewerRef.current?.querySelector('iframe');
      const doc = iframe?.contentDocument;
      if (!doc?.body) return '';
      return Array.from(
        doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote')
      )
        .map(el => el.textContent.trim())
        .filter(t => t.length > 2)
        .join('\n');
    } catch {
      return '';
    }
  }, []);

  const getPageText = useCallback(() => pageTextRef.current, []);

  const translatePage = useCallback(async (lang) => {
    const iframe = viewerRef.current?.querySelector('iframe');
    const doc = iframe?.contentDocument;
    if (!doc?.body) return;
    setIsTranslating(true);
    try {
      const els = Array.from(
        doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th')
      );
      await Promise.all(
        els.map(async (el) => {
          const text = el.textContent.trim();
          if (text.length < 3) return;
          try {
            el.textContent = await fetchTranslation(text, lang);
          } catch {
            // Keep original text on network/API error
          }
        })
      );
    } finally {
      setIsTranslating(false);
    }
  }, []);

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

      if (cancelled) { book.destroy(); return; }
      const saved = await getProgress(id);
      await rendition.display(saved || undefined);
      // Don't show the viewer yet — generate() will scramble the position

      rendition.on('rendered', () => {
        if (cancelled || !targetLangRef.current) return;
        translatePage(targetLangRef.current);
      });

      locationsReadyRef.current = false;
      rendition.on('relocated', (loc) => {
        if (cancelled || !locationsReadyRef.current) return;
        const cfi = loc.start.cfi;
        let pct = 0;
        if (book.locations.length()) {
          pct = Math.round(book.locations.percentageFromCfi(cfi) * 100);
          setProgress(pct);
        }
        saveProgress(id, cfi, pct);

        const match = flattenToc(nav.toc).find(
          (item) => item.href && cfi.includes(item.href.split('#')[0])
        );
        setCurrentChapter(match?.label?.trim() || '');
        requestAnimationFrame(() => {
          if (!cancelled) pageTextRef.current = capturePageText();
        });
        setPageChangeSignal(n => n + 1);
      });

      rendition.on('keyup', (e) => {
        if (e.key === 'ArrowRight') renditionRef.current?.next();
        if (e.key === 'ArrowLeft') renditionRef.current?.prev();
      });

      await book.locations.generate(1600);

      if (!cancelled && renditionRef.current) {
        await renditionRef.current.display(saved || undefined);
        const loc = renditionRef.current.currentLocation();
        if (loc?.start?.cfi && book.locations.length()) {
          const pct = Math.round(book.locations.percentageFromCfi(loc.start.cfi) * 100);
          setProgress(pct);
          saveProgress(id, loc.start.cfi, pct);
        }
      }
      locationsReadyRef.current = true;
      if (!cancelled) setReady(true);
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
  }, [id, applyTheme, translatePage]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
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
      if (!showToc && !showSettings && !showChat) setShowChrome(false);
    }, 3500);
  }, [showToc, showSettings, showChat]);

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

  const handleLangChange = useCallback((lang) => {
    targetLangRef.current = lang;
    setTargetLang(lang);
    if (!renditionRef.current) return;
    // Re-render current page to get original content, then translated via 'rendered' event
    getProgress(id).then((saved) => {
      renditionRef.current?.display(saved || undefined);
    });
  }, [id]);

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
      }}
    >
      {/* Progress bar */}
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Translation activity indicator */}
      {isTranslating && (
        <div className={styles.translatingBar} />
      )}

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
            onClick={(e) => { e.stopPropagation(); setShowSettings(v => !v); setShowToc(false); }}
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
            onClick={(e) => { e.stopPropagation(); setShowToc(v => !v); setShowSettings(false); }}
            title="Table of contents"
            style={{ color: th.text }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="2" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

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

        <div ref={viewerRef} className={styles.viewer} style={{ pointerEvents: showChat ? 'none' : 'auto' }} />

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
              {item.label}
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

          {/* Translation */}
          <div className={styles.settingsGroup}>
            <p className={styles.settingsLabel} style={{ color: th.text + '60' }}>
              Translation
              {isTranslating && <span className={styles.translatingDot} aria-hidden="true">●</span>}
            </p>
            <select
              className={styles.langSelect}
              value={targetLang}
              onChange={(e) => handleLangChange(e.target.value)}
              style={{ color: th.text, background: th.bg, borderColor: `${th.text}25` }}
            >
              <option value="">Off</option>
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
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
