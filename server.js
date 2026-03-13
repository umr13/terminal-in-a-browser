require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const { Client: SSHClient } = require('ssh2');
const cookie = require('cookie');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 7681;
const TERM_PASSWORD = process.env.TERM_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'default-secret';
// Public base path as seen by the browser (e.g. /terminal when behind a reverse proxy).
// The backend itself always listens at /, /login, etc. — nginx strips the prefix.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');

const sessionMiddleware = session({
  store: new MemoryStore({ checkPeriod: 86400000 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect(BASE_PATH + '/');
}

app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect(BASE_PATH + '/terminal');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === TERM_PASSWORD) {
    req.session.authenticated = true;
    res.redirect(BASE_PATH + '/terminal');
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

server.on('upgrade', (req, socket, head) => {
  sessionMiddleware(req, {}, () => {
    if (!req.session || !req.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

wss.on('connection', (ws) => {
  let ptyProcess = null;
  let sshClient = null;
  let sshStream = null;
  let initialized = false;

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
        ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          cwd: process.env.HOME || process.cwd(),
          env: process.env
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

        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24 }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
              ws.close();
              return;
            }
            sshStream = stream;
            stream.on('error', () => {}); // suppress channel-close errors
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
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
            ws.close();
          }
        });

        const connectConfig = {
          host: msg.host,
          port: msg.port || 22,
          username: msg.username,
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
      if (ptyProcess) {
        ptyProcess.write(msg.data);
      } else if (sshStream) {
        sshStream.write(msg.data);
      }
    } else if (msg.type === 'resize') {
      if (ptyProcess) {
        ptyProcess.resize(msg.cols, msg.rows);
      } else if (sshStream) {
        sshStream.setWindow(msg.rows, msg.cols, 0, 0);
      }
    }
  });

  ws.on('close', () => {
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    if (sshStream) {
      sshStream.end();
      sshStream = null;
    }
    if (sshClient) {
      sshClient.end();
      sshClient = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Terminal server running on http://localhost:${PORT}`);
});
