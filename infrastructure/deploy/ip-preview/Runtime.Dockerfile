FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV COREPACK_HOME=/opt/corepack
ENV NODE_ENV=production
ENV WRANGLER_WRITE_LOGS=false
ENV NODE_OPTIONS=--max-old-space-size=2048

RUN mkdir -p "$PNPM_HOME" "$COREPACK_HOME" \
    && corepack enable --install-directory "$PNPM_HOME" \
    && corepack prepare pnpm@11.5.2 --activate \
    && chmod -R a+rX "$PNPM_HOME" "$COREPACK_HOME"

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile --prod=false \
      --filter spott \
      --filter @spott/domain... \
      --filter @spott/design-tokens... \
      --filter @spott/api... \
      --filter @spott/web...

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MAP_STYLE_URL
ARG NEXT_PUBLIC_APP_STORE_STATE=unavailable
ARG NEXT_PUBLIC_APP_STORE_URL
ARG NEXT_PUBLIC_APP_STORE_ID
ARG SPOTT_WEB_CANONICAL_ORIGIN
ARG API_INTERNAL_URL=http://api:4100/v1
RUN case "$NEXT_PUBLIC_APP_STORE_STATE" in unavailable|preorder|available) ;; *) exit 1 ;; esac \
      && test -n "$NEXT_PUBLIC_API_URL" && test -n "$NEXT_PUBLIC_SITE_URL" \
      && test -n "$NEXT_PUBLIC_MAP_STYLE_URL" \
      && test -n "$SPOTT_WEB_CANONICAL_ORIGIN"
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL
ENV NEXT_PUBLIC_APP_STORE_STATE=$NEXT_PUBLIC_APP_STORE_STATE
ENV NEXT_PUBLIC_APP_STORE_URL=$NEXT_PUBLIC_APP_STORE_URL
ENV NEXT_PUBLIC_APP_STORE_ID=$NEXT_PUBLIC_APP_STORE_ID
ENV SPOTT_WEB_CANONICAL_ORIGIN=$SPOTT_WEB_CANONICAL_ORIGIN
ENV API_INTERNAL_URL=$API_INTERNAL_URL

RUN pnpm --filter @spott/domain build
RUN pnpm --filter @spott/api build
RUN pnpm --filter @spott/web build
RUN ! grep -R -E '/Users/|\.worktrees/|/private/tmp/' /app/apps/web/dist

RUN mkdir -p /app/apps/web/.wrangler && chown -R node:node /app/apps/web/.wrangler

USER node
