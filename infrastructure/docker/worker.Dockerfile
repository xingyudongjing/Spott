FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY services/worker/package.json services/worker/package.json
RUN pnpm install --frozen-lockfile --filter spott --filter @spott/worker...

COPY scripts scripts
COPY database database
COPY services/worker services/worker
RUN pnpm --filter @spott/worker build

ENV NODE_ENV=development
CMD ["pnpm", "--filter", "@spott/worker", "start"]
