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

## Lancer en prod (Docker Compose)

Tout tourne en conteneurs : `postgres`, `app` (backend Node, migration au démarrage), `nginx` (statique + reverse-proxy `/api`), `certbot` (renouvellement TLS). Fichiers : `docker-compose.prod.yml`, `Dockerfile` (racine, frontend), `server/Dockerfile`, `nginx/nginx.conf`.

### Configuration (une seule fois, sur le VPS)

```bash
cp .env.prod.example .env.prod        # POSTGRES_PASSWORD
cp server/.env.prod.example server/.env  # DATABASE_URL (même mot de passe que .env.prod !), GOOGLE_CLIENT_ID, SESSION_SECRET, GEMINI_API_KEY, CORS_ORIGIN
```

Remplir aussi le `.env` **racine** (celui de Vite, lu au moment du build par le `Dockerfile` frontend — pas `.env.prod`) avec les valeurs de prod : `VITE_GOOGLE_CLIENT_ID` (même client OAuth) et `VITE_API_URL=/api` (chemin relatif, proxifié par Nginx — voir `.env.prod.example` pour le détail). ⚠️ Remettre la valeur de dev (`http://localhost:8787`) après le build si tu développes aussi en local sur cette machine.

Domaine de prod : `dkut.online` (déjà en place dans `nginx/nginx.conf` — `server_name` et chemins de certificats).

### Premier lancement (bootstrap TLS)

Nginx refuse de démarrer sans certificat, mais Let's Encrypt a besoin que Nginx tourne pour valider le domaine — œuf et poule, résolu en 2 temps avec `nginx/nginx.bootstrap.conf` (HTTP seul, pas de bloc TLS) :

```bash
# 1. Build
docker compose -f docker-compose.prod.yml --env-file .env.prod build

# 2. Postgres seul, puis attendre qu'il soit prêt
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres

# 3. Nginx en conf bootstrap (HTTP seul) le temps d'obtenir le certificat
cp nginx/nginx.conf nginx/nginx.conf.bak
cp nginx/nginx.bootstrap.conf nginx/nginx.conf
docker compose -f docker-compose.prod.yml --env-file .env.prod build nginx
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d nginx

# 4. Obtenir le certificat (remplacer TON_EMAIL)
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm certbot \
  certonly --webroot -w /var/www/certbot -d dkut.online --email TON_EMAIL --agree-tos --no-eff-email

# 5. Restaurer la vraie conf (TLS) et tout démarrer
mv nginx/nginx.conf.bak nginx/nginx.conf
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

`app` applique le schéma (`npm run migrate`, idempotent) à chaque démarrage, avant de lancer le serveur — pas d'étape de migration séparée à retenir pour les déploiements suivants.

### Mises à jour (déploiements suivants)

```bash
git pull origin main
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

`certbot` tourne en continu dans son propre conteneur et renouvelle le certificat automatiquement (`certbot renew` toutes les 12h) — rien à faire une fois le bootstrap ci-dessus passé.

### Vérification

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps      # tous "running"
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app   # pas de "Missing required env var"
curl -I https://dkut.online/api/health   # doit répondre 200 (route server/src/index.js)
```

Puis test complet en navigateur externe (pas depuis le VPS, pour valider TLS/CORS réels) : sign-in Google, upload d'un EPUB, lecture, génération d'un quiz/fiche/pomodoro.

### Sauvegardes

Pas encore mis en place. Prévu : `pg_dump` sur le service `postgres` + backup du volume `bibliotheque-files` (fichiers EPUB/couvertures), en cron sur le VPS.
