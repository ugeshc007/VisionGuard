# VisionGuard AI

CCTV-based AI monitoring system: face recognition, live camera streaming, rules/events, and reporting.

Services:

- `frontend/` — React + Vite web app
- `backend/` — Node/Express API + PostgreSQL access + migrations
- `face-service/` — Python/FastAPI InsightFace embedding service
- `polling-worker/` — Node worker that processes pending face jobs
- `stream-gateway/` — go2rtc RTSP/HLS/WebRTC gateway
- PostgreSQL with the `pgvector` extension (face embeddings)

There are two ways to run the app. Pick one — don't mix them (e.g. don't point a local backend at the Dockerized Postgres port without adjusting `DATABASE_URL`).

---

## Option A — Run Locally (no Docker)

### Prerequisites

- Node.js 20+
- Python 3.11+
- PostgreSQL 16 with the `pgvector` extension installed
- FFmpeg available on PATH (or set `FFMPEG_BIN` to a full path)
- go2rtc binary (`stream-gateway/go2rtc.exe` is already in the repo for Windows)

### 1. Database

Create the database and user, then enable `pgvector`:

```powershell
createdb visionguard
psql -d visionguard -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Update `backend/.env` and `polling-worker/.env` with your actual `DATABASE_URL` (these files are gitignored — copy your own credentials in, do not commit them).

### 2. Stream gateway (go2rtc)

```powershell
cd stream-gateway
./go2rtc.exe -config go2rtc.yaml
```

Leave this running. It serves on `http://localhost:1984`.

### 3. Face AI service (Python)

```powershell
cd face-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8091
```

Leave this running. It serves on `http://localhost:8091`.

### 4. Backend (Node)

```powershell
cd backend
npm install
npm run db:migrate
npm run dev
```

`npm run dev` runs `nodemon server.js`, serving the API on `http://localhost:6969`.

Optional demo data (dev only, not for live/production data):

```powershell
npm run db:seed
```

### 5. Polling worker (Node)

```powershell
cd polling-worker
npm install
npm start
```

### 6. Frontend (Vite)

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to the backend on port 6969.

### Stopping

Ctrl+C in each terminal window (go2rtc, face-service, backend, worker, frontend).

---

## Option B — Run Containerized (Docker Compose)

### Prerequisites

- Docker Desktop

### 1. Build and start everything

```powershell
docker compose up -d --build
```

This starts, in dependency order: `postgres`, `face-ai`, `stream-gateway`, `backend` (which runs `node backend/db/migrate.js` automatically before starting the server), `worker`, and `frontend`.

### 2. Optional demo data

```powershell
docker compose exec backend node backend/db/seed.js
```

Seed data is idempotent but creates demo-looking cameras/people — skip this on a production/live test server.

### 3. Open the app

```
http://localhost:8080
```

For LAN access from another device, use the host PC's IP instead of `localhost`, and allow the relevant ports through the Windows Firewall.

### Useful commands

```powershell
docker compose logs -f backend      # tail backend logs
docker compose ps                   # see container status
docker compose down                 # stop and remove containers (keeps volumes/data)
```

### Stopping

```powershell
docker compose down
```

---

## Service URLs Reference

| Service         | Local (Option A)          | Docker (Option B)         |
|-----------------|----------------------------|----------------------------|
| Frontend        | http://localhost:5173      | http://localhost:8080      |
| Backend API     | http://localhost:6969      | http://localhost:6969      |
| Face AI         | http://localhost:8091      | http://localhost:8091      |
| Stream gateway  | http://localhost:1984      | http://localhost:1984      |
| PostgreSQL      | localhost:5432 (your setup)| localhost:5438              |

See [DEPLOYMENT.md](DEPLOYMENT.md) for deploying to another machine, backup/restore, and adding new migrations.
