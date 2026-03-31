FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY src-ts ./src-ts

CMD ["bun", "run", "src-ts/index.ts"]
