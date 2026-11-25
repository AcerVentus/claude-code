/* InSys - Internal Systems. Browser application (no external libraries). */
'use strict';
(function () {

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function append(el, kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) append(el, kid);
      else el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }

  /** Build a DOM element. All text goes in as text nodes, never as HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const v = attrs[key];
        if (v === null || v === undefined || v === false) continue;
        if (key === 'class') el.className = v;
        else if (key === 'text') el.textContent = v;
        else if (key === 'value') value = v;
        else if (key === 'style') Object.assign(el.style, v);
        else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2), v);
        else if (v === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(v));
      }
    }
    append(el, kids);
    if (value !== undefined) el.value = value;
    return el;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' + n : String(n));

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseDay(s) {
    const p = s.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }
  function dayDiff(a, b) {
    return Math.round((parseDay(a) - parseDay(b)) / 86400000);
  }
  function addDays(s, n) {
    const d = new Date(parseDay(s) + n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function fmtDate(s) {
    if (!s) return '';
    const p = s.split('-');
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function localDay(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtMoney(v) {
    if (v === null || v === undefined) return '';
    const n = Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cur = S.data && S.data.meta.currency;
    return cur ? cur + ' ' + n : n;
  }
  function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) + '%' : '—';
  }
  function plural(n, word, many) {
    return n + ' ' + (n === 1 ? word : (many || word + 's'));
  }
  function pushMap(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  // ------------------------------------------------------------------
  // Application state
  // ------------------------------------------------------------------

  const S = {
    me: null,
    csrf: '',
    data: null,
    I: null,            // indexes built from data
    activity: [],
    view: 'overview',
    openRef: null,
    filters: {},
    sort: {},
    history: { id: null, items: null },
    log: { q: '', kind: 'actions', scope: 'all', month: '', data: null, error: null, seq: 0 },
    // Updates made by other people. `shown` is the newest update already
    // announced with a banner in this browser (null until the first load).
    events: { list: [], unread: 0, lastId: 0, shown: null, open: false },
    routed: false,      // has the address bar been read since signing in?
    adminTab: 'users',
    admin: { users: null, system: null, audit: null },
    synced: true,
  };

  const VIEWS = [
    { id: 'overview', label: 'Overview', group: 'Status' },
    { id: 'my', label: 'My Work', group: 'Status' },
    { id: 'tasks', label: 'Tasks', group: 'Status' },
    { id: 'log', label: 'Activity log', group: 'Status' },
    { id: 'projects', module: 'project', group: 'Work' },
    { id: 'enquiries', module: 'enquiry', group: 'Work' },
    { id: 'eois', module: 'eoi', group: 'Work' },
    { id: 'subcons', label: 'Subcontractors', group: 'Work' },
    { id: 'finance', module: 'finance', group: 'Teams' },
    { id: 'office', module: 'office', group: 'Teams' },
    { id: 'admin', label: 'Admin', admin: true, group: 'Administration' },
  ];

  const root = document.getElementById('root');

  const mods = () => S.data.meta.modules;
  const isAdmin = () => S.me && S.me.role === 'admin';
  const userName = (id) => {
    if (id === null || id === undefined) return 'Unassigned';
    const u = S.I.users.get(id);
    return u ? u.full_name : 'Unknown';
  };
  const tone = (r) => S.I.tone[r.module][r.status] || 'active';
  const isOpen = (r) => { const t = tone(r); return t !== 'done' && t !== 'dead'; };
  const taskOpen = (t) => t.status !== 'Done';
  const canEditTask = (t) => isAdmin() || t.assignee_id === S.me.id || t.created_by === S.me.id;
  const viewForModule = (m) => VIEWS.find((v) => v.module === m).id;

  function viewAllowed(id) {
    const v = VIEWS.find((x) => x.id === id);
    if (!v || !S.data) return false;
    if (v.admin) return isAdmin();
    if (v.module) return S.data.meta.visible_modules.includes(v.module);
    return true;
  }
  const defaultView = () => (isAdmin() ? 'overview' : 'my');

  function buildIndex(data) {
    const I = {
      users: new Map(), recs: new Map(), byRef: new Map(), links: new Map(), tasksByRec: new Map(), tone: {},
      subs: new Map(), subByRef: new Map(), subsByRec: new Map(), recsBySub: new Map(),
    };
    data.users.forEach((u) => I.users.set(u.id, u));
    data.records.forEach((r) => { I.recs.set(r.id, r); I.byRef.set(r.ref, r); });
    data.links.forEach((pair) => { pushMap(I.links, pair[0], pair[1]); pushMap(I.links, pair[1], pair[0]); });
    data.tasks.forEach((t) => { if (t.record_id !== null) pushMap(I.tasksByRec, t.record_id, t); });
    Object.keys(data.meta.modules).forEach((key) => {
      I.tone[key] = {};
      data.meta.modules[key].statuses.forEach((s) => { I.tone[key][s[0]] = s[1]; });
    });
    (data.subcons || []).forEach((sub) => { I.subs.set(sub.id, sub); I.subByRef.set(sub.ref, sub); });
    (data.record_subcons || []).forEach((x) => {
      const sub = I.subs.get(x.subcon_id);
      const rec = I.recs.get(x.record_id);
      if (!sub || !rec) return;
      const entry = {
        sub: sub, rec: rec, scope: x.scope || '',
        last_update: x.last_update || '', last_update_date: x.last_update_date || null,
        next_action: x.next_action || '', next_action_date: x.next_action_date || null,
      };
      pushMap(I.subsByRec, rec.id, entry);
      pushMap(I.recsBySub, sub.id, entry);
    });
    S.I = I;
  }

  // ------------------------------------------------------------------
  // Server calls
  // ------------------------------------------------------------------

  async function api(method, path, body) {
    const opt = { method: method, headers: {}, credentials: 'same-origin', cache: 'no-store' };
    if (method !== 'GET') {
      opt.headers['Content-Type'] = 'application/json';
      opt.headers['X-CSRF-Token'] = S.csrf || '';
      opt.body = JSON.stringify(body || {});
    }
    let res;
    try {
      res = await fetch(path, opt);
    } catch (e) {
      const err = new Error('Cannot reach InSys. Check your internet connection and try again.');
      err.network = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('The request failed (' + res.status + ').'));
      err.status = res.status;
      err.code = data && data.code;
      if (res.status === 401 && path !== '/api/login') signedOut(S.data ? 'Your session has ended. Please sign in again.' : null);
      else if (err.code === 'password_change_required') showForcePassword();
      else if (err.code === 'conflict') refresh().catch(() => {});
      throw err;
    }
    return data;
  }

  let refreshing = null;
  let refreshAgain = false;

  /** Load everything this user may see and redraw. Safe to call at any time. */
  function refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        const announced = S.events.shown;
        do {
          refreshAgain = false;
          const results = await Promise.all([api('GET', '/api/state'), api('GET', '/api/activity'), api('GET', '/api/events')]);
          S.data = results[0];
          S.me = results[0].me;
          S.activity = results[1].activity;
          S.events.list = results[2].events;
          S.events.unread = results[2].unread;
          S.events.lastId = results[2].last_id;
          buildIndex(S.data);
        } while (refreshAgain);
        setSync(true);
        renderAll();
        // Anything newer than what this browser has already announced gets a banner.
        // On the first load nothing does: the bell's count covers what was missed.
        const fresh = announced === null ? [] : S.events.list.filter((e) => e.id > announced);
        S.events.shown = S.events.lastId;
        renderBell();
        if (S.events.open) { markUpdatesSeen(); renderBell(); }  // the list is on screen, so it has been seen
        else if (fresh.length) showBanners(fresh);
        if (S.view === 'admin') loadAdmin(S.adminTab);
        if (S.view === 'log') loadLog();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  let ticking = false;
  async function tick() {
    if (document.hidden || !S.data || !S.me || ticking) return;
    ticking = true;
    try {
      const v = await api('GET', '/api/version');
      setSync(true);
      if (S.data && v.version !== S.data.version) await refresh();
      else if (S.view === 'admin' && S.adminTab === 'system') loadAdmin('system');
    } catch (e) {
      if (e.network || (e.status && e.status >= 500)) setSync(false);
    } finally {
      ticking = false;
    }
  }
  setInterval(tick, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('online', tick);

  function setSync(ok) {
    S.synced = ok;
    const el = document.getElementById('sync');
    if (!el) return;
    el.className = 'sync' + (ok ? '' : ' off');
    el.title = ok ? 'Changes made by anyone appear here automatically.' : 'Trying to reconnect to InSys.';
    el.querySelector('.label').textContent = ok ? 'Live' : 'Reconnecting…';
  }

  // ------------------------------------------------------------------
  // Toasts and dialogs
  // ------------------------------------------------------------------

  function toast(message, isError) {
    let host = document.getElementById('toasts');
    if (!host) { host = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(host); }
    const el = h('div', { class: 'toast' + (isError ? ' error' : ''), text: message });
    host.appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3200);
  }

  function closeDialogs() {
    document.querySelectorAll('dialog.dlg').forEach((d) => { try { d.close(); } catch (e) { /* ignore */ } d.remove(); });
  }

  /**
   * A modal form. opts: title, intro, fields[], submitLabel, danger, wide, cancelLabel,
   * onSubmit(values) -> may throw Error(message) to keep the dialog open.
   */
  function formDialog(opts) {
    const inputs = {};
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const grid = h('div', { class: 'form-grid' });
    (opts.fields || []).forEach((f) => {
      if (f.type === 'section') { grid.appendChild(h('h3', { class: 'form-section', text: f.label })); return; }
      if (f.type === 'custom') { grid.appendChild(h('div', { class: 'field full' }, f.node)); return; }
      const id = 'f-' + f.name;
      const base = { id: id, name: f.name, required: f.required, placeholder: f.placeholder, maxlength: f.maxlength, autocomplete: f.autocomplete || 'off' };
      let input;
      const val = (f.value === null || f.value === undefined) ? '' : String(f.value);
      if (f.type === 'textarea') {
        input = h('textarea', Object.assign({}, base, { rows: f.rows || 3, value: val }));
      } else if (f.type === 'select') {
        input = h('select', Object.assign({}, base, { value: val }),
          f.options.map((o) => h('option', { value: String(o.value), text: o.label })));
      } else {
        input = h('input', Object.assign({}, base, {
          type: f.type || 'text', value: val, list: f.options ? id + '-list' : null,
          step: f.type === 'number' ? '0.01' : null, min: f.type === 'number' ? '0' : null,
        }));
      }
      inputs[f.name] = input;
      grid.appendChild(h('div', { class: 'field' + (f.full ? ' full' : '') },
        h('label', { class: 'field-label', for: id }, f.label, f.required ? h('span', { class: 'req', text: ' *' }) : null),
        input,
        (f.options && f.type !== 'select') ? h('datalist', { id: id + '-list' }, f.options.map((o) => h('option', { value: o }))) : null,
        f.hint ? h('span', { class: 'hint', text: f.hint }) : null));
    });
    const submit = h('button', { type: 'submit', class: 'btn ' + (opts.danger ? 'danger' : 'primary'), text: opts.submitLabel || 'Save' });
    const dlg = h('dialog', { class: 'dlg' + (opts.wide ? ' wide' : '') });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        const values = {};
        Object.keys(inputs).forEach((k) => {
          const el = inputs[k];
          values[k] = el.type === 'password' ? el.value : el.value.trim();
        });
        submit.disabled = true;
        error.hidden = true;
        try {
          await opts.onSubmit(values);
          dlg.close();
        } catch (ex) {
          error.textContent = ex.message || 'Something went wrong. Please try again.';
          error.hidden = false;
          submit.disabled = false;
          error.scrollIntoView({ block: 'nearest' });
        }
      },
    },
    h('div', { class: 'dlg-head' }, h('h2', { text: opts.title }), opts.intro ? h('p', { text: opts.intro }) : null),
    h('div', { class: 'dlg-body' }, error, grid),
    h('div', { class: 'dlg-foot' },
      opts.hideCancel ? null : h('button', { type: 'button', class: 'btn', text: opts.cancelLabel || 'Cancel', onclick: () => dlg.close() }),
      submit));
    dlg.appendChild(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
  }

  function confirmDialog(title, message, label, onConfirm, danger) {
    formDialog({ title: title, intro: message, submitLabel: label, danger: danger, onSubmit: onConfirm });
  }

  /** Show a temporary password once, with a copy button. */
  function secretDialog(title, message, secret) {
    const input = h('input', { type: 'text', readonly: true, value: secret, 'aria-label': 'Temporary password' });
    const copy = h('button', {
      type: 'button', class: 'btn', text: 'Copy',
      onclick: async () => {
        try { await navigator.clipboard.writeText(secret); copy.textContent = 'Copied'; }
        catch (e) { input.select(); copy.textContent = 'Press Ctrl+C'; }
      },
    });
    formDialog({
      title: title, intro: message, submitLabel: 'Done', hideCancel: true,
      fields: [{ type: 'custom', node: h('div', { class: 'secret' }, input, copy) }],
      onSubmit: async () => {},
    });
  }

  // ------------------------------------------------------------------
  // Signing in
  // ------------------------------------------------------------------

  // The alternative look, remembered per browser. It is switched from the
  // sidebar, by clicking the logo five times, or by typing "samaritan" in the
  // search box and pressing Enter.
  const THEME_KEY = 'insys-theme';
  function savedTheme() {
    try { return window.localStorage.getItem(THEME_KEY) === 'samaritan' ? 'samaritan' : 'standard'; } catch (e) { return 'standard'; }
  }
  function setTheme(name, announce) {
    if (name === 'samaritan') document.documentElement.setAttribute('data-theme', 'samaritan');
    else document.documentElement.removeAttribute('data-theme');
    try { window.localStorage.setItem(THEME_KEY, name); } catch (e) { /* stays for this visit only */ }
    const button = document.getElementById('theme-toggle');
    if (button) button.textContent = 'Theme: ' + (name === 'samaritan' ? 'Samaritan' : 'Standard');
    if (announce) toast(name === 'samaritan' ? 'Samaritan theme on. Click the InSys logo five times to switch back.' : 'Standard theme restored.');
  }
  const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'samaritan' ? 'samaritan' : 'standard');
  const toggleTheme = () => setTheme(currentTheme() === 'samaritan' ? 'standard' : 'samaritan', true);
  setTheme(savedTheme(), false);

  let logoClicks = [];
  function logoClicked() {
    const now = Date.now();
    logoClicks = logoClicks.filter((at) => now - at < 2500);
    logoClicks.push(now);
    if (logoClicks.length >= 5) { logoClicks = []; toggleTheme(); }
  }

  function brand() {
    return h('div', { class: 'brand', onclick: logoClicked },
      h('div', { class: 'brand-mark', text: 'IS', 'aria-hidden': 'true' }),
      h('div', null, h('div', { class: 'brand-name', text: 'InSys' }), h('div', { class: 'brand-sub', text: 'Internal Systems' })));
  }

  function signedOut(message) {
    if (!S.me && document.getElementById('login-form')) return;
    S.me = null; S.data = null; S.csrf = ''; S.routed = false;
    resetUpdates();
    closeDialogs();
    showLogin(message);
  }

  function showLogin(message) {
    const error = h('div', { class: 'form-error', role: 'alert', hidden: !message, text: message || '' });
    const user = h('input', { id: 'login-user', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
    const pass = h('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true });
    const button = h('button', { type: 'submit', class: 'btn primary', text: 'Sign in' });
    const form = h('form', {
      id: 'login-form',
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        error.hidden = true;
        try {
          const res = await api('POST', '/api/login', { username: user.value.trim(), password: pass.value });
          S.csrf = res.csrf;
          S.me = res.user;
          if (res.user.must_change) showForcePassword(pass.value);
          else await startApp();
        } catch (ex) {
          error.textContent = ex.message;
          error.hidden = false;
          button.disabled = false;
          pass.value = '';
          pass.focus();
        }
      },
    },
    error,
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'login-user', text: 'Username' }), user),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'login-pass', text: 'Password' }), pass),
    button);
    root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
      brand(),
      h('h1', { text: 'Sign in' }),
      h('p', { class: 'sub', text: 'Use the username and password given to you by your administrator.' }),
      form,
      h('p', { class: 'auth-foot', text: 'For authorised staff only.' }))));
    user.focus();
  }

  /** First sign-in (or after a reset): the temporary password must be replaced. */
  function showForcePassword(knownCurrent) {
    closeDialogs();
    const minLen = 10;
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const current = h('input', { id: 'fp-current', type: 'password', autocomplete: 'current-password', required: true, value: knownCurrent || '' });
    const next = h('input', { id: 'fp-new', type: 'password', autocomplete: 'new-password', required: true, minlength: minLen });
    const again = h('input', { id: 'fp-again', type: 'password', autocomplete: 'new-password', required: true });
    const button = h('button', { type: 'submit', class: 'btn primary', text: 'Save password and continue' });
    const form = h('form', {
      id: 'force-password-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (next.value !== again.value) {
          error.textContent = 'The two new passwords do not match.';
          error.hidden = false;
          return;
        }
        button.disabled = true;
        try {
          await api('POST', '/api/change-password', { current: current.value, new: next.value });
          S.me.must_change = false;
          await startApp();
          toast('Password saved. Welcome to InSys.');
        } catch (ex) {
          error.textContent = ex.message;
          error.hidden = false;
          button.disabled = false;
        }
      },
    },
    error,
    knownCurrent ? null : h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'fp-current', text: 'Temporary password' }), current),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'fp-new', text: 'New password' }), next,
      h('span', { class: 'hint', text: 'At least ' + minLen + ' characters, with at least one letter and one number.' })),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'fp-again', text: 'New password again' }), again),
    button);
    root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
      brand(),
      h('h1', { text: 'Choose your password' }),
      h('p', { class: 'sub', text: 'You signed in with a temporary password. Choose your own to continue. Only you will know it.' }),
      form,
      h('p', { class: 'auth-foot' }, h('button', { type: 'button', class: 'btn quiet', text: 'Sign out', onclick: signOut })))));
    next.focus();
  }

  async function signOut() {
    try { await api('POST', '/api/logout', {}); } catch (e) { /* signing out regardless */ }
    S.me = null; S.data = null; S.csrf = ''; S.routed = false;
    resetUpdates();
    closeDialogs();
    showLogin();
  }

  async function startApp() {
    root.replaceChildren(h('p', { class: 'boot', text: 'Loading InSys…' }));
    await refresh();
  }

  function changePasswordDialog() {
    formDialog({
      title: 'Change password',
      fields: [
        { name: 'current', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
        { name: 'next', label: 'New password', type: 'password', required: true, full: true, autocomplete: 'new-password',
          hint: 'At least ' + S.data.meta.min_password_length + ' characters, with at least one letter and one number.' },
        { name: 'again', label: 'New password again', type: 'password', required: true, full: true, autocomplete: 'new-password' },
      ],
      submitLabel: 'Change password',
      onSubmit: async (v) => {
        if (v.next !== v.again) throw new Error('The two new passwords do not match.');
        await api('POST', '/api/change-password', { current: v.current, new: v.next });
        toast('Password changed.');
      },
    });
  }

  // ------------------------------------------------------------------
  // Routing and shell
  // ------------------------------------------------------------------

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const view = viewAllowed(parts[0]) ? parts[0] : defaultView();
    S.view = view;
    S.openRef = parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : null;
  }

  function go(view, ref) {
    const target = '#/' + view + (ref ? '/' + ref : '');
    if (location.hash === target) { parseHash(); renderAll(); }
    else location.hash = target;
  }

  const recHref = (r) => '#/' + S.view + '/' + r.ref;

  window.addEventListener('hashchange', () => {
    if (!S.data) return;
    const before = S.view;
    parseHash();
    renderAll();
    if (before !== S.view) {
      window.scrollTo(0, 0);
      if (S.view === 'admin') loadAdmin(S.adminTab);
      if (S.view === 'log') loadLog();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.events.open) { closeBell(); return; }
    if (e.key === 'Escape' && S.data && S.openRef && !document.querySelector('dialog[open]')) go(S.view);
  });
  document.addEventListener('click', (e) => {
    if (S.events.open && !e.target.closest('.bell-wrap')) closeBell();
  });

  function ensureShell() {
    if (document.getElementById('main')) return;
    const search = h('input', {
      id: 'global-search', type: 'search', autocomplete: 'off',
      placeholder: 'Search any reference, title, organisation…',
      'aria-label': 'Search all records',
      oninput: () => drawSearch(search.value),
      onfocus: () => drawSearch(search.value),
      onkeydown: (e) => {
        if (e.key === 'Escape') { search.value = ''; drawSearch(''); search.blur(); }
        if (e.key === 'Enter' && search.value.trim().toLowerCase() === 'samaritan') { search.value = ''; drawSearch(''); toggleTheme(); return; }
        if (e.key === 'Enter') { const first = document.querySelector('#search-results button'); if (first) first.click(); }
      },
      onblur: () => setTimeout(() => { if (!document.activeElement || !document.activeElement.closest('#search-results')) drawSearch(''); }, 150),
    });
    root.replaceChildren(
      h('div', { class: 'shell' },
        h('aside', { class: 'sidebar' }, brand(), h('nav', { class: 'nav', id: 'nav', 'aria-label': 'Sections' }),
          h('div', { class: 'side-foot', id: 'side-foot' })),
        h('div', { class: 'content' },
          h('div', { class: 'topbar' },
            h('div', { class: 'search' }, search, h('div', { id: 'search-results', class: 'search-results', hidden: true, onmousedown: (e) => e.preventDefault() })),
            h('div', { class: 'topbar-right' },
              h('span', { id: 'sync', class: 'sync' }, h('span', { class: 'dot' }), h('span', { class: 'label', text: 'Live' })),
              h('div', { class: 'bell-wrap' },
                h('button', { id: 'bell', type: 'button', class: 'bell', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'bell-panel', onclick: toggleBell },
                  bellIcon(), h('span', { id: 'bell-count', class: 'bell-count', hidden: true })),
                h('div', { id: 'bell-panel', class: 'bell-panel', role: 'region', 'aria-label': 'Updates from other people', hidden: true })),
              h('div', { class: 'who', id: 'who' }),
              h('button', { class: 'btn small', type: 'button', text: 'Password', title: 'Change your password', onclick: changePasswordDialog }),
              h('button', { class: 'btn small', type: 'button', text: 'Sign out', onclick: signOut }))),
          h('main', { id: 'main' }))),
      h('div', { id: 'drawer-host' }));
    setSync(S.synced);
  }

  function renderAll() {
    if (!S.data) return;
    ensureShell();
    if (!S.routed || !viewAllowed(S.view)) { parseHash(); S.routed = true; }
    renderNav();
    renderMain();
    renderDrawer();
  }

  function overdueCount(module) {
    const t = today();
    return S.data.records.filter((r) => r.module === module && isOpen(r) && r.next_action_date && r.next_action_date < t).length;
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    const kids = [];
    let group = null;
    const t = today();
    VIEWS.filter((v) => viewAllowed(v.id)).forEach((v) => {
      if (v.group !== group) { group = v.group; kids.push(h('div', { class: 'nav-group', text: group })); }
      let count = null;
      if (v.module) {
        const open = S.data.records.filter((r) => r.module === v.module && isOpen(r)).length;
        const late = overdueCount(v.module);
        count = h('span', {
          class: 'count' + (late ? ' alert' : ''), text: open,
          title: plural(open, 'open item') + (late ? ', ' + late + ' with an overdue action' : ''),
        });
      } else if (v.id === 'subcons') {
        const busy = S.data.subcons.filter((sub) => subconWork(sub).open.length);
        const late = busy.filter((sub) => subconWork(sub).open.some((x) => { const d = followUp(x).date; return !!d && d < t; })).length;
        count = h('span', {
          class: 'count' + (late ? ' alert' : ''), text: busy.length,
          title: plural(busy.length, 'subcontractor') + ' on open work' + (late ? ', ' + late + ' with an overdue action' : ''),
        });
      } else if (v.id === 'my') {
        const mine = S.data.tasks.filter((x) => x.assignee_id === S.me.id && taskOpen(x));
        const late = mine.filter((x) => x.due_date && x.due_date < t).length;
        count = h('span', {
          class: 'count' + (late ? ' alert' : ''), text: mine.length,
          title: plural(mine.length, 'open task') + ' assigned to you' + (late ? ', ' + late + ' overdue' : ''),
        });
      }
      kids.push(h('a', { href: '#/' + v.id, class: v.id === S.view ? 'active' : null, 'aria-current': v.id === S.view ? 'page' : null },
        h('span', { text: v.module ? mods()[v.module].label : v.label }), count));
    });
    nav.replaceChildren(...kids);
    document.getElementById('who').replaceChildren(
      h('div', { class: 'name', text: S.me.full_name }),
      h('div', { class: 'role', text: S.data.meta.roles[S.me.role] || S.me.role }));
    const org = S.data.meta.org_name;
    document.getElementById('side-foot').replaceChildren(
      h('div', { text: (org ? org + ' · ' : '') + 'InSys ' + S.data.meta.app_version }),
      h('button', { id: 'theme-toggle', type: 'button', class: 'theme-toggle', title: 'Switch between the standard look and the Samaritan look',
        text: 'Theme: ' + (currentTheme() === 'samaritan' ? 'Samaritan' : 'Standard'), onclick: toggleTheme }));
    document.title = (org ? org + ' - ' : '') + 'InSys';
  }

  function renderMain() {
    const main = document.getElementById('main');
    const active = document.activeElement;
    const focusId = active && main.contains(active) ? active.id : null;
    const sel = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const scrollY = window.scrollY;
    const v = VIEWS.find((x) => x.id === S.view);
    let node;
    if (v.module) node = viewModule(v.module);
    else if (v.id === 'overview') node = viewOverview();
    else if (v.id === 'my') node = viewMy();
    else if (v.id === 'tasks') node = viewTasks();
    else if (v.id === 'subcons') node = viewSubcons();
    else if (v.id === 'log') node = viewLog();
    else node = viewAdmin();
    main.replaceChildren(node);
    if (S.view === 'log') drawLog();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text input */ } }
      }
    }
    window.scrollTo(0, scrollY);
  }

  // ------------------------------------------------------------------
  // Shared pieces
  // ------------------------------------------------------------------

  function statusPill(r) {
    return h('span', { class: 'pill ' + tone(r), text: r.status });
  }

  function prioChip(priority) {
    if (priority === 'High') return h('span', { class: 'chip prio-high', text: 'High priority' });
    if (priority === 'Urgent') return h('span', { class: 'chip prio-urgent' }, h('span', { class: 'icon', text: '!', 'aria-hidden': 'true' }), 'Urgent');
    return null;
  }

  /** A chip describing how close a date is. */
  function dueChip(dateStr) {
    const d = dayDiff(dateStr, today());
    if (d < 0) return h('span', { class: 'chip overdue', title: fmtDate(dateStr) }, h('span', { class: 'icon', text: '!', 'aria-hidden': 'true' }), 'Overdue ' + plural(-d, 'day'));
    if (d === 0) return h('span', { class: 'chip today', title: fmtDate(dateStr), text: 'Due today' });
    if (d === 1) return h('span', { class: 'chip', title: fmtDate(dateStr), text: 'Tomorrow' });
    if (d <= 7) return h('span', { class: 'chip', title: fmtDate(dateStr), text: 'In ' + d + ' days' });
    return h('span', { class: 'chip', text: fmtDate(dateStr) });
  }

  /** Like dueChip, but only when the date is close enough to be worth flagging. */
  function dueHint(dateStr) {
    return dayDiff(dateStr, today()) <= 7 ? dueChip(dateStr) : null;
  }

  function tile(label, value, flag, note) {
    return h('div', { class: 'tile' },
      h('div', { class: 'label', text: label }),
      h('div', { class: 'value', text: String(value) }),
      flag ? h('div', { class: 'flag ' + flag.kind }, h('span', { 'aria-hidden': 'true', text: flag.kind === 'good' ? '✓' : '!' }), flag.text) : null,
      note ? h('div', { class: 'note', text: note }) : null);
  }

  function trackingTiles(records) {
    const t = today();
    const open = records.filter(isOpen);
    const late = open.filter((r) => r.next_action_date && r.next_action_date < t).length;
    const week = open.filter((r) => r.next_action_date && r.next_action_date >= t && r.next_action_date <= addDays(t, 7)).length;
    const unset = open.filter((r) => !r.next_action_date).length;
    return [
      tile('Open items', open.length, null, records.length + ' in total'),
      tile('Overdue actions', late, late ? { kind: 'crit', text: 'Needs attention' } : { kind: 'good', text: 'None overdue' }),
      tile('Actions due in 7 days', week),
      tile('No next action date', unset, unset ? { kind: 'warn', text: 'Set a date' } : null),
    ];
  }

  function refLink(id) {
    const r = S.I.recs.get(id);
    if (r) return h('a', { class: 'ref', href: recHref(r), text: r.ref, title: r.title });
    const stub = S.data.restricted[String(id)];
    if (stub) return h('span', { class: 'ref muted', title: 'You do not have access to this section', text: stub.ref });
    return h('span', { class: 'muted', text: '—' });
  }

  const refKey = (r) => r.ref.slice(0, 3) + String(r.id).padStart(12, '0');

  // Most pressing work first: open items by next-action date (overdue ones are
  // simply the earliest dates), then open items with no date, then closed items.
  // On the same date the higher priority wins.
  const PRIORITY_RANK = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
  function urgencyKey(r) {
    const rank = PRIORITY_RANK[r.priority] === undefined ? 2 : PRIORITY_RANK[r.priority];
    if (!isOpen(r)) return '3';
    if (!r.next_action_date) return '2' + rank;
    return '1' + r.next_action_date + rank;
  }
  function byUrgency(a, b) {
    const x = urgencyKey(a); const y = urgencyKey(b);
    if (x !== y) return x < y ? -1 : 1;
    return refKey(a) < refKey(b) ? -1 : 1;
  }

  const usesSubcons = (module) => (S.data.meta.subcon_modules || []).includes(module);
  const subconNames = (r) => (S.I.subsByRec.get(r.id) || []).map((x) => x.sub.name).join(', ');

  /**
   * What is next for a subcontractor on a record: the follow-up set for that
   * subcontractor if there is one, otherwise the record's own next action.
   */
  function followUp(x) {
    const own = !!(x.next_action || x.next_action_date);
    return { own: own, text: own ? x.next_action : x.rec.next_action, date: own ? x.next_action_date : x.rec.next_action_date };
  }
  function pairUrgencyKey(x) {
    const rank = PRIORITY_RANK[x.rec.priority] === undefined ? 2 : PRIORITY_RANK[x.rec.priority];
    if (!isOpen(x.rec)) return '3';
    const date = followUp(x).date;
    return date ? '1' + date + rank : '2' + rank;
  }
  function byPairUrgency(a, b) {
    const x = pairUrgencyKey(a); const y = pairUrgencyKey(b);
    if (x !== y) return x < y ? -1 : 1;
    if (a.rec.id !== b.rec.id) return refKey(a.rec) < refKey(b.rec) ? -1 : 1;
    return a.sub.name.toLowerCase() < b.sub.name.toLowerCase() ? -1 : 1;
  }

  /** A subcontractor's work, most urgent first. */
  function subconWork(sub) {
    const all = (S.I.recsBySub.get(sub.id) || []).slice().sort(byPairUrgency);
    const open = all.filter((x) => isOpen(x.rec));
    return { all: all, open: open, closed: all.filter((x) => !isOpen(x.rec)), top: open[0] || null };
  }

  function csvCell(v) {
    let text = (v === null || v === undefined) ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;  // stop spreadsheets treating text as a formula
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function saveCsv(filename, lines) {
    const blob = new Blob([String.fromCharCode(0xFEFF) + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Exported ' + plural(lines.length - 1, 'row') + '.');
  }
  const SORTERS = {
    ref: refKey,
    module: (r) => r.module,
    title: (r) => r.title.toLowerCase(),
    status: (r) => mods()[r.module].statuses.findIndex((s) => s[0] === r.status),
    last: (r) => r.last_action_date,
    next: (r) => (isOpen(r) ? r.next_action_date : null),
    due: (r) => r.due_date,
    amount: (r) => r.amount,
    owner: (r) => (r.owner_id === null ? null : userName(r.owner_id).toLowerCase()),
    subcons: (r) => subconNames(r).toLowerCase(),
  };

  function sortRows(rows, sort) {
    const get = SORTERS[sort.key] || SORTERS.next;
    return rows.slice().sort((a, b) => {
      const x = get(a); const y = get(b);
      const xn = x === null || x === undefined || x === '';
      const yn = y === null || y === undefined || y === '';
      if (xn && yn) return refKey(a) < refKey(b) ? -1 : 1;
      if (xn) return 1;   // blanks always last
      if (yn) return -1;
      if (x < y) return -sort.dir;
      if (x > y) return sort.dir;
      return refKey(a) < refKey(b) ? -1 : 1;
    });
  }

  /**
   * Table of records. opts: module (single-section table) | null, sort {key, dir},
   * onSort(key), empty (text when there are no rows).
   */
  function recordTable(rows, opts) {
    if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: opts.empty || 'Nothing to show.' }));
    const m = opts.module ? mods()[opts.module] : null;
    const cols = [{ key: 'ref', label: 'Ref' }];
    if (!m) cols.push({ key: 'module', label: 'Section' });
    // Sections that use subcontractors get a column for them; in the mixed
    // tables (Overview, My Work) they are named under the title instead.
    const subconColumn = !!m && usesSubcons(opts.module);
    cols.push({ key: 'title', label: 'Title' });
    if (subconColumn) cols.push({ key: 'subcons', label: 'Subcons' });
    cols.push({ key: 'status', label: 'Status' },
      { key: 'last', label: 'Last action' }, { key: 'next', label: 'Next action' });
    if (m) cols.push({ key: 'due', label: m.due_label });
    if (opts.module === 'finance') cols.push({ key: 'amount', label: 'Amount', num: true });
    cols.push({ key: 'owner', label: 'Owner' });

    const head = h('tr', null, cols.map((c) => {
      const on = opts.sort && opts.sort.key === c.key;
      const sortState = on ? (opts.sort.dir === 1 ? 'ascending' : 'descending') : null;
      if (!opts.onSort) return h('th', { class: c.num ? 'num' : null, scope: 'col', text: c.label });
      return h('th', { class: c.num ? 'num' : null, scope: 'col', 'aria-sort': sortState },
        h('button', { type: 'button', title: 'Sort by ' + c.label.toLowerCase(), onclick: () => opts.onSort(c.key) },
          c.label, on ? h('span', { 'aria-hidden': 'true', text: opts.sort.dir === 1 ? '▲' : '▼' }) : null));
    }));

    const body = rows.map((r) => {
      const cells = cols.map((c) => {
        switch (c.key) {
          case 'ref': return h('td', null, h('a', { class: 'ref', href: recHref(r), text: r.ref }));
          case 'module': return h('td', { class: 'nowrap', text: mods()[r.module].singular });
          case 'title': return h('td', { class: 'cell-text' },
            h('div', { class: 'cell-title', text: r.title }),
            r.organisation ? h('div', { class: 'cell-sub', text: r.organisation }) : null,
            !subconColumn && subconNames(r) ? h('div', { class: 'cell-sub', text: 'Subcon: ' + subconNames(r) }) : null,
            prioChip(r.priority));
          case 'subcons': {
            const entries = S.I.subsByRec.get(r.id) || [];
            if (!entries.length) return h('td', { class: 'muted', text: '—' });
            return h('td', { class: 'cell-subcons' }, entries.map((entry) => h('div', null,
              h('a', {
                href: subHref(entry.sub), text: entry.sub.name,
                title: [entry.sub.discipline, entry.scope ? 'Scope: ' + entry.scope : '',
                  entry.last_update ? 'Last update: ' + entry.last_update : '',
                  entry.next_action ? 'Next follow-up: ' + entry.next_action : '',
                  entry.sub.active ? '' : 'Inactive'].filter(Boolean).join(' · ') || 'Open ' + entry.sub.ref,
              }),
              isOpen(r) && entry.next_action_date && entry.next_action_date <= today() ? [' ', dueChip(entry.next_action_date)] : null)));
          }
          case 'status': return h('td', null, statusPill(r));
          case 'last': return h('td', { class: 'cell-text' }, r.last_action
            ? [h('div', { text: r.last_action }), h('div', { class: 'cell-sub', text: fmtDate(r.last_action_date) })]
            : h('span', { class: 'muted', text: 'None logged' }));
          case 'next': {
            if (!isOpen(r)) return h('td', { class: 'muted', text: '—' });
            return h('td', { class: 'cell-text' },
              r.next_action ? h('div', { text: r.next_action }) : null,
              r.next_action_date ? dueChip(r.next_action_date) : h('span', { class: 'chip none', text: r.next_action ? 'No date set' : 'Not set' }));
          }
          case 'due': return h('td', { class: 'nowrap', text: fmtDate(r.due_date) });
          case 'amount': return h('td', { class: 'num', text: fmtMoney(r.amount) });
          default: return h('td', { class: r.owner_id === null ? 'muted nowrap' : 'nowrap', text: userName(r.owner_id) });
        }
      });
      return h('tr', {
        class: 'clickable',
        onclick: (e) => { if (!e.target.closest('a, button, input')) go(S.view, r.ref); },
      }, cells);
    });
    return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, body)));
  }

  function taskTable(tasks, opts) {
    if (!tasks.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: opts.empty || 'No tasks.' }));
    const rows = tasks.map((t) => {
      const editable = canEditTask(t);
      const box = h('input', {
        type: 'checkbox', 'aria-label': 'Mark "' + t.title + '" as done', disabled: !editable,
        title: editable ? 'Mark as done' : 'Only the assignee, the creator or an administrator can change this task',
        onchange: async () => {
          box.disabled = true;
          try {
            await api('PUT', '/api/tasks/' + t.id, { version: t.version, status: box.checked ? 'Done' : 'To Do' });
            await refresh();
          } catch (e) { toast(e.message, true); renderAll(); }
        },
      });
      box.checked = t.status === 'Done';
      return h('tr', null,
        h('td', null, box),
        h('td', { class: 'cell-text' },
          h('div', { class: 'cell-title', text: t.title }),
          t.details ? h('div', { class: 'cell-sub', text: t.details.length > 140 ? t.details.slice(0, 140) + '…' : t.details }) : null,
          prioChip(t.priority)),
        h('td', null, t.record_id === null ? h('span', { class: 'muted', text: '—' }) : refLink(t.record_id)),
        opts.hideAssignee ? null : h('td', { class: 'nowrap', text: userName(t.assignee_id) }),
        h('td', null, t.status === 'Done'
          ? h('span', { class: 'muted small', text: 'Done ' + fmtDate(localDay(t.completed_at)) })
          : (t.due_date ? dueChip(t.due_date) : h('span', { class: 'chip none', text: 'No due date' }))),
        h('td', null, h('span', { class: 'pill ' + (t.status === 'Done' ? 'done' : t.status === 'In Progress' ? 'active' : 'new'), text: t.status })),
        h('td', { class: 'nowrap' }, editable ? h('button', { type: 'button', class: 'btn quiet', text: 'Edit', onclick: () => taskForm(t) }) : null));
    });
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, h('span', { text: 'Done' })),
        h('th', { scope: 'col', text: 'Task' }),
        h('th', { scope: 'col', text: 'Linked to' }),
        opts.hideAssignee ? null : h('th', { scope: 'col', text: 'Assigned to' }),
        h('th', { scope: 'col', text: 'Due' }),
        h('th', { scope: 'col', text: 'Status' }),
        h('th', { scope: 'col' }, h('span', { text: '' })))),
      h('tbody', null, rows)));
  }

  function sortTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      const ao = taskOpen(a) ? 0 : 1; const bo = taskOpen(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ad = a.due_date || '9999-99-99'; const bd = b.due_date || '9999-99-99';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.id - b.id;
    });
  }

  function card(title, sub, ...kids) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: title }), sub ? h('span', { class: 'sub', text: sub }) : null),
      kids);
  }

  // ------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------

  function viewOverview() {
    const t = today();
    const recs = S.data.records;
    const open = recs.filter(isOpen);
    const dated = open.filter((r) => r.next_action_date);
    const late = sortRows(dated.filter((r) => r.next_action_date < t), { key: 'next', dir: 1 });
    const soon = sortRows(dated.filter((r) => r.next_action_date >= t && r.next_action_date <= addDays(t, 7)), { key: 'next', dir: 1 });
    const myTasks = S.data.tasks.filter((x) => x.assignee_id === S.me.id && taskOpen(x));
    const lateTasks = S.data.tasks.filter((x) => taskOpen(x) && x.due_date && x.due_date < t);

    const tiles = trackingTiles(recs);
    tiles.push(tile('My open tasks', myTasks.length));
    tiles.push(tile(isAdmin() ? 'Overdue tasks (everyone)' : 'Overdue tasks', lateTasks.length,
      lateTasks.length ? { kind: 'crit', text: 'Needs attention' } : null));

    // Status by section: one thin bar per status, labelled directly.
    const sections = S.data.meta.visible_modules.map((key) => {
      const m = mods()[key];
      const mine = recs.filter((r) => r.module === key);
      const max = Math.max(1, ...m.statuses.map((s) => mine.filter((r) => r.status === s[0]).length));
      const bars = h('div', { class: 'bars' });
      m.statuses.forEach((s) => {
        const n = mine.filter((r) => r.status === s[0]).length;
        bars.append(
          h('span', { class: 'name', text: s[0] }),
          h('span', { class: 'track', title: s[0] + ': ' + n }, h('span', { class: 'fill' + (n ? '' : ' zero'), style: { display: 'block', width: n ? Math.max(2, (n / max) * 100) + '%' : '2px' } })),
          h('span', { class: 'num', text: n }));
      });
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', null, h('a', { href: '#/' + viewForModule(key), text: m.label })),
          h('span', { class: 'sub', text: mine.filter(isOpen).length + ' open of ' + mine.length })),
        bars);
    });

    // Pilot KPIs.
    const count = (module, status) => recs.filter((r) => r.module === module && r.status === status).length;
    const enqDone = count('enquiry', 'Converted'); const enqClosed = count('enquiry', 'Closed');
    const eoiWon = count('eoi', 'Successful'); const eoiLost = count('eoi', 'Unsuccessful');
    const cutoff = addDays(t, -30);
    const doneTasks = S.data.tasks.filter((x) => x.status === 'Done' && x.completed_at && localDay(x.completed_at) >= cutoff).length;
    const kpis = h('div', { class: 'tiles' },
      tile('Next-action coverage', pct(dated.length, open.length), null, 'Open items that have a next action date'),
      tile('On schedule', pct(dated.length - late.length, dated.length), null, 'Dated next actions that are not overdue'),
      tile('Enquiry conversion', pct(enqDone, enqDone + enqClosed), null, enqDone + ' converted of ' + (enqDone + enqClosed) + ' concluded'),
      tile('EOI success rate', pct(eoiWon, eoiWon + eoiLost), null, eoiWon + ' successful of ' + (eoiWon + eoiLost) + ' decided'),
      tile('Tasks completed', doneTasks, null, 'In the last 30 days'));

    const kids = [
      h('div', { class: 'view-head' }, h('div', null,
        h('h1', { text: 'Overview' }),
        h('p', { class: 'sub', text: (isAdmin() ? 'Current status across every section.' : 'Current status across the sections you can see.') + ' Updated live.' }))),
      h('div', { class: 'tiles' }, tiles),
      h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Overdue next actions' }), h('span', { class: 'sub', text: plural(late.length, 'item') })),
        recordTable(late, { empty: 'Nothing is overdue.' })),
      h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Coming up in the next 7 days' }), h('span', { class: 'sub', text: plural(soon.length, 'item') })),
        recordTable(soon, { empty: 'No actions are due in the next 7 days.' })),
      h('div', { class: sections.length > 3 ? 'grid-3' : 'grid-' + Math.max(2, sections.length) }, sections),
      card('Pilot KPIs', 'Calculated from the data you can see', kpis),
    ];

    if (isAdmin()) {
      const people = S.data.users.filter((u) => u.active).map((u) => {
        const owned = open.filter((r) => r.owner_id === u.id);
        const tasks = S.data.tasks.filter((x) => x.assignee_id === u.id && taskOpen(x));
        return h('tr', null,
          h('td', null, h('div', { class: 'cell-title', text: u.full_name }), h('div', { class: 'cell-sub', text: S.data.meta.roles[u.role] })),
          h('td', { class: 'num', text: owned.length }),
          h('td', { class: 'num', text: owned.filter((r) => r.next_action_date && r.next_action_date < t).length }),
          h('td', { class: 'num', text: tasks.length }),
          h('td', { class: 'num', text: tasks.filter((x) => x.due_date && x.due_date < t).length }));
      });
      const unowned = open.filter((r) => r.owner_id === null).length;
      kids.push(h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Team workload' }),
          h('span', { class: 'sub', text: unowned ? plural(unowned, 'open item') + ' with no owner' : 'Every open item has an owner' })),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Person' }), h('th', { scope: 'col', class: 'num', text: 'Open items owned' }),
            h('th', { scope: 'col', class: 'num', text: 'Overdue actions' }), h('th', { scope: 'col', class: 'num', text: 'Open tasks' }),
            h('th', { scope: 'col', class: 'num', text: 'Overdue tasks' }))),
          h('tbody', null, people)))));
    }

    const feed = S.activity.slice(0, 15).map((a) => h('li', null,
      h('div', { class: 'main' },
        h('a', { class: 'ref', href: '#/' + S.view + '/' + a.ref, text: a.ref }), ' ',
        h('span', { text: a.title }),
        h('div', { class: 'small muted', text: a.text.length > 160 ? a.text.slice(0, 160) + '…' : a.text })),
      h('div', { class: 'side small muted', text: userName(a.user_id) + ' · ' + fmtDateTime(a.at) })));
    kids.push(card('Recent activity', 'Latest updates from everyone',
      feed.length ? h('ul', { class: 'list' }, feed) : h('div', { class: 'empty', text: 'No activity yet. Updates appear here as people log actions.' })));

    return h('div', { class: 'view' }, kids);
  }

  // ------------------------------------------------------------------
  // My Work
  // ------------------------------------------------------------------

  function viewMy() {
    const mine = sortTasks(S.data.tasks.filter((x) => x.assignee_id === S.me.id && taskOpen(x)));
    const given = sortTasks(S.data.tasks.filter((x) => x.created_by === S.me.id && x.assignee_id !== S.me.id && taskOpen(x)));
    const owned = sortRows(S.data.records.filter((r) => r.owner_id === S.me.id && isOpen(r)), { key: 'next', dir: 1 });
    const t = today();
    const lateTasks = mine.filter((x) => x.due_date && x.due_date < t).length;
    const lateOwned = owned.filter((r) => r.next_action_date && r.next_action_date < t).length;
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('h1', { text: 'My Work' }), h('p', { class: 'sub', text: 'Everything waiting on ' + S.me.full_name + '.' })),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', text: '+ New task', onclick: () => taskForm(null) }))),
      h('div', { class: 'tiles' },
        tile('My open tasks', mine.length, lateTasks ? { kind: 'crit', text: lateTasks + ' overdue' } : null),
        tile('Items I own', owned.length, lateOwned ? { kind: 'crit', text: plural(lateOwned, 'overdue action') } : null),
        tile('Tasks I have assigned', given.length, null, 'Open, with other people')),
      h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: 'My tasks' }), h('span', { class: 'sub', text: plural(mine.length, 'open task') })),
        taskTable(mine, { hideAssignee: true, empty: 'You have no open tasks.' })),
      h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Items I own' }), h('span', { class: 'sub', text: 'Open records where you are the owner, by next action date' })),
        recordTable(owned, { empty: 'You do not own any open items.' })),
      given.length ? h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Tasks I have assigned to others' }), h('span', { class: 'sub', text: plural(given.length, 'open task') })),
        taskTable(given, {})) : null);
  }

  // ------------------------------------------------------------------
  // Tasks
  // ------------------------------------------------------------------

  function viewTasks() {
    const f = S.filters.tasks || (S.filters.tasks = { q: '', who: 'me', status: 'open' });
    const host = h('div');
    const draw = () => {
      const q = f.q.toLowerCase();
      const rows = sortTasks(S.data.tasks.filter((x) => {
        if (f.status === 'open' && !taskOpen(x)) return false;
        if (f.status === 'done' && taskOpen(x)) return false;
        if (f.who === 'me' && x.assignee_id !== S.me.id) return false;
        if (f.who !== 'me' && f.who !== '' && String(x.assignee_id) !== f.who) return false;
        if (q && !(x.title + ' ' + x.details).toLowerCase().includes(q)) return false;
        return true;
      }));
      host.replaceChildren(taskTable(rows, { empty: 'No tasks match these filters.' }));
    };
    draw();
    const people = S.data.users.filter((u) => u.active && u.id !== S.me.id);
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('h1', { text: 'Tasks' }),
          h('p', { class: 'sub', text: isAdmin() ? 'Every task in InSys.' : 'Your tasks, tasks you created, and tasks on records you can see.' })),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', text: '+ New task', onclick: () => taskForm(null) }))),
      h('div', { class: 'filters' },
        h('input', { id: 'flt-tasks-q', type: 'search', placeholder: 'Search tasks…', 'aria-label': 'Search tasks', value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } }),
        h('select', { id: 'flt-tasks-who', 'aria-label': 'Assigned to', value: f.who, onchange: (e) => { f.who = e.target.value; draw(); } },
          h('option', { value: 'me', text: 'Assigned to me' }), h('option', { value: '', text: 'Assigned to anyone' }),
          people.map((u) => h('option', { value: String(u.id), text: u.full_name }))),
        h('select', { id: 'flt-tasks-status', 'aria-label': 'Status', value: f.status, onchange: (e) => { f.status = e.target.value; draw(); } },
          h('option', { value: 'open', text: 'Open tasks' }), h('option', { value: 'done', text: 'Completed' }), h('option', { value: 'all', text: 'All tasks' }))),
      host);
  }

  // ------------------------------------------------------------------
  // Section views (Projects, Enquiries, EOIs, Finance, Office Admin)
  // ------------------------------------------------------------------

  function filteredRecords(module) {
    const f = S.filters[module];
    const q = f.q.toLowerCase();
    return S.data.records.filter((r) => {
      if (r.module !== module) return false;
      if (f.status === '__open' && !isOpen(r)) return false;
      if (f.status === '__closed' && isOpen(r)) return false;
      if (f.status && f.status.slice(0, 2) !== '__' && r.status !== f.status) return false;
      if (f.owner === 'me' && r.owner_id !== S.me.id) return false;
      if (f.owner === 'none' && r.owner_id !== null) return false;
      if (f.owner && f.owner !== 'me' && f.owner !== 'none' && String(r.owner_id) !== f.owner) return false;
      if (q) {
        const hay = [r.ref, r.title, r.organisation, r.contact_name, r.contact_info, r.category, r.last_action, r.next_action, r.description]
          .concat(r.xrefs.map((x) => x.system + ' ' + x.ref), subconNames(r)).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function viewModule(module) {
    const m = mods()[module];
    const f = S.filters[module] || (S.filters[module] = { q: '', status: '__open', owner: '' });
    const sort = S.sort[module] || (S.sort[module] = { key: 'next', dir: 1 });
    const all = S.data.records.filter((r) => r.module === module);
    const host = h('div');
    const draw = () => {
      const rows = sortRows(filteredRecords(module), sort);
      host.replaceChildren(recordTable(rows, {
        module: module, sort: sort,
        onSort: (key) => { if (sort.key === key) sort.dir = -sort.dir; else { sort.key = key; sort.dir = 1; } draw(); },
        empty: all.length ? 'Nothing matches these filters.' : 'No ' + m.label.toLowerCase() + ' recorded yet. Use "+ New ' + m.singular + '" to add the first one.',
      }));
    };
    draw();

    const tiles = trackingTiles(all);
    if (module === 'finance') {
      const openAmt = (cat) => all.filter((r) => isOpen(r) && r.category === cat).reduce((sum, r) => sum + (r.amount || 0), 0);
      const t = today();
      const latePay = all.filter((r) => isOpen(r) && r.due_date && r.due_date < t).length;
      tiles.push(tile('Receivables outstanding', fmtMoney(openAmt('Invoice (receivable)')), null, 'Open invoices'));
      tiles.push(tile('Payables outstanding', fmtMoney(openAmt('Bill (payable)')), null, 'Open bills'));
      tiles.push(tile('Past payment due date', latePay, latePay ? { kind: 'crit', text: 'Needs attention' } : null));
    }
    const owners = S.data.users.filter((u) => u.id !== S.me.id && all.some((r) => r.owner_id === u.id));
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('h1', { text: m.label }),
          h('p', { class: 'sub', text: m.team ? 'Visible to the ' + m.label + ' team and administrators only.' : 'Last known action, current status and next action for every ' + m.singular.toLowerCase() + '.' })),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', text: 'Export CSV', title: 'Download the rows shown below as a spreadsheet', onclick: () => exportCsv(module) }),
          h('button', { type: 'button', class: 'btn primary', text: '+ New ' + m.singular, onclick: () => recordForm(module, null, {}) }))),
      h('div', { class: 'tiles' }, tiles),
      h('div', { class: 'filters' },
        h('input', { id: 'flt-' + module + '-q', type: 'search', placeholder: 'Filter ' + m.label.toLowerCase() + '…', 'aria-label': 'Filter ' + m.label, value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } }),
        h('select', { id: 'flt-' + module + '-status', 'aria-label': 'Status', value: f.status, onchange: (e) => { f.status = e.target.value; draw(); } },
          h('option', { value: '__open', text: 'All open' }), h('option', { value: '', text: 'All statuses' }), h('option', { value: '__closed', text: 'All closed' }),
          m.statuses.map((s) => h('option', { value: s[0], text: s[0] }))),
        h('select', { id: 'flt-' + module + '-owner', 'aria-label': 'Owner', value: f.owner, onchange: (e) => { f.owner = e.target.value; draw(); } },
          h('option', { value: '', text: 'Any owner' }), h('option', { value: 'me', text: 'Owned by me' }), h('option', { value: 'none', text: 'No owner' }),
          owners.map((u) => h('option', { value: String(u.id), text: u.full_name })))),
      host);
  }

  function exportCsv(module) {
    const m = mods()[module];
    const rows = sortRows(filteredRecords(module), S.sort[module]);
    const cell = csvCell;
    const withSubcons = usesSubcons(module);
    const header = ['Reference', 'Title', m.org_label, 'Contact name', 'Contact details', m.category_label, 'Status', 'Priority', 'Owner',
      m.amount_label, m.start_label, m.due_label, 'Last action', 'Last action date', 'Next action', 'Next action due',
      'Linked records', 'External references', 'Created', 'Last updated'];
    if (withSubcons) header.push('Subcontractors');
    const lines = [header.map(cell).join(',')];
    rows.forEach((r) => {
      const linked = (S.I.links.get(r.id) || []).map((id) => (S.I.recs.get(id) || S.data.restricted[String(id)] || {}).ref || '').filter(Boolean).join('; ');
      const values = [r.ref, r.title, r.organisation, r.contact_name, r.contact_info, r.category, r.status, r.priority,
        r.owner_id === null ? '' : userName(r.owner_id), r.amount === null ? '' : Number(r.amount).toFixed(2), r.start_date, r.due_date,
        r.last_action, r.last_action_date, r.next_action, r.next_action_date, linked,
        r.xrefs.map((x) => x.system + ': ' + x.ref).join('; '), r.created_at, r.updated_at];
      if (withSubcons) values.push((S.I.subsByRec.get(r.id) || []).map((x) => x.sub.name + (x.scope ? ' (' + x.scope + ')' : '')).join('; '));
      lines.push(values.map(cell).join(','));
    });
    saveCsv('insys-' + viewForModule(module) + '-' + today() + '.csv', lines);
  }

  // ------------------------------------------------------------------
  // Record forms and actions
  // ------------------------------------------------------------------

  function ownerOptions(module, currentId) {
    const team = mods()[module].team;
    const everywhere = S.data.meta.all_section_roles || ['admin'];
    const list = S.data.users.filter((u) => (u.active && (!team || everywhere.includes(u.role) || u.role === team)) || u.id === currentId);
    return [{ value: '', label: 'Unassigned' }].concat(list.map((u) => ({ value: u.id, label: u.full_name + (u.active ? '' : ' (inactive)') })));
  }

  function recordBody(v) {
    return {
      title: v.title, organisation: v.organisation, contact_name: v.contact_name, contact_info: v.contact_info,
      category: v.category, status: v.status, priority: v.priority,
      owner_id: v.owner_id === '' ? null : Number(v.owner_id),
      amount: v.amount === '' ? null : Number(v.amount),
      start_date: v.start_date || null, due_date: v.due_date || null, description: v.description,
      next_action: v.next_action, next_action_date: v.next_action_date || null,
    };
  }

  /** Create (rec = null) or edit a record. opts.prefill, opts.linkTo for "create linked". */
  function recordForm(module, rec, opts) {
    const m = mods()[module];
    const p = rec || opts.prefill || {};
    const cats = [{ value: '', label: '—' }].concat(m.categories.map((c) => ({ value: c, label: c })));
    if (rec && rec.category && !m.categories.includes(rec.category)) cats.push({ value: rec.category, label: rec.category });
    const fields = [
      { name: 'title', label: 'Title', required: true, full: true, maxlength: 200, value: p.title },
      { name: 'organisation', label: m.org_label, maxlength: 200, value: p.organisation },
      { name: 'category', label: m.category_label, type: 'select', options: cats, value: p.category || '' },
      { name: 'contact_name', label: 'Contact name', maxlength: 200, value: p.contact_name },
      { name: 'contact_info', label: 'Contact email / phone', maxlength: 200, value: p.contact_info },
      { name: 'status', label: 'Status', type: 'select', options: m.statuses.map((s) => ({ value: s[0], label: s[0] })), value: rec ? rec.status : m.statuses[0][0] },
      { name: 'priority', label: 'Priority', type: 'select', options: S.data.meta.priorities.map((x) => ({ value: x, label: x })), value: rec ? rec.priority : 'Normal' },
      { name: 'owner_id', label: 'Owner (person responsible)', type: 'select', options: ownerOptions(module, rec ? rec.owner_id : null), value: rec ? (rec.owner_id === null ? '' : rec.owner_id) : S.me.id },
      { name: 'amount', label: m.amount_label + (S.data.meta.currency ? ' (' + S.data.meta.currency + ')' : ''), type: 'number', value: rec ? rec.amount : '' },
      { name: 'start_date', label: m.start_label, type: 'date', value: rec ? rec.start_date : '' },
      { name: 'due_date', label: m.due_label, type: 'date', value: rec ? rec.due_date : '' },
      { name: 'description', label: 'Description / notes', type: 'textarea', full: true, rows: 3, value: rec ? rec.description : '' },
      { type: 'section', label: 'Tracking' },
    ];
    if (!rec) {
      fields.push(
        { name: 'last_action', label: 'Last action taken', full: true, maxlength: 500, placeholder: 'e.g. Sent proposal to client', hint: 'Optional. The most recent thing that was done.' },
        { name: 'last_action_date', label: 'Date of last action', type: 'date', value: today() });
    }
    fields.push(
      { name: 'next_action', label: 'Next action', full: true, maxlength: 500, placeholder: 'e.g. Follow up by phone', value: rec ? rec.next_action : '' },
      { name: 'next_action_date', label: 'Next action due', type: 'date', value: rec ? rec.next_action_date : '' });
    formDialog({
      title: rec ? 'Edit ' + rec.ref : 'New ' + m.singular,
      intro: rec ? 'To record progress, use "Log action" instead - it keeps the history.' : (opts.linkTo ? 'This will be linked to ' + opts.linkTo.ref + '.' : null),
      wide: true, fields: fields, submitLabel: rec ? 'Save changes' : 'Create ' + m.singular,
      onSubmit: async (v) => {
        const body = recordBody(v);
        if (rec) {
          body.version = rec.version;
          await api('PUT', '/api/records/' + rec.id, body);
          await refresh();
          toast(rec.ref + ' saved.');
        } else {
          body.module = module;
          body.last_action = v.last_action;
          body.last_action_date = v.last_action ? (v.last_action_date || null) : null;
          const res = await api('POST', '/api/records', body);
          if (opts.linkTo) {
            try { await api('POST', '/api/records/' + res.record.id + '/links', { target_id: opts.linkTo.id }); }
            catch (e) { toast('Created, but the link could not be added: ' + e.message, true); }
          }
          await refresh();
          toast(res.record.ref + ' created.');
          go(viewForModule(module), res.record.ref);
        }
      },
    });
  }

  function logActionForm(rec) {
    const m = mods()[rec.module];
    formDialog({
      title: 'Log action on ' + rec.ref,
      intro: 'Record what was done. This becomes the last known action, and the full history is kept.',
      wide: true,
      fields: [
        { name: 'text', label: 'What was done?', type: 'textarea', rows: 2, required: true, full: true, maxlength: 500 },
        { name: 'date', label: 'Date done', type: 'date', required: true, value: today() },
        { name: 'status', label: 'Status now', type: 'select', options: m.statuses.map((s) => ({ value: s[0], label: s[0] })), value: rec.status },
        { type: 'section', label: 'What happens next' },
        { name: 'next_action', label: 'Next action', full: true, maxlength: 500, value: rec.next_action, hint: 'Update this, or clear it if nothing further is needed.' },
        { name: 'next_action_date', label: 'Next action due', type: 'date', value: rec.next_action_date },
      ],
      submitLabel: 'Log action',
      onSubmit: async (v) => {
        await api('POST', '/api/records/' + rec.id + '/actions', {
          version: rec.version, text: v.text, date: v.date, status: v.status,
          next_action: v.next_action, next_action_date: v.next_action_date || null,
        });
        await refresh();
        toast('Action logged on ' + rec.ref + '.');
      },
    });
  }

  function noteForm(rec) {
    formDialog({
      title: 'Add note to ' + rec.ref,
      intro: 'Notes are added to the history. They do not change the last action or status.',
      fields: [{ name: 'text', label: 'Note', type: 'textarea', rows: 4, required: true, full: true, maxlength: 4000 }],
      submitLabel: 'Add note',
      onSubmit: async (v) => { await api('POST', '/api/records/' + rec.id + '/notes', { text: v.text }); await refresh(); },
    });
  }

  function linkForm(rec) {
    const linked = new Set(S.I.links.get(rec.id) || []);
    const options = S.data.records.filter((r) => r.id !== rec.id && !linked.has(r.id)).map((r) => r.ref + ' — ' + r.title);
    if (!options.length) { toast('There are no other records to link to yet.'); return; }
    formDialog({
      title: 'Link ' + rec.ref + ' to another record',
      intro: 'Links work across every section, so related work can be followed from either side.',
      fields: [{ name: 'target', label: 'Record', required: true, full: true, options: options, placeholder: 'Type a reference or title, e.g. ENQ-0001', hint: 'Start typing and pick from the list.' }],
      submitLabel: 'Link records',
      onSubmit: async (v) => {
        const found = /^([A-Za-z]{3}-\d+)/.exec(v.target);
        const target = found ? S.I.byRef.get(found[1].toUpperCase()) : null;
        if (!target) throw new Error('Pick a record from the list, or type its reference exactly (for example ENQ-0001).');
        await api('POST', '/api/records/' + rec.id + '/links', { target_id: target.id });
        await refresh();
      },
    });
  }

  function xrefForm(rec) {
    const known = Array.from(new Set(S.data.records.flatMap((r) => r.xrefs.map((x) => x.system)))).sort();
    formDialog({
      title: 'Add a reference from another system',
      intro: 'For example a CRM number, accounting system invoice number, tender portal ID or shared-drive folder.',
      fields: [
        { name: 'system', label: 'System', required: true, maxlength: 60, options: known, placeholder: 'e.g. Xero, CRM, SharePoint' },
        { name: 'ref', label: 'Reference in that system', required: true, maxlength: 120, placeholder: 'e.g. INV-2041' },
        { name: 'url', label: 'Web link (optional)', full: true, maxlength: 500, placeholder: 'https://' },
      ],
      submitLabel: 'Add reference',
      onSubmit: async (v) => { await api('POST', '/api/records/' + rec.id + '/xrefs', v); await refresh(); },
    });
  }

  function createLinkedForm(rec) {
    const choices = S.data.meta.visible_modules.map((key) => ({ value: key, label: mods()[key].singular }));
    formDialog({
      title: 'Create a record linked to ' + rec.ref,
      intro: 'For example, turn an enquiry into a project, or raise a finance item for a project. The title, organisation and contact are copied across.',
      fields: [{ name: 'module', label: 'New record type', type: 'select', options: choices, full: true, value: choices[0].value }],
      submitLabel: 'Continue',
      onSubmit: async (v) => {
        setTimeout(() => recordForm(v.module, null, {
          linkTo: rec,
          prefill: { title: rec.title, organisation: rec.organisation, contact_name: rec.contact_name, contact_info: rec.contact_info },
        }), 0);
      },
    });
  }

  function taskForm(task, presetRecord) {
    const rec = task && task.record_id !== null ? S.I.recs.get(task.record_id) : (presetRecord || null);
    const hiddenRecord = !!(task && task.record_id !== null && !rec);
    const people = S.data.users.filter((u) => u.active || (task && u.id === task.assignee_id));
    const fields = [
      { name: 'title', label: 'Task', required: true, full: true, maxlength: 200, value: task ? task.title : '' },
      { name: 'details', label: 'Details', type: 'textarea', rows: 3, full: true, maxlength: 4000, value: task ? task.details : '' },
      { name: 'assignee_id', label: 'Assigned to', type: 'select', required: true, options: people.map((u) => ({ value: u.id, label: u.full_name + (u.id === S.me.id ? ' (me)' : '') })), value: task ? task.assignee_id : S.me.id },
      { name: 'due_date', label: 'Due date', type: 'date', value: task ? task.due_date : '' },
      { name: 'priority', label: 'Priority', type: 'select', options: S.data.meta.priorities.map((x) => ({ value: x, label: x })), value: task ? task.priority : 'Normal' },
    ];
    if (task) fields.push({ name: 'status', label: 'Status', type: 'select', options: S.data.meta.task_statuses.map((x) => ({ value: x, label: x })), value: task.status });
    if (!hiddenRecord) {
      fields.push({
        name: 'record', label: 'Linked record (optional)', full: true,
        options: S.data.records.map((r) => r.ref + ' — ' + r.title),
        value: rec ? rec.ref + ' — ' + rec.title : '', placeholder: 'Type a reference or title',
      });
    }
    const dlg = formDialog({
      title: task ? 'Edit task' : 'New task', wide: true, fields: fields,
      submitLabel: task ? 'Save task' : 'Create task',
      onSubmit: async (v) => {
        const body = { title: v.title, details: v.details, assignee_id: Number(v.assignee_id), due_date: v.due_date || null, priority: v.priority };
        if (!hiddenRecord) {
          if (v.record) {
            const found = /^([A-Za-z]{3}-\d+)/.exec(v.record);
            const target = found ? S.I.byRef.get(found[1].toUpperCase()) : null;
            if (!target) throw new Error('Pick the linked record from the list, or leave it empty.');
            body.record_id = target.id;
          } else {
            body.record_id = null;
          }
        }
        if (task) {
          body.status = v.status;
          body.version = task.version;
          await api('PUT', '/api/tasks/' + task.id, body);
        } else {
          await api('POST', '/api/tasks', body);
        }
        await refresh();
        toast(task ? 'Task saved.' : 'Task created.');
      },
    });
    if (task && (isAdmin() || task.created_by === S.me.id)) {
      dlg.querySelector('.dlg-foot').prepend(h('button', {
        type: 'button', class: 'btn quiet dangerous', text: 'Delete task',
        onclick: () => {
          dlg.close();
          confirmDialog('Delete this task?', '"' + task.title + '" will be removed from every task list. It stays on record in the Activity log.', 'Delete task', async () => {
            await api('DELETE', '/api/tasks/' + task.id);
            await refresh();
            toast('Task deleted.');
          }, true);
        },
      }));
    }
  }

  // ------------------------------------------------------------------
  // Record drawer
  // ------------------------------------------------------------------

  async function loadHistory(id) {
    try {
      const res = await api('GET', '/api/records/' + id + '/history');
      S.history = { id: id, items: res.history };
      const rec = S.openRef ? S.I.byRef.get(S.openRef) : null;
      if (rec && rec.id === id) drawDrawer();
    } catch (e) { /* the drawer shows what it has */ }
  }

  function renderDrawer() {
    const rec = S.openRef && S.I ? S.I.byRef.get(S.openRef) : null;
    if (rec) {
      if (S.history.id !== rec.id) S.history = { id: rec.id, items: null };
      loadHistory(rec.id);
    }
    drawDrawer();
  }

  function detail(label, value, full, pre) {
    if (value === null || value === undefined || value === '') return null;
    return h('div', { class: 'item' + (full ? ' full' : '') },
      h('div', { class: 'k', text: label }),
      h('div', { class: 'v' + (pre ? ' pre' : '') }, value));
  }

  function drawDrawer() {
    const host = document.getElementById('drawer-host');
    if (!host) return;
    if (!S.openRef) { host.replaceChildren(); return; }
    const old = host.querySelector('.drawer');
    const scroll = old ? old.scrollTop : 0;
    const close = () => go(S.view);
    const rec = S.I.byRef.get(S.openRef);
    const top = (kicker, title) => h('div', { class: 'drawer-top' },
      h('div', null, h('div', { class: 'kicker', text: kicker }), h('h1', { text: title })),
      h('button', { type: 'button', class: 'btn small', text: 'Close', onclick: close }));

    if (S.openRef.slice(0, 4) === 'SUB-') {
      const panel = subconDrawer(top);
      host.replaceChildren(h('div', { class: 'backdrop', onclick: close }), panel);
      panel.scrollTop = scroll;
      return;
    }

    if (!rec) {
      host.replaceChildren(
        h('div', { class: 'backdrop', onclick: close }),
        h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Record ' + S.openRef },
          top(S.openRef, 'Record not available'),
          h('p', { class: 'muted', text: 'This record has been deleted, or it belongs to a section you do not have access to.' })));
      return;
    }

    const m = mods()[rec.module];
    const open = isOpen(rec);
    const t = today();
    const late = open && rec.next_action_date && rec.next_action_date < t;

    const links = (S.I.links.get(rec.id) || []).map((id) => {
      const other = S.I.recs.get(id);
      if (other) {
        return h('li', null,
          h('div', { class: 'main' }, h('a', { class: 'ref', href: recHref(other), text: other.ref }), ' ', h('span', { text: other.title }),
            h('div', { class: 'small muted', text: mods()[other.module].singular })),
          h('div', { class: 'side' }, statusPill(other),
            h('button', {
              type: 'button', class: 'btn quiet dangerous', text: 'Unlink', 'aria-label': 'Remove link to ' + other.ref,
              onclick: () => confirmDialog('Remove this link?', rec.ref + ' and ' + other.ref + ' will no longer be linked. Neither record is deleted.', 'Remove link', async () => {
                await api('DELETE', '/api/records/' + rec.id + '/links/' + other.id);
                await refresh();
              }),
            })));
      }
      const stub = S.data.restricted[String(id)];
      if (!stub) return null;
      return h('li', null,
        h('div', { class: 'main' }, h('span', { class: 'ref', text: stub.ref }), ' ',
          h('span', { class: 'muted', text: mods()[stub.module].singular + ' - details restricted to that team' })),
        h('div', { class: 'side' }, h('span', { class: 'tag', text: 'Restricted' })));
    }).filter(Boolean);

    const xrefs = rec.xrefs.map((x) => h('li', null,
      h('div', { class: 'main' }, h('span', { class: 'tag', text: x.system }), ' ',
        x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', text: x.ref }) : h('span', { class: 'cell-title', text: x.ref })),
      h('div', { class: 'side' }, h('button', {
        type: 'button', class: 'btn quiet dangerous', text: 'Remove', 'aria-label': 'Remove reference ' + x.system + ' ' + x.ref,
        onclick: () => confirmDialog('Remove this reference?', x.system + ' ' + x.ref + ' will be removed from ' + rec.ref + '.', 'Remove', async () => {
          await api('DELETE', '/api/records/' + rec.id + '/xrefs/' + x.id);
          await refresh();
        }),
      }))));

    const tasks = sortTasks(S.I.tasksByRec.get(rec.id) || []);
    const hist = S.history.id === rec.id ? S.history.items : null;
    const kindLabel = KIND_LABELS;

    const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': rec.ref + ' ' + rec.title },
      top(rec.ref + ' · ' + m.singular, rec.title),
      h('div', { class: 'badges' }, statusPill(rec), prioChip(rec.priority),
        h('span', { class: 'muted small', text: 'Owner: ' + userName(rec.owner_id) })),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', text: 'Log action', onclick: () => logActionForm(rec) }),
        h('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => recordForm(rec.module, rec, {}) }),
        h('button', { type: 'button', class: 'btn', text: 'Add note', onclick: () => noteForm(rec) }),
        h('button', { type: 'button', class: 'btn', text: 'Add task', onclick: () => taskForm(null, rec) }),
        isAdmin() ? h('button', {
          type: 'button', class: 'btn quiet dangerous', text: 'Delete',
          onclick: () => confirmDialog('Delete ' + rec.ref + '?', '"' + rec.title + '" will be removed from every list. Its history is kept in the Activity log under "Deleted items", where an administrator can restore it.', 'Delete', async () => {
            await api('DELETE', '/api/records/' + rec.id);
            go(S.view);
            await refresh();
            toast(rec.ref + ' deleted.');
          }, true),
        }) : null),

      h('div', { class: 'track-grid' },
        h('div', { class: 'track-box' },
          h('div', { class: 'label', text: 'Last known action' }),
          rec.last_action
            ? [h('div', { class: 'what', text: rec.last_action }),
              h('div', { class: 'when', text: fmtDate(rec.last_action_date) + (rec.last_action_by ? ' · ' + userName(rec.last_action_by) : '') })]
            : h('div', { class: 'when', text: 'No action has been logged yet.' })),
        h('div', { class: 'track-box' + (late ? ' overdue' : '') },
          h('div', { class: 'label', text: 'Next action' }),
          !open ? h('div', { class: 'when', text: 'None needed - this item is ' + rec.status.toLowerCase() + '.' })
            : [rec.next_action ? h('div', { class: 'what', text: rec.next_action }) : h('div', { class: 'when', text: 'No next action has been set.' }),
              h('div', { class: 'when' }, rec.next_action_date
                ? [h('span', { text: fmtDate(rec.next_action_date) }), dueHint(rec.next_action_date)]
                : h('span', { class: 'chip none', text: 'No date set' }))])),

      card('Details', null, h('div', { class: 'details' },
        detail(m.org_label, rec.organisation),
        detail(m.category_label, rec.category),
        detail('Contact name', rec.contact_name),
        detail('Contact details', rec.contact_info),
        detail(m.amount_label, rec.amount === null ? '' : fmtMoney(rec.amount)),
        detail(m.start_label, fmtDate(rec.start_date)),
        detail(m.due_label, rec.due_date ? [fmtDate(rec.due_date), ' ', open ? dueHint(rec.due_date) : null] : ''),
        detail('Description / notes', rec.description, true, true),
        detail('Created', fmtDateTime(rec.created_at) + ' by ' + userName(rec.created_by)),
        detail('Last updated', fmtDateTime(rec.updated_at) + ' by ' + userName(rec.updated_by)))),

      usesSubcons(rec.module) ? subconCard(rec) : null,

      h('section', { class: 'card' },
        h('div', { class: 'section-head' }, h('h2', { text: 'Cross-references' }),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn small', text: 'Link a record', onclick: () => linkForm(rec) }),
            h('button', { type: 'button', class: 'btn small', text: 'Create linked…', onclick: () => createLinkedForm(rec) }),
            h('button', { type: 'button', class: 'btn small', text: 'Add external ref', onclick: () => xrefForm(rec) }))),
        h('h3', { class: 'muted', text: 'Linked InSys records' }),
        links.length ? h('ul', { class: 'list' }, links) : h('p', { class: 'muted small', text: 'Not linked to any other record yet.' }),
        h('h3', { class: 'muted', style: { marginTop: '12px' }, text: 'References in other systems' }),
        xrefs.length ? h('ul', { class: 'list' }, xrefs) : h('p', { class: 'muted small', text: 'No references to other systems yet.' })),

      h('section', { class: 'card' },
        h('div', { class: 'section-head' }, h('h2', { text: 'Tasks' }),
          h('button', { type: 'button', class: 'btn small', text: 'Add task', onclick: () => taskForm(null, rec) })),
        tasks.length ? h('ul', { class: 'list' }, tasks.map((x) => h('li', null,
          h('div', { class: 'main' }, h('span', { class: 'cell-title', text: x.title }),
            h('div', { class: 'small muted', text: userName(x.assignee_id) + ' · ' + x.status })),
          h('div', { class: 'side' },
            x.status === 'Done' ? null : (x.due_date ? dueChip(x.due_date) : null),
            canEditTask(x) ? h('button', { type: 'button', class: 'btn quiet', text: 'Edit', onclick: () => taskForm(x) }) : null))))
          : h('p', { class: 'muted small', text: 'No tasks on this record.' })),

      card('History', hist ? plural(hist.length, 'entry', 'entries') : null,
        hist === null ? h('p', { class: 'muted small', text: 'Loading history…' })
          : h('ul', { class: 'timeline' }, hist.map((a) => h('li', { class: a.kind },
            h('div', { class: 'when', text: (kindLabel[a.kind] || 'Update') + ' · ' + userName(a.user_id) + ' · ' + fmtDateTime(a.at) +
              (a.kind === 'action' && a.action_date ? ' · done ' + fmtDate(a.action_date) : '') }),
            h('div', { class: 'text', text: a.text }))))));

    host.replaceChildren(h('div', { class: 'backdrop', onclick: close }), drawer);
    drawer.scrollTop = scroll;
  }

  // ------------------------------------------------------------------
  // Updates from other people: banners, and the bell that keeps them
  // ------------------------------------------------------------------

  const BANNER_SECONDS = 8;

  function bellIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22zm7-5.2-1.6-1.7V10a5.4 5.4 0 0 0-4.2-5.3V3.6a1.2 1.2 0 0 0-2.4 0v1.1A5.4 5.4 0 0 0 6.6 10v5.1L5 16.8v1.4h14v-1.4z');
    svg.appendChild(path);
    return svg;
  }

  function timeAgo(iso) {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
    return fmtDateTime(iso);
  }

  const eventWho = (e) => (e.actor_id === null || e.actor_id === undefined ? 'InSys' : userName(e.actor_id));
  function eventSubject(e) {
    if (e.record) return e.record.ref + ' ' + e.record.title + (e.record.deleted ? ' (deleted)' : '');
    if (e.subcon) return e.subcon.ref + ' ' + e.subcon.name;
    if (e.scope === 'subcons') return 'Subcontractor directory';
    if (e.scope === 'admin') return 'Administration';
    return 'Task';
  }
  const snippet = (text) => (text.length > 140 ? text.slice(0, 140) + '…' : text);

  /** Go to whatever an update is about. */
  function openEvent(e) {
    closeBell();
    if (e.record && e.record.deleted) {
      Object.assign(S.log, { q: e.record.ref, kind: 'all', scope: 'deleted', month: '' });
      if (S.view === 'log') { renderAll(); loadLog(); } else go('log');
    } else if (e.record) go(viewForModule(e.record.module), e.record.ref);
    else if (e.subcon) go('subcons', e.subcon.ref);
    else if (e.scope === 'subcons') go('subcons');
    else if (e.scope === 'admin') { S.adminTab = 'users'; go('admin'); }
    else go('my');
  }

  function showBanners(events) {
    let host = document.getElementById('banners');
    if (!host) { host = h('div', { id: 'banners', 'aria-live': 'polite' }); document.body.appendChild(host); }
    const oldestFirst = events.slice().sort((a, b) => a.id - b.id);
    const shown = oldestFirst.slice(-3);
    const more = oldestFirst.length - shown.length;
    const fade = (el) => {
      setTimeout(() => el.classList.add('fading'), (BANNER_SECONDS - 1) * 1000);
      setTimeout(() => el.remove(), BANNER_SECONDS * 1000);
    };
    shown.forEach((e) => {
      const el = h('div', { class: 'banner', role: 'status' },
        h('button', { type: 'button', class: 'banner-main', title: 'Open', onclick: () => { el.remove(); openEvent(e); } },
          h('span', { class: 'banner-who', text: eventWho(e) + ' · ' + (KIND_LABELS[e.kind] || 'Update') }),
          h('span', { class: 'banner-what', text: eventSubject(e) }),
          h('span', { class: 'banner-text', text: snippet(e.text) })),
        h('button', { type: 'button', class: 'banner-close', 'aria-label': 'Dismiss this update', text: '×', onclick: () => el.remove() }));
      host.appendChild(el);
      fade(el);
    });
    if (more > 0) {
      const el = h('div', { class: 'banner', role: 'status' },
        h('button', { type: 'button', class: 'banner-main', onclick: (ev) => { ev.stopPropagation(); el.remove(); if (!S.events.open) toggleBell(); } },
          h('span', { class: 'banner-who', text: 'and ' + plural(more, 'more update') }),
          h('span', { class: 'banner-text', text: 'Open the bell to see them all.' })));
      host.appendChild(el);
      fade(el);
    }
    while (host.children.length > 4) host.firstChild.remove();
  }

  function renderBell() {
    const button = document.getElementById('bell');
    if (!button) return;
    const E = S.events;
    const count = document.getElementById('bell-count');
    count.hidden = !E.unread;
    count.textContent = E.unread > 99 ? '99+' : String(E.unread);
    button.setAttribute('aria-label', 'Updates from other people' + (E.unread ? ', ' + E.unread + ' new' : ''));
    button.title = E.unread ? plural(E.unread, 'new update') + ' from other people' : 'Updates from other people';
    button.setAttribute('aria-expanded', String(E.open));
    button.classList.toggle('has-new', !!E.unread);
    const panel = document.getElementById('bell-panel');
    panel.hidden = !E.open;
    if (!E.open) return;
    const items = E.list.map((e) => h('button', { type: 'button', class: 'bell-item' + (e.unread ? ' unread' : ''), onclick: () => openEvent(e) },
      h('span', { class: 'bell-meta' },
        h('span', { text: eventWho(e) + ' · ' + (KIND_LABELS[e.kind] || 'Update') }),
        h('span', { text: (e.unread ? 'New · ' : '') + timeAgo(e.at) })),
      h('span', { class: 'bell-what', text: eventSubject(e) }),
      h('span', { class: 'bell-text', text: snippet(e.text) })));
    panel.replaceChildren(
      h('div', { class: 'bell-head' }, h('h2', { text: 'Updates from other people' }),
        h('span', { class: 'muted small', text: E.list.some((e) => e.unread) ? plural(E.list.filter((e) => e.unread).length, 'new update') : 'Nothing new' })),
      items.length ? h('div', { class: 'bell-list' }, items)
        : h('div', { class: 'bell-empty', text: 'No updates from other people yet. Changes they make to things you can see will appear here.' }),
      h('div', { class: 'bell-foot' }, h('a', { href: '#/log', onclick: closeBell, text: 'See everything in the Activity log' })));
  }

  /** Opening the bell counts as having seen what is in it. */
  function markUpdatesSeen() {
    const E = S.events;
    if (!E.unread) return;
    E.unread = 0;
    api('POST', '/api/events/seen', { last_id: E.lastId }).catch(() => {});
  }

  function toggleBell(event) {
    if (event) event.stopPropagation();
    S.events.open = !S.events.open;
    renderBell();           // drawn first so new items are still marked "New" this once
    if (S.events.open) {
      markUpdatesSeen();
      renderBell();
      const host = document.getElementById('banners');
      if (host) host.replaceChildren();   // they are all in the list now
    }
    else S.events.list.forEach((e) => { e.unread = false; });
  }

  function closeBell() {
    if (!S.events.open) return;
    S.events.open = false;
    S.events.list.forEach((e) => { e.unread = false; });
    renderBell();
  }

  function resetUpdates() {
    S.events = { list: [], unread: 0, lastId: 0, shown: null, open: false };
    const host = document.getElementById('banners');
    if (host) host.remove();
  }

  // ------------------------------------------------------------------
  // Activity log: everything done, catalogued by month
  // ------------------------------------------------------------------

  const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthLabel = (m) => MONTHS_FULL[+m.slice(5) - 1] + ' ' + m.slice(0, 4);
  const KIND_LABELS = {
    created: 'Created', updated: 'Edited', action: 'Action', note: 'Note', link: 'Link', xref: 'Reference',
    task: 'Task', subcon: 'Subcontractor', deleted: 'Deleted', restored: 'Restored', admin: 'Administration',
  };

  async function loadLog() {
    const L = S.log;
    const seq = ++L.seq;
    const params = new URLSearchParams({ q: L.q, kind: L.kind, scope: L.scope, month: L.month });
    try {
      const data = await api('GET', '/api/log?' + params.toString());
      if (seq !== L.seq) return;  // a newer request has been made since
      L.data = data;
      L.error = null;
    } catch (e) {
      if (seq !== L.seq) return;
      L.error = e.message;
    }
    if (S.view === 'log') drawLog();
  }

  let logTimer = null;
  function logFilterChanged(delay) {
    S.log.month = '';  // let the server pick: newest month, or all months when searching
    clearTimeout(logTimer);
    logTimer = setTimeout(loadLog, delay || 0);
  }

  function restoreRecord(record) {
    confirmDialog('Restore ' + record.ref + '?', '"' + record.title + '" will be put back in ' + mods()[record.module].label +
      ' with its history, links and subcontractors.', 'Restore', async () => {
      await api('POST', '/api/records/' + record.id + '/restore', {});
      await refresh();
      toast(record.ref + ' restored.');
      go(viewForModule(record.module), record.ref);
    });
  }

  function exportLogCsv() {
    const data = S.log.data;
    if (!data) return;
    const lines = [['Date', 'Logged at', 'Who', 'Reference', 'Section', 'Title', 'Item state', 'Type', 'What was done'].map(csvCell).join(',')];
    data.entries.forEach((e) => {
      lines.push([e.day, e.at, userName(e.user_id), e.record ? e.record.ref : '', e.record ? mods()[e.record.module].singular : 'Task',
        e.record ? e.record.title : '', e.state === 'deleted' ? 'Deleted' : (e.state === 'closed' ? 'Completed / closed' : 'Open'),
        KIND_LABELS[e.kind] || e.kind, e.text].map(csvCell).join(','));
    });
    saveCsv('insys-activity-log-' + (data.month === 'all' ? 'all' : data.month) + '.csv', lines);
  }

  function drawLog() {
    const host = document.getElementById('log-host');
    if (!host) return;
    const L = S.log;
    if (L.error) { host.replaceChildren(h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: L.error }))); return; }
    const data = L.data;
    if (!data) { host.replaceChildren(h('p', { class: 'muted', text: 'Loading…' })); return; }
    const total = data.months.reduce((sum, m) => sum + m.count, 0);
    const pick = (month) => () => { L.month = month; loadLog(); };
    const index = h('nav', { class: 'month-index', 'aria-label': 'Months' },
      h('button', { type: 'button', class: data.month === 'all' ? 'active' : null, onclick: pick('all') },
        h('span', { text: 'All months' }), h('span', { class: 'count', text: total })),
      data.months.map((m) => h('button', { type: 'button', class: data.month === m.month ? 'active' : null, onclick: pick(m.month) },
        h('span', { text: monthLabel(m.month) }), h('span', { class: 'count', text: m.count }))));

    let body;
    if (!data.entries.length) {
      body = h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: total
        ? 'Nothing in this month matches. Pick another month on the left.'
        : (L.q || L.scope !== 'all' || L.kind !== 'actions' ? 'Nothing matches this search.' : 'Nothing has been logged yet. Actions appear here as people use "Log action".') }));
    } else {
      const rows = [];
      let lastMonth = null;
      data.entries.forEach((e) => {
        const month = e.day.slice(0, 7);
        if (data.month === 'all' && month !== lastMonth) {
          lastMonth = month;
          rows.push(h('tr', { class: 'month-row' }, h('th', { colspan: '4', scope: 'colgroup', text: monthLabel(month) })));
        }
        const r = e.record;
        let item;
        if (!r) {
          item = h('td', { class: 'muted', text: 'Task' });
        } else if (e.state === 'deleted') {
          item = h('td', { class: 'cell-text' },
            h('span', { class: 'ref', text: r.ref }), ' ', h('span', { class: 'tag', text: 'Deleted' }),
            h('div', { class: 'cell-sub', text: r.title }),
            isAdmin() && e.kind === 'deleted' ? h('button', { type: 'button', class: 'btn quiet', text: 'Restore', 'aria-label': 'Restore ' + r.ref, onclick: () => restoreRecord(r) }) : null);
        } else {
          item = h('td', { class: 'cell-text' },
            h('a', { class: 'ref', href: '#/log/' + r.ref, text: r.ref }),
            e.state === 'closed' ? [' ', h('span', { class: 'tag', text: r.status })] : null,
            h('div', { class: 'cell-sub', text: r.title }));
        }
        rows.push(h('tr', null,
          h('td', { class: 'nowrap', text: fmtDate(e.day) }),
          item,
          h('td', { class: 'log-text' }, h('span', { class: 'tag', text: KIND_LABELS[e.kind] || 'Update' }), ' ', h('span', { class: 'text', text: e.text })),
          h('td', { class: 'nowrap', text: userName(e.user_id) })));
      });
      body = h('div', null,
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Date', 'Item', 'What was done', 'By'].map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', null, rows))),
        data.truncated ? h('p', { class: 'muted small', style: { marginTop: '8px' }, text: 'Showing the newest ' + data.entries.length + ' of ' + data.total + '. Pick a month or search to narrow it down.' }) : null);
    }
    host.replaceChildren(h('div', { class: 'log-layout' }, index, h('div', { class: 'log-entries' },
      h('p', { class: 'muted small', style: { marginBottom: '8px' }, text: (data.month === 'all' ? 'All months' : monthLabel(data.month)) + ' · ' + plural(data.total, 'entry', 'entries') }),
      body)));
  }

  function viewLog() {
    const L = S.log;
    const node = h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('h1', { text: 'Activity log' }),
          h('p', { class: 'sub', text: 'Everything that has been done, catalogued by month. Completed and deleted items stay here for future reference.' })),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', text: 'Export CSV', title: 'Download the entries shown below as a spreadsheet', onclick: exportLogCsv }))),
      h('div', { class: 'filters' },
        h('input', { id: 'flt-log-q', type: 'search', placeholder: 'Search what was done, a reference or a person…', 'aria-label': 'Search the activity log', value: L.q,
          oninput: (e) => { L.q = e.target.value; logFilterChanged(250); } }),
        h('select', { id: 'flt-log-kind', 'aria-label': 'Type of entry', value: L.kind, onchange: (e) => { L.kind = e.target.value; logFilterChanged(); } },
          h('option', { value: 'actions', text: 'Actions done' }), h('option', { value: 'tasks', text: 'Tasks' }), h('option', { value: 'all', text: 'All activity' })),
        h('select', { id: 'flt-log-scope', 'aria-label': 'Which items', value: L.scope, onchange: (e) => { L.scope = e.target.value; logFilterChanged(); } },
          h('option', { value: 'all', text: 'All items' }), h('option', { value: 'open', text: 'Open items' }),
          h('option', { value: 'closed', text: 'Completed / closed items' }), h('option', { value: 'deleted', text: 'Deleted items' }))),
      h('div', { id: 'log-host' }));
    // The results are drawn once this node is on the page (see renderMain).
    return node;
  }

  // ------------------------------------------------------------------
  // Subcontractors: directory, picker, and their place on a record
  // ------------------------------------------------------------------

  const DISCIPLINES = ['Structural', 'Civil', 'Mechanical', 'Electrical', 'HVAC', 'Plumbing / hydraulics',
    'Fire protection', 'Geotechnical', 'Surveying', 'Architectural', 'Environmental', 'Instrumentation & controls'];

  const subconHay = (sub) => [sub.ref, sub.name, sub.discipline, sub.capabilities, sub.services, sub.contact_name, sub.email,
    sub.phone, sub.address, sub.registration, sub.notes].join(' ').toLowerCase();

  // What a subcontractor can do, for matching against the needs of a scope.
  const capabilityHay = (sub) => [sub.discipline, sub.capabilities, sub.services, sub.notes, sub.name].join(' ').toLowerCase();
  const splitList = (text) => {
    const seen = new Set();
    return (text || '').split(/[,;\n]+/).map((x) => x.trim()).filter((x) => {
      const key = x.toLowerCase();
      if (!x || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const subHref = (sub) => '#/' + S.view + '/' + sub.ref;

  function workSummary(open) {
    const n = (module) => open.filter((x) => x.rec.module === module).length;
    const parts = [];
    if (n('project')) parts.push(plural(n('project'), 'project'));
    if (n('enquiry')) parts.push(plural(n('enquiry'), 'enquiry', 'enquiries'));
    if (n('eoi')) parts.push(plural(n('eoi'), 'EOI'));
    return parts.join(' · ');
  }

  /** What is next for a subcontractor on a record, as shown in the subcontractor lists. */
  function followUpCell(x) {
    if (!isOpen(x.rec)) return h('span', { class: 'muted', text: '—' });
    const f = followUp(x);
    return [f.text ? h('div', { text: f.text }) : null,
      f.date ? dueChip(f.date) : h('span', { class: 'chip none', text: f.text ? 'No date set' : 'Not set' }),
      f.own ? [' ', h('span', { class: 'tag', title: 'A follow-up set for this subcontractor on this item', text: 'Subcon follow-up' })] : null];
  }

  function subconForm(sub, opts) {
    const options = opts || {};
    const known = Array.from(new Set(DISCIPLINES.concat(S.data.subcons.map((x) => x.discipline).filter(Boolean)))).sort();
    formDialog({
      title: sub ? 'Edit ' + sub.ref : 'Add a subcontractor to the directory',
      intro: sub ? null : 'Once in the directory, a subcontractor can be added to any project, enquiry or expression of interest.',
      wide: true,
      fields: [
        { name: 'name', label: 'Subcontractor / company name', required: true, full: true, maxlength: 150, value: sub ? sub.name : (options.name || '') },
        { name: 'discipline', label: 'Engineering discipline(s)', maxlength: 100, options: known, placeholder: 'e.g. Structural, Civil', value: sub ? sub.discipline : '' },
        { name: 'active', label: 'Status', type: 'select', value: sub && !sub.active ? 'no' : 'yes',
          options: [{ value: 'yes', label: 'Active' }, { value: 'no', label: 'Inactive (not for new work)' }] },
        { name: 'capabilities', label: 'Capabilities and specialised studies', type: 'textarea', rows: 2, full: true, maxlength: 1500, value: sub ? sub.capabilities : '',
          placeholder: 'e.g. Seismic assessment, Wind tunnel study, HAZOP, Finite element analysis',
          hint: 'Separate with commas. These are what "Find by capability" searches, so list anything you may later need to find them for.' },
        { name: 'contact_name', label: 'Contact person', maxlength: 150, value: sub ? sub.contact_name : '' },
        { name: 'phone', label: 'Phone', maxlength: 60, value: sub ? sub.phone : '' },
        { name: 'email', label: 'Email', maxlength: 200, value: sub ? sub.email : '' },
        { name: 'website', label: 'Website', maxlength: 300, value: sub ? sub.website : '' },
        { name: 'registration', label: 'Registration / licence number', maxlength: 100, full: true, value: sub ? sub.registration : '' },
        { name: 'address', label: 'Address', type: 'textarea', rows: 2, full: true, maxlength: 500, value: sub ? sub.address : '' },
        { name: 'services', label: 'Engineering services provided', type: 'textarea', rows: 3, full: true, maxlength: 2000, value: sub ? sub.services : '' },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, full: true, maxlength: 5000, value: sub ? sub.notes : '',
          hint: 'For example rates, insurance and accreditation details, or past performance.' },
      ],
      submitLabel: sub ? 'Save changes' : 'Add to directory',
      onSubmit: async (v) => {
        const body = {
          name: v.name, discipline: v.discipline, capabilities: v.capabilities, active: v.active === 'yes', contact_name: v.contact_name, phone: v.phone,
          email: v.email, website: v.website, registration: v.registration, address: v.address, services: v.services, notes: v.notes,
        };
        if (sub) {
          body.version = sub.version;
          await api('PUT', '/api/subcons/' + sub.id, body);
          await refresh();
          toast(sub.ref + ' saved.');
        } else {
          const res = await api('POST', '/api/subcons', body);
          await refresh();
          toast(res.subcon.name + ' added to the directory as ' + res.subcon.ref + '.');
          if (options.after) await options.after(res.subcon);
          else go('subcons', res.subcon.ref);
        }
      },
    });
  }

  /** The searchable pop-up for putting subcontractors on a record. Stays open so several can be added. */
  function subconPicker(rec) {
    const search = h('input', { id: 'subcon-search', type: 'search', autocomplete: 'off', placeholder: 'Search by name, discipline, capability, contact…', 'aria-label': 'Search subcontractors' });
    const list = h('div', { class: 'pick-list' });
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const dlg = h('dialog', { class: 'dlg wide' });
    let busy = false;

    const add = async (sub) => {
      if (busy) return;
      busy = true;
      error.hidden = true;
      try {
        await api('POST', '/api/records/' + rec.id + '/subcons', { subcon_id: sub.id });
        await refresh();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      }
      busy = false;
      draw();
    };

    const draw = () => {
      const current = S.I.recs.get(rec.id);
      if (!current) { dlg.close(); return; }
      const on = new Set((S.I.subsByRec.get(current.id) || []).map((x) => x.sub.id));
      const q = search.value.trim().toLowerCase();
      const all = S.data.subcons.filter((sub) => sub.active || on.has(sub.id));
      const shown = all.filter((sub) => !q || subconHay(sub).includes(q));
      if (!shown.length) {
        list.replaceChildren(h('div', { class: 'pick-empty', text: all.length
          ? 'No subcontractor matches "' + search.value.trim() + '". Use "New subcontractor" to add them to the directory.'
          : 'The directory is empty. Use "New subcontractor" to add the first one.' }));
        return;
      }
      list.replaceChildren(...shown.map((sub) => {
        const added = on.has(sub.id);
        return h('button', {
          type: 'button', class: 'pick' + (added ? ' added' : ''), disabled: added,
          'aria-label': (added ? 'Already added: ' : 'Add ') + sub.name,
          onclick: () => add(sub),
        },
        h('span', { class: 'pick-main' },
          h('span', { class: 'cell-title', text: sub.name }),
          h('span', { class: 'cell-sub', text: [sub.ref, sub.discipline, sub.contact_name, sub.phone].filter(Boolean).join(' · ') }),
          sub.capabilities ? h('span', { class: 'cell-sub', text: sub.capabilities.length > 110 ? sub.capabilities.slice(0, 110) + '…' : sub.capabilities }) : null),
        h('span', { class: 'pick-side', text: added ? '✓ Added' : 'Add' }));
      }));
    };

    search.addEventListener('input', draw);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = list.querySelector('button.pick:not(:disabled)');
        if (first) first.click();
      }
    });
    dlg.appendChild(h('div', { class: 'dlg-form' },
      h('div', { class: 'dlg-head' }, h('h2', { text: 'Add subcontractors to ' + rec.ref }),
        h('p', { text: 'Click a subcontractor to add them. You can add as many as are working on this in parallel.' })),
      h('div', { class: 'dlg-body' }, error, search, list),
      h('div', { class: 'dlg-foot split' },
        h('button', {
          type: 'button', class: 'btn', text: '+ New subcontractor',
          onclick: () => subconForm(null, { name: search.value.trim(), after: async (sub) => { search.value = ''; await add(sub); } }),
        }),
        h('button', { type: 'button', class: 'btn primary', text: 'Done', onclick: () => dlg.close() }))));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    draw();
    search.focus();
  }

  /** Scope, last known update and next follow-up for one subcontractor on one record. */
  function followUpForm(rec, entry) {
    formDialog({
      title: entry.sub.name + ' on ' + rec.ref,
      intro: 'Track this subcontractor separately from the ' + mods()[rec.module].singular.toLowerCase() + ' itself: what you last heard from them, and what you need to follow up next.',
      wide: true,
      fields: [
        { name: 'scope', label: 'Scope of work', full: true, maxlength: 300, value: entry.scope, placeholder: 'e.g. Structural design and certification' },
        { type: 'section', label: 'Last known update' },
        { name: 'last_update', label: 'What was the last update from or about them?', type: 'textarea', rows: 2, full: true, maxlength: 500, value: entry.last_update,
          placeholder: 'e.g. Sent drawings for pricing; they confirmed receipt' },
        { name: 'last_update_date', label: 'Date of that update', type: 'date', value: entry.last_update_date || today() },
        { type: 'section', label: 'Next follow-up' },
        { name: 'next_action', label: 'Next follow-up action', full: true, maxlength: 500, value: entry.next_action, placeholder: 'e.g. Chase their quote',
          hint: 'Clear this when nothing further is needed from them.' },
        { name: 'next_action_date', label: 'Expected date', type: 'date', value: entry.next_action_date },
      ],
      submitLabel: 'Save',
      onSubmit: async (v) => {
        await api('PUT', '/api/records/' + rec.id + '/subcons/' + entry.sub.id, {
          scope: v.scope, last_update: v.last_update, last_update_date: v.last_update ? (v.last_update_date || null) : null,
          next_action: v.next_action, next_action_date: v.next_action_date || null,
        });
        await refresh();
        toast('Saved for ' + entry.sub.name + '.');
      },
    });
  }

  /** The "Subcontractors" card inside a project, enquiry or EOI. */
  function subconCard(rec) {
    const entries = S.I.subsByRec.get(rec.id) || [];
    const open = isOpen(rec);
    return h('section', { class: 'card' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Subcontractors' }),
        h('button', { type: 'button', class: 'btn small', text: 'Add subcontractor', onclick: () => subconPicker(rec) })),
      entries.length ? h('ul', { class: 'list subcon-list' }, entries.map((entry) => h('li', null,
        h('div', { class: 'main' },
          h('a', { class: 'cell-title', href: subHref(entry.sub), text: entry.sub.name }),
          entry.sub.active ? null : [' ', h('span', { class: 'tag', text: 'Inactive' })],
          h('div', { class: 'small muted', text: [entry.sub.discipline, entry.scope ? 'Scope: ' + entry.scope : 'No scope noted'].filter(Boolean).join(' · ') }),
          h('div', { class: 'small' }, h('span', { class: 'muted', text: 'Last update: ' }),
            entry.last_update ? [entry.last_update, h('span', { class: 'muted', text: ' (' + fmtDate(entry.last_update_date) + ')' })] : h('span', { class: 'muted', text: 'none recorded' })),
          h('div', { class: 'small' }, h('span', { class: 'muted', text: 'Next follow-up: ' }),
            (entry.next_action || entry.next_action_date)
              ? [entry.next_action || 'Follow up', ' ', entry.next_action_date ? (open ? dueChip(entry.next_action_date) : h('span', { class: 'muted', text: fmtDate(entry.next_action_date) })) : h('span', { class: 'chip none', text: 'No date set' })]
              : h('span', { class: 'muted', text: 'none set' }))),
        h('div', { class: 'side' },
          h('button', { type: 'button', class: 'btn small', text: 'Update', 'aria-label': 'Update ' + entry.sub.name + ' on ' + rec.ref, onclick: () => followUpForm(rec, entry) }),
          h('button', {
            type: 'button', class: 'btn quiet dangerous', text: 'Remove', 'aria-label': 'Remove ' + entry.sub.name + ' from ' + rec.ref,
            onclick: () => confirmDialog('Remove ' + entry.sub.name + '?', entry.sub.name + ' will be taken off ' + rec.ref + '. They stay in the directory.', 'Remove', async () => {
              await api('DELETE', '/api/records/' + rec.id + '/subcons/' + entry.sub.id);
              await refresh();
            }),
          })))))
        : h('p', { class: 'muted small', text: 'No subcontractors on this ' + mods()[rec.module].singular.toLowerCase() + ' yet.' }));
  }

  function workList(items) {
    return h('ul', { class: 'list' }, items.map((x) => {
      const f = followUp(x);
      return h('li', null,
        h('div', { class: 'main' },
          h('a', { class: 'ref', href: recHref(x.rec), text: x.rec.ref }), ' ', h('span', { class: 'cell-title', text: x.rec.title }),
          h('div', { class: 'small muted', text: [mods()[x.rec.module].singular, x.scope ? 'Scope: ' + x.scope : '', 'Owner: ' + userName(x.rec.owner_id)].filter(Boolean).join(' · ') }),
          x.last_update ? h('div', { class: 'small', text: 'Last update: ' + x.last_update + ' (' + fmtDate(x.last_update_date) + ')' }) : null,
          isOpen(x.rec) ? h('div', { class: 'small', text: f.text ? (f.own ? 'Follow-up: ' : 'Next: ') + f.text : 'No next action set' }) : null),
        h('div', { class: 'side' },
          isOpen(x.rec) && f.date ? dueChip(f.date) : null,
          prioChip(x.rec.priority), statusPill(x.rec)));
    }));
  }

  /** The panel that opens for a subcontractor (SUB-0001). */
  function subconDrawer(top) {
    const sub = S.I.subByRef.get(S.openRef);
    if (!sub) {
      return h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Subcontractor ' + S.openRef },
        top(S.openRef, 'Subcontractor not available'),
        h('p', { class: 'muted', text: 'This subcontractor has been deleted from the directory.' }));
    }
    const work = subconWork(sub);
    const link = (href, text) => h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: text });
    const caps = splitList(sub.capabilities);
    return h('aside', { class: 'drawer', role: 'dialog', 'aria-label': sub.ref + ' ' + sub.name },
      top(sub.ref + ' · Subcontractor', sub.name),
      h('div', { class: 'badges' },
        h('span', { class: 'pill ' + (sub.active ? 'done' : 'dead'), text: sub.active ? 'Active' : 'Inactive' }),
        sub.discipline ? h('span', { class: 'tag', text: sub.discipline }) : null,
        h('span', { class: 'muted small', text: work.open.length ? 'Working on ' + workSummary(work.open) : 'No current work' })),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', text: 'Edit details', onclick: () => subconForm(sub) }),
        isAdmin() ? h('button', {
          type: 'button', class: 'btn quiet dangerous', text: 'Delete',
          onclick: () => confirmDialog('Delete ' + sub.name + '?', 'This removes ' + sub.name + ' from the directory' +
            (work.all.length ? ' and from the ' + plural(work.all.length, 'record') + ' they are on' : '') +
            '. This cannot be undone. To keep the history, mark them Inactive instead.', 'Delete permanently', async () => {
            await api('DELETE', '/api/subcons/' + sub.id);
            go(S.view);
            await refresh();
            toast(sub.name + ' deleted from the directory.');
          }, true),
        }) : null),

      card('Current work', work.open.length ? 'Most urgent action first' : null,
        work.open.length ? workList(work.open) : h('p', { class: 'muted small', text: 'Not on any open project, enquiry or expression of interest. Add them from a record with "Add subcontractor".' })),

      card('Details', null, h('div', { class: 'details' },
        detail('Engineering discipline(s)', sub.discipline),
        detail('Contact person', sub.contact_name),
        detail('Capabilities and specialised studies', caps.length ? h('div', { class: 'tag-row' }, caps.map((c) => h('span', { class: 'tag', text: c }))) : '', true),
        detail('Phone', sub.phone ? h('a', { href: 'tel:' + sub.phone.replace(/[^0-9+]/g, ''), text: sub.phone }) : ''),
        detail('Email', sub.email ? h('a', { href: 'mailto:' + sub.email, text: sub.email }) : ''),
        detail('Website', sub.website ? link(sub.website, sub.website) : ''),
        detail('Registration / licence number', sub.registration),
        detail('Address', sub.address, true, true),
        detail('Engineering services provided', sub.services, true, true),
        detail('Notes', sub.notes, true, true),
        detail('Added to directory', fmtDateTime(sub.created_at) + ' by ' + userName(sub.created_by)),
        detail('Last updated', fmtDateTime(sub.updated_at) + ' by ' + userName(sub.updated_by)))),

      work.closed.length ? card('Past work', plural(work.closed.length, 'closed item'), workList(work.closed)) : null);
  }

  function exportSubconsCsv(subs) {
    const header = ['Reference', 'Subcontractor', 'Discipline', 'Capabilities', 'Status', 'Contact person', 'Phone', 'Email', 'Website',
      'Registration / licence', 'Address', 'Services', 'Notes', 'Open projects', 'Open enquiries', 'Open EOIs',
      'Current work', 'Most urgent action', 'Most urgent action due'];
    const lines = [header.map(csvCell).join(',')];
    subs.forEach((sub) => {
      const work = subconWork(sub);
      const n = (module) => work.open.filter((x) => x.rec.module === module).length;
      const f = work.top ? followUp(work.top) : null;
      lines.push([sub.ref, sub.name, sub.discipline, sub.capabilities, sub.active ? 'Active' : 'Inactive', sub.contact_name, sub.phone, sub.email, sub.website,
        sub.registration, sub.address, sub.services, sub.notes, n('project'), n('enquiry'), n('eoi'),
        work.open.map((x) => x.rec.ref).join('; '),
        work.top ? work.top.rec.ref + ': ' + (f.text || 'no next action set') : '',
        f ? f.date : ''].map(csvCell).join(','));
    });
    saveCsv('insys-subcontractors-' + today() + '.csv', lines);
  }

  /** Put several subcontractors on one record in one go (from "Find by capability"). */
  function addSubconsToRecord(subs, after) {
    const order = { enquiry: 0, eoi: 1, project: 2 };
    const records = S.data.records.filter((r) => usesSubcons(r.module) && isOpen(r))
      .sort((a, b) => (order[a.module] - order[b.module]) || (b.id - a.id));
    if (!records.length) { toast('There is no open enquiry, expression of interest or project to add them to yet.', true); return; }
    formDialog({
      title: 'Add ' + plural(subs.length, 'subcontractor') + ' to…',
      intro: subs.map((sub) => sub.name).join(', '),
      fields: [{ name: 'record', label: 'Enquiry, expression of interest or project', required: true, full: true,
        options: records.map((r) => r.ref + ' — ' + r.title), placeholder: 'Type a reference or title, e.g. ENQ-0004',
        hint: 'Start typing and pick from the list. Open items only.' }],
      submitLabel: 'Add to this item',
      onSubmit: async (v) => {
        const found = /^([A-Za-z]{3}-\d+)/.exec(v.record);
        const rec = found ? S.I.byRef.get(found[1].toUpperCase()) : null;
        if (!rec || !usesSubcons(rec.module)) throw new Error('Pick an enquiry, expression of interest or project from the list.');
        const already = new Set((S.I.subsByRec.get(rec.id) || []).map((x) => x.sub.id));
        const fresh = subs.filter((sub) => !already.has(sub.id));
        for (const sub of fresh) {
          await api('POST', '/api/records/' + rec.id + '/subcons', { subcon_id: sub.id });
        }
        await refresh();
        toast(fresh.length ? plural(fresh.length, 'subcontractor') + ' added to ' + rec.ref + '.' : 'They were already on ' + rec.ref + '.');
        if (after) after();
        go(viewForModule(rec.module), rec.ref);
      },
    });
  }

  function viewSubcons() {
    const f = S.filters.subcons || (S.filters.subcons = { q: '', status: 'active', mode: 'directory', sort: 'urgent', need: '', picked: new Set() });
    const t = today();
    const subs = S.data.subcons;
    const work = new Map(subs.map((sub) => [sub.id, subconWork(sub)]));
    const engaged = subs.filter((sub) => work.get(sub.id).open.length);
    const lateDate = (x) => { const d = followUp(x).date; return !!d && d < t; };
    const late = engaged.filter((sub) => work.get(sub.id).open.some(lateDate));
    const host = h('div');

    const visible = () => {
      const q = f.q.trim().toLowerCase();
      return subs.filter((sub) => {
        if (f.status === 'active' && !sub.active) return false;
        if (f.status === 'inactive' && sub.active) return false;
        if (f.status === 'engaged' && !work.get(sub.id).open.length) return false;
        if (!q) return true;
        // Also match on the work they are doing, so "PRJ-0003" finds its subcontractors.
        return (subconHay(sub) + ' ' + work.get(sub.id).all.map((x) => x.rec.ref + ' ' + x.rec.title).join(' ').toLowerCase()).includes(q);
      });
    };

    const directory = () => {
      const rows = visible().sort((a, b) => {
        const wa = work.get(a.id); const wb = work.get(b.id);
        if (f.sort === 'urgent') {
          if (wa.top && wb.top) { const c = byPairUrgency(wa.top, wb.top); if (pairUrgencyKey(wa.top) !== pairUrgencyKey(wb.top)) return c; }
          else if (wa.top || wb.top) return wa.top ? -1 : 1;
        } else if (f.sort === 'busy' && wa.open.length !== wb.open.length) {
          return wb.open.length - wa.open.length;
        }
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      });
      if (!rows.length) {
        return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: subs.length
          ? 'No subcontractor matches these filters.'
          : 'The directory is empty. Use "+ Add subcontractor" to add the first one.' }));
      }
      return h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Ref', 'Subcontractor', 'Contact', 'Current work', 'Most urgent action'].map((x) => h('th', { scope: 'col', text: x })))),
        h('tbody', null, rows.map((sub) => {
          const w = work.get(sub.id);
          return h('tr', { class: 'clickable', onclick: (e) => { if (!e.target.closest('a, button, input')) go('subcons', sub.ref); } },
            h('td', null, h('a', { class: 'ref', href: subHref(sub), text: sub.ref })),
            h('td', { class: 'cell-text' },
              h('div', { class: 'cell-title', text: sub.name }),
              sub.discipline ? h('div', { class: 'cell-sub', text: sub.discipline }) : null,
              sub.capabilities ? h('div', { class: 'cell-sub', text: sub.capabilities.length > 90 ? sub.capabilities.slice(0, 90) + '…' : sub.capabilities }) : null,
              sub.active ? null : h('span', { class: 'tag', text: 'Inactive' })),
            h('td', { class: 'cell-text' },
              sub.contact_name ? h('div', { text: sub.contact_name }) : null,
              h('div', { class: 'cell-sub', text: [sub.phone, sub.email].filter(Boolean).join(' · ') || (sub.contact_name ? '' : '—') })),
            h('td', { class: 'cell-text' }, w.open.length
              ? [h('div', { text: workSummary(w.open) }), h('div', { class: 'cell-sub' }, w.open.map((x, i) => [i ? ', ' : '', h('a', { href: recHref(x.rec), text: x.rec.ref, title: x.rec.title })]))]
              : h('span', { class: 'muted', text: 'None' })),
            h('td', { class: 'cell-text' }, w.top
              ? [h('div', { class: 'cell-sub' }, h('a', { class: 'ref', href: recHref(w.top.rec), text: w.top.rec.ref }), ' ', w.top.rec.title),
                followUpCell(w.top), ' ', prioChip(w.top.rec.priority)]
              : h('span', { class: 'muted', text: '—' })));
        }))));
    };

    const priorities = () => {
      const shown = new Set(visible().map((sub) => sub.id));
      const rows = [];
      subs.forEach((sub) => { if (shown.has(sub.id)) work.get(sub.id).open.forEach((x) => rows.push(x)); });
      rows.sort(byPairUrgency);
      if (!rows.length) {
        return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: 'No subcontractor is on any open project, enquiry or expression of interest' + (f.q || f.status !== 'active' ? ' that matches these filters.' : '.') }));
      }
      return h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Next action', 'Subcontractor', 'Last update', 'Ref', 'Section', 'Title', 'Status', 'Owner'].map((x) => h('th', { scope: 'col', text: x })))),
        h('tbody', null, rows.map((x) => h('tr', { class: 'clickable', onclick: (e) => { if (!e.target.closest('a, button, input')) go('subcons', x.rec.ref); } },
          h('td', { class: 'cell-text' }, followUpCell(x), ' ', prioChip(x.rec.priority)),
          h('td', { class: 'cell-text' }, h('a', { class: 'cell-title', href: subHref(x.sub), text: x.sub.name }),
            h('div', { class: 'cell-sub', text: [x.sub.discipline, x.scope].filter(Boolean).join(' · ') })),
          h('td', { class: 'cell-text' }, x.last_update ? [h('div', { text: x.last_update }), h('div', { class: 'cell-sub', text: fmtDate(x.last_update_date) })] : h('span', { class: 'muted', text: '—' })),
          h('td', null, h('a', { class: 'ref', href: recHref(x.rec), text: x.rec.ref })),
          h('td', { class: 'nowrap', text: mods()[x.rec.module].singular }),
          h('td', { class: 'cell-text' }, h('div', { class: 'cell-title', text: x.rec.title }),
            x.rec.organisation ? h('div', { class: 'cell-sub', text: x.rec.organisation }) : null),
          h('td', null, statusPill(x.rec)),
          h('td', { class: x.rec.owner_id === null ? 'muted nowrap' : 'nowrap', text: userName(x.rec.owner_id) }))))));
    };

    // "What does this scope need?" -> who can do it.
    const capability = () => {
      const terms = splitList(f.need).map((x) => x.toLowerCase());
      const active = subs.filter((sub) => sub.active);
      if (!terms.length) {
        const known = new Map();
        active.forEach((sub) => splitList(sub.discipline).concat(splitList(sub.capabilities)).forEach((c) => {
          const key = c.toLowerCase();
          if (!known.has(key)) known.set(key, { label: c, count: 0 });
          known.get(key).count += 1;
        }));
        const tags = Array.from(known.values()).sort((a, b) => (b.count - a.count) || (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
        return h('div', { class: 'card' },
          h('p', { class: 'muted', text: 'Type what the scope needs in the box above, separated by commas, for example "structural, seismic assessment, geotechnical investigation". InSys lists the subcontractors whose disciplines, capabilities, services or notes cover each requirement.' }),
          tags.length ? [h('h3', { class: 'muted', style: { margin: '14px 0 8px' }, text: 'Disciplines and capabilities in the directory - click one to search for it' }),
            h('div', { class: 'tag-row' }, tags.map((x) => h('button', {
              type: 'button', class: 'tag-button', text: x.label + (x.count > 1 ? ' (' + x.count + ')' : ''),
              onclick: () => { f.need = x.label; renderMain(); const box = document.getElementById('flt-subcons-need'); if (box) box.focus(); },
            })))]
            : h('p', { class: 'muted small', style: { marginTop: '10px' }, text: 'No disciplines or capabilities have been entered for any subcontractor yet. Add them with "Edit details" on each subcontractor.' }));
      }
      const scored = active.map((sub) => {
        const hay = capabilityHay(sub);
        return { sub: sub, hit: terms.filter((term) => hay.includes(term)) };
      }).filter((x) => x.hit.length).sort((a, b) => (b.hit.length - a.hit.length) ||
        (work.get(a.sub.id).open.length - work.get(b.sub.id).open.length) || (a.sub.name.toLowerCase() < b.sub.name.toLowerCase() ? -1 : 1));
      const uncovered = terms.filter((term) => !scored.some((x) => x.hit.includes(term)));
      const ids = new Set(scored.map((x) => x.sub.id));
      Array.from(f.picked).forEach((id) => { if (!ids.has(id)) f.picked.delete(id); });
      const bar = h('div', { class: 'select-bar' });
      const drawBar = () => {
        const chosen = scored.map((x) => x.sub).filter((sub) => f.picked.has(sub.id));
        const emails = chosen.map((sub) => sub.email).filter(Boolean);
        bar.replaceChildren(
          h('span', { class: 'cell-title', text: chosen.length ? plural(chosen.length, 'subcontractor') + ' selected' : 'Tick the subcontractors to approach' }),
          h('button', { type: 'button', class: 'btn primary small', disabled: !chosen.length, text: 'Add selected to an enquiry…',
            title: 'Put the selected subcontractors on an enquiry, expression of interest or project',
            onclick: () => addSubconsToRecord(chosen, () => { f.picked.clear(); }) }),
          h('button', { type: 'button', class: 'btn small', disabled: !emails.length, text: 'Email selected',
            title: emails.length ? 'Start an email to ' + emails.join(', ') : 'None of the selected subcontractors has an email address',
            onclick: () => { window.location.href = 'mailto:' + emails.map(encodeURIComponent).join(','); } }),
          h('button', { type: 'button', class: 'btn small', disabled: !emails.length, text: 'Copy email addresses',
            onclick: async () => { try { await navigator.clipboard.writeText(emails.join('; ')); toast(plural(emails.length, 'email address', 'email addresses') + ' copied.'); } catch (e) { toast(emails.join('; ')); } } }),
          chosen.length && emails.length < chosen.length ? h('span', { class: 'muted small', text: (chosen.length - emails.length) + ' selected without an email address' }) : null);
      };
      drawBar();
      const summary = h('p', { class: 'muted', style: { marginBottom: '10px' } },
        scored.length ? plural(scored.length, 'active subcontractor') + ' cover' + (scored.length === 1 ? 's' : '') + ' at least one requirement, best match first.' : 'No active subcontractor covers any of these requirements.',
        uncovered.length ? [' Not covered by anyone: ', uncovered.map((term, i) => [i ? ' ' : '', h('span', { class: 'chip overdue' }, h('span', { class: 'icon', text: '!', 'aria-hidden': 'true' }), term)])] : null);
      if (!scored.length) return h('div', null, summary);
      return h('div', null, summary, bar,
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, h('span', { text: 'Select' })),
            ['Subcontractor', 'Covers', 'Capabilities and services', 'Current work', 'Contact'].map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', null, scored.map((x) => {
            const sub = x.sub;
            const box = h('input', { type: 'checkbox', 'aria-label': 'Select ' + sub.name, onchange: () => { if (box.checked) f.picked.add(sub.id); else f.picked.delete(sub.id); drawBar(); } });
            box.checked = f.picked.has(sub.id);
            const w = work.get(sub.id);
            return h('tr', null,
              h('td', null, box),
              h('td', { class: 'cell-text' }, h('a', { class: 'cell-title', href: subHref(sub), text: sub.name }),
                h('div', { class: 'cell-sub', text: [sub.ref, sub.discipline].filter(Boolean).join(' · ') })),
              h('td', { class: 'cell-text' },
                h('div', { class: 'cell-title', text: x.hit.length + ' of ' + terms.length }),
                h('div', { class: 'tag-row' }, terms.map((term) => (x.hit.includes(term)
                  ? h('span', { class: 'tag match', text: '✓ ' + term })
                  : h('span', { class: 'tag miss', text: term }))))),
              h('td', { class: 'cell-text' },
                sub.capabilities ? h('div', { text: sub.capabilities }) : null,
                sub.services ? h('div', { class: 'cell-sub', text: sub.services.length > 160 ? sub.services.slice(0, 160) + '…' : sub.services }) : null,
                !sub.capabilities && !sub.services ? h('span', { class: 'muted', text: '—' }) : null),
              h('td', { class: 'cell-text' }, w.open.length ? workSummary(w.open) : h('span', { class: 'muted', text: 'None' })),
              h('td', { class: 'cell-text' }, sub.contact_name ? h('div', { text: sub.contact_name }) : null,
                h('div', { class: 'cell-sub', text: [sub.phone, sub.email].filter(Boolean).join(' · ') || (sub.contact_name ? '' : 'No contact details') })));
          })))));
    };

    const sortSelect = h('select', { id: 'flt-subcons-sort', 'aria-label': 'Order', value: f.sort, onchange: (e) => { f.sort = e.target.value; draw(); } },
      h('option', { value: 'urgent', text: 'Most urgent action first' }), h('option', { value: 'busy', text: 'Most current work first' }), h('option', { value: 'name', text: 'Name A to Z' }));
    const draw = () => {
      sortSelect.hidden = f.mode !== 'directory';
      host.replaceChildren(f.mode === 'work' ? priorities() : (f.mode === 'capability' ? capability() : directory()));
    };
    draw();

    const modes = [['directory', 'Directory'], ['work', 'Work by priority'], ['capability', 'Find by capability']];
    const filters = f.mode === 'capability'
      ? h('div', { class: 'filters' },
        h('input', { id: 'flt-subcons-need', class: 'wide-input', type: 'search', value: f.need, 'aria-label': 'What the scope needs',
          placeholder: 'What does the scope need? e.g. structural, seismic assessment, geotechnical investigation',
          oninput: (e) => { f.need = e.target.value; draw(); } }))
      : h('div', { class: 'filters' },
        h('input', { id: 'flt-subcons-q', type: 'search', placeholder: 'Search name, discipline, capability, contact, or a record…', 'aria-label': 'Search subcontractors', value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } }),
        h('select', { id: 'flt-subcons-status', 'aria-label': 'Show', value: f.status, onchange: (e) => { f.status = e.target.value; draw(); } },
          h('option', { value: 'active', text: 'Active subcontractors' }), h('option', { value: 'engaged', text: 'On open work' }),
          h('option', { value: 'all', text: 'All, including inactive' }), h('option', { value: 'inactive', text: 'Inactive only' })),
        sortSelect);
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' },
        h('div', null, h('h1', { text: 'Subcontractors' }),
          h('p', { class: 'sub', text: 'Directory of subcontractors, and the projects, enquiries and expressions of interest each one is working on.' })),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', text: 'Export CSV', title: 'Download the subcontractors shown in the directory as a spreadsheet', onclick: () => exportSubconsCsv(visible()) }),
          h('button', { type: 'button', class: 'btn primary', text: '+ Add subcontractor', onclick: () => subconForm(null) }))),
      h('div', { class: 'tiles' },
        tile('In the directory', subs.length, null, subs.filter((sub) => !sub.active).length ? subs.filter((sub) => !sub.active).length + ' inactive' : null),
        tile('On open work', engaged.length, null, 'Projects, enquiries and EOIs'),
        tile('With an overdue action', late.length, late.length ? { kind: 'crit', text: 'Needs attention' } : (engaged.length ? { kind: 'good', text: 'None overdue' } : null)),
        tile('Not currently used', subs.filter((sub) => sub.active).length - engaged.filter((sub) => sub.active).length, null, 'Active, with no open work')),
      h('div', { class: 'tabs', role: 'tablist' }, modes.map((x) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(f.mode === x[0]), class: f.mode === x[0] ? 'active' : null, text: x[1],
        onclick: () => { f.mode = x[0]; renderMain(); },
      }))),
      filters,
      host);
  }

  // ------------------------------------------------------------------
  // Global search
  // ------------------------------------------------------------------

  function drawSearch(text) {
    const host = document.getElementById('search-results');
    if (!host) return;
    const q = text.trim().toLowerCase();
    if (!q) { host.hidden = true; host.replaceChildren(); return; }
    const hits = [];
    for (const r of S.data.records) {
      const refHit = r.ref.toLowerCase().includes(q);
      const xref = r.xrefs.find((x) => (x.system + ' ' + x.ref).toLowerCase().includes(q));
      const textHit = [r.title, r.organisation, r.contact_name, r.contact_info].join(' ').toLowerCase().includes(q);
      const subHit = !refHit && !xref && !textHit && subconNames(r).toLowerCase().includes(q);
      if (refHit || xref || textHit || subHit) hits.push({ r: r, rank: refHit ? 0 : (xref ? 1 : (textHit ? 2 : 3)), xref: xref });
    }
    hits.sort((a, b) => a.rank - b.rank || b.r.id - a.r.id);
    const subs = S.data.subcons.filter((sub) => [sub.ref, sub.name, sub.discipline, sub.contact_name, sub.email, sub.phone]
      .join(' ').toLowerCase().includes(q)).slice(0, 5).map((sub) => h('button', {
      type: 'button',
      onclick: () => {
        document.getElementById('global-search').value = '';
        drawSearch('');
        go('subcons', sub.ref);
      },
    },
    h('span', { class: 'ref', text: sub.ref }), ' ', h('span', { text: sub.name }),
    h('div', { class: 'meta', text: ['Subcontractor', sub.discipline, sub.contact_name, sub.active ? '' : 'Inactive'].filter(Boolean).join(' · ') })));
    const shown = subs.concat(hits.slice(0, 12).map((x) => h('button', {
      type: 'button',
      onclick: () => {
        document.getElementById('global-search').value = '';
        drawSearch('');
        go(viewForModule(x.r.module), x.r.ref);
      },
    },
    h('span', { class: 'ref', text: x.r.ref }), ' ', h('span', { text: x.r.title }),
    h('div', { class: 'meta', text: [mods()[x.r.module].singular, x.r.status, x.r.organisation, x.xref ? x.xref.system + ' ' + x.xref.ref : '',
      x.rank === 3 ? 'Subcon: ' + subconNames(x.r) : ''].filter(Boolean).join(' · ') }))));
    host.replaceChildren(...(shown.length ? shown : [h('div', { class: 'none', text: 'Nothing matches "' + text.trim() + '".' })]));
    host.hidden = false;
  }

  // ------------------------------------------------------------------
  // Administration
  // ------------------------------------------------------------------

  async function loadAdmin(tab) {
    if (!isAdmin()) return;
    try {
      if (tab === 'users') S.admin.users = (await api('GET', '/api/admin/users')).users;
      else if (tab === 'system') {
        const before = JSON.stringify(S.admin.system);
        S.admin.system = await api('GET', '/api/admin/system');
        if (before === JSON.stringify(S.admin.system)) return;
      } else if (tab === 'log') S.admin.audit = (await api('GET', '/api/admin/audit')).audit;
      else return;
      if (S.view === 'admin' && S.adminTab === tab) renderMain();
    } catch (e) { /* shown as "loading" until the next attempt */ }
  }

  function viewAdmin() {
    const tabs = [['users', 'People & logins'], ['system', 'System & online access'], ['log', 'Security log'], ['settings', 'Settings']];
    let body;
    if (S.adminTab === 'users') body = adminUsers();
    else if (S.adminTab === 'system') body = adminSystem();
    else if (S.adminTab === 'log') body = adminLog();
    else body = adminSettings();
    return h('div', { class: 'view' },
      h('div', { class: 'view-head' }, h('div', null, h('h1', { text: 'Admin' }), h('p', { class: 'sub', text: 'Logins, access, backups and settings. Administrators only.' }))),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map((x) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(S.adminTab === x[0]), class: S.adminTab === x[0] ? 'active' : null, text: x[1],
        onclick: () => { S.adminTab = x[0]; renderMain(); loadAdmin(x[0]); },
      }))),
      body);
  }

  function roleOptions() {
    return Object.keys(S.data.meta.roles).map((k) => ({ value: k, label: S.data.meta.roles[k] }));
  }

  function adminUsers() {
    const users = S.admin.users;
    if (!users) return h('p', { class: 'muted', text: 'Loading…' });
    const rows = users.map((u) => h('tr', null,
      h('td', null, h('div', { class: 'cell-title', text: u.full_name }), h('div', { class: 'cell-sub', text: u.username })),
      h('td', { text: S.data.meta.roles[u.role] || u.role }),
      h('td', null, !u.active ? h('span', { class: 'pill dead', text: 'Deactivated' })
        : (u.must_change ? h('span', { class: 'pill waiting', text: 'Temporary password' }) : h('span', { class: 'pill done', text: 'Active' }))),
      h('td', { class: 'nowrap', text: u.last_login ? fmtDateTime(u.last_login) : 'Never' }),
      h('td', { class: 'nowrap' },
        h('button', { type: 'button', class: 'btn quiet', text: 'Edit', onclick: () => userForm(u) }),
        u.id === S.me.id ? null : h('button', {
          type: 'button', class: 'btn quiet', text: 'Reset password',
          onclick: () => confirmDialog('Reset password for ' + u.full_name + '?', 'They will be signed out everywhere and will need the new temporary password to sign in.', 'Reset password', async () => {
            const res = await api('POST', '/api/admin/users/' + u.id + '/reset-password', {});
            await loadAdmin('users');
            setTimeout(() => secretDialog('Temporary password for ' + u.full_name,
              'Give this to ' + u.full_name + ' privately (username: ' + u.username + '). They will choose their own password when they sign in. It will not be shown again.', res.temp_password), 0);
          }),
        }),
        u.id === S.me.id ? null : h('button', {
          type: 'button', class: 'btn quiet' + (u.active ? ' dangerous' : ''), text: u.active ? 'Deactivate' : 'Reactivate',
          onclick: () => confirmDialog((u.active ? 'Deactivate ' : 'Reactivate ') + u.full_name + '?',
            u.active ? 'They will be signed out and unable to sign in. Their records, tasks and history are kept.' : 'They will be able to sign in again with their existing password.',
            u.active ? 'Deactivate' : 'Reactivate', async () => {
              await api('PUT', '/api/admin/users/' + u.id, { active: !u.active });
              await refresh();
            }, u.active),
        }))));
    return h('div', null,
      h('div', { class: 'view-head' },
        h('p', { class: 'sub', text: 'Each person signs in with their own username and password and sees their own tasks. Roles decide who can open the Finance and Office Admin sections.' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', text: '+ Add person', onclick: () => userForm(null) }))),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Person', 'Role', 'Login status', 'Last signed in', ''].map((x) => h('th', { scope: 'col', text: x })))),
        h('tbody', null, rows))));
  }

  function userForm(u) {
    const fields = [];
    if (!u) fields.push({ name: 'username', label: 'Username', required: true, maxlength: 32, placeholder: 'e.g. jsmith', hint: 'Lowercase letters, numbers, dots or dashes.' });
    fields.push({ name: 'full_name', label: 'Full name', required: true, maxlength: 100, value: u ? u.full_name : '' });
    fields.push({ name: 'role', label: 'Role', type: 'select', full: !!u, options: roleOptions(), value: u ? u.role : 'staff' });
    const access = S.data.meta.role_access || {};
    fields.push({ type: 'custom', node: h('dl', { class: 'role-list' }, Object.keys(S.data.meta.roles).map((key) => [
      h('dt', { text: S.data.meta.roles[key] }), h('dd', { text: access[key] || '' })])) });
    formDialog({
      title: u ? 'Edit ' + u.full_name : 'Add a person',
      intro: u ? 'Username: ' + u.username : 'InSys creates a temporary password for you to pass on.',
      fields: fields, submitLabel: u ? 'Save' : 'Create login',
      onSubmit: async (v) => {
        if (u) {
          await api('PUT', '/api/admin/users/' + u.id, { full_name: v.full_name, role: v.role });
          await refresh();
          toast('Saved.');
        } else {
          const res = await api('POST', '/api/admin/users', { username: v.username, full_name: v.full_name, role: v.role });
          await refresh();
          setTimeout(() => secretDialog('Login created for ' + res.user.full_name,
            'Username: ' + res.user.username + '. Give them this temporary password privately. They will choose their own when they first sign in. It will not be shown again.', res.temp_password), 0);
        }
      },
    });
  }

  function adminSystem() {
    const sys = S.admin.system;
    if (!sys) return h('p', { class: 'muted', text: 'Loading…' });
    let online;
    if (sys.public_url) {
      const copy = h('button', {
        type: 'button', class: 'btn small', text: 'Copy address',
        onclick: async () => { try { await navigator.clipboard.writeText(sys.public_url); copy.textContent = 'Copied'; } catch (e) { toast('Select the address and copy it.', true); } },
      });
      online = [h('span', { class: 'pill done', text: 'On' }), ' ', h('a', { href: sys.public_url, target: '_blank', rel: 'noopener noreferrer', text: sys.public_url }), ' ', copy,
        h('div', { class: 'small muted', text: 'Share this address with your team. It changes each time InSys is restarted.' })];
    } else if (sys.online_requested) {
      online = [h('span', { class: 'pill waiting', text: sys.tunnel_status === 'unavailable' ? 'Unavailable' : 'Connecting' }),
        h('div', { class: 'small muted', text: sys.tunnel_status === 'unavailable'
          ? 'The online access tool could not be started. Look at the InSys window on the host computer for details.'
          : 'Setting up the secure connection. This normally takes a few seconds.' })];
    } else {
      online = [h('span', { class: 'pill dead', text: 'Off' }),
        h('div', { class: 'small muted', text: sys.packaged
          ? 'InSys is only reachable on the host computer. To use it from anywhere, close InSys, start it again and choose 3 (Online).'
          : 'InSys is only reachable on the host computer. To use it from anywhere, close InSys and start it with "Start-InSys-Online.bat".' })];
    }
    return h('div', null,
      card('Where InSys is running', null, h('div', { class: 'kv' },
        h('div', { class: 'k', text: 'On the host computer' }), h('div', { class: 'v', text: sys.local_url }),
        h('div', { class: 'k', text: 'Over the internet' }), h('div', { class: 'v' }, online),
        h('div', { class: 'k', text: 'Data folder' }), h('div', { class: 'v', text: sys.data_dir }),
        h('div', { class: 'k', text: 'Version' }), h('div', { class: 'v', text: 'InSys ' + sys.app_version + ' (Python ' + sys.python + ' on ' + sys.platform + ')' }))),
      card('Backups', null,
        h('p', { class: 'muted', text: 'InSys saves an automatic backup into the "backups" folder inside the data folder once a day and keeps the latest 20. ' +
          (sys.last_backup_hours === null ? 'No automatic backup has been made yet.' : 'The most recent one was made ' + (sys.last_backup_hours < 1 ? 'less than an hour' : 'about ' + plural(Math.round(sys.last_backup_hours), 'hour')) + ' ago.') }),
        h('p', { style: { marginTop: '10px' } }, h('a', { class: 'btn', href: '/api/admin/backup', download: '', text: 'Download a backup now' })),
        h('p', { class: 'small muted', style: { marginTop: '8px' }, text: 'The backup file holds all InSys data, including (scrambled) passwords. Store it somewhere safe.' })),
      transferCard());
  }

  /** Administrator only: take the whole database to another InSys, or bring one in. */
  function transferCard() {
    const picker = h('input', {
      id: 'transfer-file', type: 'file', accept: '.db', hidden: true, 'aria-label': 'Database file to load',
      onchange: () => {
        const file = picker.files && picker.files[0];
        picker.value = '';
        if (!file) return;
        confirmDialog('Load "' + file.name + '" into this InSys?',
          'Everything in this InSys now will be replaced by the contents of the file. A copy of the current data is saved in the backups folder first. ' +
          'Everyone, including you, will be signed out and must sign in with a username and password from the InSys the file came from.',
          'Replace the data with this file', async () => {
            let res;
            try {
              res = await fetch('/api/admin/restore', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store', body: file,
                headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': S.csrf || '' },
              });
            } catch (e) {
              throw new Error('The file could not be sent. Check the connection and that the file is under 300 MB.');
            }
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            if (!res.ok) throw new Error((data && data.error) || 'The file could not be loaded (' + res.status + ').');
            setTimeout(() => signedOut('Database loaded: ' + plural(data.records, 'record') + ' and ' + plural(data.users, 'login') +
              '. Sign in with a username and password from the InSys the file came from.'), 0);
          }, true);
      },
    });
    return card('Transfer to another computer or office', 'Administrators only',
      h('p', { class: 'muted', text: 'To host InSys somewhere else, download the whole database as one file, copy it to the other computer, and load it into the InSys running there (Admin, System & online access, "Load a database file"). ' +
        'The other InSys then has all the records, history, subcontractors and logins, and runs independently on its own network.' }),
      h('p', { style: { marginTop: '10px' } },
        h('a', { class: 'btn primary', href: '/api/admin/backup', download: '', text: 'Download database' }), ' ',
        h('button', { type: 'button', class: 'btn', text: 'Load a database file…', onclick: () => picker.click() }), picker),
      h('p', { class: 'small muted', style: { marginTop: '8px' }, text: 'After the copy, the two systems are separate: changes made in one do not appear in the other. Loading a file replaces what is here; it does not merge.' }));
  }

  function adminLog() {
    const items = S.admin.audit;
    if (!items) return h('p', { class: 'muted', text: 'Loading…' });
    const names = {
      setup: 'InSys set up', login_ok: 'Signed in', login_failed: 'Failed sign-in', password_changed: 'Password changed',
      password_reset: 'Password reset', user_created: 'Login created', user_updated: 'Login changed',
      record_deleted: 'Record deleted', backup_downloaded: 'Backup downloaded', settings_changed: 'Settings changed',
      upgraded: 'InSys upgraded', subcon_deleted: 'Subcontractor deleted',
      record_restored: 'Record restored', database_loaded: 'Database loaded',
    };
    if (!items.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: 'Nothing logged yet.' }));
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['When', 'Event', 'Who', 'Details', 'From'].map((x) => h('th', { scope: 'col', text: x })))),
      h('tbody', null, items.map((a) => h('tr', null,
        h('td', { class: 'nowrap', text: fmtDateTime(a.at) }),
        h('td', null, a.event === 'login_failed' ? h('span', { class: 'chip overdue' }, h('span', { class: 'icon', text: '!', 'aria-hidden': 'true' }), names[a.event]) : (names[a.event] || a.event)),
        h('td', { text: a.username || '—' }),
        h('td', { class: 'cell-text', text: a.detail }),
        h('td', { class: 'nowrap muted', text: a.ip }))))));
  }

  function adminSettings() {
    return card('Organisation', null,
      h('div', { class: 'kv' },
        h('div', { class: 'k', text: 'Organisation name' }), h('div', { class: 'v', text: S.data.meta.org_name || 'Not set' }),
        h('div', { class: 'k', text: 'Currency label' }), h('div', { class: 'v', text: S.data.meta.currency || 'Not set' })),
      h('p', { style: { marginTop: '12px' } }, h('button', {
        type: 'button', class: 'btn', text: 'Change',
        onclick: () => formDialog({
          title: 'Organisation settings',
          fields: [
            { name: 'org_name', label: 'Organisation name', full: true, maxlength: 100, value: S.data.meta.org_name, hint: 'Shown in the browser tab and the sidebar.' },
            { name: 'currency', label: 'Currency label', maxlength: 6, value: S.data.meta.currency, placeholder: 'e.g. USD, GBP, AUD', hint: 'Shown next to amounts.' },
          ],
          onSubmit: async (v) => { await api('PUT', '/api/admin/settings', v); await refresh(); toast('Settings saved.'); },
        }),
      })));
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------

  (async function boot() {
    try {
      const res = await api('GET', '/api/me');
      S.me = res.user;
      S.csrf = res.csrf;
      if (res.user.must_change) showForcePassword();
      else await startApp();
    } catch (e) {
      if (e.status === 401) return;  // the sign-in screen is already showing
      if (!document.getElementById('login-form')) {
        root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, brand(),
          h('h1', { text: 'InSys is not reachable' }),
          h('p', { class: 'sub', text: e.message }),
          h('button', { type: 'button', class: 'btn primary', text: 'Try again', onclick: () => location.reload() }))));
      }
    }
  })();

})();
