if (new URLSearchParams(location.search).get('error')) {
  const msg = document.createElement('div');
  msg.className = 'login-error';
  msg.textContent = 'Invalid credentials';
  document.querySelector('form').prepend(msg);
}
