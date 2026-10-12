// Open Rummy - pm2 process file (alternative to deploy/open-rummy.service; use one, not both).
//
//   sudo npm install -g pm2
//   pm2 start /srv/open-rummy/ecosystem.config.cjs --env production
//   pm2 save && pm2 startup systemd      # follow the printed command to start on boot
//
// pm2 does not read /etc/open-rummy.env; edit env_production below instead (no secrets needed).
module.exports = {
  apps: [
    {
      name: 'open-rummy',
      script: '/srv/open-rummy/server/server.js',
      cwd: '/srv/open-rummy',
      // Cap V8's heap; pm2 restarts the process if RSS still grows past max_memory_restart.
      node_args: '--max-old-space-size=256',
      max_memory_restart: '350M',
      instances: 1, // rooms live in memory, so the server must not be clustered
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 10000,
      time: true,
      env_production: {
        NODE_ENV: 'production',
        PORT: '3001',
        HOST: '127.0.0.1',
        WEB_ROOT: '/srv/open-rummy/web',
        MAX_ROOMS: '500',
        ALLOWED_ORIGINS: '', // e.g. 'https://rummy.example.com'
        // nginx proxies /ws and sets X-Forwarded-For: trust exactly that one hop for the per-IP limits
        TRUST_PROXY: '1',
        // optional limits (defaults shown): MAX_CONNECTIONS: '4000', MAX_CONNS_PER_IP: '20', MAX_ROOMS_PER_IP: '5'
      },
    },
  ],
};
