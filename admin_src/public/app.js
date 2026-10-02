'use strict';

const API = '/api/v1';
const $ = (id) => document.getElementById(id);
const state = { token: null, user: null, stations: [], detail: null, hours: 24, timer: null };

try { state.token = sessionStorage.getItem('rg_token'); } catch { /* storage unavailable */ }

// ── Helpers ────────────────────────────────────────────────────────────────

// Builds DOM nodes without innerHTML, so station-supplied text is never parsed as markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child.nodeType ? child : String(child));
  }
  return el;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/auth/login') {
    showLogin();
    throw new Error('Your session has expired. Sign in again.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data && data.error) || {};
    const details = (err.details || []).map((d) => `${d.field} ${d.message}`).join('; ');
    throw new Error(details || err.message || `Request failed (${res.status})`);
  }
  return data;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

const fail = (err) => toast(err.message);

function formatBytes(n) {
  if (!n) return '0 MB';
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
}

const formatNumber = (n) => Number(n).toLocaleString();
const formatDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');
const isAdmin = () => state.user && state.user.role === 'admin';

function tiles(container, items) {
  container.replaceChildren(...items.map(([label, value]) => h('div', { class: 'tile' }, h('b', {}, value), h('span', {}, label))));
}

// ── Session ────────────────────────────────────────────────────────────────

function showLogin() {
  state.token = null;
  try { sessionStorage.removeItem('rg_token'); } catch { /* ignore */ }
  clearInterval(state.timer);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('app').hidden = true;
  $('login').hidden = false;
}

async function start() {
  if (!state.token) return showLogin();
  try {
    state.user = await api('GET', '/auth/me');
  } catch {
    return showLogin();
  }
  $('login').hidden = true;
  $('app').hidden = false;
  $('whoami').textContent = state.user.username;
  for (const el of document.querySelectorAll('[data-admin]')) el.hidden = !isAdmin();
  await refresh();
  if (isAdmin()) showUpdateNotice().catch(() => {});
  clearInterval(state.timer);
  state.timer = setInterval(() => refresh().catch(() => {}), 5000);
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $('loginError').textContent = '';
  try {
    const session = await api('POST', '/auth/login', { username: form.get('username'), password: form.get('password') });
    state.token = session.token;
    try { sessionStorage.setItem('rg_token', session.token); } catch { /* ignore */ }
    event.target.reset();
    await start();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  showLogin();
});

async function showUpdateNotice() {
  const version = await api('GET', '/system/version');
  const notice = $('updateNotice');
  notice.hidden = version.update_available !== true;
  if (notice.hidden) return;
  notice.replaceChildren(
    h('strong', {}, 'A newer version of the gateway is available. '),
    h('button', { class: 'link', onclick: () => document.querySelector('[data-tab=updates]').click() }, 'Open Updates'),
    ' to install it or to switch on automatic updates.'
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────

$('tabs').addEventListener('click', (event) => {
  const tab = event.target.dataset.tab;
  if (!tab) return;
  for (const button of $('tabs').querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button === event.target));
    $(`tab-${button.dataset.tab}`).hidden = button !== event.target;
  }
  if (tab === 'keys') loadKeys().catch(fail);
  if (tab === 'users') loadUsers().catch(fail);
  if (tab === 'servers') loadServers().catch(fail);
  if (tab === 'updates') loadUpdates(true).catch(fail);
});

// ── Stations ───────────────────────────────────────────────────────────────

async function refresh() {
  const query = $('search').value.trim();
  const [overview, list] = await Promise.all([
    api('GET', '/overview'),
    api('GET', `/stations?limit=500${query ? `&q=${encodeURIComponent(query)}` : ''}`),
  ]);
  state.stations = list.stations;
  // Tenants see how much of their station allowance is used.
  const limit = state.user.max_stations;
  $('quota').textContent = isAdmin() ? '' : `${list.total} of ${limit} station${limit === 1 ? '' : 's'} used`;
  $('newStation').hidden = !isAdmin() && !query && list.total >= limit;
  tiles($('tiles'), [
    ['Listeners now', formatNumber(overview.listeners_now)],
    ['Stations on air', `${overview.stations_on_air} of ${overview.stations}`],
    ['Data sent today', formatBytes(overview.bytes_today)],
    ['Data sent this month', formatBytes(overview.bytes_this_month)],
  ]);
  renderStations();
}

function statusOf(station) {
  if (!station.is_active) return ['off', 'Suspended'];
  if (station.live.source_offline) return ['off', 'Source offline'];
  if (!station.live.online) return ['', 'Standby'];
  return station.live.source === 'backup' ? ['backup', 'On air (backup)'] : ['live', 'On air'];
}

function renderStations() {
  $('stationsEmpty').hidden = state.stations.length > 0;
  $('stationRows').replaceChildren(...state.stations.map((station) => {
    const [kind, label] = statusOf(station);
    const live = station.live;
    const playing = [live.artist, live.title].filter(Boolean).join(' - ');
    const art = live.artwork || station.artwork_url;
    return h('tr', {},
      h('td', {}, h('div', { class: 'station-name' }, station.name), h('code', {}, `/${station.slug}`)),
      h('td', {}, h('span', { class: `status ${kind}` }, label),
        // Name the servers that get no audio for this station, with the reason on hover.
        live.no_audio_on.length > 0 && h('small', { title: live.no_audio_on.map((n) => `${n.server}: ${n.reason || 'no audio'}`).join('\n') },
          live.source_offline ? (live.no_audio_on[0].reason || '').slice(0, 60) : `No audio on ${live.no_audio_on.map((n) => n.server).join(', ')}`)),
      h('td', { class: 'num' }, formatNumber(live.listeners) + (station.max_listeners ? ` / ${formatNumber(station.max_listeners)}` : '')),
      h('td', { class: 'wrap' }, art && h('img', { class: 'art', src: art, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }), playing || h('span', { class: 'muted' }, 'No title')),
      h('td', {}, h('code', {}, station.stream_url)),
      h('td', { class: 'row-actions' },
        h('button', { onclick: () => openDetail(station).catch(fail) }, 'Stats'),
        h('button', { onclick: () => openStationForm(station) }, 'Edit'),
        isAdmin() && h('button', { onclick: () => toggleSuspend(station) }, station.is_active ? 'Suspend' : 'Resume'),
        h('button', { class: 'danger', onclick: () => removeStation(station) }, 'Delete'))
    );
  }));
}

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch(fail), 250);
});

const STATION_FIELDS = ['name', 'slug', 'primary_url', 'backup_url', 'metadata_url', 'artwork_url', 'max_listeners'];

function openStationForm(station) {
  const form = $('stationForm');
  form.reset();
  form.dataset.slug = station ? station.slug : '';
  $('stationDialogTitle').textContent = station ? `Edit ${station.name}` : 'Add station';
  $('stationError').textContent = '';
  form.elements.slug.disabled = Boolean(station);
  if (station) for (const field of STATION_FIELDS) form.elements[field].value = station[field] ?? '';
  $('stationDialog').showModal();
}

$('newStation').addEventListener('click', () => openStationForm(null));
$('stationCancel').addEventListener('click', () => $('stationDialog').close());

$('stationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const editing = form.dataset.slug;
  const body = {};
  for (const field of STATION_FIELDS) {
    if (field === 'slug' && editing) continue;
    if (field === 'max_listeners') {
      if (isAdmin()) body.max_listeners = Number(form.elements.max_listeners.value) || 0;
    } else body[field] = form.elements[field].value.trim();
  }
  try {
    await api(editing ? 'PATCH' : 'POST', editing ? `/stations/${editing}` : '/stations', body);
    $('stationDialog').close();
    toast(editing ? 'Station updated' : 'Station added');
    await refresh();
  } catch (err) {
    $('stationError').textContent = err.message;
  }
});

async function toggleSuspend(station) {
  const action = station.is_active ? 'suspend' : 'unsuspend';
  if (station.is_active && !confirm(`Suspend ${station.name}? Its listeners will be disconnected.`)) return;
  await api('POST', `/stations/${station.slug}/${action}`).then(refresh).catch(fail);
}

async function removeStation(station) {
  if (!confirm(`Delete ${station.name}? Its configuration and all of its statistics are removed permanently.`)) return;
  await api('DELETE', `/stations/${station.slug}`).then(refresh).catch(fail);
}

// ── Station detail and charts ──────────────────────────────────────────────

const STEP_MS = { minute: 60000, hour: 3600000, day: 86400000 };

// The API omits empty buckets; charts need them back as zeros.
function fillGaps(series) {
  const step = STEP_MS[series.interval];
  const byTime = new Map(series.points.map((p) => [Math.floor(Date.parse(p.t) / step) * step, p]));
  const out = [];
  const end = Date.parse(series.to);
  for (let t = Math.floor(Date.parse(series.from) / step) * step; t <= end; t += step) {
    out.push(byTime.get(t) || { t: new Date(t).toISOString(), bytes: 0, peak_listeners: 0, avg_listeners: 0, sessions: 0, listener_hours: 0 });
  }
  return out;
}

function timeLabel(iso, interval) {
  const date = new Date(iso);
  return interval === 'day'
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function niceMax(value) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= value);
}

const tooltip = $('tooltip');
function showTip(event, lines) {
  tooltip.replaceChildren(...lines.flatMap((line, i) => (i ? [h('br'), line] : [h('b', {}, line)])));
  tooltip.hidden = false;
  const box = tooltip.getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - box.width - 8);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY - box.height - 12)}px`;
}
const hideTip = () => { tooltip.hidden = true; };

function drawChart(container, points, interval, { kind, value, format }) {
  if (!points.some((p) => value(p) > 0)) {
    container.replaceChildren(h('div', { class: 'none' }, 'No activity in this period.'));
    return;
  }
  const W = Math.max(320, container.clientWidth || 900), H = 180, left = 60, right = 8, top = 8, bottom = 22;
  const innerW = W - left - right, innerH = H - top - bottom;
  const max = niceMax(Math.max(...points.map(value)));
  const x = (i) => left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => top + innerH - (v / max) * innerH;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  for (const fraction of [0, 0.5, 1]) {
    const gy = y(max * fraction);
    root.append(svg('line', { class: 'grid', x1: left, x2: W - right, y1: gy, y2: gy }));
    const label = svg('text', { class: 'axis', x: left - 6, y: gy + 4, 'text-anchor': 'end' });
    label.textContent = format(max * fraction);
    root.append(label);
  }
  for (const i of [0, Math.floor((points.length - 1) / 2), points.length - 1]) {
    const label = svg('text', { class: 'axis', x: x(i), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' });
    label.textContent = timeLabel(points[i].t, interval);
    root.append(label);
  }

  const slot = innerW / points.length;
  if (kind === 'bar') {
    const gap = slot > 6 ? 2 : 0;
    points.forEach((p, i) => {
      const v = value(p);
      if (v <= 0) return;
      const height = Math.max(1, top + innerH - y(v));
      root.append(svg('rect', { class: 'bar', x: left + i * slot + gap / 2, y: top + innerH - height, width: Math.max(1, slot - gap), height, rx: Math.min(4, slot / 3) }));
    });
  } else {
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(value(p)).toFixed(1)}`).join('');
    root.append(svg('path', { class: 'area', d: `${path}L${x(points.length - 1)},${top + innerH}L${x(0)},${top + innerH}Z` }));
    root.append(svg('path', { class: 'line', d: path }));
  }

  const cross = svg('line', { class: 'cross', y1: top, y2: top + innerH, visibility: 'hidden' });
  root.append(cross);
  root.addEventListener('pointermove', (event) => {
    const box = root.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const i = kind === 'bar'
      ? Math.min(points.length - 1, Math.max(0, Math.floor((px - left) / slot)))
      : Math.min(points.length - 1, Math.max(0, Math.round(((px - left) / innerW) * (points.length - 1))));
    const cx = kind === 'bar' ? left + (i + 0.5) * slot : x(i);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    showTip(event, [format(value(points[i])), timeLabel(points[i].t, interval)]);
  });
  root.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  container.replaceChildren(root);
}

async function openDetail(station) {
  state.detail = station;
  $('detailTitle').textContent = station.name;
  const stream = station.stream_url;
  $('detailLinks').replaceChildren(
    h('div', {}, 'Stream: ', h('code', {}, stream)),
    h('div', {}, 'Playlists: ', h('a', { href: station.playlist_urls.m3u }, 'M3U'), ' · ', h('a', { href: station.playlist_urls.pls }, 'PLS')),
    h('audio', { controls: true, preload: 'none', src: stream })
  );
  // The tooltip must live inside the modal to appear above it.
  $('detailDialog').append(tooltip);
  if (!$('detailDialog').open) $('detailDialog').showModal();
  await loadDetail();
}

async function loadDetail() {
  const station = state.detail;
  const to = new Date();
  const from = new Date(to.getTime() - state.hours * 3600000);
  const series = await api('GET', `/stations/${station.slug}/stats?from=${from.toISOString()}&to=${to.toISOString()}`);
  const points = fillGaps(series);
  tiles($('detailTiles'), [
    ['Listeners now', formatNumber(station.live.listeners)],
    ['Peak listeners', formatNumber(series.totals.peak_listeners)],
    ['Connections', formatNumber(series.totals.sessions)],
    ['Listening hours', formatNumber(series.totals.listener_hours)],
    ['Data sent', formatBytes(series.totals.bytes)],
  ]);
  drawChart($('chartListeners'), points, series.interval, { kind: 'line', value: (p) => p.peak_listeners, format: (v) => formatNumber(Math.round(v)) });
  drawChart($('chartBytes'), points, series.interval, { kind: 'bar', value: (p) => p.bytes, format: formatBytes });
  $('detailTable').replaceChildren(
    h('thead', {}, h('tr', {}, ['Time', 'Peak listeners', 'Average listeners', 'Connections', 'Data sent'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
    h('tbody', {}, series.points.slice().reverse().map((p) => h('tr', {},
      h('td', {}, timeLabel(p.t, series.interval)),
      h('td', { class: 'num' }, formatNumber(p.peak_listeners)),
      h('td', { class: 'num' }, p.avg_listeners.toFixed(2)),
      h('td', { class: 'num' }, formatNumber(p.sessions)),
      h('td', { class: 'num' }, formatBytes(p.bytes)))))
  );
}

$('rangeButtons').addEventListener('click', (event) => {
  const hours = Number(event.target.dataset.hours);
  if (!hours) return;
  state.hours = hours;
  for (const button of $('rangeButtons').children) button.setAttribute('aria-pressed', String(button === event.target));
  loadDetail().catch(fail);
});

$('detailClose').addEventListener('click', () => $('detailDialog').close());
$('detailDialog').addEventListener('close', () => {
  hideTip();
  for (const audio of $('detailLinks').querySelectorAll('audio')) audio.pause();
});

// ── API keys ───────────────────────────────────────────────────────────────

async function loadKeys() {
  const { api_keys: keys } = await api('GET', `/api-keys${isAdmin() ? '?user_id=all' : ''}`);
  $('keyRows').replaceChildren(...keys.map((key) => h('tr', {},
    h('td', {}, key.name),
    h('td', {}, h('code', {}, `${key.key_prefix}…`)),
    h('td', {}, key.username),
    h('td', {}, formatDate(key.last_used_at)),
    h('td', {}, formatDate(key.created_at)),
    h('td', { class: 'row-actions' }, h('button', { class: 'danger', onclick: () => revokeKey(key) }, 'Revoke'))
  )));
}

$('keyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const created = await api('POST', '/api-keys', { name: new FormData(event.target).get('name') });
    $('newKey').replaceChildren('Copy this key now. It will not be shown again: ', h('code', {}, created.key));
    $('newKey').hidden = false;
    event.target.reset();
    await loadKeys();
  } catch (err) {
    fail(err);
  }
});

async function revokeKey(key) {
  if (!confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) return;
  await api('DELETE', `/api-keys/${key.id}`).then(loadKeys).catch(fail);
}

// ── Accounts ───────────────────────────────────────────────────────────────

async function loadUsers() {
  const { users } = await api('GET', '/users');
  $('userRows').replaceChildren(...users.map((user) => h('tr', {},
    h('td', {}, user.username),
    h('td', {}, user.role === 'admin' ? 'Administrator' : 'Tenant'),
    h('td', {}, user.external_id || h('span', { class: 'muted' }, 'None')),
    h('td', { class: 'num' }, user.role === 'admin' ? user.station_count : `${user.station_count} of ${user.max_stations}`),
    h('td', {}, h('span', { class: `status ${user.is_active ? 'live' : 'off'}` }, user.is_active ? 'Active' : 'Disabled')),
    h('td', { class: 'row-actions' }, user.id !== state.user.id && [
      user.role !== 'admin' && h('button', { onclick: () => changeStationLimit(user) }, 'Station limit'),
      h('button', { onclick: () => api('PATCH', `/users/${user.id}`, { is_active: !user.is_active }).then(loadUsers).catch(fail) }, user.is_active ? 'Disable' : 'Enable'),
      h('button', { class: 'danger', onclick: () => removeUser(user) }, 'Delete'),
    ])
  )));
}

$('userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = { username: form.get('username').trim() };
  if (form.get('password')) body.password = form.get('password');
  if (form.get('external_id').trim()) body.external_id = form.get('external_id').trim();
  if (form.get('max_stations') !== '') body.max_stations = Number(form.get('max_stations'));
  try {
    await api('POST', '/users', body);
    event.target.reset();
    toast('Account added');
    await loadUsers();
  } catch (err) {
    fail(err);
  }
});

async function removeUser(user) {
  if (!confirm(`Delete ${user.username}? Their ${user.station_count} station(s), keys and statistics are removed permanently.`)) return;
  await api('DELETE', `/users/${user.id}`).then(loadUsers).catch(fail);
}

async function changeStationLimit(user) {
  const answer = prompt(`How many stations may ${user.username} create?`, user.max_stations);
  if (answer === null) return;
  const limit = Number(answer);
  if (!Number.isInteger(limit) || limit < 0) return toast('Enter a whole number, 0 or more.');
  await api('PATCH', `/users/${user.id}`, { max_stations: limit }).then(loadUsers).catch(fail);
}

// ── Updates ────────────────────────────────────────────────────────────────

const short = (sha) => (sha ? sha.slice(0, 7) : 'Unknown');
const UPDATE_STATES = { running: 'Installing', waiting: 'Waiting', ok: 'Last run', failed: 'Failed', idle: '' };

async function loadUpdates(fillForm) {
  const v = await api('GET', '/system/version');
  const up = v.updater;
  tiles($('updateTiles'), [
    ['Running version', short(v.installed)],
    ['Latest version', short(v.latest)],
    ['Status', v.update_available === true ? 'Update available' : v.update_available === false ? 'Up to date' : 'Unknown'],
    ['Automatic updates', v.settings.auto ? `Daily at ${v.settings.time}` : 'Off'],
  ]);

  // What the updater on the server is doing or last did, and anything in its way.
  const lines = [];
  if (!v.enabled) lines.push('This server is not watching a repository for updates (UPDATE_REPO is not set).');
  else if (v.error) lines.push(`Could not check for updates: ${v.error}.`);
  else if (v.update_available === null && !v.installed) lines.push('The running version is unknown because the images were built on this server, so updates cannot be detected here.');
  if (!up.scheduler_running) lines.push('The update scheduler is not running on the server, so nothing is installed by itself. On the server, in the installation directory, run: ./scripts/update.sh schedule install');
  if (up.install_pending) lines.push('An update has been requested and will start within 5 minutes.');
  if (up.message && UPDATE_STATES[up.state]) lines.push(`${UPDATE_STATES[up.state]}: ${up.message}${up.updated_at ? ` (${formatDate(up.updated_at)})` : ''}`);
  const stateBox = $('updateState');
  stateBox.hidden = lines.length === 0;
  stateBox.className = `notice${up.state === 'failed' || !up.scheduler_running ? ' alert' : ''}`;
  stateBox.replaceChildren(...lines.flatMap((line, i) => (i ? [h('br'), line] : [line])));

  if (fillForm) {
    $('updateForm').elements.auto.checked = v.settings.auto;
    $('updateForm').elements.time.value = v.settings.time;
  }
  $('updateClock').textContent = up.server_time
    ? `On the server's own clock, which now reads ${up.server_time}${up.server_zone ? ` ${up.server_zone}` : ''}.`
    : "On the server's own clock.";
  const busy = up.install_pending || up.state === 'running';
  $('installNow').disabled = v.update_available !== true || busy || !up.scheduler_running;
  $('installText').textContent = v.update_available === true
    ? `Version ${short(v.latest)} is available. Installing it backs up the database, downloads the new version and restarts the services that changed; listeners are disconnected for a few seconds and reconnect. It starts within 5 minutes of pressing the button.`
    : v.update_available === false ? 'This server is on the latest version.' : 'It is not known whether a newer version exists.';
  // Keep the page current while an update is under way.
  clearTimeout(loadUpdates.timer);
  if (busy && !$('tab-updates').hidden) loadUpdates.timer = setTimeout(() => loadUpdates(false).catch(() => {}), 10000);
}

$('updateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('updateError').textContent = '';
  const form = event.target.elements;
  try {
    await api('PUT', '/system/update-settings', { auto: form.auto.checked, time: form.time.value });
    toast(form.auto.checked ? `Automatic updates are on, daily at ${form.time.value}` : 'Automatic updates are off');
    await loadUpdates(true);
  } catch (err) {
    $('updateError').textContent = err.message;
  }
});

$('installNow').addEventListener('click', async () => {
  if (!confirm('Install the update now? Listeners are disconnected for a few seconds while services restart.')) return;
  try {
    await api('POST', '/system/update');
    toast('Update requested; it starts within 5 minutes');
    await loadUpdates(false);
    showUpdateNotice().catch(() => {});
  } catch (err) {
    fail(err);
  }
});

$('checkNow').addEventListener('click', async () => {
  await api('GET', '/system/version?refresh').catch(fail);
  await loadUpdates(false).catch(fail);
  showUpdateNotice().catch(() => {});
  toast('Checked for updates');
});

// ── Streaming servers ──────────────────────────────────────────────────────

const SERVER_STATES = { UP: ['live', 'Healthy'], DOWN: ['off', 'Unreachable'], DRAIN: ['backup', 'Draining'], MAINT: ['', 'Maintenance'], NOLB: ['backup', 'Stopping'] };

const formatGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
const LEVEL_WORDS = { ok: '', warning: ' (high)', critical: ' (critical)' };

// A percentage with its level spelled out, so the colour is never the only cue.
function usageCell(part, detail) {
  if (!part || part.percent === null) return h('span', { class: 'muted' }, 'No data');
  return h('span', { class: `usage ${part.status}` }, `${Math.round(part.percent)}%${LEVEL_WORDS[part.status]}`, detail && h('small', {}, detail));
}

async function loadServers() {
  const [{ managed }, report] = await Promise.all([api('GET', '/servers'), api('GET', '/capacity')]);
  const servers = report.servers;
  $('serversUnmanaged').hidden = managed;
  const notice = $('capacityNotice');
  notice.hidden = report.reasons.length === 0;
  notice.className = `notice${report.add_server_recommended ? ' alert' : ''}`;
  notice.replaceChildren(
    h('strong', {}, report.add_server_recommended ? 'Capacity is running low: consider adding a streaming server. ' : 'Worth a look: '),
    report.reasons.join('; ') + '.'
  );
  $('serverRows').replaceChildren(...servers.map((server) => {
    const direct = server.mode === 'direct';
    let [kind, label] = SERVER_STATES[server.state] || ['', managed ? 'Pending' : 'Not applied'];
    if (direct && server.state === 'DOWN') label = 'Not reporting';
    const silent = server.audio && server.audio.status === 'no_audio';
    if (silent) [kind, label] = ['off', 'No audio'];
    const res = server.resources;
    return h('tr', {},
      h('td', {}, h('span', { class: 'station-name' }, server.name), server.is_builtin && h('span', { class: 'muted' }, ' (this server)')),
      h('td', {}, h('code', {}, direct || server.is_builtin ? server.host : `${server.host}:${server.port}`), direct && h('small', {}, 'Edge server, own DNS record')),
      h('td', { class: silent ? 'wrap' : '' }, h('span', { class: `status ${kind}` }, label),
        silent && h('small', {}, `${server.audio.forced ? 'Set by an administrator' : 'Detected by the server'}: ${server.audio.reason || 'no reason given'}`)),
      h('td', { class: 'num' }, server.connections == null ? '' : formatNumber(server.connections)),
      h('td', {}, usageCell(res && res.cpu, res && `${res.cpu.cores} cores`)),
      h('td', {}, usageCell(res && res.memory, res && `of ${formatGb(res.memory.total_bytes)}`)),
      h('td', {}, usageCell(res && res.disk, res && `${formatGb(res.disk.free_bytes)} free`)),
      h('td', { class: 'num' }, res ? `${((res.network_out_bps * 8) / 1e6).toFixed(1)} Mbit/s` : ''),
      h('td', { class: 'num' }, direct ? '' : server.weight),
      h('td', { class: 'row-actions' },
        // Weight and draining act on this gateway's HAProxy, which a direct server bypasses.
        !direct && h('button', { onclick: () => changeWeight(server) }, 'Weight'),
        !direct && h('button', { onclick: () => updateServer(server, { enabled: !server.enabled }) }, server.enabled ? 'Drain' : 'Enable'),
        server.audio && server.audio.forced
          ? h('button', { onclick: () => setAudioStatus(server, 'auto') }, 'Back to automatic')
          : h('button', { onclick: () => setAudioStatus(server, 'no_audio') }, 'Mark no audio'),
        !server.is_builtin && h('button', { class: 'danger', onclick: () => removeServer(server) }, 'Remove'))
    );
  }));
}

async function updateServer(server, changes) {
  if (changes.enabled === false && !confirm(`Drain ${server.name}? Its current listeners stay connected, and no new listeners are sent to it.`)) return;
  await api('PATCH', `/servers/${server.id}`, changes).then(loadServers).catch(fail);
}

async function setAudioStatus(server, status) {
  const body = { status };
  if (status === 'no_audio') {
    const reason = prompt(`Take ${server.name} out as having no audio? Its listeners are disconnected and reconnect to the other servers. It stays out until you choose "Back to automatic".\n\nReason (shown here and in the API):`, '');
    if (reason === null) return;
    body.reason = reason;
  }
  await api('PUT', `/servers/${server.id}/audio-status`, body).then(loadServers).catch(fail);
}

async function changeWeight(server) {
  const answer = prompt(`Weight for ${server.name} (1-256). A server with twice the weight takes twice the listeners.`, server.weight);
  if (answer === null) return;
  await updateServer(server, { weight: Number(answer) });
}

async function removeServer(server) {
  const consequence = server.mode === 'direct'
    ? 'This only removes it from the list. Take its address out of your DNS records to stop listeners reaching it.'
    : 'Its listeners are disconnected and reconnect to the remaining servers.';
  if (!confirm(`Remove ${server.name}? ${consequence}`)) return;
  await api('DELETE', `/servers/${server.id}`).then(loadServers).catch(fail);
}

$('addServer').addEventListener('click', () => {
  $('serverForm').reset();
  $('serverError').textContent = '';
  $('joinCommand').hidden = true;
  $('serverDialog').showModal();
});
$('serverCancel').addEventListener('click', () => $('serverDialog').close());
$('serverDialog').addEventListener('close', () => loadServers().catch(fail));

$('makeJoinCommand').addEventListener('click', async () => {
  try {
    const created = await api('POST', '/cluster/join-tokens', { note: 'created in the dashboard' });
    $('joinCommandText').textContent = created.install_command;
    $('joinCommandNote').textContent = `Works once, until ${formatDate(created.expires_at)}. The server appears in the list as soon as it has joined.`;
    $('joinCommand').hidden = false;
  } catch (err) {
    fail(err);
  }
});

$('serverForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $('serverError').textContent = '';
  try {
    const added = await api('POST', '/servers', {
      host: form.get('host').trim(),
      port: Number(form.get('port')) || 3000,
      setup_key: form.get('setup_key').trim(),
    });
    $('serverDialog').close();
    toast(`${added.name} joined and is receiving listeners`);
  } catch (err) {
    $('serverError').textContent = err.message;
  }
});

start();
