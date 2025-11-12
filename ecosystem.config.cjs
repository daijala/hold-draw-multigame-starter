// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'colorup',
      script: 'dist/index.js', // run the compiled JS
      // ── Process behavior ─────────────────────────────────────────
      instances: 1, // set to "max" to use all cores
      exec_mode: 'fork', // or "cluster" if your code is stateless
      autorestart: true,
      exp_backoff_restart_delay: 1000, // backoff on crash
      max_restarts: 20,
      max_memory_restart: '512M',
      kill_timeout: 1500, // let graceful shutdown run
      // ── Env ─────────────────────────────────────────────────────
      env: {
        NODE_ENV: 'development',
        PORT: 8000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8000,
      },
      // ── Logs ────────────────────────────────────────────────────
      time: true, // timestamp logs
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      // ── Watch (off for prod) ────────────────────────────────────
      watch: false, // keep false in prod; use tsx for dev
      // If you really want PM2 watch in dev, set watch:true and tweak ignore list:
      // watch: ["dist"],
      // ignore_watch: ["node_modules", ".git", "games.json", "games.json.bak", "logs"]
    },
  ],

  // Optional: simple deploy stanza (not used on Replit, handy for VPS)
  deploy: {
    // production: {
    //   user: "node",
    //   host: "your-host",
    //   ref: "origin/main",
    //   repo: "git@github.com:you/hold-draw-server.git",
    //   path: "/var/www/hold-draw-server",
    //   "post-deploy": "npm ci && npm run build && pm2 reload ecosystem.config.cjs --env production"
    // }
  },
};
