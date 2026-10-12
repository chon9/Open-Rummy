#!/usr/bin/env bash
# Open Rummy - one-time (and re-runnable) setup of an AWS Lightsail Ubuntu 24.04 instance.
#
# Usage, on the instance, from a checkout or copy of this repo's deploy/ directory:
#   sudo bash deploy/setup-lightsail.sh [DOMAIN] [EMAIL]
#   sudo DOMAIN=rummy.example.com EMAIL=you@example.com bash deploy/setup-lightsail.sh
#
#   DOMAIN  public host name pointing at the instance's static IP. Without it nginx answers
#           on any host name (server_name _) and HTTPS is skipped.
#   EMAIL   Let's Encrypt account email. When DOMAIN and EMAIL are both set, certbot obtains a
#           certificate non-interactively and enables the HTTP->HTTPS redirect.
#
# Optional env: DEPLOY_USER (owner of the deployed files, default: the sudo caller or ubuntu),
#               SWAP_SIZE (default 1G), FORCE_NGINX=1 (overwrite a certbot-modified site file),
#               SKIP_UPGRADE=1 (skip apt upgrade).
#
# Safe to run again: every step checks what already exists. Contains no secrets.

set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
EMAIL="${2:-${EMAIL:-}}"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"
SWAP_SIZE="${SWAP_SIZE:-1G}"
APP_USER="openrummy"
APP_DIR="/srv/open-rummy"
ENV_FILE="/etc/open-rummy.env"
SITE_AVAILABLE="/etc/nginx/sites-available/open-rummy.conf"
SITE_ENABLED="/etc/nginx/sites-enabled/open-rummy.conf"
UNIT_FILE="/etc/systemd/system/open-rummy.service"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_TEMPLATE="$SCRIPT_DIR/nginx/open-rummy.conf"
UNIT_TEMPLATE="$SCRIPT_DIR/open-rummy.service"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0 [DOMAIN] [EMAIL]"
[[ -f $NGINX_TEMPLATE ]] || die "missing $NGINX_TEMPLATE (run from a copy of the repo's deploy/ directory)"
[[ -f $UNIT_TEMPLATE ]] || die "missing $UNIT_TEMPLATE"
id "$DEPLOY_USER" >/dev/null 2>&1 || die "deploy user '$DEPLOY_USER' does not exist (set DEPLOY_USER)"
if [[ -n $DOMAIN && ! $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]]; then
  die "DOMAIN '$DOMAIN' does not look like a host name"
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------------------------
log "Swap ($SWAP_SIZE) - small instances need it for npm and Vite builds"
if swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  echo "swap already active on /swapfile"
else
  if [[ ! -f /swapfile ]]; then
    fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-open-rummy-swap.conf
sysctl -q -p /etc/sysctl.d/90-open-rummy-swap.conf

# ---------------------------------------------------------------------------------------------
log "Packages"
apt-get update -y
if [[ ${SKIP_UPGRADE:-0} != 1 ]]; then
  apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
fi
apt-get install -y ca-certificates curl gnupg git rsync ufw nginx certbot python3-certbot-nginx

# ---------------------------------------------------------------------------------------------
log "Node.js 22 (NodeSource)"
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [[ $node_major != 22 ]]; then
  setup_script="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$setup_script"
  bash "$setup_script"
  rm -f "$setup_script"
  apt-get install -y nodejs
fi
echo "node $(node --version), npm $(npm --version)"
[[ -x /usr/bin/node ]] || die "/usr/bin/node not found; the systemd unit expects it there"

# ---------------------------------------------------------------------------------------------
log "Firewall (ufw): OpenSSH + Nginx Full"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'
echo "Also open TCP 80 and 443 in the Lightsail console (Networking > IPv4/IPv6 firewall)."

# ---------------------------------------------------------------------------------------------
log "Service user and directories"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi
# Code is owned by the deploy user (so deploy.sh can rsync without sudo) and only readable by
# the service user: a compromised server process cannot modify its own code.
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$APP_DIR" "$APP_DIR/web" "$APP_DIR/server"
if [[ ! -f $APP_DIR/web/index.html ]]; then
  cat > "$APP_DIR/web/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Open Rummy</title>
<p>Open Rummy is installed. Deploy the client build with deploy/deploy.sh.</p>
HTML
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/web/index.html"
fi

# ---------------------------------------------------------------------------------------------
log "Environment file $ENV_FILE"
if [[ -f $ENV_FILE ]]; then
  echo "keeping existing $ENV_FILE"
else
  origins=""
  [[ -n $DOMAIN ]] && origins="https://$DOMAIN,http://$DOMAIN"
  cat > "$ENV_FILE" <<EOF
# Open Rummy server settings (read by systemd: EnvironmentFile=-$ENV_FILE). No secrets needed.
PORT=3001
HOST=127.0.0.1
WEB_ROOT=$APP_DIR/web
MAX_ROOMS=500
ALLOWED_ORIGINS=$origins
NODE_ENV=production
# nginx in front sets X-Forwarded-For (see .env.example before changing)
TRUST_PROXY=1
#MAX_CONNECTIONS=4000
#MAX_CONNS_PER_IP=20
#MAX_ROOMS_PER_IP=5
EOF
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ---------------------------------------------------------------------------------------------
log "nginx site"
server_name="${DOMAIN:-_}"
if [[ -f $SITE_AVAILABLE ]] && grep -q 'managed by Certbot' "$SITE_AVAILABLE" && [[ ${FORCE_NGINX:-0} != 1 ]]; then
  # Overwriting would drop the TLS config certbot added; certbot below re-checks the cert.
  echo "keeping certbot-managed $SITE_AVAILABLE (FORCE_NGINX=1 to replace it)"
else
  sed "s/rummy\.example\.com/$server_name/g" "$NGINX_TEMPLATE" > "$SITE_AVAILABLE"
fi
ln -sf "$SITE_AVAILABLE" "$SITE_ENABLED"
# The stock default site also claims port 80 as default_server; remove its symlink only.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

# ---------------------------------------------------------------------------------------------
log "systemd unit"
install -m 644 "$UNIT_TEMPLATE" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable open-rummy >/dev/null
if [[ -f $APP_DIR/server/server.js ]]; then
  systemctl restart open-rummy
  echo "open-rummy restarted"
else
  echo "no $APP_DIR/server/server.js yet; the service starts after the first deploy"
fi

# Let the deploy user restart the service without a password (Lightsail's ubuntu user already
# has full sudo; this keeps working if that is ever tightened).
sudoers="/etc/sudoers.d/open-rummy-deploy"
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart open-rummy, /usr/bin/systemctl status open-rummy, /usr/bin/systemctl status open-rummy *" > "$sudoers.tmp"
chmod 440 "$sudoers.tmp"
visudo -cf "$sudoers.tmp" >/dev/null && mv "$sudoers.tmp" "$sudoers" || { rm -f "$sudoers.tmp"; echo "warning: sudoers entry not installed"; }

# ---------------------------------------------------------------------------------------------
if [[ -n $DOMAIN && -n $EMAIL ]]; then
  log "HTTPS certificate for $DOMAIN (Let's Encrypt)"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" \
    --redirect --keep-until-expiring --no-eff-email
  systemctl reload nginx
else
  log "HTTPS skipped (pass DOMAIN and EMAIL to enable certbot)"
fi

# ---------------------------------------------------------------------------------------------
cat <<EOF

Setup complete.

Next steps:
  1. Lightsail console: attach a static IP, open ports 80 and 443, and point your domain's
     A record at the static IP${DOMAIN:+ (${DOMAIN})}.
  2. From your workstation (Git Bash / Linux / macOS), in the repo root:
       export LIGHTSAIL_HOST=${DEPLOY_USER}@<static-ip-or-domain>
       export SSH_KEY=/path/to/your-lightsail-key.pem
       bash deploy/deploy.sh
     Or build on this server (1 GB+ RAM): bash $APP_DIR/src/deploy/deploy-from-git.sh
  3. Check: curl -fsS http://127.0.0.1:3001/healthz && systemctl status open-rummy
  4. HTTPS later: sudo certbot --nginx -d <domain> -m <email> --agree-tos --redirect
  5. Settings: sudo nano $ENV_FILE && sudo systemctl restart open-rummy
EOF
