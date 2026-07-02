# ЛавашОК — образ приложения
FROM node:20-bookworm-slim

# Инструменты сборки для нативного модуля better-sqlite3.
# Если для вашей версии Node есть готовый бинарник (prebuild) — не пригодятся,
# но с ними сборка гарантированно проходит.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Сначала зависимости — для кэширования слоёв
COPY package*.json ./
RUN npm install --omit=dev

# Затем код
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
