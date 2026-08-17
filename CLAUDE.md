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

React 18 + Vite 5, epubjs 0.3.93, react-router-dom v6, @google/generative-ai, react-markdown. No TypeScript.

## Architecture

**Bibliothèque** is a fully client-side EPUB reader. Books and reading progress are stored in the user's Google Drive; no backend is involved.

### Auth & Google Drive layer

Authentication uses Google Identity Services (GSI) implicit-grant flow via `src/lib/googleAuth.js`. The access token is persisted in `localStorage` under `gauth_token` / `gauth_expiry` and considered valid until 60 s before expiry. `requestSignIn()` silently reuses an existing grant or forces the consent screen. `invalidateToken()` clears all three localStorage keys without revoking the token (used by the 403 recovery path). **When adding OAuth scopes, bump `SCOPE_VER` in `googleAuth.js`** — this invalidates cached tokens and forces re-consent on next sign-in.

Drive operations are split across three modules:
- **`src/lib/driveApi.js`** — raw Drive REST v3 wrappers (upload, download, delete, list, search, createFolder). Resumable upload is used for EPUB files. Exports `DriveAuthError` — thrown when a Drive call returns 403 with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`; the handler also calls `invalidateToken()` so the stale token is wiped. Callers (Library.jsx) catch `DriveAuthError` and call `signOut()` to force re-consent.
- **`src/lib/driveStorage.js`** — session-cached folder/file resolution. Creates a `dkut/` root folder in Drive with two subfolders: `library/` (EPUB files) and `revision-sheet/` (generated markdown notes). Also manages a `bibliotheque-data.json` file at the root. Exposes `loadData()` / `saveData()`, `getLibraryFolderId()`, and `saveNotesheet(title, markdownContent)`. Module-level vars (`_rootId`, `_libraryId`, `_notesheetId`, `_dataFileId`) are all reset on sign-out via `resetDriveStorage()`.
- **`src/lib/progress.js`** — in-memory mirror of `data.progress`; writes are debounced 1500 ms (`saveProgress` catches errors silently). `flushProgress()` forces an immediate write (called on `visibilitychange`/cleanup). `getAllProgress()` returns all progress entries. `clearProgress(id)` deletes one entry immediately (used when deleting a book). Reset on sign-out via `resetProgress()`.

The Drive data file shape: `{ books: [{ id, title, author, addedAt, language?, translatedFrom? }], progress: { [driveId]: { cfi, pct } }, customPrompts: [...], deletedDefaultPromptIds: [...] }`. The `id` field is the Drive file ID of the EPUB. `language`/`translatedFrom` are optional, set only on books produced by the whole-book translator (see below) — `translatedFrom` holds the source book's Drive id. Progress values support a legacy string format (bare CFI) — `getProgress()` normalises both.

### Local cache

`src/lib/bookCache.js` caches EPUB `ArrayBuffer`s and cover base64 strings in a separate IndexedDB (`bibliotheque-cache`) to avoid re-downloading from Drive on every open. Keys are `epub-{driveId}` and `cover-{driveId}`. IDB returns a structured-clone copy on each `get()`, so callers must still `.slice(0)` before passing to epubjs.

### Book storage facade

`src/utils/storage.js` is the public API used by Library and Reader. It orchestrates Drive + cache:
- `saveBook()` uploads to Drive under `dkut/library/`, caches locally, appends to `bibliotheque-data.json`. Skips upload if title+author already exists.
- `saveTranslatedBook({ title, author, data, sourceId, language, addedAt })` — used by the whole-book translator (see below); same upload/cache flow as `saveBook()` but deliberately never dedupes by title+author (each translation run must land as a genuinely new Drive file, not silently resolve to a prior run's id). Tags the new library entry with `language`/`translatedFrom: sourceId`.
- `getBook(id)` checks IDB cache first, falls back to `downloadFile`, then re-caches.
- `getAllBooks()` returns metadata + cached covers without downloading EPUB data. Silently deduplicates by title+author (keeps most recent `addedAt`).
- `deleteBook(id)` deletes from Drive, evicts IDB cache, removes from `bibliotheque-data.json`.
- `syncLibrary()` scans `dkut/library/` on Drive and registers any EPUB not already in `bibliotheque-data.json`; returns the count of newly added books.

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
- Location generation (`book.locations.generate(1600)`) happens after initial display; a `locationsReadyRef` flag prevents saving progress until generation is complete, then `rendition.display()` is called a second time to land at the correct position with accurate percentage. `percentageFromCfi` and `locationFromCfi` calls are wrapped in try/catch because CFI text offsets can be out of bounds after in-place DOM translation.
- Reader's `useEffect` uses a `cancelled` boolean flag; every `await` must check `if (cancelled) return` before touching state.

### Library UX details

- Upload: drag-and-drop or file picker; both call `processFiles()`, which filters `.epub` only, extracts metadata per file, then calls `saveBook()`.
- Books with no cover get a deterministic color from `spineColor()`, which hashes the title into one of 8 dark palettes.
- Delete requires two clicks: first click arms `confirmDelete` state for 3 s.
- **Sync Drive** button calls `syncLibrary()` to discover EPUBs already in Drive that aren't yet registered in the data file.

### Reader UX details

- Themes: `night` (dark brown), `sepia` (warm cream), `day` (off-white). Font size 13–26 px, 1 px steps.
- Reading position (CFI + percentage) is loaded via `getProgress(id)` and saved via `saveProgress(id, cfi, pct)` from `src/lib/progress.js` (Drive-backed, debounced, flushed on tab hide/unmount).
- Keyboard: `ArrowLeft`/`ArrowRight` navigate; `Escape` closes panels; `f`/`F` toggles fullscreen. Wired on both `window` and epubjs `rendition`.
- Mobile tap zones: left/center/right invisible overlay — left/right navigate, center toggles chrome visibility.
- Translation: `translatePage()` queries text nodes from the EPUB iframe and replaces in-place via Google Translate's unofficial endpoint. Results cached in module-level `_translationCache` Map (key `${lang}\0${text}`). `targetLangRef` mirrors state to avoid stale closure in `rendition.on('relocated')`.
- Fullscreen: toggled via `document.fullscreenElement`; keyboard shortcut `f/F`. The current CFI is saved to `preFullscreenCfiRef` before the toggle; on `fullscreenchange`, the rendition is resized with `resize('100%','100%')` and position is restored via `display(cfi)` after a 100 ms settle delay (prevents blank page on viewport resize).

### Vite / build notes

`vite.config.js` explicitly pre-bundles epubjs (`optimizeDeps.include`) and targets `es2020` — required because epubjs uses dynamic `import()` patterns that confuse Vite's auto-detection.

### Styling

CSS Modules per page (`Library.module.css`, `Reader.module.css`, `Auth.module.css`). Global baseline in `src/index.css`. Fonts from Google Fonts in `index.html`: Cormorant Garamond (headings), Libre Baskerville (reader body), Space Mono (monospace accents).

### Reader chrome behaviour

Top bar, nav arrows, and bottom bar auto-hide after 3.5 s of inactivity. Any `mousemove` or click resets the timer. Panels (TOC, settings, chat) prevent the hide timer while open.

### AI reading assistant

`src/lib/geminiApi.js` — wrapper around `@google/generative-ai` using model `gemini-3.5-flash-lite` (const `MODEL`). All system instructions force French output. Exports:
- `streamChatMessage()` — async generator yielding text chunks for free-form chat; injects full page text as context.
- `generateRevisionSheet()` — non-streaming; one structured markdown revision sheet (résumé, concepts clés, termes importants, questions de révision) for the whole chapter, in one call.
- `generateInterviewPrep()` — non-streaming; 6–10 alternating conceptual/technical interview questions with model answers, grounded in the chapter text via `ANTI_FABRICATION_RULES` (never invent APIs/examples not present in the source).
- `generateRevisionSet()` — async generator producing *one revision sheet per concept* instead of a single cramped document: a `planRevisionSheets()` call first asks the model for a JSON plan (`PLAN_SCHEMA`: `slug`/`title`/`sourceHeading` per concept), which is then validated against real `#`–`######` heading lines extracted from the page text (`validatePlanAgainstHeadings` — drops any planned sheet whose `sourceHeading` doesn't literally appear in the source, since a one-shot long generation was observed to dilute rule-following as it progressed). Each validated concept is then generated with its own `generateSheetForConcept()` call (exported standalone so a single failed card can be retried without re-running the plan). Yields progress events: `planning`, `plan`, `sheet-start`, `sheet-done`, `sheet-error`, `plan-error`, `aborted`, `done`.
- `generateLearningPackage()` — non-streaming, single structured call (`LEARNING_PACKAGE_SCHEMA`) returning paired `{ exercises, solutions }` markdown documents with matching numbering; `EXERCISE_SCOPE_RULES` requires new practice scenarios (not source examples) but restricted to concepts actually taught in the chapter.

`src/lib/customPrompts.js` — Drive-backed CRUD for the chat's suggested-prompt list (`getAllPrompts`/`savePrompt`/`deletePrompt`), stored in `data.customPrompts`. Ships 7 `DEFAULT_PROMPTS` (revision-sheet, revision-set, prepare-interview, learning-package, plus 3 plain `chat` prompts) identified by stable ids. `ensurePrompts()` merges in any default added after a user's data file already existed (matched by id) and re-seeds a first-time data file entirely. Deleting a default prompt records its id in `data.deletedDefaultPromptIds` so the merge step doesn't resurrect it. Module-level cache reset via `resetCustomPrompts()` on sign-out.

`src/components/ChatPanel.jsx` (~1000 lines) — bottom drawer, resizable (drag handle, `MIN_DRAWER_HEIGHT`–`MAX_DRAWER_HEIGHT_RATIO` of viewport), renders markdown via `react-markdown` with custom component overrides. Suggested prompts are loaded from `customPrompts.js` and dispatch on `prompt.type`:
- `chat` — sends as a normal message.
- `revision-sheet` / `prepare-interview` — single non-streaming call, rendered as a `revision-sheet`/`interview-prep` message with a **Save to Drive** button (`saveNotesheet()` → `dkut/revision-sheet/<title>.md`).
- `revision-set` / `learning-package` — rendered as a card grid (`role: 'revision-set'`/`'learning-package'`) that fills in as each concept/pair streams in via the generator's progress events; each card has retry, per-card download, and a **download all** button (`downloadAllSheets()`, staggered 200 ms apart to avoid browser throttling). Learning-package retry always regenerates both exercises+solutions together since they share numbering.
- A **custom prompt manager** (add/edit/delete, `promptForm` state) lets the user create their own suggested prompts of any type; editing auto-expands the drawer to near-fullscreen.

Assistant replies that contain multiple named documents (e.g. a multi-file custom-prompt response) are parsed by `extractDownloadableFiles()` — first tries `` `filename.ext` `` markers immediately followed by a fenced block (tracking fence depth so nested code fences don't break file boundaries), then falls back to splitting on top-level ` ```markdown ` fences and naming each chunk from its first heading — surfaced as individual download buttons.

Chat history sent to Gemini is capped at the last 20 messages via `buildHistory()`, which excludes `separator`, `revision-sheet`, `revision-set`, `interview-prep`, `learning-package`, and in-flight streaming messages. A `separator` message ("New page") is inserted automatically when `pageChangeSignal` changes. Streams responses chunk by chunk; aborts in-flight requests (`AbortController`) on unmount or explicit cancel.

`src/lib/languages.js` — shared `LANGUAGES` list (`{code, label}`) and `languageLabel(code)`, used by both Reader's live per-page translator and the whole-book translator below (previously a local const duplicated only in Reader.jsx).

### Whole-book translation

`src/lib/epubTranslator.js` — translates an entire EPUB to another language via Gemini while preserving archive structure and formatting. Triggered per-book from Library.jsx (`TranslateBookModal.jsx`), not from the Reader — it's a batch job against the archived file, unrelated to any open reading session.

Key design point: after `book.ready`, `book.archive.zip` is the live, fully-loaded JSZip instance backing the open book (epubjs dependency, already present in `node_modules`). The translator never rebuilds the archive — it reads each target file via `book.archive.getText(url)`, overwrites only the files it changes via `zip.file(path, newContent)`, and calls `zip.generateAsync(...)` once at the end; everything else (images, fonts, CSS, `mimetype`) round-trips untouched.

- Per chapter (`book.spine.spineItems`), the raw XHTML is parsed with `DOMParser` (`application/xhtml+xml`, falling back to `text/html` on a parser error) and walked for translatable block elements (`p, h1-h6, li, blockquote, td, th, dd, dt, figcaption` — mirrors Reader.jsx's live translator selector, minus `pre`). Within each block, any nested `code`/`pre`/`math` is masked out as a `⟦N⟧` token (the actual removed DOM node is kept, not a re-serialized HTML string) before the block's text is sent to Gemini, then spliced back verbatim after — this is what keeps code and math byte-identical through translation even when nested inside a translated paragraph. Formatting other than code/math (bold, italic, links) is *not* individually preserved, same known trade-off as the live translator.
- Gemini calls are batched per chapter (`translateSegments()` in `geminiApi.js`, structured JSON: array of `{id, text}` in, array of `{id, text}` out), splitting only past a ~5000-char / 60-segment budget — bounds total calls to roughly one per chapter rather than one per paragraph. `validateBatch()` never trusts the reply's structure: checks segment count, id set, and that each segment's `⟦N⟧` token set is preserved, before accepting it. A failed batch is retried once, then falls back to one call per individual segment; a segment that still fails keeps its original untranslated (but token-intact) text rather than ever fabricating a translation.
- The nav document (EPUB3 `book.packaging.navPath`) or NCX (`ncxPath`) is translated through the same pipeline, so the in-reader TOC matches the translated prose.
- Only the OPF's `dc:language` is rewritten (`patchOpfLanguage()`) — `dc:title`/`dc:creator` are never touched, to avoid any hallucinated/mistranslated title. **The OPF must be read/written via its raw zip-relative key (`book.container.packagePath`, decoded) directly — never through `book.resolve()`**, which by the time `book.ready` has resolved treats `packagePath` as relative to the OPF's own directory (since `book.path` is set to the OPF's own path during opening) and silently double-prefixes it (e.g. `OEBPS/content.opf` → `OEBPS/OEBPS/content.opf`); confirmed by direct testing against real EPUBs. Spine/nav/ncx hrefs are the opposite case — they *are* OPF-relative, so `book.resolve()` is correct for those.
- `estimateTranslation({ arrayBuffer })` runs the same parsing/segmentation pass with zero Gemini calls, returning chapter/segment/char counts and an estimated call count — shown to the user for confirmation before a real run starts.
- `translateEpub({ apiKey, arrayBuffer, targetLang, signal })` is the orchestrating async generator (sequential, one chapter at a time — no worker-pool, matching every other Gemini async generator in this codebase), yielding progress events (`plan`, `chapter-start`, `chapter-done`, `chapter-error`, `nav-*`, `metadata-*`, `building`, `done` with `{blob, stats}`, `aborted`).

`src/components/TranslateBookModal.jsx` — per-book modal opened from a `⇄` button on the Library card (hidden on books that are themselves already a translated copy, i.e. have `translatedFrom` set). Flow: language picker + estimate (warns if a translation into that language already exists for this book) → confirm → chapter-by-chapter progress list with a Stop button (`AbortController`) → on completion, auto-saves to Drive via `saveTranslatedBook()` and offers an immediate local download regardless of upload outcome, with an isolated upload retry (the generated blob stays in memory, so retrying never re-runs any Gemini calls).
