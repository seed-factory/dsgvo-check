# syntax=docker/dockerfile:1
#
# dsgvo-check container image (D24): Node 24 on Debian 12 (bookworm, slim) plus the full Chrome for Testing
# (new headless, `channel: 'chromium'`) installed by playwright-core at the pinned version. Runs as a non-root
# user with tini as PID 1. The seccomp profile for the Chromium sandbox ships in the image:
#
#   docker build -t dsgvo-check .
#   docker run --rm dsgvo-check seccomp-profile > dsgvo-check-seccomp.json
#   docker run --rm --cap-drop=ALL --security-opt no-new-privileges \
#     --security-opt seccomp=dsgvo-check-seccomp.json \
#     -v "$PWD/report:/work/report" dsgvo-check https://www.example.de --out /work/report --format console,json,html
#
# See docker/README.md for the hardened flags used by the GitHub Action and the GitLab template.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- build: compile TypeScript to dist/
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
WORKDIR /src
COPY package.json pnpm-lock.yaml .npmrc ./
RUN corepack pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN corepack pnpm build

# ---------------------------------------------------------------- deps: production dependencies only
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN corepack pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
# CI and the release job pass VERSION from package.json; the default must stay equal to it (delivery-config test).
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="dsgvo-check" \
      org.opencontainers.image.description="Passive scanner for German websites: signs of DSGVO/TDDDG/DDG issues and basic security problems" \
      org.opencontainers.image.source="https://github.com/seed-factory/dsgvo-check" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    DSGVO_CHECK_CONTAINER=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LANG=C.UTF-8 \
    HOME=/home/scanner \
    NO_UPDATE_NOTIFIER=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 scanner \
 && useradd --uid 10001 --gid scanner --create-home --home-dir /home/scanner --shell /usr/sbin/nologin scanner

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# System libraries and fonts for Chromium, then the full Chrome for Testing (no headless shell, D24).
# The browser revision is pinned by the playwright-core version in the lockfile.
RUN node node_modules/playwright-core/cli.js install-deps chromium \
 && node node_modules/playwright-core/cli.js install --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache \
 && chmod -R a+rX /ms-playwright

COPY LICENSE NOTICE ./
COPY data ./data
COPY schema ./schema
COPY --from=build /src/dist ./dist
COPY docker/seccomp-chromium.json /etc/dsgvo-check/seccomp.json
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/dsgvo-check

RUN mkdir -p /work && chown scanner:scanner /work
USER 10001:10001
WORKDIR /work

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dsgvo-check"]
CMD ["--help"]
