FROM docker.io/library/node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig*.json svelte.config.js vite.config.ts ./
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run build && npm prune --omit=dev --no-fund --no-audit

FROM docker.io/library/node:24.22.1-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg openssl \
    && rm -rf /var/lib/apt/lists/* && install -d -m 0700 -o node -g node ./local-only
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build

ARG BUILD_HASH=unknown
ARG BUILD_VERSION=0.1.0
ARG BUILD_DATE=unknown
ARG GIT_SHA=unknown
ARG GIT_DIRTY=false
ARG CI_RUN_ID=local

# Podman includes active build arguments in RUN cache keys. Refresh the image
# metadata even when this revision produces identical application files.
RUN test -n "$BUILD_HASH" && test -n "$BUILD_VERSION" && test -n "$BUILD_DATE" \
    && test -n "$GIT_SHA" && test -n "$GIT_DIRTY" && test -n "$CI_RUN_ID"
ENV APP_BUILD_HASH=${BUILD_HASH} \
    APP_VERSION=${BUILD_VERSION} \
    APP_BUILD_DATE=${BUILD_DATE} \
    APP_GIT_SHA=${GIT_SHA} \
    APP_GIT_DIRTY=${GIT_DIRTY} \
    APP_CI_RUN_ID=${CI_RUN_ID} \
    NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/Slyke/reolink-wui" \
      org.opencontainers.image.title="reolink-wui" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      build.git.dirty="${GIT_DIRTY}" build.ci.run-id="${CI_RUN_ID}"
USER node
EXPOSE 3000 8080
CMD ["node", "build/index.js"]
