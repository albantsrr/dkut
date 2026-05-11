# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server
npm run build     # Production build → dist/
npm run preview   # Serve the production build locally
```

There are no tests or linters configured.

## Setup

Create a `.env.local` file with:
```
VITE_GOOGLE_CLIENT_ID=<your OAuth 2.0 client ID>
VITE_GEMINI_API_KEY=<your Gemini API key from ai.google.dev>
```
The app won't authenticate without `VITE_GOOGLE_CLIENT_ID`. The OAuth client must have `https://accounts.google.com/gsi/client` authorized and the correct JS origin / redirect URI for the dev/prod URL.
`VITE_GEMINI_API_KEY` is required for the AI reading assistant chat panel (free tier available on ai.google.dev).

## Stack

React 18 + Vite 5, epubjs 0.3.93, react-router-dom v6, @google/generative-ai. No TypeScript.

## Architecture

**Bibliothèque** is a fully client-side EPUB reader. Books and reading progress are stored in the user's Google Drive; no backend is involved.

### Auth & Google Drive layer

Authentication uses Google Identity Services (GSI) implicit-grant flow via `src/lib/googleAuth.js`. The access token is persisted in `localStorage` under `gauth_token` / `gauth_expiry` and considered valid until 60 s before expiry. `requestSignIn()` silently reuses an existing grant or forces the consent screen. **When adding OAuth scopes, bump `SCOPE_VER` in `googleAuth.js`** — this invalidates cached tokens and forces re-consent on next sign-in.

Drive operations are split across three modules:
- **`src/lib/driveApi.js`** — raw Drive REST v3 wrappers (upload, download, delete, list, search, createFolder). Resumable upload is used for EPUB files.
- **`src/lib/driveStorage.js`** — session-cached folder/file resolution. Ensures a `Bibliothèque/` Drive folder and a `bibliotheque-data.json` file exist; exposes `loadData()` / `saveData()`. Both `_folderId` and `_dataFileId` are module-level vars reset on sign-out via `resetDriveStorage()`.
- **`src/lib/progress.js`** — in-memory mirror of `data.progress`; writes are fire-and-forget (`saveData` catches errors silently) except `clearProgress` which awaits. Reset on sign-out via `resetProgress()`.

The Drive data file shape: `{ books: [{ id, title, author, addedAt }], progress: { [driveId]: cfi } }`. The `id` field is the Drive file ID of the EPUB.

### Local cache

`src/lib/bookCache.js` caches EPUB `ArrayBuffer`s and cover base64 strings in a separate IndexedDB (`bibliotheque-cache`) to avoid re-downloading from Drive on every open. Keys are `epub-{driveId}` and `cover-{driveId}`. IDB returns a structured-clone copy on each `get()`, so callers must still `.slice(0)` before passing to epubjs.

### Book storage facade

`src/utils/storage.js` is the public API used by Library and Reader. It orchestrates Drive + cache:
- `saveBook()` uploads to Drive, caches locally, appends to `bibliotheque-data.json`.
- `getBook(id)` checks IDB cache first, falls back to `downloadFile`, then re-caches.
- `getAllBooks()` returns metadata + cached covers without downloading EPUB data.
- `deleteBook(id)` deletes from Drive, evicts IDB cache, removes from `bibliotheque-data.json`.

Book IDs are Drive file IDs.

### Auth context & routing

`src/contexts/AuthContext.jsx` wraps auth state and exposes `{ user, loading, signIn, signOut }`. `AuthProvider` is mounted in `main.jsx` around `<App>`. `user` has shape `{ sub, name, email, picture }` from the Google OAuth userinfo endpoint. `signOut()` chains `gSignOut → resetDriveStorage → resetProgress → clearAllCache`.

Routes:

| Route | Component | Auth required |
|---|---|---|
| `/auth` | `Auth` | No |
| `/` | `Library` | Yes (`ProtectedRoute`) |
| `/read/:id` | `Reader` | Yes (`ProtectedRoute`) |

`ProtectedRoute` renders a spinner while `loading` is true, then redirects to `/auth` if `user` is null.

### epubjs usage

- `extractMeta()` in Library and `extractCover()` in storage.js both open a throwaway `Epub` instance, then call `book.destroy()`.
- Reader renders into `viewerRef` with `flow: 'paginated'` and `spread: 'none'`. The `ArrayBuffer` is always `.slice(0)`-d before passing to epubjs because epubjs consumes (transfers) the buffer.
- `applyTheme()` always re-registers the theme object before calling `themes.select()`.
- Location generation (`book.locations.generate(1600)`) happens after initial display so progress percentage is asynchronous.
- Reader's `useEffect` uses a `cancelled` boolean flag; every `await` must check `if (cancelled) return` before touching state.

### Library UX details

- Upload: drag-and-drop or file picker; both call `processFiles()`, which filters `.epub` only, extracts metadata per file, then calls `saveBook()`.
- Books with no cover get a deterministic color from `spineColor()`, which hashes the title into one of 8 dark palettes.
- Delete requires two clicks: first click arms `confirmDelete` state for 3 s.

### Reader UX details

- Themes: `night` (dark brown), `sepia` (warm cream), `day` (off-white). Font size 13–26 px, 1 px steps.
- Reading position (CFI) is loaded via `getProgress(id)` and saved via `saveProgress(id, cfi)` from `src/lib/progress.js` (Drive-backed, fire-and-forget).
- Keyboard: `ArrowLeft`/`ArrowRight` navigate; `Escape` closes panels. Wired on both `window` and epubjs `rendition`.
- Translation: `translatePage()` queries text nodes from the EPUB iframe and replaces in-place via Google Translate's unofficial endpoint. Results cached in module-level `_translationCache` Map (key `${lang}\0${text}`). `targetLangRef` mirrors state to avoid stale closure in `rendition.on('relocated')`.

### Vite / build notes

`vite.config.js` explicitly pre-bundles epubjs (`optimizeDeps.include`) and targets `es2020` — required because epubjs uses dynamic `import()` patterns that confuse Vite's auto-detection.

### Styling

CSS Modules per page (`Library.module.css`, `Reader.module.css`, `Auth.module.css`). Global baseline in `src/index.css`. Fonts from Google Fonts in `index.html`: Cormorant Garamond (headings), Libre Baskerville (reader body), Space Mono (monospace accents).

### Reader chrome behaviour

Top bar, nav arrows, and bottom bar auto-hide after 3.5 s of inactivity. Any `mousemove` or click resets the timer. Panels (TOC, settings, chat) prevent the hide timer while open.

### AI reading assistant

`src/lib/geminiApi.js` — stateless async-generator wrapper around `@google/generative-ai`. Exports `streamChatMessage()` which yields text chunks from Gemini 2.5 Flash. Full page text is injected as context in each user message via `buildUserMessage()`. History is capped at the last 20 messages (non-separator, non-streaming) via `buildHistory()` in ChatPanel. The system instruction is dynamically built by `buildSystemInstruction()` with book title, author, and chapter; instructs Gemini to always respond in French, concisely (3–5 sentences).

`src/components/ChatPanel.jsx` — bottom drawer (50vh, slides up). Props: `isOpen`, `onClose`, `themeColors`, `bookTitle`, `bookAuthor`, `chapterName`, `getPageText` (lazy callback), `pageChangeSignal` (incremented on each `relocated` event to insert page-change separators). Streams responses chunk by chunk; aborts on unmount. Four hardcoded `SUGGESTED_PROMPTS` appear as quick-start chips (résumé, termes difficiles, questions, simplification).
