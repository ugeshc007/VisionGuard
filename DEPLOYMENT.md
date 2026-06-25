# VisionGuard AI Deployment Guide

This guide moves VisionGuard AI to another PC with PostgreSQL, pgvector, Face AI, stream gateway, web app, worker, migrations, and seed data.

## 1. Requirements

- Windows 10/11 or Linux host
- Git
- Docker Desktop
- Node.js 20+ if running outside Docker
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

- Web: `http://localhost:7070`
- PostgreSQL: internal `postgres:5432`, host `localhost:5438`
- Face AI: `http://localhost:8091`
- Stream gateway: `http://localhost:1984`

## 4. Start Everything With Docker

```powershell
docker compose up -d --build
```

The `web` container automatically runs:

```powershell
node tools/migrate-db.js
```

before starting the server.

## 5. Seed Baseline Data

Run this once after first deployment if you want the default site/camera/rules/users:

```powershell
docker compose exec web node tools/seed-db.js
```

Seed data is idempotent, so running it again updates the same baseline records instead of duplicating them.

## 6. Open The App

[http://localhost:7070](http://localhost:7070)

For local network access from another device, use the host PC IP:

```text
http://YOUR_PC_IP:7070
```

Make sure Windows Firewall allows inbound port `7070`.

## 7. Database Migration Commands

Local Node mode:

```powershell
npm install
npm run db:migrate
npm run db:seed
npm start
```

Docker mode:

```powershell
docker compose exec web node tools/migrate-db.js
docker compose exec web node tools/seed-db.js
```

## 8. Add A New Migration

Create a new SQL file:

```text
db/migrations/002_short_description.sql
```

Rules:

- Use `CREATE TABLE IF NOT EXISTS`
- Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- Keep migrations forward-only
- Do not edit already-applied migration files on production machines

Then run:

```powershell
npm run db:migrate
```

or:

```powershell
docker compose exec web node tools/migrate-db.js
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
- `visionguard-web`: Node web/API app
- `visionguard-worker`: pending face processing worker
- `visionguard-face-ai`: InsightFace embedding service
- `visionguard-stream-gateway`: RTSP/HLS/WebRTC stream gateway

## 12. Production Notes

- Change PostgreSQL password before production.
- Do not commit `.env`.
- Use HTTPS/reverse proxy for public access.
- Restrict who can view face images and forensic search.
- Back up PostgreSQL before upgrading.
