# Migration Drive → backend auto-hébergé (VPS)

> **Statut** : Phases 1–5 faites — voir `server/` et `src/components/ImportFromDriveModal.jsx`. Plus rien dans l'app live ne lit/écrit Google Drive comme fonctionnement normal (seul l'import ponctuel y accède encore, volontairement), et plus aucune clé Gemini côté client. Reste à valider avec un vrai sign-in Google en navigateur et un vrai compte Drive (non scriptable depuis l'agent). Phase 6 (déploiement VPS) pas commencée.
>
> Note d'implémentation (Phase 1–2) : l'auth backend vérifie l'**access token** OAuth2 déjà utilisé par le flow Google Sign-In existant (via `tokeninfo`/`userinfo` de Google), pas un ID token via un bouton GIS dédié comme décrit plus bas. Ce choix reste valable maintenant que Phases 3–5 sont finies : le flow OAuth2 est toujours ce qui authentifie l'utilisateur, donc pas de raison de le remplacer tant qu'un nettoyage dédié n'est pas fait exprès.
>
> Note (Phase 3) : `custom_prompts.id` est `TEXT` (composite `(user_id, id)`), pas un UUID généré serveur comme les autres tables — les ids de prompts sont toujours générés côté client (ids fixes pour les défauts, `custom-${Date.now()}` pour ceux créés par l'utilisateur), et `savePrompt()` fait un upsert par id.
>
> Note (Phase 4) : le câblage bout-en-bout vers l'API Gemini est vérifié (auth, streaming, NDJSON, gestion d'erreur — voir `POST /ai/chat` et `POST /ai/revision-set` testés en direct), mais la clé `GEMINI_API_KEY` existante a ses crédits prépayés épuisés (429 côté Google, indépendant de cette migration — même clé, même compte que l'ancienne implémentation côté client). Les tests de validation (`NO_API_KEY`, `NO_PAGE_TEXT`, gating auth) sont tous passés ; seule une génération réussie avec du vrai contenu généré n'a pas pu être observée. Rien à corriger côté code — juste besoin d'une clé avec du crédit (ou d'attendre le renouvellement) pour un test complet en conditions réelles.
>
> Note (Phase 5) : rebâtie en import in-app plutôt qu'en script Node autonome (voir la discussion dans la conversation) — le scope `drive` de l'OAuth existant restait donc nécessaire, pas seulement toléré comme "vestige temporaire", tant que l'outil existait.
>
> Post-migration (2026-09) : l'outil d'import Drive (`ImportFromDriveModal.jsx`) et les fichiers `driveApi.js`/`driveStorage.js` ont été supprimés — plus nécessaires une fois la migration personnelle faite. Le scope OAuth `drive` a été retiré en même temps (`googleAuth.js`, `SCOPE_VER` bumpée à `v5`). Voir CLAUDE.md pour l'état actuel.

## Contexte

Aujourd'hui **Bibliothèque** n'a pas de backend : tout l'état (livres, progression, prompts, quiz, pomodoro) vit dans un unique blob JSON (`bibliotheque-data.json`) sur le Google Drive personnel de l'utilisateur, et les EPUB sont uploadés comme fichiers Drive. L'auth est un flow OAuth2 implicite Google (scope Drive) géré entièrement côté client (`src/lib/googleAuth.js`). Les appels Gemini (`src/lib/geminiApi.js`) tournent aussi côté client avec `VITE_GEMINI_API_KEY` embarquée dans le bundle.

Objectif : pouvoir ouvrir l'app à de nouveaux utilisateurs, hébergés sur un VPS que tu contrôles. Ça implique de sortir du modèle "chaque user a son propre Drive comme backend" vers un vrai service : une base de données partagée avec isolation par utilisateur, un stockage fichiers sur le VPS, et une API que le frontend consomme.

Décisions déjà actées avec toi :
- **Backend** : Node.js + Express (même écosystème JS que le frontend).
- **Auth** : on garde Google Sign-In (aucun mot de passe à gérer), mais vérifié côté serveur au lieu de manipuler un token Drive côté client.
- **Stockage** : disque local du VPS pour les fichiers + Postgres pour les métadonnées.
- **Migration** : rebuild complet en parallèle de l'app actuelle, puis migration ponctuelle de ton propre compte, puis bascule.

Ce document est un plan d'architecture et une feuille de route par phases — pas un diff ligne à ligne, vu l'ampleur du chantier. Chaque phase liste les fichiers concernés et reste testable indépendamment.

## Architecture cible

```
Navigateur (React/Vite, statique)
   │  fetch, credentials: 'include' (cookie de session httpOnly)
   ▼
Nginx (VPS) — TLS Let's Encrypt, sert le build statique, reverse-proxy /api/*
   ▼
Backend Node/Express (VPS, PM2 ou systemd)
   │              │
   ▼              ▼
Postgres      Disque local (/var/lib/bibliotheque/{userId}/…)
(métadonnées)  (fichiers EPUB + couvertures)
   │
   ▼
Appels Gemini (server-side, clé API jamais exposée au navigateur)
```

Docker Compose recommandé pour le VPS (services `app`, `postgres`, `nginx`) — reproductible, facilite les sauvegardes (volume Postgres + volume fichiers).

## Modèle de données (Postgres)

Mapping quasi 1:1 depuis le blob JSON actuel (`driveStorage.js` → `loadData()/saveData()`), ce qui simplifie beaucoup la migration :

- `users (id, google_sub unique, email, name, picture, created_at)`
- `books (id, user_id fk, title, author, added_at, language nullable, translated_from fk nullable, file_path, cover_path nullable)`
- `progress (user_id fk, book_id fk, cfi, pct, updated_at, PK(user_id, book_id))`
- `custom_prompts (id, user_id fk, type, title, content, is_default bool, created_at)`
- `deleted_default_prompt_ids (user_id fk, prompt_id, PK(user_id, prompt_id))`
- `quiz_progress (user_id fk, book_id fk, chapter_href, mode, questions_json jsonb, generated_at, best_score, total, attempts, completed, last_attempt_at, PK(user_id, book_id, chapter_href, mode))`
- `pomodoro_log (user_id fk, book_id fk, sessions_completed, total_minutes, exercises_answered, exercises_correct, first_session_at, last_session_at, PK(user_id, book_id))`
- `revision_sheets (id, user_id fk, title, content, created_at)` — le contenu markdown stocké directement en DB (petit volume de texte), plutôt qu'en fichier sur disque comme c'est le cas sur Drive aujourd'hui.

Chaque `user_id fk` assure l'isolation multi-tenant qui n'existe pas aujourd'hui (le Drive de chacun *est* déjà son isolation naturelle).

## API backend (REST, Express)

Auth :
- `POST /auth/google` — vérifie l'**access token** OAuth2 déjà utilisé par le flow Drive existant (`tokeninfo` + `userinfo` de Google, sans dépendance à `google-auth-library` — voir la note d'implémentation en haut de ce document), upsert `users`, pose un cookie de session httpOnly (JWT signé, ~7j).
- `POST /auth/logout`
- `GET /me`

Livres :
- `GET /books` — métadonnées + couverture (équivalent `getAllBooks`)
- `POST /books` — upload multipart, extrait couverture, écrit sur disque, insère la ligne (équivalent `saveBook`)
- `GET /books/:id/file` — stream l'EPUB (vérifie `user_id` propriétaire)
- `DELETE /books/:id`

Progression / prompts / quiz / pomodoro / notes : un endpoint REST par module existant (`progress.js`, `customPrompts.js`, `quizProgress.js`, `pomodoroLog.js`, `saveNotesheet`), calqué sur leurs fonctions publiques actuelles.

IA (voir point critique ci-dessous) :
- `POST /ai/chat` (streaming texte brut), `POST /ai/revision-sheet`, `POST /ai/revision-sheet-concept`, `POST /ai/revision-set` (streaming NDJSON), `POST /ai/quiz`, `POST /ai/session-exercises`, `POST /ai/translate-segments`.

## Point critique à ne pas sauter : la clé Gemini — ✅ résolu (Phase 4)

`VITE_GEMINI_API_KEY` était embarquée dans le bundle client (visible dans le devtools réseau de n'importe qui). Ça passait pour un usage strictement personnel, mais **ouvrir l'app à d'autres users avec cette clé encore côté client leur aurait donné un accès direct au quota/à la facturation Gemini**. Ce n'était pas optionnel dans ce projet, donc pas traité comme un "plus tard" : tous les appels `@google/generative-ai` ont migré côté serveur (`server/src/gemini.js`, appelé par `POST /ai/*` dans `server/src/routes/ai.js`) ; `geminiApi.js` côté frontend n'est plus qu'un client HTTP vers ces routes, et plus aucune clé Gemini n'existe côté client.

## Adaptation frontend — principe : garder les mêmes façades

Pour limiter la casse dans `Library.jsx`, `Reader.jsx`, `ChatPanel.jsx`, `QuizModal.jsx`, `PomodoroModal.jsx` (qui n'importent que les façades, jamais Drive directement) :
- Nouveau `src/lib/api.js` : petit wrapper fetch vers le backend (`credentials: 'include'`).
- `src/utils/storage.js` garde les mêmes exports (`saveBook`, `getBook`, `getAllBooks`, `deleteBook`) mais appelle `api.js` au lieu de `driveApi.js`/`driveStorage.js`. `syncLibrary()` disparaît (n'a plus de sens sans Drive comme source de vérité externe).
- `src/lib/progress.js`, `customPrompts.js`, `quizProgress.js`, `pomodoroLog.js` gardent leurs fonctions publiques actuelles (mêmes noms/signatures, mêmes patterns de cache module-level + reset au sign-out) mais leur implémentation interne appelle `api.js` au lieu de `driveStorage.loadData/saveData`.
- `src/lib/bookCache.js` (cache IndexedDB des EPUB) change très peu : il télécharge depuis `/books/:id/file` au lieu de `downloadFile` (Drive).
- `src/lib/googleAuth.js` — **en pratique laissé tel quel**, contrairement à ce que cette section prévoyait initialement (voir la note d'implémentation Phase 1–2 en haut de ce document) : le flow OAuth2 implicite existant (scope Drive inclus) reste la mécanique de sign-in, et `POST /auth/google` vérifie l'access token qu'il produit déjà plutôt que d'exiger un second flow ID-token/bouton GIS.
- `src/contexts/AuthContext.jsx` garde la même forme `{ user, loading, signIn, signOut }` consommée par le reste de l'app ; `establishBackendSession()` y est ajouté de façon additive (voir CLAUDE.md § Backend migration) plutôt que de remplacer le flow existant.

## Feuille de route par phases

1. **Backend skeleton** ✅ — Express + Postgres (schéma ci-dessus, migrations via ex. `node-pg-migrate` ou SQL brut) + `POST /auth/google` + `GET /me` + middleware `requireAuth` (vérifie le cookie de session). Testable seul : login réel avec ton compte Google, cookie posé, `/me` répond.
2. **Livres & fichiers** ✅ — endpoints `books`, stockage disque VPS (en local d'abord : `./data/library/{userId}/`), bascule `storage.js` + `bookCache.js` sur la nouvelle API. Testable : upload/liste/lecture/suppression d'un EPUB de bout en bout dans l'UI existante.
3. **Progression / prompts / quiz / pomodoro / notes** ✅ — un module Drive à la fois migré vers son endpoint + table, en gardant la façade JS identique. Testable module par module (la progression de lecture se sauve, le quiz garde son meilleur score, etc.).
4. **IA côté serveur** ✅ — déplacer tous les appels `@google/generative-ai` dans le backend, `geminiApi.js` devient un client HTTP vers `/ai/*` (chat en streaming brut, revision-set en NDJSON, le reste en JSON simple). `VITE_GEMINI_API_KEY` supprimée du frontend.
5. **Import Drive → nouveau backend** ✅ — finalement construit comme un outil in-app (`ImportFromDriveModal.jsx`, bouton dans Library.jsx) plutôt qu'un script Node autonome, pour éviter un second flow OAuth et le fait qu'epubjs (extraction de couverture) ne tourne pas hors navigateur. Réutilise `driveStorage.js`/`driveApi.js` en lecture et les façades déjà branchées au nouveau backend en écriture. Un run, un seul compte (le tien) au départ ; rejouable sans risque sauf pour les fiches de révision (voir CLAUDE.md § One-time Drive import).
6. **Déploiement VPS** — Docker Compose (`app`, `postgres`, `nginx` + Let's Encrypt), variables d'env (`DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GEMINI_API_KEY`, `SESSION_SECRET`), volumes persistants pour Postgres et les fichiers, stratégie de backup (`pg_dump` + rsync du volume fichiers, cron).
7. **Plus tard, hors scope immédiat** — écran de signup pour de nouveaux users, quotas de stockage par compte, rate-limiting des appels IA par user, observabilité (logs, erreurs). À ne pas construire avant que 1–6 tournent correctement pour ton propre usage.

## Vérification

- Phases 1–3 : lancer Postgres local (Docker), lancer le backend en dev, pointer le frontend Vite dessus (`VITE_API_URL`), reproduire chaque flow existant (upload livre, lecture avec sauvegarde de progression, quiz, session pomodoro, prompts custom) et confirmer qu'il n'y a plus aucun appel réseau vers `googleapis.com/drive`.
- Phase 4 : confirmer via l'onglet réseau du navigateur qu'aucune clé Gemini ne transite plus côté client, et que le chat streame toujours correctement depuis `/ai/chat`.
- Phase 5 : cliquer "Importer depuis Drive" dans la bibliothèque (compte réel, avec de vraies données Drive), puis comparer manuellement quelques livres/scores/prompts entre l'ancien Drive et le nouveau Postgres pour valider l'intégrité. Vérifier aussi qu'un second clic ne duplique pas les livres/progression/quiz (comportement attendu), mais duplique bien les fiches de révision (limite connue, pas un bug).
- Phase 6 : déploiement sur le VPS réel, test complet en HTTPS depuis un navigateur externe, redémarrage du VPS pour vérifier que PM2/systemd + Docker Compose relancent bien tous les services.
