# Lancer le projet

## Prérequis

- Node.js 20+, Docker (pour Postgres en local)
- Un projet Google Cloud avec : un client OAuth 2.0 (type "Web application", scope `email`/`profile`/`openid`) et une clé API Gemini (aistudio.google.com)

## Configuration (une seule fois)

**`.env`** (racine du repo) :
```
VITE_GOOGLE_CLIENT_ID=<client id du projet Google Cloud>
VITE_API_URL=http://localhost:8787
```

**`server/.env`** (copier `server/.env.example`) :
```
PORT=8787
DATABASE_URL=postgres://bibliotheque:bibliotheque@localhost:5433/bibliotheque
GOOGLE_CLIENT_ID=<même valeur que VITE_GOOGLE_CLIENT_ID>
SESSION_SECRET=<openssl rand -base64 48>
CORS_ORIGIN=http://localhost:5173
GEMINI_API_KEY=<clé Gemini>
STORAGE_DIR=./data
```

⚠️ `CORS_ORIGIN` doit correspondre **exactement** au port réellement utilisé par Vite (affiché au lancement — pas toujours 5173 si le port est déjà pris). Idem côté Google Cloud Console : ce même port doit être dans "Authorized JavaScript origins" du client OAuth.

## Lancer en local

```bash
# 1. Postgres (une fois, tourne en arrière-plan)
docker compose -f docker-compose.dev.yml up -d
cd server && npm run migrate   # première fois seulement

# 2. Backend
cd server && npm run dev       # http://localhost:8787

# 3. Frontend (autre terminal, à la racine)
npm run dev                    # http://localhost:5173 (ou le port affiché)
```

Ouvrir l'URL du frontend, se connecter avec Google.

## Lancer en prod

**Pas encore fait — Phase 6 de `MIGRATION_PLAN.md`.** Ce qui suit est le plan prévu, pas une procédure testée :

- VPS avec Docker Compose : conteneurs `app` (backend + build frontend servi par Nginx), `postgres`, `nginx` (reverse-proxy + TLS Let's Encrypt).
- Mêmes variables d'env que ci-dessus, avec `STORAGE_DIR` pointant vers un volume persistant (ex. `/var/lib/bibliotheque/data`) et `CORS_ORIGIN`/le client OAuth pointant vers le vrai domaine.
- Sauvegardes : `pg_dump` (Postgres) + rsync du volume fichiers.

À détailler et tester quand on attaquera cette phase.
