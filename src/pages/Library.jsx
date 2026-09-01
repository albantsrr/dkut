import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Epub from 'epubjs';
import { getAllBooks, saveBook, deleteBook } from '../utils/storage.js';
import { getAllProgress, clearProgress } from '../lib/progress.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import TranslateBookModal from '../components/TranslateBookModal.jsx';
import ReadingModeModal from '../components/ReadingModeModal.jsx';
import UserMenu from '../components/UserMenu.jsx';
import styles from './Library.module.css';

const SPINE_COLORS = [
  { bg: '#5C2A1A', text: '#f0c090' },
  { bg: '#1A2E4A', text: '#90b8e8' },
  { bg: '#2A1A4A', text: '#b090e8' },
  { bg: '#1A3A2A', text: '#90d4a8' },
  { bg: '#4A2A1A', text: '#e8b890' },
  { bg: '#1A3A3A', text: '#90d4d4' },
  { bg: '#3A2A1A', text: '#d4b890' },
  { bg: '#3A1A2A', text: '#d490b8' },
];

function spineColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return SPINE_COLORS[Math.abs(h) % SPINE_COLORS.length];
}

async function extractMeta(arrayBuffer) {
  return new Promise((resolve) => {
    const book = Epub(arrayBuffer.slice(0));
    book.ready.then(async () => {
      const meta = await book.loaded.metadata;
      let cover = null;
      try {
        const coverUrl = await book.coverUrl();
        if (coverUrl) {
          const resp = await fetch(coverUrl);
          const blob = await resp.blob();
          cover = await new Promise((res) => {
            const fr = new FileReader();
            fr.onloadend = () => res(fr.result);
            fr.readAsDataURL(blob);
          });
        }
      } catch { /* no cover */ }
      book.destroy();
      resolve({
        title: meta.title || 'Untitled',
        author: meta.creator || 'Unknown author',
        cover,
      });
    }).catch(() => {
      book.destroy();
      resolve({ title: 'Untitled', author: 'Unknown author', cover: null });
    });
  });
}

export default function Library() {
  const [books, setBooks] = useState([]);
  const [progressMap, setProgressMap] = useState({});
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [translatingBook, setTranslatingBook] = useState(null);
  const [choosingBook, setChoosingBook] = useState(null);
  const fileInputRef = useRef(null);
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  useEffect(() => {
    setInitialLoading(true);
    Promise.all([getAllBooks(), getAllProgress().catch(() => ({}))])
      .then(([b, p]) => { setBooks(b); setProgressMap(p); })
      .catch((err) => {
        setFetchError(err.message ?? 'Failed to load books.');
      })
      .finally(() => setInitialLoading(false));
  }, []);

  const processFiles = useCallback(async (files) => {
    const epubs = Array.from(files).filter(f => f.name.endsWith('.epub'));
    if (!epubs.length) return;
    setLoading(true);

    for (const file of epubs) {
      setLoadingMsg(`Adding "${file.name.replace('.epub', '')}"…`);
      const arrayBuffer = await file.arrayBuffer();
      const meta = await extractMeta(arrayBuffer);
      await saveBook({ ...meta, data: arrayBuffer, addedAt: Date.now() });
    }

    setLoading(false);
    setLoadingMsg('');
    Promise.all([getAllBooks(), getAllProgress().catch(() => ({}))])
      .then(([b, p]) => { setBooks(b); setProgressMap(p); });
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const onDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (confirmDelete === id) {
      const removedBook = books.find(b => b.id === id);
      setBooks(prev => prev.filter(b => b.id !== id));
      setProgressMap(prev => { const next = { ...prev }; delete next[id]; return next; });
      setConfirmDelete(null);
      try {
        await deleteBook(id);
      } catch (err) {
        // Deletion actually failed (not just "already gone") — the Drive file
        // is still there, so restore the card instead of leaving the UI out
        // of sync with the catalog (which a page reload would reveal anyway).
        if (removedBook) setBooks(prev => [...prev, removedBook]);
        alert(`La suppression a échoué : ${err.message}. Réessayez.`);
      }
    } else {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  };

  const handleRestart = (e, book) => {
    e.stopPropagation();
    clearProgress(book.id).catch(console.error);
    setProgressMap((prev) => { const next = { ...prev }; delete next[book.id]; return next; });
    setChoosingBook(book);
  };

  const handleChooseMode = (mode) => {
    const book = choosingBook;
    setChoosingBook(null);
    navigate(`/read/${book.id}`, { state: { mode } });
  };

  const handleTranslateClick = (e, book) => {
    e.stopPropagation();
    setTranslatingBook(book);
  };

  const handleTranslated = useCallback(() => {
    getAllBooks().then(setBooks).catch(() => {});
  }, []);

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.ornament}>✦</div>
        <h1 className={styles.title}>Library</h1>
        <p className={styles.subtitle}>personal reading archive</p>
        <div className={styles.ornamentLine}>
          <span />
          <span className={styles.diamond}>◆</span>
          <span />
        </div>
        <div className={styles.userBar}>
          <UserMenu user={user} onSignOut={signOut} />
        </div>
      </header>

      {/* Upload Zone */}
      <section
        className={`${styles.uploadZone} ${dragging ? styles.dragging : ''} ${loading ? styles.uploading : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !loading && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
        aria-label="Add an EPUB book"
      >
        <svg className={styles.uploadBorder} xmlns="http://www.w3.org/2000/svg">
          <rect
            x="1" y="1"
            width="calc(100% - 2px)" height="calc(100% - 2px)"
            rx="3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="8 6"
          />
        </svg>

        {loading ? (
          <div className={styles.uploadInner}>
            <div className={styles.loadingSpinner} />
            <p className={styles.uploadLabel}>{loadingMsg}</p>
          </div>
        ) : (
          <div className={styles.uploadInner}>
            <div className={styles.uploadIcon}>
              <svg width="32" height="40" viewBox="0 0 32 40" fill="none">
                <rect x="1" y="1" width="22" height="30" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <rect x="5" y="5" width="22" height="30" rx="2" stroke="currentColor" strokeWidth="1" fill="var(--bg)" />
                <rect x="9" y="9" width="22" height="30" rx="2" stroke="currentColor" strokeWidth="1" fill="var(--bg-elevated)" />
                <line x1="13" y1="20" x2="27" y2="20" stroke="currentColor" strokeWidth="1" opacity="0.5" />
                <line x1="13" y1="24" x2="24" y2="24" stroke="currentColor" strokeWidth="1" opacity="0.3" />
                <path d="M20 12 L20 6 M17 9 L20 6 L23 9" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className={styles.uploadLabel}>
              Drop your <span>.epub</span> files here
            </p>
            <p className={styles.uploadSub}>or click to browse</p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".epub"
          multiple
          className={styles.hiddenInput}
          onChange={(e) => processFiles(e.target.files)}
        />
      </section>

      {/* Collection */}
      {books.length > 0 && (
        <section className={styles.collection}>
          <div className={styles.collectionHeader}>
            <span className={styles.collectionRule} />
            <span className={styles.collectionLabel}>Collection</span>
            <span className={styles.collectionRule} />
            <span className={styles.collectionCount}>
              {books.length} {books.length > 1 ? 'volumes' : 'volume'}
            </span>
          </div>

          <div className={styles.grid}>
            {books
              .sort((a, b) => b.addedAt - a.addedAt)
              .map((book) => {
                const color = spineColor(book.title);
                const prog = progressMap[book.id];
                const pct = prog?.pct ?? 0;
                const hasProgress = pct > 0;
                const done = pct >= 100;
                return (
                  <article
                    key={book.id}
                    className={styles.bookCard}
                    onClick={() => setChoosingBook(book)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setChoosingBook(book)}
                    role="button"
                    aria-label={`Read ${book.title}`}
                  >
                    <div className={styles.bookCover}>
                      {book.cover ? (
                        <img src={book.cover} alt={book.title} className={styles.coverImg} />
                      ) : (
                        <div
                          className={styles.coverPlaceholder}
                          style={{ background: color.bg }}
                        >
                          <div className={styles.coverSpine} style={{ borderColor: color.text + '33' }} />
                          <p className={styles.coverTitle} style={{ color: color.text }}>
                            {book.title}
                          </p>
                          <p className={styles.coverAuthor} style={{ color: color.text + 'aa' }}>
                            {book.author}
                          </p>
                        </div>
                      )}

                      {hasProgress && (
                        <div className={styles.progressBar}>
                          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                        </div>
                      )}

                      <div className={styles.bookOverlay}>
                        {hasProgress ? (
                          <div className={styles.overlayActions}>
                            <span className={styles.readBtn}>
                              {done ? 'Done ✓' : `Resume — ${pct}%`}
                            </span>
                            <button
                              className={styles.restartBtn}
                              onClick={(e) => handleRestart(e, book)}
                            >
                              ↺ From beginning
                            </button>
                          </div>
                        ) : (
                          <span className={styles.readBtn}>Read →</span>
                        )}
                      </div>
                    </div>

                    <div className={styles.bookMeta}>
                      <p className={styles.bookTitle}>{book.title}</p>
                      <p className={styles.bookAuthor}>{book.author}</p>
                      {hasProgress && (
                        <p className={styles.bookProgress}>
                          {done ? 'Read' : `${pct}% read`}
                        </p>
                      )}
                    </div>

                    <button
                      className={`${styles.deleteBtn} ${confirmDelete === book.id ? styles.deleteBtnConfirm : ''}`}
                      onClick={(e) => handleDelete(e, book.id)}
                      title={confirmDelete === book.id ? 'Confirm deletion' : 'Delete'}
                      aria-label="Delete this book"
                    >
                      {confirmDelete === book.id ? '✕ Confirm' : '✕'}
                    </button>

                    {!book.translatedFrom && (
                      <button
                        className={styles.translateBtn}
                        onClick={(e) => handleTranslateClick(e, book)}
                        title="Traduire ce livre"
                        aria-label="Translate this book"
                      >
                        ⇄
                      </button>
                    )}
                  </article>
                );
              })}
          </div>
        </section>
      )}

      {fetchError && (
        <p className={styles.errorHint}>
          Error: {fetchError}
        </p>
      )}

      {initialLoading && (
        <p className={styles.emptyHint}>Loading your library…</p>
      )}

      {!initialLoading && !fetchError && books.length === 0 && !loading && (
        <p className={styles.emptyHint}>
          Your collection is empty — add a book to get started.
        </p>
      )}

      <footer className={styles.footer}>
        <span className={styles.footerOrnament}>✦</span>
      </footer>

      {translatingBook && (
        <TranslateBookModal
          book={translatingBook}
          allBooks={books}
          onClose={() => setTranslatingBook(null)}
          onTranslated={handleTranslated}
        />
      )}

      {choosingBook && (
        <ReadingModeModal
          book={choosingBook}
          onChoose={handleChooseMode}
          onClose={() => setChoosingBook(null)}
        />
      )}

    </div>
  );
}
