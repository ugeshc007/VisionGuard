FROM node:22-alpine

WORKDIR /app

COPY polling-worker/package*.json ./polling-worker/
RUN npm ci --omit=dev --prefix polling-worker

COPY polling-worker ./polling-worker

ENV NODE_ENV=production

CMD ["node", "polling-worker/worker.js"]
