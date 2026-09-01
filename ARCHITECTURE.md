# Architecture — Bibliothèque

Documentation technique de référence, pensée pour être lue par un humain. Pour le détail exhaustif fichier par fichier (utile pour Claude Code ou pour un debug fin), voir `CLAUDE.md`. Pour l'historique et la feuille de route de la migration Drive → backend, voir `MIGRATION_PLAN.md`.

## Vue d'ensemble

Bibliothèque est une liseuse EPUB personnelle avec assistant de lecture IA (chat, fiches de révision, quiz, mode Pomodoro) et traduction de livres entiers. L'app était à l'origine 100% côté client avec Google Drive comme stockage ; elle migre actuellement vers un backend auto-hébergé pour permettre l'ouverture à d'autres utilisateurs.

**État actuel** : Phases 1 à 5 de la migration sont faites (voir `MIGRATION_PLAN.md`). Tout — livres, progression, prompts, quiz, pomodoro, notes, appels IA — passe par le nouveau backend. Il ne reste que la Phase 6 (déploiement sur un vrai VPS), pas encore faite.

## Stack technique

| Couche | Techno |
|---|---|
| Frontend | React 18 + Vite 5, epubjs (rendu EPUB), react-router-dom v6, react-markdown |
| Backend | Node.js + Express (ESM), projet séparé dans `server/` |
| Base de données | PostgreSQL |
| Stockage fichiers | Disque local (EPUB + couvertures) |
| IA | API Gemini (`gemini-3.5-flash-lite`), appelée uniquement côté serveur |
| Auth | Google Sign-In (OAuth2), session applicative en cookie httpOnly |

## Architecture générale

```
Navigateur (React/Vite)
   │  fetch, credentials: 'include' (cookie de session)
   ▼
Backend Express (server/)
   │              │              │
   ▼              ▼              ▼
Postgres      Disque local    API Gemini
(métadonnées)  (EPUB+covers)  (jamais exposée au navigateur)
```

Le frontend ne parle jamais directement à Postgres, au disque, ni à Gemini — tout passe par l'API du backend. La seule exception volontaire est l'outil d'import Drive ponctuel (voir plus bas), qui lit encore Google Drive directement depuis le navigateur.

## Structure du repo

```
dkut/
├── src/                  # Frontend React
│   ├── pages/            # Library, Reader, Auth, Profile
│   ├── components/       # ChatPanel, QuizModal, PomodoroModal, modals divers
│   ├── lib/               # Clients API, logique métier (progress, quiz, pomodoro, prompts…)
│   └── utils/storage.js  # Façade "livres" utilisée par Library/Reader
├── server/               # Backend Express — projet Node séparé, son propre package.json
│   ├── src/routes/       # Un fichier par ressource (books, progress, prompts, quiz, pomodoro, ai…)
│   ├── src/gemini.js     # Tous les appels à l'API Gemini
│   ├── src/db/schema.sql # Schéma Postgres
│   └── src/storage.js    # Écriture des fichiers EPUB/couvertures sur disque
├── CLAUDE.md             # Doc exhaustive fichier-par-fichier (pour Claude Code)
├── MIGRATION_PLAN.md     # Plan et statut de la migration Drive → backend
└── docker-compose.dev.yml # Postgres local pour le développement
```

## Modèle de données (Postgres)

Une ligne par utilisateur dans `users`, tout le reste rattaché par `user_id` :

- **`books`** — un livre = un fichier EPUB sur disque + une ligne de métadonnées (titre, auteur, langue si traduit, chemin du fichier/couverture).
- **`progress`** — position de lecture (CFI + pourcentage) par livre.
- **`custom_prompts`** / **`deleted_default_prompt_ids`** — prompts suggérés dans le panneau de chat, personnalisables.
- **`quiz_progress`** — questions générées + meilleur score, par livre/chapitre/mode (exercices ou entretien).
- **`pomodoro_log`** — agrégats du mode Pomodoro (temps total, exercices répondus/corrects) par livre.
- **`revision_sheets`** — fiches de révision sauvegardées (markdown stocké directement en base).

Chaque requête backend filtre systématiquement par `user_id` (voir Authentification ci-dessous) — c'est ce qui garantit l'isolation entre comptes.

## Authentification

Le sign-in passe toujours par le flow OAuth2 implicite de Google (bouton "Sign in with Google", inchangé depuis le début du projet). Ce que ça donne au navigateur — un **access token** — est envoyé une fois à `POST /auth/google`, qui :

1. Vérifie ce token auprès de Google (`tokeninfo` + `userinfo`) — confirme qu'il a bien été émis pour cette appli, récupère l'identité du compte.
2. Crée ou retrouve la ligne `users` correspondante (clé stable : `google_sub`, l'identifiant Google du compte).
3. Pose un cookie de session httpOnly (JWT signé, 7 jours) — c'est ce cookie, pas le token Google, qui authentifie ensuite chaque appel à l'API du backend.

Le scope demandé lors du sign-in est `email profile openid` — le scope Drive, utilisé le temps de la migration par un outil d'import ponctuel, a été retiré une fois cet outil supprimé.

## Stockage des livres — concrètement

- **Fichier EPUB + couverture** : sur disque, dans `STORAGE_DIR/{userId}/books/{bookId}.epub` et `.../covers/{bookId}.<ext>`. Isolation physique : un dossier par utilisateur.
- **Métadonnées** : table `books` en Postgres, avec `user_id` en clé étrangère — chaque requête est filtrée dessus, donc même en devinant l'UUID d'un livre d'un autre compte, l'API ne renverrait rien.
- Le navigateur garde en plus un cache local (IndexedDB) des octets de l'EPUB pour ne pas re-télécharger à chaque ouverture — ce n'est qu'un cache, pas une source de vérité.

## Fonctionnalités clés

- **Lecteur** (`Reader.jsx`) — rendu EPUB paginé via epubjs, thèmes, plein écran, sauvegarde de position en continu.
- **Assistant de lecture IA** (`ChatPanel.jsx`) — chat en streaming, génération de fiches de révision (une globale ou une par concept), tout contextualisé avec le texte de la page en cours.
- **Quiz** (`QuizModal.jsx`) — QCM générés par chapitre (exercices ou préparation d'entretien), score sauvegardé.
- **Mode Pomodoro** (`PomodoroModal.jsx`) — cycles de lecture chronométrés (durée personnalisable depuis `/profile`) avec mini-quiz de fin de cycle, statistiques agrégées sur `/profile`.
- **Traduction de livre entier** (`TranslateBookModal.jsx`) — traduit un EPUB complet chapitre par chapitre en préservant code/formules/structure, produit un nouveau livre dans la bibliothèque.
- **Profil** (`Profile.jsx`, route `/profile`) — identité de compte, réglages Pomodoro, statistiques d'apprentissage ; accessible via le menu avatar (`UserMenu.jsx`) présent sur Library et Reader.

## Toutes les routes du backend

| Ressource | Fichier |
|---|---|
| Auth | `server/src/routes/auth.js` |
| Livres | `server/src/routes/books.js` |
| Progression de lecture | `server/src/routes/progress.js` |
| Prompts personnalisés | `server/src/routes/prompts.js` |
| Quiz | `server/src/routes/quiz.js` |
| Pomodoro | `server/src/routes/pomodoro.js` |
| Réglages Pomodoro | `server/src/routes/pomodoroSettings.js` |
| Fiches de révision | `server/src/routes/revisionSheets.js` |
| IA (Gemini) | `server/src/routes/ai.js` |

Toutes (sauf `/auth/google` et `/auth/logout`) exigent le cookie de session (middleware `requireAuth`).

## Pour aller plus loin

- **Comment lancer le projet** → `RUNNING.md`
- **Détail exhaustif de chaque module** (utile pour du debug fin ou pour Claude Code) → `CLAUDE.md`
- **Historique et suite de la migration vers un backend auto-hébergé** → `MIGRATION_PLAN.md`
