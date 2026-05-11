import { useState, useEffect, useRef, useCallback } from 'react';
import { streamChatMessage, generateRevisionSheet } from '../lib/geminiApi.js';
import { saveNotesheet } from '../lib/driveStorage.js';
import styles from './ChatPanel.module.css';

const SUGGESTED_PROMPTS = [
  { label: 'Create a revision sheet', action: 'revision-sheet' },
  { label: 'Explain difficult terms', action: 'chat' },
  { label: 'Create 3 comprehension questions', action: 'chat' },
  { label: 'Simplify this passage', action: 'chat' },
];

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
  const streamingAbortRef = useRef(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    return () => streamingAbortRef.current?.abort();
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

  const th = themeColors;
  const borderColor = th.text + '18';

  return (
    <div
      className={`${styles.drawer} ${isOpen ? styles.drawerOpen : ''}`}
      style={{ background: th.bg + 'f0', borderTopColor: borderColor, pointerEvents: isOpen ? 'auto' : 'none' }}
      onClick={e => e.stopPropagation()}
    >
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
        {messages.length === 0 && (
          <div className={styles.emptyState}>
            <p className={styles.emptyHint} style={{ color: th.text }}>
              Suggested prompts
            </p>
            {SUGGESTED_PROMPTS.map(prompt => (
              <button
                key={prompt.label}
                className={styles.suggestedBtn}
                style={{ color: th.text, borderColor }}
                onClick={() =>
                  prompt.action === 'revision-sheet'
                    ? handleCreateRevisionSheet()
                    : handleSend(prompt.label)
                }
                disabled={isLoading}
              >
                {prompt.label}
              </button>
            ))}
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

          return (
            <div
              key={msg.id}
              className={`${styles.message} ${msg.role === 'user' ? styles.userMsg : styles.assistantMsg}`}
            >
              <p style={{ color: th.text }}>
                {msg.text}
                {msg.isStreaming && <span className={styles.cursor} />}
              </p>
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
