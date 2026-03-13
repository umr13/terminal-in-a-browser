require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const rateLimit = require('express-rate-limit');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const { Client: SSHClient } = require('ssh2');
const cookie = require('cookie');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Refuse to start with default/missing secrets
if (!process.env.TERM_PASSWORD) {
  console.error('FATAL: TERM_PASSWORD is not set in .env');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set in .env');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // nginx terminates SSL; trust X-Forwarded-Proto for req.secure
const server = http.createServer(app);

const PORT = process.env.PORT || 7681;
const TERM_PASSWORD = process.env.TERM_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;
const MAX_TABS = parseInt(process.env.MAX_TABS || '10');

// TOFU SSH known-hosts store
const KNOWN_HOSTS_FILE = path.join(process.env.HOME || '', '.terminal-browser-known-hosts.json');
let knownHosts = {};
try {
  knownHosts = JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8'));
} catch {}

function saveKnownHosts() {
  fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(knownHosts, null, 2), { mode: 0o600 });
}

// Track open WebSocket connections per session
const sessionConnections = new Map(); // sessionId -> count

const sessionMiddleware = session({
  store: new MemoryStore({ checkPeriod: 86400000 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  },
});

// Security headers + CSP
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net; " +
    "style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "connect-src 'self' wss: ws:; " +
    "img-src 'self' data:; " +
    "frame-ancestors 'none';"
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect(BASE_PATH + '/');
}

// Rate-limit login: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.redirect(BASE_PATH + '/?error=1'),
});

app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect(BASE_PATH + '/terminal');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password === TERM_PASSWORD) {
    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) return res.redirect(BASE_PATH + '/?error=1');
      req.session.authenticated = true;
      req.session.save((saveErr) => {
        if (saveErr) return res.redirect(BASE_PATH + '/?error=1');
        res.redirect(BASE_PATH + '/terminal');
      });
    });
  } else {
    res.redirect(BASE_PATH + '/?error=1');
  }
});

app.get('/terminal', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'));
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(BASE_PATH + '/'));
});

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  if (ALLOWED_ORIGIN) return origin === ALLOWED_ORIGIN;
  // Default: origin host must match the Host header (prevents cross-site WS hijacking)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  if (!isOriginAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  sessionMiddleware(req, {}, () => {
    if (!req.session || !req.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const sessionId = req.session.id;
    const count = sessionConnections.get(sessionId) || 0;
    if (count >= MAX_TABS) {
      socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
      socket.destroy();
      return;
    }
    sessionConnections.set(sessionId, count + 1);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._sessionId = sessionId;
      wss.emit('connection', ws, req);
    });
  });
});

wss.on('connection', (ws) => {
  let ptyProcess = null;
  let sshClient = null;
  let sshStream = null;
  let initialized = false;

  function cleanup() {
    const count = sessionConnections.get(ws._sessionId) || 0;
    if (count > 0) sessionConnections.set(ws._sessionId, count - 1);
    if (ptyProcess) { ptyProcess.kill(); ptyProcess = null; }
    if (sshStream) { sshStream.end(); sshStream = null; }
    if (sshClient) { sshClient.end(); sshClient = null; }
  }

  function clampDims(cols, rows) {
    return {
      cols: Math.min(Math.max(parseInt(cols) || 80, 10), 500),
      rows: Math.min(Math.max(parseInt(rows) || 24, 5), 200),
    };
  }

  ws.on('message', (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg);
    } catch {
      return;
    }

    if (!initialized) {
      initialized = true;

      if (msg.type === 'local') {
        const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : 'bash');
        const shellArgs = process.platform === 'win32' ? [] : ['-l'];
        const { cols, rows } = clampDims(msg.cols, msg.rows);

        ptyProcess = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: process.env.HOME || process.cwd(),
          env: process.env,
        });

        ptyProcess.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }));
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
            ws.close();
          }
        });

        ws.send(JSON.stringify({ type: 'ready' }));

      } else if (msg.type === 'ssh') {
        sshClient = new SSHClient();
        const { cols, rows } = clampDims(msg.cols, msg.rows);
        const hostKey = `${msg.host}:${msg.port || 22}`;

        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', message: 'SSH shell could not be opened.' }));
              ws.close();
              return;
            }
            sshStream = stream;
            stream.on('error', () => {});
            ws.send(JSON.stringify({ type: 'ready' }));

            stream.on('data', (data) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data: data.toString() }));
              }
            });

            stream.stderr.on('data', (data) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', data: data.toString() }));
              }
            });

            stream.on('close', () => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'exit', code: 0 }));
                ws.close();
              }
              sshClient.end();
            });
          });
        });

        sshClient.on('error', (err) => {
          console.error(`SSH connection error [${hostKey}]: ${err.message}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'SSH connection failed. Check host, credentials, and server logs.' }));
            ws.close();
          }
        });

        const connectConfig = {
          host: msg.host,
          port: msg.port || 22,
          username: msg.username,
          readyTimeout: 10000,
          hostVerifier: (key) => {
            const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
            if (knownHosts[hostKey]) {
              if (knownHosts[hostKey] !== fingerprint) {
                console.error(`SSH HOST KEY MISMATCH for ${hostKey}! Stored: ${knownHosts[hostKey]}, Got: ${fingerprint}`);
                ws.send(JSON.stringify({ type: 'error', message: `Host key mismatch for ${msg.host} — possible MITM attack. Connection refused.` }));
                return false;
              }
              return true;
            }
            // TOFU: first connection — store and notify
            knownHosts[hostKey] = fingerprint;
            saveKnownHosts();
            console.log(`SSH: Trusted new host ${hostKey} fingerprint: ${fingerprint}`);
            return true;
          },
        };

        if (msg.privateKey) {
          connectConfig.privateKey = msg.privateKey;
        } else {
          connectConfig.password = msg.password;
        }

        sshClient.connect(connectConfig);

      } else {
        initialized = false;
      }
      return;
    }

    if (msg.type === 'input') {
      if (ptyProcess) ptyProcess.write(msg.data);
      else if (sshStream) sshStream.write(msg.data);
    } else if (msg.type === 'resize') {
      const { cols, rows } = clampDims(msg.cols, msg.rows);
      if (ptyProcess) ptyProcess.resize(cols, rows);
      else if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`Terminal server running on http://localhost:${PORT}`);
});
