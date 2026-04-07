FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --production --frozen-lockfile

COPY src/ ./src/
COPY public/ ./public/

ENV PORT=8080
ENV DB_PATH=/data/pushtracker.db

EXPOSE 8080

CMD ["bun", "run", "src/server.ts"]
