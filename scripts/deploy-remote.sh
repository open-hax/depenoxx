#!/usr/bin/env bash
set -euo pipefail

# depenoxx remote deployment script
# Simplified version of proxx's deploy-remote.sh for single-service deploys

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"

DEPLOY_ENABLE_TLS="${DEPLOY_ENABLE_TLS:-false}"
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-120}"
DEPLOY_COMPOSE_PROJECT_NAME="${DEPLOY_COMPOSE_PROJECT_NAME:-depenoxx}"
DEPLOY_PUBLIC_HOST="${DEPLOY_PUBLIC_HOST:-depenoxx.promethean.rest}"
DEPLOY_ENV_APPEND="${DEPLOY_ENV_APPEND:-}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

render_caddyfile() {
  local output_path="$1" public_host="$2"
  cat > "$output_path" << EOF
${public_host} {
  encode gzip zstd

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
  }

  reverse_proxy depenoxx:8798
}
EOF
}

build_runtime_payloads() {
  mkdir -p "$TMP_DIR"

  if [[ -n "$DEPLOY_ENV_APPEND" ]]; then
    touch "$TMP_DIR/.env"
    printf '\n%s\n' "$DEPLOY_ENV_APPEND" >> "$TMP_DIR/.env"
  fi

  if [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
    render_caddyfile "$TMP_DIR/Caddyfile" "$DEPLOY_PUBLIC_HOST"
  fi
}

sync_repo_tree() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$DEPLOY_PATH' '$DEPLOY_PATH/deploy'"

  rsync -az --delete \
    --checksum \
    --exclude '/.git/' \
    --exclude '/node_modules/' \
    --exclude '/dist/' \
    --exclude '/.env' \
    "$ROOT_DIR/" "$REMOTE:$DEPLOY_PATH/"

  if [[ -f "$TMP_DIR/.env" ]]; then
    rsync -az "$TMP_DIR/.env" "$REMOTE:$DEPLOY_PATH/.env"
  fi

  if [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
    rsync -az "$ROOT_DIR/deploy/docker-compose.ssl.yml" "$REMOTE:$DEPLOY_PATH/deploy/docker-compose.ssl.yml"
    rsync -az "$TMP_DIR/Caddyfile" "$REMOTE:$DEPLOY_PATH/Caddyfile"
  fi
}

remote_compose_up() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$DEPLOY_ENABLE_TLS" "$DEPLOY_COMPOSE_PROJECT_NAME" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_ENABLE_TLS="$2"
DEPLOY_COMPOSE_PROJECT_NAME="$3"
cd "$DEPLOY_PATH"

compose_args=()
if [[ -f .env ]]; then
  compose_args+=(--env-file .env)
fi
compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")

if [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
  compose_args+=(-f docker-compose.yml -f deploy/docker-compose.ssl.yml)
else
  compose_args+=(-f docker-compose.yml)
fi

docker compose "${compose_args[@]}" up -d --build --remove-orphans
EOF
}

wait_for_remote_health() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$DEPLOY_ENABLE_TLS" "$DEPLOY_HEALTH_TIMEOUT_SECONDS" "$DEPLOY_COMPOSE_PROJECT_NAME" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_ENABLE_TLS="$2"
DEPLOY_HEALTH_TIMEOUT_SECONDS="$3"
DEPLOY_COMPOSE_PROJECT_NAME="$4"
cd "$DEPLOY_PATH"

compose_args=()
if [[ -f .env ]]; then
  compose_args+=(--env-file .env)
fi
compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")

if [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
  compose_args+=(-f docker-compose.yml -f deploy/docker-compose.ssl.yml)
else
  compose_args+=(-f docker-compose.yml)
fi

deadline=$(( $(date +%s) + DEPLOY_HEALTH_TIMEOUT_SECONDS ))
while true; do
  container_id="$(docker compose "${compose_args[@]}" ps -q depenoxx)"
  if [[ -n "$container_id" ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$health" == "healthy" || "$health" == "running" ]]; then
      exit 0
    fi
  fi

  if (( $(date +%s) >= deadline )); then
    echo "remote deploy health check timed out" >&2
    docker compose "${compose_args[@]}" ps >&2 || true
    docker compose "${compose_args[@]}" logs --tail=200 >&2 || true
    exit 1
  fi

  sleep 5
done
EOF
}

build_runtime_payloads
sync_repo_tree
remote_compose_up
wait_for_remote_health
