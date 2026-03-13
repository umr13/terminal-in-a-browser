# terminal-in-a-browser

A lightweight web-based terminal with local shell and SSH support. Runs as a single Node.js process with no build step.

## Features

- Password-protected login
- Multiple tabs, each with its own terminal session
- Local shell or SSH connections per tab
- Designed to run behind a reverse proxy (e.g. nginx)

## Setup

```bash
npm install
cp .env.example .env   # then edit .env
node server.js
```

### `.env`

```
TERM_PASSWORD=yourpassword
SESSION_SECRET=yoursecret
PORT=8081
BASE_PATH=/example   # optional, if behind a reverse proxy
```

## Running with PM2

```bash
pm2 start ecosystem.config.js
pm2 restart terminal-in-a-browser --update-env
pm2 logs terminal-in-a-browser
```

## Reverse proxy (optional)

If you want to serve the app under a subpath or alongside other services, you can put it behind a reverse proxy like nginx. Set `BASE_PATH` in `.env` to match the public path prefix (e.g. `/webshell`).

> **Important:** WebSocket upgrade headers must be forwarded or terminal connections will fail. Also ensure `proxy_pass` ends with `/` so the path prefix is stripped before reaching the app.

```nginx
location /example/ {
    proxy_pass http://localhost:8081/;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```
