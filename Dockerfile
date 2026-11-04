# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
WORKDIR /app
# Node 26 no longer bundles corepack, which runs the pnpm version pinned in package.json.
RUN npm install --global corepack@0.36.0
COPY package.json pnpm-lock.yaml .npmrc ./
RUN corepack pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/emit-schema.ts ./scripts/
RUN corepack pnpm build && corepack pnpm prune --prod --ignore-scripts

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    DSGVO_CHECK_CONTAINER=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LANG=C.UTF-8 \
    HOME=/home/scanner

COPY --from=build /app/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core /opt/playwright-core

RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin scanner \
 && install -d -o scanner -g scanner /work \
 && node /opt/playwright-core/cli.js install-deps chromium \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && apt-get purge -y --auto-remove xvfb \
 && node /opt/playwright-core/cli.js install --no-shell chromium \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE ./
COPY test/data ./test/data
COPY --from=build /app/schema ./schema
COPY docker/seccomp-chromium.json /etc/dsgvo-check/seccomp.json
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/dsgvo-check

ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/seed-factory/dsgvo-check" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dsgvo-check"]
CMD ["--help"]
