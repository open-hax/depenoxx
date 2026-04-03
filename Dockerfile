# depenoxx
#
# Generic workspace dependency graph generator.
# Bind-mount the workspace at /workspace.
# Includes Graphviz (dot) for rendering DOT -> SVG/PNG.

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    graphviz \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

CMD ["node", "src/server.mjs"]
