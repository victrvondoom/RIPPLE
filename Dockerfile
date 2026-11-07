# RIPPLE: one container, web app + API on port 8787. Data lives in /app/data (mount a volume to keep it).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8787 RIPPLE_DB_PATH=/app/data/ripple.db RIPPLE_OUTBOX=/app/data/outbox
EXPOSE 8787
VOLUME ["/app/data"]
# RIPPLE_SEED_PASSWORD must be set to a non-default value in production (the server refuses to start otherwise).
CMD ["npx", "tsx", "src/server/index.ts"]
