FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@10.6.5

FROM base AS builder
COPY pnpm-workspace.yaml package.json turbo.json ./
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/
COPY assets/ ./assets/
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @halochat/server build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
