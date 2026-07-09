import { useState, useEffect, useRef, useCallback } from 'react';
import { streamChatMessage, generateRevisionSheet } from '../lib/geminiApi.js';
import { saveNotesheet } from '../lib/driveStorage.js';
import { getAllPrompts, savePrompt, deletePrompt } from '../lib/customPrompts.js';
import styles from './ChatPanel.module.css';

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
  const re = /`([\w.-]+\.\w+)`[^\n]*\n+```(?:\w+)?\n([\s\S]*?)```/g;
  const files = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    files.push({ filename: match[1], content: match[2].trimEnd() });
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

function buildHistory(messages) {
  return messages
    .filter(m => m.role !== 'separator' && m.role !== 'revision-sheet' && !m.isStreaming)
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
  const [drawerHeight, setDrawerHeight] = useState(null); // px override; null = default CSS height
  const streamingAbortRef = useRef(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
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
    if (pageChangeSignal === 0 || messages.length === 0) return;
    setMessages(prev => [
      ...prev,
      { id: Date.now(), role: 'separator', text: 'New page' },
    ]);
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
    try {
      const updated = await deletePrompt(id);
      setPrompts(updated);
    } catch (err) {
      console.error('[ChatPanel] Failed to delete prompt:', err);
    }
  }, []);

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
                  className={styles.suggestedBtn}
                  style={{ color: th.text, borderColor }}
                  onClick={() =>
                    prompt.type === 'revision-sheet'
                      ? handleCreateRevisionSheet()
                      : handleSend(prompt.text)
                  }
                  disabled={isLoading}
                >
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
                    className={styles.promptActionBtn}
                    style={{ color: th.text }}
                    onClick={() => handleDeletePrompt(prompt.id)}
                    title="Delete prompt"
                  >
                    ✕
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
                  className={styles.promptFormTextarea}
                  style={{ color: th.text }}
                  value={promptForm.text}
                  onChange={e => setPromptForm(f => ({ ...f, text: e.target.value }))}
                  placeholder="Prompt text sent to the assistant"
                  rows={7}
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

          if (msg.role === 'revision-sheet') {
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
                  </>
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
              <p style={{ color: th.text }}>
                {msg.text}
                {msg.isStreaming && <span className={styles.cursor} />}
              </p>
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
