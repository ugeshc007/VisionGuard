FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY backend/package*.json ./backend/
RUN npm ci --omit=dev --prefix backend

COPY backend ./backend
# faceEngine.js's hybrid embedding fallback spawns tools/insightface_embedder.py
# (repo-root tools/, not backend/) - keep this in sync with backend/utils/faceEngine.js's
# rootDir resolution (two levels up from backend/utils/).
COPY tools ./tools

ENV NODE_ENV=production
ENV PORT=6969

EXPOSE 6969

CMD ["node", "backend/server.js"]
