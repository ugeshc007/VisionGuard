# VisionGuard AI Deployment Guide

This guide moves VisionGuard AI to another PC with PostgreSQL, pgvector, Face AI, stream gateway, web app, worker, and migrations for live camera testing.

## 1. Requirements

- Windows 10/11 or Linux host
- Git
- Docker Desktop
- Node.js 20+ if running outside Docker
- FFmpeg if running outside Docker (`ffmpeg` must be available in PATH)
- Same network access for cameras/RTSP streams

## 2. Clone The Project

```powershell
cd C:\Apps
git clone https://github.com/ugeshc007/VisionGuard.git "VisionGuard AI"
cd "C:\Apps\VisionGuard AI"
```

## 3. Configure Environment

```powershell
copy .env.example .env
notepad .env
```

For Docker deployment, the compose file already uses internal container URLs:

- Web: `http://localhost:6969`
- PostgreSQL: internal `postgres:5432`, host `localhost:5438`
- Face AI: `http://localhost:8091`
- Stream gateway: `http://localhost:1984`

## 4. Start Everything With Docker

```powershell
docker compose up -d --build
```

The `backend` container automatically runs:

```powershell
node backend/db/migrate.js
```

before starting the server.

## 5. Live Data Only

For live testing, do not run the seed command. Add real sites, cameras, rules, and staff from the UI.

If you need demo data on a development laptop only, run:

```powershell
docker compose exec backend node backend/db/seed.js
```

Seed data is idempotent, but it creates demo-looking cameras and people, so avoid it on production/live test servers.

## 6. Open The App

[http://localhost:6969](http://localhost:6969)

For local network access from another device, use the host PC IP:

```text
http://YOUR_PC_IP:6969
```

Make sure Windows Firewall allows inbound port `6969`.

## 7. Database Migration Commands

Local Node mode:

```powershell
cd backend
npm install
npm run db:migrate
npm run dev
```

Docker mode:

```powershell
docker compose exec backend node backend/db/migrate.js
```

## 8. Add A New Migration

Create a new SQL file:

```text
backend/db/migrations/002_short_description.sql
```

Rules:

- Use `CREATE TABLE IF NOT EXISTS`
- Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- Keep migrations forward-only
- Do not edit already-applied migration files on production machines

Then run:

```powershell
cd backend
npm run db:migrate
```

or:

```powershell
docker compose exec backend node backend/db/migrate.js
```

## 9. Backup And Restore

Backup from Docker PostgreSQL:

```powershell
docker compose exec postgres pg_dump -U visionguard -d visionguard > visionguard-backup.sql
```

Restore:

```powershell
type visionguard-backup.sql | docker compose exec -T postgres psql -U visionguard -d visionguard
```

## 10. GitHub Push

```powershell
git init
git branch -M main
git remote add origin https://github.com/ugeshc007/VisionGuard.git
git add .
git commit -m "Add deployment and database migration tooling"
git push -u origin main
```

If the remote already has commits:

```powershell
git pull --rebase origin main
git push -u origin main
```

## 11. Services

- `visionguard-postgres`: PostgreSQL with pgvector
- `visionguard-backend`: Node web/API app
- `visionguard-worker`: pending face processing worker
- `visionguard-face-ai`: InsightFace embedding service
- `visionguard-stream-gateway`: RTSP/HLS/WebRTC stream gateway

## 12. RTSP AI Auto Capture

For CCTV cameras, add the RTSP URL in the camera configuration, for example:

```text
rtsp://admin:PASSWORD@192.168.1.182:554/Streaming/Channels/402
```

When this RTSP camera is selected in the Camera page, **Start AI auto capture** uses server-side FFmpeg snapshots instead of the browser webcam. This avoids browser errors such as:

```text
NotFoundError: Requested device not found
```

Docker installs FFmpeg automatically. For non-Docker Windows deployment, install FFmpeg and set:

```text
FFMPEG_BIN=C:\ffmpeg\bin\ffmpeg.exe
```

## 13. Production Notes

- Change PostgreSQL password before production.
- Do not commit `.env`.
- Use HTTPS/reverse proxy for public access.
- Restrict who can view face images and forensic search.
- Back up PostgreSQL before upgrading.
