import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { streamChatMessage, generateRevisionSheet, generateRevisionSet, generateSheetForConcept, generateInterviewPrep, generateLearningPackage } from '../lib/geminiApi.js';
import { saveNotesheet } from '../lib/driveStorage.js';
import { getAllPrompts, savePrompt, deletePrompt } from '../lib/customPrompts.js';
import styles from './ChatPanel.module.css';

const markdownComponents = {
  p: ({ node, ...props }) => <p className={styles.mdP} {...props} />,
  ul: ({ node, ...props }) => <ul className={styles.mdList} {...props} />,
  ol: ({ node, ...props }) => <ol className={styles.mdList} {...props} />,
  li: ({ node, ...props }) => <li className={styles.mdListItem} {...props} />,
  h1: ({ node, ...props }) => <h1 className={styles.mdHeading} {...props} />,
  h2: ({ node, ...props }) => <h2 className={styles.mdHeading} {...props} />,
  h3: ({ node, ...props }) => <h3 className={styles.mdHeading} {...props} />,
  strong: ({ node, ...props }) => <strong className={styles.mdStrong} {...props} />,
  code: ({ node, inline, ...props }) =>
    inline ? <code className={styles.mdInlineCode} {...props} /> : <code className={styles.mdCodeBlock} {...props} />,
  pre: ({ node, ...props }) => <pre className={styles.mdPre} {...props} />,
};

const MIN_DRAWER_HEIGHT = 220;
const MAX_DRAWER_HEIGHT_RATIO = 0.92;

// Blends two hex colors so the drawer surface reads as distinct from the
// page background instead of sharing its exact color across every theme.
function mixHex(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const channel = (shift) => {
    const va = (a >> shift) & 255;
    const vb = (b >> shift) & 255;
    return Math.round(va + (vb - va) * t);
  };
  const r = channel(16), g = channel(8), bch = channel(0);
  return `#${[r, g, bch].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Detects `filename.ext` mentions immediately followed by a fenced code
// block, e.g. the multi-file output produced by custom prompts asking for
// several distinct documents (exercices.md, solutions.md, ...).
function extractNamedFiles(text) {
  const markerRe = /`([\w.-]+\.\w+)`[^\n]*\n+```(?:\w+)?\n/g;
  // Matches a bare line of backticks (closing fence) or backticks + a
  // language tag (nested opening fence, e.g. the ```python example inside
  // each fiche) so we can track fence depth and stop at the file's own
  // closing fence instead of at the next file's marker.
  const fenceLineRe = /^```(\w*)\s*$/gm;
  const files = [];
  let match;
  while ((match = markerRe.exec(text)) !== null) {
    const contentStart = match.index + match[0].length;
    fenceLineRe.lastIndex = contentStart;
    let depth = 1;
    let contentEnd = text.length;
    let fenceMatch;
    while ((fenceMatch = fenceLineRe.exec(text)) !== null) {
      depth += fenceMatch[1] ? 1 : -1;
      if (depth === 0) { contentEnd = fenceMatch.index; break; }
    }
    files.push({ filename: match[1], content: text.slice(contentStart, contentEnd).trimEnd() });
  }
  return files;
}

function slugify(str) {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
}

// Fallback for models that don't prefix each file with a `filename.md`
// marker: splits on top-level ```markdown fences (the ones Gemini uses to
// wrap each whole document) and names each chunk after its first heading.
// Fences tagged with another language (```sql, ```python...) inside a
// document are treated as plain content, not as file boundaries.
function extractMarkdownDocuments(text) {
  const openRe = /```markdown\s*\n/gi;
  const opens = [];
  let m;
  while ((m = openRe.exec(text)) !== null) {
    opens.push({ start: m.index, contentStart: m.index + m[0].length });
  }
  if (opens.length < 2) return [];

  return opens.map((open, i) => {
    const contentEnd = i + 1 < opens.length ? opens[i + 1].start : text.length;
    const content = text.slice(open.contentStart, contentEnd)
      .trimEnd()
      .replace(/```\s*$/, '')
      .trimEnd();
    const heading = content.match(/^#\s+(.+)$/m);
    const filename = `${heading ? slugify(heading[1]) : `file-${i + 1}`}.md`;
    return { filename, content };
  });
}

function extractDownloadableFiles(text) {
  const named = extractNamedFiles(text);
  return named.length > 0 ? named : extractMarkdownDocuments(text);
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Browsers throttle/warn on many downloads fired in the same tick from one
// click, so stagger them slightly instead of looping synchronously. Keeps the
// same numbering as the per-card download button (based on position in the
// full plan, not among only the done ones) so filenames stay consistent
// whether a sheet is downloaded individually or as part of the batch.
function downloadAllSheets(cards) {
  const orderPrefixLength = String(cards.length).length;
  const doneEntries = cards
    .map((card, i) => ({ card, orderPrefix: String(i + 1).padStart(orderPrefixLength, '0') }))
    .filter(({ card }) => card.status === 'done');
  doneEntries.forEach(({ card, orderPrefix }, i) => {
    setTimeout(() => {
      downloadTextFile(`${orderPrefix}-${card.slug || slugify(card.title)}.md`, card.text);
    }, i * 200);
  });
}

const CARD_STATUS_CLASS = {
  pending: 'cardStatusPending',
  generating: 'cardStatusGenerating',
  done: 'cardStatusDone',
  error: 'cardStatusError',
};

function buildHistory(messages) {
  return messages
    .filter(m => m.role !== 'separator' && m.role !== 'revision-sheet' && m.role !== 'revision-set' && m.role !== 'interview-prep' && m.role !== 'learning-package' && !m.isStreaming)
    .slice(-20)
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));
}

export default function ChatPanel({
  isOpen,
  onClose,
  themeColors,
  bookTitle,
  bookAuthor,
  chapterName,
  getPageText,
  pageChangeSignal,
}) {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  // Track save state per revision-sheet message id
  const [saveStates, setSaveStates] = useState({});
  const [prompts, setPrompts] = useState([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  // null = no form open; { id, title, text, type } otherwise (id is null when creating)
  const [promptForm, setPromptForm] = useState(null);
  const [confirmDeletePrompt, setConfirmDeletePrompt] = useState(null);
  const [drawerHeight, setDrawerHeight] = useState(null); // px override; null = default CSS height
  const streamingAbortRef = useRef(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const promptTextareaRef = useRef(null);
  const drawerRef = useRef(null);
  const resizeStateRef = useRef(null);

  useEffect(() => {
    return () => streamingAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAllPrompts()
      .then(list => { if (!cancelled) setPrompts(list); })
      .catch(err => console.error('[ChatPanel] Failed to load prompts:', err))
      .finally(() => { if (!cancelled) setPromptsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [inputValue]);

  useEffect(() => {
    if (promptTextareaRef.current) {
      promptTextareaRef.current.style.height = 'auto';
      promptTextareaRef.current.style.height = promptTextareaRef.current.scrollHeight + 'px';
    }
  }, [promptForm?.text]);

  // Editing a custom prompt (often a long, multi-paragraph one) is cramped in
  // the default drawer height — give it the full resizable range so there's
  // an actual overview instead of a tiny scrolling box.
  const isEditingPrompt = promptForm !== null;
  useEffect(() => {
    if (!isEditingPrompt) return;
    const roomyHeight = window.innerHeight * MAX_DRAWER_HEIGHT_RATIO;
    setDrawerHeight(h => (h == null || h < roomyHeight ? roomyHeight : h));
  }, [isEditingPrompt]);

  useEffect(() => {
    if (pageChangeSignal === 0) return;
    setMessages(prev => {
      if (prev.length === 0 || prev[prev.length - 1].role === 'separator') return prev;
      return [...prev, { id: Date.now(), role: 'separator', text: 'New page' }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageChangeSignal]);

  const handleSend = useCallback(async (overrideText) => {
    const userText = (overrideText ?? inputValue).trim();
    if (!userText || isLoading) return;

    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

    setInputValue('');
    setError(null);

    const userId = Date.now();
    const assistantId = userId + 1;

    const userMsg = { id: userId, role: 'user', text: userText };
    const assistantMsg = { id: assistantId, role: 'assistant', text: '', isStreaming: true };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsLoading(true);

    const controller = new AbortController();
    streamingAbortRef.current = controller;

    try {
      const pageText = getPageText();
      const historySnapshot = buildHistory([...messages, userMsg]);

      const stream = streamChatMessage({
        apiKey,
        userMessage: userText,
        pageText,
        bookTitle,
        bookAuthor,
        chapterName,
        history: historySnapshot,
        signal: controller.signal,
      });

      let fullText = '';
      for await (const chunk of stream) {
        fullText += chunk;
        setMessages(prev =>
          prev.map(m => (m.id === assistantId ? { ...m, text: fullText } : m))
        );
      }

      setMessages(prev =>
        prev.map(m => (m.id === assistantId ? { ...m, isStreaming: false } : m))
      );
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[ChatPanel] Gemini error:', err);
      const code = err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK';
      setError(code);
      setMessages(prev => prev.filter(m => m.id !== assistantId));
    } finally {
      setIsLoading(false);
      streamingAbortRef.current = null;
    }
  }, [inputValue, isLoading, messages, bookTitle, bookAuthor, chapterName, getPageText]);

  const handleCreateRevisionSheet = useCallback(async () => {
    if (isLoading) return;
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    setError(null);
    setIsLoading(true);

    const sheetId = Date.now();
    const title = `${chapterName || bookTitle || 'Chapter'} — Revision Sheet`;

    // Add a placeholder while generating
    setMessages(prev => [...prev, { id: sheetId, role: 'revision-sheet', text: '', title, isGenerating: true }]);

    try {
      const pageText = getPageText();
      const text = await generateRevisionSheet({
        apiKey,
        pageText,
        bookTitle,
        bookAuthor,
        chapterName,
      });
      setMessages(prev =>
        prev.map(m => (m.id === sheetId ? { ...m, text, isGenerating: false } : m))
      );
    } catch (err) {
      console.error('[ChatPanel] Revision sheet error:', err);
      const code = err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK';
      setError(code);
      setMessages(prev => prev.filter(m => m.id !== sheetId));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, bookTitle, bookAuthor, chapterName, getPageText]);

  const handleCreateRevisionSet = useCallback(async () => {
    if (isLoading) return;
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    setError(null);
    setIsLoading(true);

    const setId = Date.now();
    const setTitle = `${chapterName || bookTitle || 'Chapter'} — Fiches de révision`;
    setMessages(prev => [...prev, { id: setId, role: 'revision-set', title: setTitle, phase: 'planning', cards: [] }]);

    const controller = new AbortController();
    streamingAbortRef.current = controller;

    const patchSet = (fn) => setMessages(prev => prev.map(m => (m.id === setId ? fn(m) : m)));
    const patchCard = (index, patch) =>
      patchSet(m => ({ ...m, cards: m.cards.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));

    try {
      const pageText = getPageText();
      for await (const event of generateRevisionSet({
        apiKey, pageText, bookTitle, bookAuthor, chapterName, signal: controller.signal,
      })) {
        switch (event.type) {
          case 'plan':
            patchSet(m => ({
              ...m,
              phase: 'generating',
              cards: event.sheets.map(s => ({ ...s, status: 'pending', text: '' })),
            }));
            break;
          case 'sheet-start':
            patchCard(event.index, { status: 'generating' });
            break;
          case 'sheet-done':
            patchCard(event.index, { status: 'done', text: event.text });
            break;
          case 'sheet-error':
            patchCard(event.index, { status: 'error', errorMessage: event.error });
            break;
          case 'plan-error':
            patchSet(m => ({ ...m, phase: 'error' }));
            setError(event.error || 'NETWORK');
            break;
          case 'aborted':
          case 'done':
            patchSet(m => ({ ...m, phase: 'done' }));
            break;
          default:
            break;
        }
      }
    } catch (err) {
      console.error('[ChatPanel] Revision set error:', err);
      const code = err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK';
      setError(code);
      patchSet(m => ({ ...m, phase: 'error' }));
    } finally {
      setIsLoading(false);
      streamingAbortRef.current = null;
    }
  }, [isLoading, bookTitle, bookAuthor, chapterName, getPageText]);

  const handleCreateInterviewPrep = useCallback(async () => {
    if (isLoading) return;
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    setError(null);
    setIsLoading(true);

    const sheetId = Date.now();
    const title = `${chapterName || bookTitle || 'Chapter'} — Préparation d'entretien`;

    setMessages(prev => [...prev, { id: sheetId, role: 'interview-prep', text: '', title, isGenerating: true }]);

    try {
      const pageText = getPageText();
      const text = await generateInterviewPrep({
        apiKey,
        pageText,
        bookTitle,
        bookAuthor,
        chapterName,
      });
      setMessages(prev =>
        prev.map(m => (m.id === sheetId ? { ...m, text, isGenerating: false } : m))
      );
    } catch (err) {
      console.error('[ChatPanel] Interview prep error:', err);
      const code = err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK';
      setError(code);
      setMessages(prev => prev.filter(m => m.id !== sheetId));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, bookTitle, bookAuthor, chapterName, getPageText]);

  const handleCreateLearningPackage = useCallback(async () => {
    if (isLoading) return;
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    setError(null);
    setIsLoading(true);

    const setId = Date.now();
    const setTitle = `${chapterName || bookTitle || 'Chapter'} — Pack d'exercices`;
    setMessages(prev => [...prev, {
      id: setId,
      role: 'learning-package',
      title: setTitle,
      phase: 'generating',
      cards: [
        { slug: 'exercices', title: 'Exercices', status: 'pending', text: '' },
        { slug: 'solutions', title: 'Solutions', status: 'pending', text: '' },
      ],
    }]);

    const controller = new AbortController();
    streamingAbortRef.current = controller;

    const patchSet = (fn) => setMessages(prev => prev.map(m => (m.id === setId ? fn(m) : m)));

    try {
      const pageText = getPageText();
      const { exercises, solutions } = await generateLearningPackage({
        apiKey, pageText, bookTitle, bookAuthor, chapterName, signal: controller.signal,
      });
      patchSet(m => ({
        ...m,
        phase: 'done',
        cards: [
          { ...m.cards[0], status: 'done', text: exercises },
          { ...m.cards[1], status: 'done', text: solutions },
        ],
      }));
    } catch (err) {
      if (err.name === 'AbortError') {
        patchSet(m => ({ ...m, phase: 'done' }));
      } else {
        console.error('[ChatPanel] Learning package error:', err);
        const code = err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK';
        setError(code);
        patchSet(m => ({
          ...m,
          phase: 'error',
          cards: m.cards.map(c => ({ ...c, status: 'error', errorMessage: code })),
        }));
      }
    } finally {
      setIsLoading(false);
      streamingAbortRef.current = null;
    }
  }, [isLoading, bookTitle, bookAuthor, chapterName, getPageText]);

  const handleRetryCard = useCallback(async (setId, index) => {
    const setMsg = messages.find(m => m.id === setId);
    const sheet = setMsg?.cards?.[index];
    if (!sheet) return;
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

    // Exercices/solutions are generated together in one paired call — a
    // single card can't be regenerated in isolation without breaking the
    // exercise/solution numbering match, so retry re-runs the whole pair.
    if (setMsg.role === 'learning-package') {
      setMessages(prev => prev.map(m =>
        m.id === setId
          ? { ...m, phase: 'generating', cards: m.cards.map(c => ({ ...c, status: 'generating', errorMessage: undefined })) }
          : m
      ));
      try {
        const pageText = getPageText();
        const { exercises, solutions } = await generateLearningPackage({ apiKey, pageText, bookTitle, bookAuthor, chapterName });
        setMessages(prev => prev.map(m =>
          m.id === setId
            ? { ...m, phase: 'done', cards: [{ ...m.cards[0], status: 'done', text: exercises }, { ...m.cards[1], status: 'done', text: solutions }] }
            : m
        ));
      } catch (err) {
        const code = err.message === 'NO_API_KEY' ? 'NO_API_KEY' : err.message || 'NETWORK';
        setMessages(prev => prev.map(m =>
          m.id === setId
            ? { ...m, phase: 'error', cards: m.cards.map(c => ({ ...c, status: 'error', errorMessage: code })) }
            : m
        ));
      }
      return;
    }

    setMessages(prev => prev.map(m =>
      m.id === setId
        ? { ...m, cards: m.cards.map((c, i) => (i === index ? { ...c, status: 'generating', errorMessage: undefined } : c)) }
        : m
    ));
    try {
      const pageText = getPageText();
      const text = await generateSheetForConcept({ apiKey, pageText, bookTitle, bookAuthor, chapterName, sheet });
      setMessages(prev => prev.map(m =>
        m.id === setId
          ? { ...m, cards: m.cards.map((c, i) => (i === index ? { ...c, status: 'done', text } : c)) }
          : m
      ));
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === setId
          ? { ...m, cards: m.cards.map((c, i) => (i === index ? { ...c, status: 'error', errorMessage: err.message || 'NETWORK' } : c)) }
          : m
      ));
    }
  }, [messages, bookTitle, bookAuthor, chapterName, getPageText]);

  const handleSaveSheet = useCallback(async (msg) => {
    setSaveStates(prev => ({ ...prev, [msg.id]: 'saving' }));
    try {
      await saveNotesheet(msg.title, msg.text);
      setSaveStates(prev => ({ ...prev, [msg.id]: 'saved' }));
    } catch (err) {
      console.error('[ChatPanel] Save notesheet error:', err);
      setSaveStates(prev => ({ ...prev, [msg.id]: 'error' }));
    }
  }, []);

  const handleSubmitPromptForm = useCallback(async () => {
    if (!promptForm) return;
    const title = promptForm.title.trim();
    const text = promptForm.text.trim();
    if (!title || !text) return;
    const promptData = {
      id: promptForm.id ?? `custom-${Date.now()}`,
      title,
      text,
      type: promptForm.type ?? 'chat',
    };
    try {
      const updated = await savePrompt(promptData);
      setPrompts(updated);
      setPromptForm(null);
    } catch (err) {
      console.error('[ChatPanel] Failed to save prompt:', err);
    }
  }, [promptForm]);

  const handleDeletePrompt = useCallback(async (id) => {
    if (confirmDeletePrompt !== id) {
      setConfirmDeletePrompt(id);
      setTimeout(() => setConfirmDeletePrompt(prev => (prev === id ? null : prev)), 3000);
      return;
    }
    setConfirmDeletePrompt(null);
    try {
      const updated = await deletePrompt(id);
      setPrompts(updated);
    } catch (err) {
      console.error('[ChatPanel] Failed to delete prompt:', err);
    }
  }, [confirmDeletePrompt]);

  const handleResizeStart = useCallback((e) => {
    resizeStateRef.current = {
      startY: e.clientY,
      startHeight: drawerRef.current?.getBoundingClientRect().height ?? 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handleResizeMove = useCallback((e) => {
    if (!resizeStateRef.current) return;
    const { startY, startHeight } = resizeStateRef.current;
    const delta = startY - e.clientY; // dragging up enlarges the drawer
    const maxHeight = window.innerHeight * MAX_DRAWER_HEIGHT_RATIO;
    const next = Math.min(maxHeight, Math.max(MIN_DRAWER_HEIGHT, startHeight + delta));
    setDrawerHeight(next);
  }, []);

  const handleResizeEnd = useCallback((e) => {
    resizeStateRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const th = themeColors;
  const borderColor = th.text + '18';
  const panelBg = mixHex(th.bg, th.text, 0.07);
  const drawerBorderColor = th.text + '35';

  return (
    <div
      ref={drawerRef}
      className={`${styles.drawer} ${isOpen ? styles.drawerOpen : ''}`}
      style={{
        background: panelBg + 'f2',
        borderTopColor: drawerBorderColor,
        boxShadow: '0 -14px 34px rgba(0, 0, 0, 0.28)',
        pointerEvents: isOpen ? 'auto' : 'none',
        ...(drawerHeight != null ? { height: `${drawerHeight}px` } : {}),
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Resize handle */}
      <div
        className={styles.resizeHandle}
        style={{ color: th.text }}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        title="Drag to resize"
      >
        <span className={styles.resizeGrip} />
      </div>

      {/* Header */}
      <div
        className={styles.drawerHeader}
        style={{ borderBottomColor: borderColor }}
      >
        <span className={styles.drawerTitle} style={{ color: th.text }}>
          Reading Assistant
        </span>
        <div className={styles.headerActions}>
          {messages.length > 0 && (
            <button
              className={styles.clearBtn}
              onClick={() => setMessages([])}
              style={{ color: th.text }}
              title="Clear conversation"
            >
              Clear
            </button>
          )}
          <button
            className={styles.closeBtn}
            onClick={onClose}
            style={{ color: th.text }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className={styles.messages}>
        {messages.length === 0 && promptsLoaded && (
          <div className={styles.emptyState}>
            <p className={styles.emptyHint} style={{ color: th.text }}>
              Suggested prompts
            </p>
            {prompts.map(prompt => (
              <div key={prompt.id} className={styles.promptRow}>
                <button
                  className={`${styles.suggestedBtn} ${prompt.type === 'revision-set' || prompt.type === 'learning-package' ? styles.suggestedBtnMultiStep : ''}`}
                  style={{ color: th.text, borderColor }}
                  onClick={() => {
                    if (prompt.type === 'revision-sheet') return handleCreateRevisionSheet();
                    if (prompt.type === 'revision-set') return handleCreateRevisionSet();
                    if (prompt.type === 'prepare-interview') return handleCreateInterviewPrep();
                    if (prompt.type === 'learning-package') return handleCreateLearningPackage();
                    return handleSend(prompt.text);
                  }}
                  disabled={isLoading}
                  title={
                    prompt.type === 'revision-set' ? 'Génère plusieurs fiches (un appel par concept, ~1 min)'
                    : prompt.type === 'learning-package' ? 'Génère deux fichiers pairés : exercices et solutions'
                    : undefined
                  }
                >
                  {prompt.type !== 'chat' && <span aria-hidden="true">⚡ </span>}
                  {prompt.title}
                </button>
                <div className={styles.promptActions}>
                  <button
                    className={styles.promptActionBtn}
                    style={{ color: th.text }}
                    onClick={() => setPromptForm({ id: prompt.id, title: prompt.title, text: prompt.text, type: prompt.type })}
                    title="Edit prompt"
                  >
                    ✎
                  </button>
                  <button
                    className={`${styles.promptActionBtn} ${confirmDeletePrompt === prompt.id ? styles.promptActionBtnConfirm : ''}`}
                    style={confirmDeletePrompt === prompt.id ? undefined : { color: th.text }}
                    onClick={() => handleDeletePrompt(prompt.id)}
                    title={confirmDeletePrompt === prompt.id ? 'Confirm deletion' : 'Delete prompt'}
                  >
                    {confirmDeletePrompt === prompt.id ? '✕ Confirm' : '✕'}
                  </button>
                </div>
              </div>
            ))}

            {promptForm ? (
              <div className={styles.promptForm} style={{ borderColor }}>
                <input
                  className={styles.promptFormInput}
                  style={{ color: th.text }}
                  value={promptForm.title}
                  onChange={e => setPromptForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="Title"
                  autoFocus
                />
                <textarea
                  ref={promptTextareaRef}
                  className={styles.promptFormTextarea}
                  style={{ color: th.text }}
                  value={promptForm.text}
                  onChange={e => setPromptForm(f => ({ ...f, text: e.target.value }))}
                  placeholder="Prompt text sent to the assistant"
                />
                <div className={styles.promptFormActions}>
                  <button
                    className={styles.promptFormCancel}
                    style={{ color: th.text, borderColor }}
                    onClick={() => setPromptForm(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className={styles.promptFormSave}
                    style={{ color: th.text, borderColor }}
                    onClick={handleSubmitPromptForm}
                    disabled={!promptForm.title.trim() || !promptForm.text.trim()}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <button
                className={styles.addPromptBtn}
                style={{ color: th.text, borderColor }}
                onClick={() => setPromptForm({ id: null, title: '', text: '', type: 'chat' })}
              >
                + Add prompt
              </button>
            )}
          </div>
        )}

        {messages.map(msg => {
          if (msg.role === 'separator') {
            return (
              <div key={msg.id} className={styles.separator} style={{ color: th.text }}>
                <span>{msg.text}</span>
              </div>
            );
          }

          if (msg.role === 'revision-sheet' || msg.role === 'interview-prep') {
            const saveState = saveStates[msg.id];
            return (
              <div key={msg.id} className={styles.revisionSheet} style={{ borderLeftColor: '#c8a96e', background: th.bg }}>
                <p className={styles.revisionTitle} style={{ color: th.text }}>
                  {msg.title}
                </p>
                {msg.isGenerating ? (
                  <span className={styles.loadingDot} />
                ) : (
                  <>
                    <pre className={styles.revisionContent} style={{ color: th.text }}>
                      {msg.text}
                    </pre>
                    <div className={styles.cardActions}>
                      <button
                        className={styles.downloadFileBtn}
                        style={{ color: th.text, borderColor }}
                        onClick={() => downloadTextFile(`${slugify(msg.title)}.md`, msg.text)}
                        title={`Download ${slugify(msg.title)}.md`}
                      >
                        ⬇ Télécharger
                      </button>
                      <button
                        className={styles.saveSheetBtn}
                        style={{ color: th.text, borderColor }}
                        onClick={() => handleSaveSheet(msg)}
                        disabled={saveState === 'saving' || saveState === 'saved'}
                      >
                        {saveState === 'saving' && 'Saving…'}
                        {saveState === 'saved' && 'Saved to Drive ✓'}
                        {saveState === 'error' && 'Save failed — retry'}
                        {!saveState && 'Save to Drive'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          }

          if (msg.role === 'revision-set' || msg.role === 'learning-package') {
            const doneCount = msg.cards.filter(c => c.status === 'done').length;
            const errorCount = msg.cards.filter(c => c.status === 'error').length;
            return (
              <div key={msg.id} className={styles.revisionSet} style={{ borderLeftColor: '#c8a96e', background: th.bg }}>
                <div className={styles.revisionSetHeader}>
                  <p className={styles.revisionTitle} style={{ color: th.text }}>{msg.title}</p>
                  {(msg.phase === 'planning' || msg.phase === 'generating') && (
                    <button
                      className={styles.stopSetBtn}
                      style={{ color: th.text, borderColor }}
                      onClick={() => streamingAbortRef.current?.abort()}
                    >
                      Stop
                    </button>
                  )}
                  {doneCount > 0 && msg.phase !== 'planning' && msg.phase !== 'generating' && (
                    <button
                      className={styles.downloadAllBtn}
                      style={{ color: th.text, borderColor }}
                      onClick={() => downloadAllSheets(msg.cards)}
                      title={`Download all ${doneCount} sheets`}
                    >
                      ⬇ Tout télécharger
                    </button>
                  )}
                </div>

                {msg.phase === 'planning' && <span className={styles.loadingDot} />}
                {msg.phase === 'error' && msg.cards.length === 0 && (
                  <p className={styles.revisionSetStatus} style={{ color: th.text }}>
                    Échec de la planification des fiches.
                  </p>
                )}

                {msg.cards.length > 0 && (
                  <div className={styles.revisionSetCards}>
                    {msg.cards.map((card, i) => {
                      const cardSaveKey = `${msg.id}-${i}`;
                      const saveState = saveStates[cardSaveKey];
                      const orderPrefix = String(i + 1).padStart(String(msg.cards.length).length, '0');
                      return (
                        <div
                          key={card.slug ?? i}
                          className={`${styles.revisionCard} ${styles[CARD_STATUS_CLASS[card.status]] || ''}`}
                          style={{ borderColor }}
                        >
                          <p className={styles.revisionCardTitle} style={{ color: th.text }}>{card.title}</p>
                          {card.status === 'pending' && (
                            <span className={styles.cardStatusLabel} style={{ color: th.text }}>En attente…</span>
                          )}
                          {card.status === 'generating' && <span className={styles.loadingDot} />}
                          {card.status === 'error' && (
                            <div className={styles.cardErrorBox}>
                              <span className={styles.cardStatusLabel} style={{ color: th.text }}>
                                Échec — {card.errorMessage}
                              </span>
                              <button
                                className={styles.retryCardBtn}
                                style={{ color: th.text, borderColor }}
                                onClick={() => handleRetryCard(msg.id, i)}
                              >
                                Réessayer
                              </button>
                            </div>
                          )}
                          {card.status === 'done' && (
                            <>
                              <pre className={styles.revisionContent} style={{ color: th.text }}>{card.text}</pre>
                              <div className={styles.cardActions}>
                                <button
                                  className={styles.downloadFileBtn}
                                  style={{ color: th.text, borderColor }}
                                  onClick={() => downloadTextFile(`${orderPrefix}-${card.slug || slugify(card.title)}.md`, card.text)}
                                  title={`Download ${orderPrefix}-${card.slug || slugify(card.title)}.md`}
                                >
                                  ⬇ Télécharger
                                </button>
                                <button
                                  className={styles.saveSheetBtn}
                                  style={{ color: th.text, borderColor }}
                                  onClick={() => handleSaveSheet({ id: cardSaveKey, title: `${orderPrefix} - ${card.title}`, text: card.text })}
                                  disabled={saveState === 'saving' || saveState === 'saved'}
                                >
                                  {saveState === 'saving' && 'Saving…'}
                                  {saveState === 'saved' && 'Saved to Drive ✓'}
                                  {saveState === 'error' && 'Save failed — retry'}
                                  {!saveState && 'Save to Drive'}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {msg.phase === 'done' && msg.cards.length > 0 && (
                  <p className={styles.revisionSetSummary} style={{ color: th.text }}>
                    {doneCount}/{msg.cards.length} fiches générées
                    {errorCount > 0 ? `, ${errorCount} échec${errorCount > 1 ? 's' : ''}` : ''}.
                  </p>
                )}
              </div>
            );
          }

          const detectedFiles = msg.role === 'assistant' && !msg.isStreaming
            ? extractDownloadableFiles(msg.text)
            : [];

          return (
            <div
              key={msg.id}
              className={`${styles.message} ${msg.role === 'user' ? styles.userMsg : styles.assistantMsg}`}
            >
              <div className={styles.mdBody} style={{ color: th.text }}>
                {msg.isStreaming ? (
                  <p className={styles.mdP}>
                    {msg.text}
                    <span className={styles.cursor} />
                  </p>
                ) : (
                  <ReactMarkdown components={markdownComponents}>{msg.text}</ReactMarkdown>
                )}
              </div>
              {detectedFiles.length > 0 && (
                <div className={styles.messageDownloads}>
                  {detectedFiles.map((file, i) => (
                    <button
                      key={i}
                      className={styles.downloadFileBtn}
                      style={{ color: th.text, borderColor }}
                      onClick={() => downloadTextFile(file.filename, file.content)}
                      title={`Download ${file.filename}`}
                    >
                      ⬇ {file.filename}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {error && (
          <div className={styles.errorBanner}>
            {error === 'NO_API_KEY'
              ? 'API key missing. Add VITE_GEMINI_API_KEY to .env.local (get it at ai.google.dev)'
              : `Error: ${error}`}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className={styles.inputArea} style={{ borderTopColor: borderColor }}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          style={{ color: th.text }}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask a question about this page…"
          rows={1}
          disabled={isLoading}
        />
        <button
          className={styles.sendBtn}
          onClick={() => handleSend()}
          disabled={isLoading || !inputValue.trim()}
          title="Send (Enter)"
        >
          {isLoading ? (
            <span className={styles.loadingDot} />
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 13V3M3 8l5-5 5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
