#!/usr/bin/env bash
# Open Rummy - build locally and deploy to a Lightsail instance prepared by setup-lightsail.sh.
# Runs in Git Bash on Windows, Linux and macOS.
#
# Required environment (never hardcode these; keep the key file outside the repo):
#   LIGHTSAIL_HOST   SSH target, e.g. ubuntu@203.0.113.10 or ubuntu@rummy.example.com
#                    (a bare host name gets "ubuntu@" prepended)
#   SSH_KEY          path to the private key, e.g. ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem
#                    (Git Bash: use /c/Users/<you>/... rather than C:\Users\...)
# Optional:
#   SKIP_TESTS=1     skip npm test
#   SKIP_INSTALL=1   skip npm ci (reuse node_modules)
#   PUBLIC_URL       e.g. https://rummy.example.com - also checks <PUBLIC_URL>/healthz
#
# Usage:  LIGHTSAIL_HOST=ubuntu@1.2.3.4 SSH_KEY=~/.ssh/key.pem bash deploy/deploy.sh

set -euo pipefail

die() { printf 'deploy: error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

[[ -n ${LIGHTSAIL_HOST:-} ]] || die "LIGHTSAIL_HOST is not set (e.g. export LIGHTSAIL_HOST=ubuntu@203.0.113.10)"
[[ -n ${SSH_KEY:-} ]] || die "SSH_KEY is not set (path to your Lightsail private key)"
[[ -f $SSH_KEY ]] || die "SSH_KEY file not found: $SSH_KEY"

TARGET="$LIGHTSAIL_HOST"
[[ $TARGET == *@* ]] || TARGET="ubuntu@$TARGET"

APP_DIR="/srv/open-rummy"
STAGING=".open-rummy-staging" # relative to the remote user's home directory

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# IdentitiesOnly stops ssh from offering every key in the agent first (servers cap attempts).
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

# ---------------------------------------------------------------------------------------------
log "Build"
if [[ ${SKIP_INSTALL:-0} != 1 ]]; then npm ci --no-audit --no-fund; fi
if [[ ${SKIP_TESTS:-0} != 1 ]]; then npm test; fi
npm run build

CLIENT_DIST="packages/client/dist"
SERVER_BUNDLE="packages/server/dist/server.js"
[[ -f $CLIENT_DIST/index.html ]] || die "$CLIENT_DIST/index.html missing after build"
[[ -f $SERVER_BUNDLE ]] || die "$SERVER_BUNDLE missing after build"

# Refuse to ship anything that looks like a secret inside the build output.
node scripts/check-secrets.mjs --path "$CLIENT_DIST" "$SERVER_BUNDLE"

# ---------------------------------------------------------------------------------------------
log "Upload to $TARGET:~/$STAGING"
remote "mkdir -p ~/$STAGING/web ~/$STAGING/server"
if command -v rsync >/dev/null 2>&1; then
  RSYNC_SSH="ssh -i \"$SSH_KEY\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  rsync -az --delete -e "$RSYNC_SSH" "$CLIENT_DIST/" "$TARGET:$STAGING/web/"
  rsync -az -e "$RSYNC_SSH" "$SERVER_BUNDLE" "$TARGET:$STAGING/server/server.js"
else
  # Git Bash usually has no rsync: fall back to scp of a fresh staging copy.
  echo "rsync not found locally; using scp"
  remote "rm -rf ~/$STAGING/web && mkdir -p ~/$STAGING/web"
  scp "${SSH_OPTS[@]}" -q -r "$CLIENT_DIST/." "$TARGET:$STAGING/web/"
  scp "${SSH_OPTS[@]}" -q "$SERVER_BUNDLE" "$TARGET:$STAGING/server/server.js"
fi

# ---------------------------------------------------------------------------------------------
log "Install and restart on the server"
# The remote side has rsync (installed by setup-lightsail.sh); --delete removes stale hashed
# assets. Directories are owned by the deploy user, so only the restart needs sudo.
remote "set -e
  rsync -a --delete ~/$STAGING/web/ $APP_DIR/web/
  install -m 644 ~/$STAGING/server/server.js $APP_DIR/server/server.js.new
  mv -f $APP_DIR/server/server.js.new $APP_DIR/server/server.js
  sudo systemctl restart open-rummy"

log "Health check"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if remote "curl -fsS --max-time 3 http://127.0.0.1:3001/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ $ok != 1 ]]; then
  remote "sudo systemctl status open-rummy --no-pager -l | tail -n 20" || true
  die "server did not answer /healthz after restart"
fi
echo "server healthy"

if [[ -n ${PUBLIC_URL:-} ]]; then
  curl -fsS --max-time 10 "${PUBLIC_URL%/}/healthz" >/dev/null || die "public health check failed: ${PUBLIC_URL%/}/healthz"
  echo "public endpoint healthy: ${PUBLIC_URL%/}"
fi

log "Deployed."
