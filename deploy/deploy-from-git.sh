#!/usr/bin/env bash
# Open Rummy - pull, build and deploy ON the Lightsail instance itself.
# Use on instances with 1 GB+ RAM (plus the swap that setup-lightsail.sh creates); on 512 MB
# instances build locally with deploy/deploy.sh instead.
#
# Run as the deploy user (e.g. ubuntu), not root:
#   bash /srv/open-rummy/src/deploy/deploy-from-git.sh
# First time (the script clones the repo itself, so it can also be fetched standalone):
#   curl -fsSLO https://raw.githubusercontent.com/chon9/Open-Rummy/main/deploy/deploy-from-git.sh
#   bash deploy-from-git.sh
#
# Optional env: REPO_URL (default https://github.com/chon9/Open-Rummy.git), BRANCH (main),
#               SRC_DIR (/srv/open-rummy/src), RUN_TESTS=1 (also run npm test).

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chon9/Open-Rummy.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="/srv/open-rummy"
SRC_DIR="${SRC_DIR:-$APP_DIR/src}"

die() { printf 'deploy-from-git: error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

[[ $EUID -ne 0 ]] || die "run as the deploy user, not root (it needs sudo only for the restart)"
command -v node >/dev/null || die "node not installed (run deploy/setup-lightsail.sh first)"
[[ -w $APP_DIR ]] || die "$APP_DIR is not writable by $(id -un) (run setup-lightsail.sh with DEPLOY_USER=$(id -un))"

mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
if (( mem_kb < 900000 )); then
  echo "warning: only $((mem_kb / 1024)) MB RAM; the build may be slow or fail. Prefer deploy/deploy.sh." >&2
fi

log "Source: $REPO_URL ($BRANCH) -> $SRC_DIR"
if [[ -d $SRC_DIR/.git ]]; then
  git -C "$SRC_DIR" fetch --prune origin
  git -C "$SRC_DIR" checkout "$BRANCH"
  git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi
cd "$SRC_DIR"
echo "at $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

log "Build"
npm ci --no-audit --no-fund
if [[ ${RUN_TESTS:-0} == 1 ]]; then npm test; fi
# Vite + three.js need more than the default heap on small machines; swap absorbs the peak.
NODE_OPTIONS=--max-old-space-size=768 npm run build

[[ -f packages/client/dist/index.html ]] || die "client build missing"
[[ -f packages/server/dist/server.js ]] || die "server bundle missing"

log "Install"
rsync -a --delete packages/client/dist/ "$APP_DIR/web/"
install -m 644 packages/server/dist/server.js "$APP_DIR/server/server.js.new"
mv -f "$APP_DIR/server/server.js.new" "$APP_DIR/server/server.js"
sudo systemctl restart open-rummy

log "Health check"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    echo "server healthy"
    exit 0
  fi
  sleep 1
done
sudo systemctl status open-rummy --no-pager -l | tail -n 20 || true
die "server did not answer /healthz after restart"
