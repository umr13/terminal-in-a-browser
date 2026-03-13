(function () {
  const tabBar = document.getElementById('tab-bar');
  const container = document.getElementById('terminal-container');
  const btnNewTab = document.getElementById('btn-new-tab');
  const btnNewSsh = document.getElementById('btn-new-ssh');
  const btnLogout = document.getElementById('btn-logout');
  const sshModal = document.getElementById('ssh-modal');
  const btnSshConnect = document.getElementById('btn-ssh-connect');
  const btnSshCancel = document.getElementById('btn-ssh-cancel');

  let tabCounter = 0;
  let activeTabId = null;
  const tabs = {}; // id -> { ws, term, fitAddon, wrapper, tabEl }
  const emptyState = document.getElementById('empty-state');

  function updateEmptyState() {
    emptyState.classList.toggle('hidden', Object.keys(tabs).length > 0);
  }

  // Derive base from current page path: /webshell/terminal → /webshell
  const basePath = location.pathname.replace(/\/[^/]*$/, '');
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${basePath}/`;

  btnLogout.addEventListener('click', () => {
    fetch(basePath + '/logout', { method: 'POST' })
      .then(() => { location.href = basePath + '/'; });
  });

  function createTab(initMsg) {
    const id = ++tabCounter;
    const label = initMsg.type === 'ssh' ? `SSH: ${initMsg.host}` : `Shell ${id}`;

    // Tab element
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.id = id;

    const indicator = document.createElement('span');
    indicator.className = 'tab-indicator';
    indicator.textContent = '›';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'tab-label';
    labelSpan.textContent = label;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });

    tabEl.appendChild(indicator);
    tabEl.appendChild(labelSpan);
    tabEl.appendChild(closeBtn);
    tabEl.addEventListener('click', () => switchTab(id));
    tabBar.appendChild(tabEl);

    // Terminal wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'term-wrapper';
    container.appendChild(wrapper);

    // xterm instance
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Menlo, monospace",
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3a7bd550',
        black: '#1a1a1a', red: '#e06c75', green: '#98c379',
        yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd',
        cyan: '#56b6c2', white: '#abb2bf',
        brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
        brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
        brightCyan: '#56b6c2', brightWhite: '#ffffff'
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(wrapper);

    // WebSocket
    const ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      // Send init message with current dimensions
      fitAddon.fit();
      const dims = { cols: term.cols, rows: term.rows };
      ws.send(JSON.stringify({ ...initMsg, ...dims }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'ready') {
        // ready — nothing extra needed
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      } else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[33m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
        tabEl.style.opacity = '0.5';
      }
    });

    ws.addEventListener('close', () => {
      if (tabs[id]) {
        term.write('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n');
        tabEl.style.opacity = '0.5';
      }
    });

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    tabs[id] = { ws, term, fitAddon, wrapper, tabEl };
    updateEmptyState();
    switchTab(id);
    return id;
  }

  function switchTab(id) {
    if (activeTabId && tabs[activeTabId]) {
      tabs[activeTabId].wrapper.classList.remove('active');
      tabs[activeTabId].tabEl.classList.remove('active');
    }
    activeTabId = id;
    const t = tabs[id];
    t.wrapper.classList.add('active');
    t.tabEl.classList.add('active');
    t.fitAddon.fit();
    sendResize(id);
    t.term.focus();
  }

  function closeTab(id) {
    const t = tabs[id];
    if (!t) return;

    if (t.ws.readyState === WebSocket.OPEN || t.ws.readyState === WebSocket.CONNECTING) {
      t.ws.close();
    }
    t.term.dispose();
    t.wrapper.remove();
    t.tabEl.remove();
    delete tabs[id];
    updateEmptyState();

    // Switch to another tab if this was active
    if (activeTabId === id) {
      activeTabId = null;
      const remaining = Object.keys(tabs);
      if (remaining.length > 0) {
        switchTab(parseInt(remaining[remaining.length - 1]));
      }
    }
  }

  function sendResize(id) {
    const t = tabs[id];
    if (!t) return;
    if (t.ws.readyState === WebSocket.OPEN) {
      t.ws.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
    }
  }

  window.addEventListener('resize', () => {
    if (activeTabId && tabs[activeTabId]) {
      tabs[activeTabId].fitAddon.fit();
      sendResize(activeTabId);
    }
  });

  // Buttons
  btnNewTab.addEventListener('click', () => createTab({ type: 'local' }));

  btnNewSsh.addEventListener('click', () => {
    sshModal.classList.remove('hidden');
    document.getElementById('ssh-host').focus();
  });

  btnSshCancel.addEventListener('click', () => sshModal.classList.add('hidden'));

  sshModal.addEventListener('click', (e) => {
    if (e.target === sshModal) sshModal.classList.add('hidden');
  });

  btnSshConnect.addEventListener('click', () => {
    const host = document.getElementById('ssh-host').value.trim();
    const port = parseInt(document.getElementById('ssh-port').value) || 22;
    const username = document.getElementById('ssh-user').value.trim();
    const password = document.getElementById('ssh-pass').value;

    if (!host || !username) return;

    sshModal.classList.add('hidden');
    createTab({ type: 'ssh', host, port, username, password });

    // Clear sensitive field
    document.getElementById('ssh-pass').value = '';
  });

  // Enter key in SSH modal
  sshModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSshConnect.click();
    if (e.key === 'Escape') sshModal.classList.add('hidden');
  });

  // Open first local tab on load
  createTab({ type: 'local' });
})();
