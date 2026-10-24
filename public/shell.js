// Shared sidebar for the signed-in pages: Dashboard · Automations · Comments,
// the light/dark switch and the account. Pages mark themselves with <body data-page="…">.
(() => {
  const icons = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
    automations: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    comments: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  };
  const page = document.body.dataset.page;
  const link = (key, href, label) => `<a href="${href}" class="${page === key ? 'on' : ''}" ${page === key ? 'aria-current="page"' : ''}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[key]}</svg>${label}</a>`;
  const side = document.getElementById('side');
  side.innerHTML = `
    <a class="brand" href="/"><span class="logo">▶</span>CommentDrop</a>
    <nav class="nav">${link('dashboard', '/dashboard', 'Dashboard')}${link('automations', '/automations', 'Automations')}${link('comments', '/comments', 'Comments')}</nav>
    <div class="side-foot">
      <button class="theme-btn" id="themeBtn" type="button" aria-label="Switch light or dark theme"></button>
      <div class="acct" id="acct"></div>
    </div>`;

  const root = document.documentElement;
  const paintTheme = () => {
    const dark = root.dataset.theme === 'dark';
    document.getElementById('themeBtn').innerHTML = dark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>Light mode'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>Dark mode';
  };
  document.getElementById('themeBtn').onclick = () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('cd.theme', root.dataset.theme); } catch {}
    paintTheme();
  };
  paintTheme();

  fetch('/api/me').then((r) => (r.status === 401 ? (location.href = '/') : r.json())).then((me) => {
    if (!me || !me.email) return;
    const name = me.channelTitle || me.channel_title || me.name || me.email;
    const avatar = me.channelAvatar || me.channel_avatar;
    document.getElementById('acct').innerHTML = `
      ${avatar ? `<img src="${avatar}" alt="" referrerpolicy="no-referrer">` : `<span class="acct-i">${String(name)[0].toUpperCase()}</span>`}
      <div class="acct-t"><b></b><span></span></div>
      <button class="acct-out" type="button" title="Sign out" aria-label="Sign out"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg></button>`;
    document.querySelector('.acct-t b').textContent = name;
    document.querySelector('.acct-t span').textContent = me.email;
    document.querySelector('.acct-out').onclick = async () => { await fetch('/api/auth/signout', { method: 'POST' }); location.href = '/'; };
  }).catch(() => {});
})();
