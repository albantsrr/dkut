# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server
npm run build     # Production build → dist/
npm run preview   # Serve the production build locally
```

There are no tests or linters configured.

Backend (`server/`, a separate Node project — see "Backend migration" below):
```bash
cd server
npm run dev       # Start the API with --watch (auto-restart on change)
npm run migrate   # Apply server/src/db/schema.sql to DATABASE_URL
```
Local Postgres for dev: `docker compose -f docker-compose.dev.yml up -d` (repo root) — maps to host port **5433**, not 5432 (already taken by another project's container on this machine; adjust if that's not the case for you).

## Setup

Create a `.env.local` file with:
```
VITE_GOOGLE_CLIENT_ID=<your OAuth 2.0 client ID>
VITE_API_URL=<backend URL, e.g. http://localhost:8787>
```
The app won't authenticate without `VITE_GOOGLE_CLIENT_ID`. The OAuth client must have `https://accounts.google.com/gsi/client` authorized and the correct JS origin / redirect URI for the dev/prod URL.
`VITE_API_URL` points at the `server/` backend (see below); defaults to `http://localhost:8787` if unset. There is no frontend Gemini key anymore — see below.

`server/.env` (copy from `server/.env.example`) needs `DATABASE_URL`, `GOOGLE_CLIENT_ID` (same value as the frontend's), `SESSION_SECRET` (`openssl rand -base64 48`), `CORS_ORIGIN` (comma-separated origins allowed to send credentialed requests — must match wherever the Vite dev server actually runs), and `GEMINI_API_KEY` (from ai.google.dev, free tier available) — required for the AI reading assistant, revision sheets, quizzes, pomodoro exercises, and whole-book translation; the app itself still runs fine without it, those features just surface a `NO_API_KEY` error.

## Stack

React 18 + Vite 5, epubjs 0.3.93, react-router-dom v6, react-markdown (+ rehype-highlight, remark-math/rehype-katex for LaTeX rendering in chat). No TypeScript. `@google/generative-ai` now lives only in `server/` (Node) — see "Backend migration" below.

## Architecture

**Bibliothèque** was originally a fully client-side EPUB reader with everything stored in the user's Google Drive. **A migration to a self-hosted backend (`server/`, Node/Express + Postgres, deployable to a VPS) is in progress — see `MIGRATION_PLAN.md` at the repo root for the full rationale and phased roadmap.** As of phase 3 of that plan, every piece of *ongoing* app data — books/covers, reading progress, custom prompts, quiz progress, the pomodoro log, and revision-sheet notes — is served by `server/`; the live app never reads or writes Google Drive as part of its normal operation anymore. Google Sign-In itself is still the auth mechanism (see "Backend migration" below for why), and Drive read access specifically is still requested for one deliberate remaining reason: `ImportFromDriveModal.jsx` (phase 5, see "One-time Drive import" below), a one-time in-app tool that copies a user's pre-migration Drive data into the new backend.

### Auth layer

Authentication uses Google Identity Services (GSI) implicit-grant flow via `src/lib/googleAuth.js`. The access token is persisted in `localStorage` under `gauth_token` / `gauth_expiry` and considered valid until 60 s before expiry. `requestSignIn()` silently reuses an existing grant or forces the consent screen. `invalidateToken()` clears all three localStorage keys without revoking the token. **When adding OAuth scopes, bump `SCOPE_VER` in `googleAuth.js`** — this invalidates cached tokens and forces re-consent on next sign-in. This flow requests the `drive` scope solely so `ImportFromDriveModal.jsx` (see "One-time Drive import" below) can read a user's pre-migration data — narrowing the scope is a deliberately deferred cleanup, to keep until that import path is no longer needed by anyone.

- **`src/lib/progress.js`** — in-memory mirror of all progress rows for the current user (fetched once via `GET /progress`, see "Backend migration" below); writes are debounced 1500 ms per book (`saveProgress` catches errors silently). `flushProgress()` forces any pending debounced writes immediately (called on `visibilitychange`/cleanup). `getAllProgress()` returns all progress entries. `clearProgress(id)` deletes one entry immediately (used when deleting a book). Reset on sign-out via `resetProgress()`.
- **`src/lib/driveApi.js`** and **`src/lib/driveStorage.js`** — the original Drive REST v3 wrappers and the Drive-blob (`bibliotheque-data.json`) session-cache/resolution layer. No longer part of any *ongoing* live-app data path (books/progress/prompts/quiz/pomodoro/notes all moved off Drive in phases 2-3) — their only live caller now is `ImportFromDriveModal.jsx`'s one-time read of a user's old data (see "One-time Drive import" below).

### Local cache

`src/lib/bookCache.js` caches EPUB `ArrayBuffer`s in a separate IndexedDB (`bibliotheque-cache`) to avoid re-downloading on every open. Key: `epub-{bookId}`. IDB returns a structured-clone copy on each `get()`, so callers must still `.slice(0)` before passing to epubjs. Covers are no longer cached here (see Book storage facade below) — `evictBook()` still clears any leftover `cover-{id}` IDB entry from before that change.

### Book storage facade

`src/utils/storage.js` is the public API used by Library and Reader. It now talks to the `server/` backend (via `src/lib/api.js`) instead of Drive:
- `saveBook()` POSTs multipart (`title`, `author`, `addedAt`, `cover` data URL, `epub` blob) to `POST /books`, caches the EPUB bytes locally. The backend skips the insert and returns the existing id if title+author already exists for this user.
- `saveTranslatedBook({ title, author, data, sourceId, language, addedAt })` — used by the whole-book translator (see below); same upload/cache flow as `saveBook()` but sets `skipDedupe: true` (each translation run must land as a genuinely new book row, not silently resolve to a prior run's id) plus `language`/`translatedFrom: sourceId`. Extracts its own cover via the module-local `extractCover()` (the translator doesn't produce one).
- `getBook(id)` always fetches metadata + cover fresh from `GET /books/:id` (cheap, and the backend is now the persistent source of truth for covers); only the EPUB bytes are checked against the IDB cache first, falling back to `GET /books/:id/file`.
- `getAllBooks()` is `GET /books` — metadata + cover (base64 data URL, read server-side from `cover_path`) for every book owned by the current user, deduped by construction (one Postgres row per book).
- `deleteBook(id)` is `DELETE /books/:id`, then evicts the IDB cache entry.
- `syncLibrary()` is gone — it existed to reconcile Drive's file listing with `bibliotheque-data.json`; the new backend's Postgres row *is* the catalog, so there's nothing to reconcile.

Book IDs are Postgres UUIDs (`books.id`), not Drive file IDs.

### Backend migration (`server/`)

Standalone Node/Express app (own `package.json`, ESM). Not yet deployed anywhere — local dev only so far (see Commands above). Phases 1–4 of `MIGRATION_PLAN.md` are done: every table has live routes, and every `@google/generative-ai` call has moved server-side (`server/src/gemini.js`) — there is no Gemini key left in the frontend bundle. Only phase 5 (one-shot Drive migration script, not yet written) and phase 6 (actual VPS deployment) remain.

Auth deliberately does **not** use an ID-token/GIS-button flow: the frontend still drives sign-in through the pre-existing Google OAuth2 popup (`src/lib/googleAuth.js`, unchanged), and this is now the *only* reason that flow (and its `drive` scope) still exists.
- `POST /auth/google` (`server/src/routes/auth.js`) takes the **access token** the frontend already has, verifies it two ways — Google's `tokeninfo` endpoint confirms `aud`/`azp` matches `GOOGLE_CLIENT_ID` (rejects a token minted for a different app), then `userinfo` (authenticated with that same token) supplies profile fields — upserts a `users` row keyed on `google_sub`, and sets an httpOnly session cookie (JWT, `server/src/session.js`, 7-day expiry).
- `src/contexts/AuthContext.jsx` calls this additively: `establishBackendSession()` runs after every place the Drive-OAuth flow already obtains/refreshes a token (initial load if already signed in, `signIn()`, and the periodic silent-refresh effect) and swallows its own errors so a backend hiccup never blocks sign-in itself. `signOut()` also calls `POST /auth/logout` to clear the cookie.
- `requireAuth` middleware (`server/src/middleware/requireAuth.js`) verifies the session cookie on every other route and sets `req.userId`; every route below scopes its query by it.
- Postgres schema (`server/src/db/schema.sql`, applied via `npm run migrate`): `users`, `books`, `progress`, `custom_prompts`, `deleted_default_prompt_ids`, `quiz_progress`, `pomodoro_log`, `revision_sheets`. `custom_prompts.id` is `TEXT` (not a server-generated UUID like every other table's `id`) — prompt ids are always client-generated (fixed strings for defaults, `custom-${Date.now()}` for user-created ones, see `src/components/ChatPanel.jsx`) and `savePrompt()` upserts by id, so the primary key is the composite `(user_id, id)`.
- File storage (`server/src/storage.js`): EPUB + cover files on local disk at `STORAGE_DIR/{userId}/books/{bookId}.epub` and `.../covers/{bookId}.<ext>` (`STORAGE_DIR` defaults to `./data`, gitignored; becomes a persisted volume path on the VPS). Cover extraction itself still happens client-side via epubjs (unchanged, see `extractMeta()` in Library.jsx / `extractCover()` in storage.js) — the backend only ever receives and stores the resulting base64 data URL, it never parses an EPUB itself.
- Routes, one file per resource: `server/src/routes/{books,progress,prompts,quiz,pomodoro,revisionSheets}.js`. `quiz.js`'s `:chapterHref` param is a full section href that may itself contain `/` — the frontend `encodeURIComponent()`s it into one path segment before interpolating into the URL, and Express decodes it back transparently into `req.params.chapterHref`.
- `src/lib/api.js` is the frontend's thin fetch wrapper (`credentials: 'include'` for the session cookie) — `apiGet`, `apiGetBuffer`, `apiPostJson`, `apiPutJson`, `apiPost`, `apiPostForm`, `apiDelete`.
- `server/src/gemini.js` — a near-verbatim port of the original client-side `src/lib/geminiApi.js` (same prompts, schemas, validation), the one meaningful difference being `GEMINI_API_KEY` now comes from `process.env` instead of a function parameter. `server/src/routes/ai.js` wraps each exported function in a `requireAuth`-gated `POST /ai/*` route (see "AI reading assistant" below for the frontend side of this split). Every route ties an `AbortController` to the Express request's `close` event (`abortOnClose()`) so a client disconnect actually cancels the in-flight Gemini call server-side, not just abandons it. Two routes stream a response instead of returning one JSON blob: `/ai/chat` writes raw text chunks (`Content-Type: text/plain`) as they arrive from `streamChatMessage()`; `/ai/revision-set` writes one JSON object per line (`Content-Type: application/x-ndjson`) — one line per `generateRevisionSet()` progress event. Both track a `started` flag so an error *before* the first chunk/line still gets a clean JSON `{error}` response, while an error *after* streaming has begun can only end the connection (headers are already committed by then).
- Of the five modules migrated in phase 3, only `progress.js` and `customPrompts.js` keep an in-memory mirror (populated lazily, reset on sign-out) — `progress.js` because saves are debounced per book on a hot path (page turns), `customPrompts.js` because its default-prompt merge/backfill logic (see the AI reading assistant section below) must run once per session, not on every read. `quizProgress.js` and `pomodoroLog.js` dropped their in-memory cache entirely — reads/writes are infrequent enough that hitting the backend directly every time is simpler and always fresh; their `resetQuizProgress()`/`resetPomodoroLog()` exports are now no-ops, kept only so `AuthContext`'s sign-out sequence didn't need editing.

### One-time Drive import (`ImportFromDriveModal.jsx`)

Phase 5 of `MIGRATION_PLAN.md`, deliberately built as an in-app tool (triggered by an "Importer depuis Drive" button in Library.jsx) rather than a standalone Node script — a script would need its own OAuth handling (the browser's implicit-grant token isn't usable from Node) and can't run epubjs (browser-only APIs: Blob, FileReader, DOMParser) for cover extraction. Running inside the already-signed-in browser sidesteps both problems for free, reusing modules that already exist on both ends: `driveStorage.js`/`driveApi.js` to read the old data, `storage.js`/`progress.js`/`customPrompts.js`/`quizProgress.js`/`pomodoroLog.js`/`revisionSheets.js` (all already backend-wired since phases 2-3) to write it to the new backend.

- Reads the whole legacy blob via `loadData()`, then works through it in a fixed order — books first, since every other data type is keyed by the book's *old* Drive file id and needs remapping to the *new* Postgres book id: an `idMap` (`Map<driveId, newBookId>`) is built while importing books, then consulted (skipping entries with no match) for progress, quiz progress, and the pomodoro log.
- Per book: `downloadFile(driveId)` (`driveApi.js`) for the EPUB bytes, `extractCover()` (now exported from `storage.js`, not just used internally by `saveTranslatedBook`) for the cover, then `saveBook()` — which already dedupes by title+author server-side, so re-running the whole import is safe for books specifically.
- Re-running is *broadly* safe but not uniformly so: progress and quiz progress converge to the same end state on a second run (last-write-wins / reset-then-set), pomodoro history explicitly checks `getPomodoroStats(newBookId)` first and skips if an entry already exists (otherwise its increment-based writes would double-count), but **revision-sheet notes have no natural dedup key server-side and will duplicate on a second run** — called out directly in the modal's setup screen copy rather than solved, since this tool is meant for a single run per account.
- Quiz progress and pomodoro history are imported as faithfully as the new data model allows, not byte-for-byte: a quiz's cached question set is restored via `saveQuizQuestions()` (so replaying it costs no new Gemini call), and if it had a completed attempt, exactly one `saveQuizAttempt()` call seeds the historical best score — the true historical *attempt count* isn't preserved. Similarly, a book's whole pomodoro history collapses into one `recordCompletedCycle()` call (`sessionsCompleted` becomes 1), but the true aggregate totals (minutes, exercises answered/correct) are preserved exactly.

### Auth context & routing

`src/contexts/AuthContext.jsx` wraps auth state and exposes `{ user, loading, signIn, signOut }`. `AuthProvider` is mounted in `main.jsx` around `<App>`. `user` has shape `{ sub, name, email, picture }` from the Google OAuth userinfo endpoint. `signOut()` chains `gSignOut → POST /auth/logout → resetProgress → resetCustomPrompts → resetQuizProgress (no-op) → resetPomodoroLog (no-op) → clearAllCache`.

Routes:

| Route | Component | Auth required |
|---|---|---|
| `/auth` | `Auth` | No |
| `/` | `Library` | Yes (`ProtectedRoute`) |
| `/read/:id` | `Reader` | Yes (`ProtectedRoute`) |
| `/stats` | `Stats` | Yes (`ProtectedRoute`) |

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
- Opening a book (card click or `↺ From beginning`) shows `ReadingModeModal.jsx` — free reading vs. Pomodoro learning mode — before navigating to `/read/:id`; the choice is passed as router state (`{ mode: 'free' | 'learning' }`) rather than a URL param or persisted setting.
- "Importer depuis Drive" button opens `ImportFromDriveModal.jsx` — see "One-time Drive import" above. `onImported` re-fetches both books and progress (`getAllBooks()` + `getAllProgress()`) the same way the initial page-load effect does.

### Reader UX details

- Themes: `night` (dark brown), `sepia` (warm cream), `day` (off-white). Font size 13–26 px, 1 px steps.
- Reading position (CFI + percentage) is loaded via `getProgress(id)` and saved via `saveProgress(id, cfi, pct)` from `src/lib/progress.js` (backend-backed, debounced per book, flushed on tab hide/unmount).
- Keyboard: `ArrowLeft`/`ArrowRight` navigate; `Escape` closes panels; `f`/`F` toggles fullscreen. Wired on both `window` and epubjs `rendition`.
- Mobile tap zones: left/center/right invisible overlay — left/right navigate, center toggles chrome visibility.
- Fullscreen: toggled via `document.fullscreenElement`; keyboard shortcut `f/F`. The current CFI is saved to `preFullscreenCfiRef` before the toggle; on `fullscreenchange`, the rendition is resized with `resize('100%','100%')` and position is restored via `display(cfi)` after a 100 ms settle delay (prevents blank page on viewport resize).

### Vite / build notes

`vite.config.js` explicitly pre-bundles epubjs (`optimizeDeps.include`) and targets `es2020` — required because epubjs uses dynamic `import()` patterns that confuse Vite's auto-detection.

`src/main.jsx` unregisters any active service worker on every load (leftover `public/sw.js` purges its own caches and unregisters itself) — the app is not a PWA.

### Styling

CSS Modules per page (`Library.module.css`, `Reader.module.css`, `Auth.module.css`). Global baseline in `src/index.css`. Fonts from Google Fonts in `index.html`: Cormorant Garamond (headings), Libre Baskerville (reader body), Space Mono (monospace accents).

### Reader chrome behaviour

Top bar, nav arrows, and bottom bar auto-hide after 3.5 s of inactivity. Any `mousemove` or click resets the timer. Panels (TOC, settings, chat) prevent the hide timer while open.

### AI reading assistant

The actual `@google/generative-ai` calls live in `server/src/gemini.js` (model `gemini-3.5-flash-lite`, const `MODEL`) — see "Backend migration" above. `src/lib/geminiApi.js` on the frontend is now just an HTTP client over `POST /ai/*` with the exact same exported function names/shapes it had when it called Gemini directly (every call site — ChatPanel, QuizModal, PomodoroModal, TranslateBookModal/epubTranslator — only had to stop passing `apiKey`, nothing else changed). All system instructions force French output. What each one does (prompts/schemas/validation are unchanged by the phase-4 move, just relocated):
- `streamChatMessage()` — async generator yielding text chunks for free-form chat; injects full page text as context.
- `generateRevisionSheet()` — non-streaming; one structured markdown revision sheet (résumé, concepts clés, termes importants, questions de révision) for the whole chapter, in one call.
- `generateRevisionSet()` — async generator producing *one revision sheet per concept* instead of a single cramped document: a `planRevisionSheets()` call first asks the model for a JSON plan (`PLAN_SCHEMA`: `slug`/`title`/`sourceHeading` per concept), which is then validated against real `#`–`######` heading lines extracted from the page text (`validatePlanAgainstHeadings` — drops any planned sheet whose `sourceHeading` doesn't literally appear in the source, since a one-shot long generation was observed to dilute rule-following as it progressed). Each validated concept is then generated with its own `generateSheetForConcept()` call (exported standalone so a single failed card can be retried without re-running the plan). Yields progress events: `planning`, `plan`, `sheet-start`, `sheet-done`, `sheet-error`, `plan-error`, `aborted`, `done`.
- `generateQuiz({ mode: 'exercise' | 'interview' })` — non-streaming, single structured call (`QUIZ_SCHEMA`) returning a validated array of QCM questions (`{ question, options[4], correctIndex, explanation }`, Markdown/fenced-code allowed in text fields). `mode: 'exercise'` uses `EXERCISE_QUIZ_RULES` (new practice scenarios grounded in the chapter, mixing archetypes — predict output, spot the bug, fill-in-the-blank — rather than plain definition recall); `mode: 'interview'` uses `INTERVIEW_QUIZ_RULES` + `ANTI_FABRICATION_RULES` (never invent APIs/examples not in the source, alternate conceptual/technical). Both explicitly require each question to be self-contained: any class/function referenced from an earlier example must be reproduced in full in the question text, never referenced by name alone.
- `generateSessionExercises()` — same `QUIZ_SCHEMA`/`EXERCISE_QUIZ_RULES` machinery as `generateQuiz`, but grounds 2-3 questions in the concatenated text read during one Pomodoro cycle (capped to the trailing `SESSION_TEXT_CHAR_CAP` chars) instead of a whole chapter; see Pomodoro learning mode below. Deliberately uncached — each cycle is a fresh call.

`src/lib/customPrompts.js` — backend-backed CRUD for the chat's suggested-prompt list (`getAllPrompts`/`savePrompt`/`deletePrompt`), via `GET/PUT/DELETE /prompts` (`server/src/routes/prompts.js`). Ships 5 `DEFAULT_PROMPTS` (revision-sheet, revision-set, plus 3 plain `chat` prompts) identified by stable ids. `ensurePrompts()` merges in any default added after a user's account already existed (matched by id) — the same code path also seeds all of them for a brand new account, since `GET /prompts` simply returns an empty list rather than requiring a separate "first load" branch; it also drops any prompt whose id is in `RETIRED_DEFAULT_IDS` (former `prepare-interview`/`learning-package` defaults, superseded by the Quiz feature below) so stale entries disappear from existing users' data too. Deleting a default prompt calls `DELETE /prompts/:id?markDeletedDefault=true` so the merge step doesn't resurrect it — the backend has no notion of "which ids are defaults," that check (`DEFAULT_PROMPTS.some(...)`) stays entirely on the frontend. Module-level cache reset via `resetCustomPrompts()` on sign-out.

`src/components/ChatPanel.jsx` — bottom drawer, resizable (drag handle, `MIN_DRAWER_HEIGHT`–`MAX_DRAWER_HEIGHT_RATIO` of viewport), renders markdown via `react-markdown` (+ `rehype-highlight` for syntax-colored code blocks; a bespoke `hljs-*` palette lives in each component's CSS module rather than an imported theme) with custom component overrides. Suggested prompts are loaded from `customPrompts.js` and dispatch on `prompt.type`:
- `chat` — sends as a normal message.
- `revision-sheet` — single non-streaming call, rendered as a `revision-sheet` message with a **Save** button (`saveNotesheet()` from `src/lib/revisionSheets.js` → `POST /revision-sheets`; the return value, a new row id, is unused — only success/failure matters to the caller).
- `revision-set` — rendered as a card grid (`role: 'revision-set'`) that fills in as each concept streams in via the generator's progress events; each card has retry, per-card download, and a **download all** button (`downloadAllSheets()`, staggered 200 ms apart to avoid browser throttling).
- A **custom prompt manager** (add/edit/delete, `promptForm` state) lets the user create their own suggested prompts of any type; editing auto-expands the drawer to near-fullscreen.

Note: `react-markdown` v10 no longer passes an `inline` prop to the `code` component (removed in v8) — block vs. inline is instead distinguished purely in CSS via a `.mdPre .mdCode` descendant selector, and the `code` component always applies its own class *before* spreading the rest of the props so rehype's `language-xxx` class (added to fenced code with a language tag) doesn't silently overwrite it.

Assistant replies that contain multiple named documents (e.g. a multi-file custom-prompt response) are parsed by `extractDownloadableFiles()` — first tries `` `filename.ext` `` markers immediately followed by a fenced block (tracking fence depth so nested code fences don't break file boundaries), then falls back to splitting on top-level ` ```markdown ` fences and naming each chunk from its first heading — surfaced as individual download buttons.

Chat history sent to Gemini is capped at the last 20 messages via `buildHistory()`, which excludes `separator`, `revision-sheet`, `revision-set`, and in-flight streaming messages. A `separator` message ("New page") is inserted automatically when `pageChangeSignal` changes. Streams responses chunk by chunk; aborts in-flight requests (`AbortController`) on unmount or explicit cancel.

`src/lib/languages.js` — shared `LANGUAGES` list (`{code, label}`) and `languageLabel(code)`, used by the whole-book translator below.

### Interactive quizzes (QCM)

Exercises and interview prep are played as interactive multiple-choice quizzes directly in the Reader, not read as Markdown in the chat drawer.

- **Entry points**, both in `Reader.jsx`: a permanent toolbar icon (opens a small picker for the current chapter: Exercices / Entretien, each showing a cached best score if one exists) and a one-time end-of-chapter nudge banner. The banner is triggered from the `relocated` handler when the detected chapter href changes; a `nudgedChaptersRef` Set prevents re-showing it for a chapter already left this session. Current-chapter detection uses `loc.start.href` (the section href epubjs already resolves) matched against `nav.toc` — **not** `loc.start.cfi` substring-matching, which is unreliable since a CFI encodes a spine index + manifest id and never contains the href literally.
- Because the iframe has already moved to the new chapter by the time the nudge fires, `pageTextRef.current` is snapshotted into the banner's state at the exact moment the href changes (before the `capturePageText()` RAF callback overwrites it), so the nudge can generate a quiz grounded in the chapter just left.
- `src/components/QuizModal.jsx` (+ `.module.css`) — full-screen overlay (mounted from `Reader.jsx`, not `ChatPanel.jsx`) with four phases: loading (skip straight to `start` if a cached quiz exists for this book/chapter/mode) → start (shows best score if any, **Commencer**/**Rejouer**, and a **Régénérer** button) → playing (one question at a time, progress bar, 4 answer buttons with immediate green/red feedback + explanation) → summary (score, **Rejouer** replays the same cached questions with no new Gemini call, **Fermer**).
- `src/lib/quizProgress.js` — thin client over `GET/PUT/POST /books/:bookId/quiz/...` (`server/src/routes/quiz.js`), no in-memory cache (see "Backend migration" above). Conceptually still `{ [chapterHref]: { exercise: Entry, interview: Entry } }` per book, where `Entry = { questions, generatedAt, bestScore, total, attempts, completed, lastAttemptAt }`, just backed by Postgres rows keyed `(user_id, book_id, chapter_href, mode)` instead of a nested JS object. `saveQuizQuestions()` (`PUT`) is only ever called right after a *fresh* Gemini generation (first time or an explicit Régénérer) so it always resets stats to zero rather than carrying forward the previous question set's score. `saveQuizAttempt()` (`POST .../attempt`) updates `bestScore`/`attempts`/`completed` when a playthrough reaches the summary screen. `getAllQuizProgress(bookId)` backs the per-chapter ✓ badges and aggregate count in the TOC sidebar.

### Pomodoro learning mode

An alternative timed reading mode, chosen per-session via `ReadingModeModal.jsx` (see Library UX above) and locked for the session — `Reader.jsx` reads the choice once at mount from router state (`isLearningMode`) with no mid-session toggle.

- While active, a 25-minute (`CYCLE_MINUTES`) wall-clock cycle runs via `setInterval`, recomputed from a `cycleEndAtRef` deadline each tick (not a decrementing counter) so a backgrounded/throttled tab doesn't drift or burst-fire on wake. The remaining time is shown in a toolbar pill (`.pomodoroPill`).
- Text read during the cycle is accumulated per-chapter into `cycleChaptersRef` (a `Map<href, {label, text}>`) from the same `relocated` handler that drives the free-reading end-of-chapter nudge — the two features are mutually exclusive (learning mode never shows the nudge) since a chapter boundary crossed mid-cycle would otherwise trigger both.
- When the deadline fires, `PomodoroModal.jsx` opens as a full-screen overlay: generates 2-3 exercises via `generateSessionExercises()` grounded in the accumulated cycle text, plays them one at a time, then records the cycle and runs a skippable 5-minute (`BREAK_MINUTES`) break before calling `onCycleFinished` (closes the modal and starts the next cycle via `startCycle()`). If the deadline fires while a manual quiz (`QuizModal`) is already open, only the modal's *display* is deferred via `cycleDueRef` until the quiz closes — the two full-screen overlays never stack. There is no dismiss affordance during generation/play: the only way out of an active cycle is leaving the Reader, and an interrupted cycle is never recorded.
- `src/lib/pomodoroLog.js` — thin client over `GET/POST /pomodoro` (`server/src/routes/pomodoro.js`), no in-memory cache. One row per `(user_id, book_id)`: `{ sessionsCompleted, totalMinutes, exercisesAnswered, exercisesCorrect, firstSessionAt, lastSessionAt }` — deliberately compact aggregates only, no per-session question/answer log. `recordCompletedCycle()` (`POST /pomodoro/:bookId/cycle`) is the only write, called once per cycle when the summary screen is reached; the backend increments the row (`sessions_completed + 1`, minutes/answered/correct summed) rather than the frontend read-modify-writing it.
- `src/pages/Stats.jsx` (route `/stats`, linked from the Library header) cross-references `getAllPomodoroStats()` with `getAllBooks()` to show aggregate tiles (sessions, time, accuracy) plus a per-book breakdown; entries for since-deleted books are dropped.

### Whole-book translation

`src/lib/epubTranslator.js` — translates an entire EPUB to another language via Gemini while preserving archive structure and formatting. Triggered per-book from Library.jsx (`TranslateBookModal.jsx`), not from the Reader — it's a batch job against the archived file, unrelated to any open reading session.

Key design point: after `book.ready`, `book.archive.zip` is the live, fully-loaded JSZip instance backing the open book (epubjs dependency, already present in `node_modules`). The translator never rebuilds the archive — it reads each target file via `book.archive.getText(url)`, overwrites only the files it changes via `zip.file(path, newContent)`, and calls `zip.generateAsync(...)` once at the end; everything else (images, fonts, CSS, `mimetype`) round-trips untouched.

- Per chapter (`book.spine.spineItems`), the raw XHTML is parsed with `DOMParser` (`application/xhtml+xml`, falling back to `text/html` on a parser error) and walked for translatable block elements (`p, h1-h6, li, blockquote, td, th, dd, dt, figcaption`). Within each block, any nested `code`/`pre`/`math` is masked out as a `⟦N⟧` token (the actual removed DOM node is kept, not a re-serialized HTML string) before the block's text is sent to Gemini, then spliced back verbatim after — this is what keeps code and math byte-identical through translation even when nested inside a translated paragraph. Formatting other than code/math (bold, italic, links) is *not* individually preserved.
- Gemini calls are batched per chapter (`translateSegments()` in `geminiApi.js`, structured JSON: array of `{id, text}` in, array of `{id, text}` out), splitting only past a ~5000-char / 60-segment budget — bounds total calls to roughly one per chapter rather than one per paragraph. `validateBatch()` never trusts the reply's structure: checks segment count, id set, and that each segment's `⟦N⟧` token set is preserved, before accepting it. A failed batch is retried once, then falls back to one call per individual segment; a segment that still fails keeps its original untranslated (but token-intact) text rather than ever fabricating a translation.
- The nav document (EPUB3 `book.packaging.navPath`) or NCX (`ncxPath`) is translated through the same pipeline, so the in-reader TOC matches the translated prose.
- Only the OPF's `dc:language` is rewritten (`patchOpfLanguage()`) — `dc:title`/`dc:creator` are never touched, to avoid any hallucinated/mistranslated title. **The OPF must be read/written via its raw zip-relative key (`book.container.packagePath`, decoded) directly — never through `book.resolve()`**, which by the time `book.ready` has resolved treats `packagePath` as relative to the OPF's own directory (since `book.path` is set to the OPF's own path during opening) and silently double-prefixes it (e.g. `OEBPS/content.opf` → `OEBPS/OEBPS/content.opf`); confirmed by direct testing against real EPUBs. Spine/nav/ncx hrefs are the opposite case — they *are* OPF-relative, so `book.resolve()` is correct for those.
- `estimateTranslation({ arrayBuffer })` runs the same parsing/segmentation pass with zero Gemini calls, returning chapter/segment/char counts and an estimated call count — shown to the user for confirmation before a real run starts.
- `translateEpub({ arrayBuffer, targetLang, signal })` is the orchestrating async generator (sequential, one chapter at a time — no worker-pool, matching every other Gemini async generator in this codebase), yielding progress events (`plan`, `chapter-start`, `chapter-done`, `chapter-error`, `nav-*`, `metadata-*`, `building`, `done` with `{blob, stats}`, `aborted`). There is no client-side `NO_API_KEY` pre-check anymore (removed along with the `apiKey` param in phase 4) — a missing server-side `GEMINI_API_KEY` now simply surfaces as a `chapter-error`/`nav-error` event on the first segment batch, same as any other translation failure.

`src/components/TranslateBookModal.jsx` — per-book modal opened from a `⇄` button on the Library card (hidden on books that are themselves already a translated copy, i.e. have `translatedFrom` set). Flow: language picker + estimate (warns if a translation into that language already exists for this book) → confirm → chapter-by-chapter progress list with a Stop button (`AbortController`) → on completion, auto-saves via `saveTranslatedBook()` (`POST /books`, see Book storage facade above) and offers an immediate local download regardless of upload outcome, with an isolated upload retry (the generated blob stays in memory, so retrying never re-runs any Gemini calls).
