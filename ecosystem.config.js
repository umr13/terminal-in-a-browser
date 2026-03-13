module.exports = {
  apps: [{
    name: 'terminal-in-a-browser',
    script: 'server.js',
    env: { NODE_ENV: 'production', PORT: 7681 }
  }]
}
