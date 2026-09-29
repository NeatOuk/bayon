# syntax=docker/dockerfile:1
# Bayon's own image: api, supervisor, web and frm from one build.
# deploy/bayon.sh builds it on the docker host from `git archive <sha>`, so the context is tracked
# files only (no node_modules, no dist, no .env). FROM names an image already on the host; the build
# runs with --pull=false and never pulls it again. No secret is ever part of the build.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
# Labelled like the final image: the classic builder keeps this stage as an untagged image, which
# must be removable by label like every other object of ours on the shared host.
ARG REVISION=unknown
LABEL frm.managed="1" frm.deploy="bayon" org.opencontainers.image.revision="${REVISION}"
# node-pty compiles here; better-sqlite3 uses its prebuild where one exists (pnpm-workspace.yaml's
# allowBuilds approves both).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.26.0
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -w build \
 && CI=1 pnpm install --prod --frozen-lockfile --offline

FROM ${NODE_IMAGE}
# git and ssh for the supervisor (mirrors; the container executor over ssh); procps because the
# supervisor lock and the local executor read process start times with ps. No docker CLI, no tmux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 bayon-app \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp \
      --shell /usr/sbin/nologin bayon-app \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/frm \
 && install -d -m 0755 /run/secrets
COPY --from=build /src /opt/bayon
COPY deploy/gitconfig /etc/gitconfig
RUN chmod 0755 /opt/bayon/deploy/frm /opt/bayon/deploy/migrate.sh \
      /opt/bayon/deploy/git-credential-frm \
 && ln -s /opt/bayon/deploy/frm /usr/local/bin/frm
# The file secret store is the default here: a secret in this image's environment is refused.
ENV NODE_ENV=production \
    HOME=/tmp \
    FRM_SECRET_STORE=file \
    FRM_SECRETS_DIR=/run/secrets
USER 10001:10001
WORKDIR /opt/bayon
ARG REVISION=unknown
LABEL frm.managed="1" frm.deploy="bayon" org.opencontainers.image.revision="${REVISION}"
