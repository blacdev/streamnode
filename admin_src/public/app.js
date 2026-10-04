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
    const details = (Array.isArray(err.details) ? err.details : []).map((d) => `${FIELD_LABELS[d.field] || d.field} ${d.message}`).join('; ');
    const error = new Error(details || err.message || `Request failed (${res.status})`);
    error.code = err.code;
    error.details = err.details;
    throw error;
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

// How fields are named to the user when the server refuses one.
const FIELD_LABELS = { ident_file_id: 'Ident:', fallback_file_id: 'Fallback audio:' };

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
  if (isAdmin()) dropboxReturn();
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
  if (tab === 'files') loadFiles().catch(fail);
  if (tab === 'billing') loadBilling().catch(fail);
  if (tab === 'settings') Promise.all([loadSettings(), loadRates()]).catch(fail);
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
  if (station.live.source === 'fallback') return ['backup', 'On air (fallback audio)'];
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
      h('td', {}, h('div', { class: 'station-name' }, station.name), h('code', {}, `/${station.slug}`),
        live.stream_format && h('small', { title: `${featureWords(live.stream_format.features)} ${live.stream_format.notes}` }, live.stream_format.summary)),
      h('td', {}, h('span', { class: `status ${kind}` }, label),
        // Name the servers that get no audio for this station, with the reason on hover.
        live.no_audio_on.length > 0 && h('small', { title: live.no_audio_on.map((n) => `${n.server}: ${n.reason || 'no audio'}`).join('\n') },
          live.source_offline ? (live.no_audio_on[0].reason || '').slice(0, 60) : `No audio on ${live.no_audio_on.map((n) => n.server).join(', ')}`)),
      h('td', { class: 'num' }, formatNumber(live.listeners) + (station.max_listeners ? ` / ${formatNumber(station.max_listeners)}` : '')),
      h('td', { class: 'wrap' }, art && h('img', { class: 'art', src: art, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }), playing || h('span', { class: 'muted' }, 'No title')),
      h('td', {}, h('code', {}, station.stream_url)),
      h('td', { class: 'row-actions' },
        h('button', { onclick: () => openDetail(station).catch(fail) }, 'Stats'),
        h('button', { onclick: () => openStationForm(station).catch(fail) }, 'Edit'),
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

const FEATURE_NAMES = { silence_detection: 'silence detection', fades: 'fades', idents: 'idents', fallback_audio: 'fallback audio' };

// What a stream of this kind gets and does not get, in words.
function featureWords(features) {
  const names = (wanted) => Object.keys(FEATURE_NAMES).filter((key) => features[key] === wanted).map((key) => FEATURE_NAMES[key]);
  const [on, off] = [names(true), names(false)];
  if (!off.length) return 'All features are available.';
  if (!on.length) return 'Relayed as it is: no silence detection, fades, idents or fallback audio.';
  return `Available: ${on.join(', ')}. Not available: ${off.join(', ')}.`;
}

// The table of supported stream types, loaded once.
async function showStreamTypes() {
  if (state.streamTypes) return;
  state.streamTypes = (await api('GET', '/stream-types')).stream_types;
  $('streamTypes').replaceChildren(
    h('thead', {}, h('tr', {}, ['Stream', 'Relayed', 'Silence detection', 'Fades', 'Ident and fallback audio'].map((t) => h('th', {}, t)))),
    h('tbody', {}, state.streamTypes.map((t) => h('tr', {},
      h('td', { class: 'wrap' }, h('div', { class: 'station-name' }, t.name), h('small', {}, t.description)),
      ...[t.relayed, t.features.silence_detection, t.features.fades, t.features.idents && t.features.fallback_audio].map((yes) => h('td', {}, yes ? 'Yes' : 'No')))))
  );
}

async function openStationForm(station) {
  const form = $('stationForm');
  form.reset();
  // The files of the account that owns the station.
  const owner = station && station.user_id !== state.user.id ? `?user_id=${station.user_id}` : '';
  const library = await api('GET', `/files${owner}`).catch(() => ({ files: [], limits: {}, usage: null }));
  // Every file in the account's storage can be chosen; one that does not suit this station is refused on saving, with the reason.
  for (const field of ['ident_file_id', 'fallback_file_id']) {
    form.elements[field].replaceChildren(
      h('option', { value: '' }, 'None'),
      ...library.files.map((file) => h('option', { value: file.id }, `${file.name} (${file.format}, ${formatLength(file.duration_seconds)})`))
    );
  }
  state.stationFiles = { usage: library.usage, owner: owner.slice(1) };
  showStationStorage();
  $('stationUpload').textContent = '';
  const format = station && station.live.stream_format;
  const usable = !format || format.features.idents;
  $('stationFormat').textContent = !format ? 'Files must be in exactly the same format as the stream.'
    : usable ? `This station's stream is ${format.summary}. A file in exactly that format is used as it is, which is best.`
      : `This station's stream is ${format.summary}, so idents and fallback audio cannot be used on it.`;
  $('stationStream').textContent = format ? `Detected: ${format.summary}. ${featureWords(format.features)} ${format.features.fallback_audio && !Object.values(format.features).every(Boolean) ? format.notes : ''}` : '';
  showStreamTypes().catch(() => {});
  if (isAdmin()) {
    // The account the station belongs to, and what it is charged for.
    const { users } = await api('GET', '/users');
    form.elements.user_id.replaceChildren(...users.map((user) => h('option', { value: user.id }, user.username)));
    form.elements.user_id.value = station ? station.user_id : state.user.id;
    for (const field of ['billing_bitrate_kbps', 'discount_percent', 'price_override', 'subscription_ends_on']) {
      form.elements[field].value = station ? station[field] ?? '' : field === 'discount_percent' ? 0 : '';
    }
  }
  form.dataset.slug = station ? station.slug : '';
  $('stationDialogTitle').textContent = station ? `Edit ${station.name}` : 'Add station';
  $('stationError').textContent = '';
  form.elements.slug.disabled = Boolean(station);
  if (station) {
    for (const field of [...STATION_FIELDS, 'failover_delay_secs', 'ident_file_id', 'fallback_file_id']) form.elements[field].value = station[field] ?? '';
    form.elements.silence_detection.checked = station.silence_detection;
    form.elements.noise_detection.checked = station.noise_detection;
    form.elements.silence_threshold_db.value = station.silence_threshold_db ?? '';
  }
  $('stationDialog').showModal();
}

function showStationStorage() {
  const usage = state.stationFiles && state.stationFiles.usage;
  $('stationStorage').textContent = !usage ? ''
    : usage.quota_bytes === null ? `${formatSize(usage.used_bytes)} of storage used.`
      : `${formatSize(usage.used_bytes)} of ${formatSize(usage.quota_bytes)} of storage used, shared by all of this account's stations.`;
}

// Uploading from a station's form: the file goes into the account's storage,
// is checked for this station, and is selected. Saving the station applies it.
for (const [input, field, use] of [['ident_upload', 'ident_file_id', 'ident'], ['fallback_upload', 'fallback_file_id', 'fallback']]) {
  $('stationForm').elements[input].addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const form = $('stationForm');
    const note = $('stationUpload');
    $('stationError').textContent = '';
    const query = new URLSearchParams({ filename: file.name, use });
    if (form.elements.convert.checked) query.set('convert', 'true');
    if (form.dataset.slug) {
      query.set('station', form.dataset.slug);
      query.set('assign', 'false');
    }
    const scope = state.stationFiles.owner;
    form.querySelector('button.primary').disabled = true;
    try {
      const stored = await uploadFile(file, `${query}${scope ? `&${scope}` : ''}`, state.stationFiles.usage, (text) => { note.textContent = `${file.name}: ${text}`; });
      for (const name of ['ident_file_id', 'fallback_file_id']) {
        if ([...form.elements[name].options].some((option) => option.value === String(stored.id))) continue;
        form.elements[name].append(h('option', { value: stored.id }, `${stored.name} (${stored.format}, ${formatLength(stored.duration_seconds)})`));
      }
      form.elements[field].value = stored.id;
      state.stationFiles.usage = stored.usage;
      showStationStorage();
      note.textContent = `${stored.name} ${stored.already_stored ? 'is already in your storage and has been' : 'uploaded and'} selected. Save the station to use it.${stored.status === 'converting' ? ' It is being converted to the stream\'s format and plays once that is done.' : ''}`;
    } catch (err) {
      note.textContent = '';
      $('stationError').textContent = err.message;
    }
    event.target.value = '';
    form.querySelector('button.primary').disabled = false;
  });
}

$('newStation').addEventListener('click', () => openStationForm(null).catch(fail));
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
  body.failover_delay_secs = Number(form.elements.failover_delay_secs.value);
  body.silence_detection = form.elements.silence_detection.checked;
  body.noise_detection = form.elements.noise_detection.checked;
  body.silence_threshold_db = form.elements.silence_threshold_db.value === '' ? null : Number(form.elements.silence_threshold_db.value);
  body.ident_file_id = Number(form.elements.ident_file_id.value) || null;
  body.fallback_file_id = Number(form.elements.fallback_file_id.value) || null;
  if (isAdmin()) {
    const owner = Number(form.elements.user_id.value);
    const current = state.stations.find((s) => s.slug === editing);
    if (!current || current.user_id !== owner) {
      body.user_id = owner;
      // The files chosen belong to the account the station is leaving.
      if (current) { delete body.ident_file_id; delete body.fallback_file_id; }
    }
    const optional = (name) => (form.elements[name].value === '' ? null : Number(form.elements[name].value));
    body.billing_bitrate_kbps = optional('billing_bitrate_kbps');
    body.discount_percent = Number(form.elements.discount_percent.value) || 0;
    body.price_override = optional('price_override');
    body.subscription_ends_on = form.elements.subscription_ends_on.value || null;
  }
  const save = () => api(editing ? 'PATCH' : 'POST', editing ? `/stations/${editing}` : '/stations', body);
  try {
    try {
      await save();
    } catch (err) {
      // A chosen file is in another format than the stream. Converting it replaces it, so that is asked first.
      const convertible = editing && Array.isArray(err.details) ? err.details.filter((d) => d.can_convert) : [];
      if (!convertible.length || convertible.length !== err.details.length) throw err;
      const question = `${convertible.map((d) => `${FIELD_LABELS[d.field]} ${d.message}`).join('\n\n')}\n\nConvert ${convertible.length === 1 ? 'it' : 'them'} now?`;
      if (!confirm(question)) throw err;
      for (const d of convertible) {
        const made = await api('POST', `/files/${d.file_id}/convert`, { station: editing, use: d.field === 'ident_file_id' ? 'ident' : 'fallback' });
        body[d.field] = made.id;
      }
      await save();
      toast('Converting; the file plays once that is done');
    }
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

// ── Audio files ────────────────────────────────────────────────────────────

const formatSize = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const formatLength = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)} s`);
const fileScope = () => (isAdmin() && $('fileAccount').value && Number($('fileAccount').value) !== state.user.id ? `user_id=${$('fileAccount').value}` : '');

// A file's format, and where it stands if the gateway is converting or has converted it.
function fileState(file) {
  if (file.status === 'converting') return [`Converting to ${file.format}`, h('small', {}, 'It can be chosen already; it plays once this is done.')];
  if (file.status === 'failed') return [h('span', { class: 'status off' }, 'Could not be converted'), h('small', {}, file.status_detail || '')];
  if (!file.converted) return file.format;
  const gain = file.gain_db ? `, loudness ${file.gain_db > 0 ? 'raised' : 'lowered'} by ${Math.abs(file.gain_db)} dB to match the stream` : '';
  return [file.format, h('small', {}, `Converted by the gateway${gain}`)];
}

async function loadFiles() {
  if (isAdmin() && !$('fileAccount').options.length) {
    const { users } = await api('GET', '/users');
    $('fileAccount').replaceChildren(...users.map((user) => h('option', { value: user.id, selected: user.id === state.user.id }, user.username)));
  }
  const scope = fileScope();
  const library = await api('GET', `/files${scope ? `?${scope}` : ''}`);
  state.files = library;
  const { used_bytes: used, quota_bytes: quota } = library.usage;
  $('fileUsage').textContent = quota === null ? `${formatSize(used)} used` : `${formatSize(used)} of ${formatSize(quota)} used`;
  $('fileLimits').textContent = `An ident may be at most ${library.limits.ident_max_seconds} seconds long.`;
  $('filesEmpty').hidden = library.files.length > 0;
  $('fileRows').replaceChildren(...library.files.map((file) => h('tr', {},
    h('td', {}, h('div', { class: 'station-name' }, file.name), file.original_name && h('small', {}, file.original_name)),
    h('td', { class: file.status === 'failed' ? 'wrap' : '' }, fileState(file)),
    h('td', { class: 'num' }, formatLength(file.duration_seconds)),
    h('td', { class: 'num' }, formatSize(file.size_bytes)),
    h('td', { class: 'wrap' }, file.used_by.length ? file.used_by.map((u) => `${u.station} (${u.as})`).join(', ') : h('span', { class: 'muted' }, 'Not in use')),
    h('td', {}, file.stored_in === 'dropbox' ? 'Dropbox' : 'This server'),
    h('td', { class: 'row-actions' },
      h('button', { onclick: () => renameFile(file) }, 'Rename'),
      h('button', { class: 'danger', onclick: () => removeFile(file) }, 'Delete'))
  )));
  // Stations of the account being shown, for "use it as".
  const owner = scope ? Number($('fileAccount').value) : state.user.id;
  const mine = (isAdmin() ? (await api('GET', `/stations?limit=500&user_id=${owner}`)).stations : state.stations);
  // While something is being converted, keep the list current.
  clearTimeout(loadFiles.timer);
  if (library.files.some((file) => file.status === 'converting') && !$('tab-files').hidden) {
    loadFiles.timer = setTimeout(() => loadFiles().catch(() => {}), 4000);
  }
  state.fileStations = mine;
  $('fileForm').elements.station.replaceChildren(...mine.map((station) => h('option', { value: station.slug }, station.name)));
  showFileStation();
}

function showFileStation() {
  const form = $('fileForm').elements;
  $('fileStationLabel').hidden = !form.use.value;
  const station = (state.fileStations || []).find((s) => s.slug === form.station.value);
  const format = station && station.live.stream_format;
  $('fileStationFormat').textContent = !station ? 'This account has no stations yet.'
    : format && !format.features.idents ? `Its stream is ${format.summary}, so idents and fallback audio cannot be used on it.`
      : format ? `Its stream is ${format.summary}. The file must be exactly that.`
      : 'This station has not been on air yet, so its format is not known. The file is checked when it is first needed, and skipped if it does not match.';
}
$('fileForm').elements.use.addEventListener('change', showFileStation);
$('fileForm').elements.station.addEventListener('change', showFileStation);
$('fileAccount').addEventListener('change', () => loadFiles().catch(fail));

// Sends a file to the account's storage. `query` says what it is for; the
// server answers with the reason and the remedy when it cannot be accepted.
function uploadFile(file, query, usage, onProgress) {
  return new Promise((resolve, reject) => {
    const free = usage && usage.free_bytes;
    if (free !== null && free !== undefined && file.size > free) {
      return reject(new Error(`This file is ${formatSize(file.size)} but only ${formatSize(free)} of storage is free. Delete files that are no longer needed, or ask the administrator to raise the storage quota.`));
    }
    // XMLHttpRequest rather than fetch, for the progress of large uploads.
    const request = new XMLHttpRequest();
    request.open('POST', `${API}/files?${query}`);
    request.setRequestHeader('Authorization', `Bearer ${state.token}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(`${Math.round((e.loaded / e.total) * 100)}% sent`); };
    request.onerror = () => reject(new Error('The upload did not complete. Check the connection and try again.'));
    request.onload = () => {
      let data = null;
      try { data = JSON.parse(request.responseText); } catch { /* not JSON */ }
      if (request.status === 201 || request.status === 200 || request.status === 202) return resolve(data);
      if (request.status === 401) showLogin();
      const err = (data && data.error) || {};
      const error = new Error((Array.isArray(err.details) && err.details.map((d) => `${FIELD_LABELS[d.field] || d.field} ${d.message}`).join('; ')) || err.message || `Upload failed (${request.status})`);
      error.code = err.code;
      reject(error);
    };
    onProgress('Starting');
    request.send(file);
  });
}

$('fileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  const file = form.file.files[0];
  const error = $('fileError');
  error.textContent = '';
  if (!file) return;
  const query = new URLSearchParams({ filename: file.name });
  if (form.name.value.trim()) query.set('name', form.name.value.trim());
  if (form.convert.checked) query.set('convert', 'true');
  if (form.use.value && form.station.value) {
    query.set('use', form.use.value);
    query.set('station', form.station.value);
  } else if (form.use.value) {
    error.textContent = 'Choose a station, or add the file to the library only.';
    return;
  }
  const scope = fileScope();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const stored = await uploadFile(file, `${query}${scope ? `&${scope}` : ''}`, state.files && state.files.usage, (text) => { $('fileProgress').textContent = text; });
    event.target.reset();
    toast(stored.already_stored ? `${stored.name} is already in your storage` : stored.status === 'converting' ? `${stored.name} uploaded; it is being converted` : `${stored.name} uploaded`);
    loadFiles().catch(fail);
    refresh().catch(() => {});
  } catch (err) {
    error.textContent = err.message;
  }
  button.disabled = false;
  $('fileProgress').textContent = '';
});

async function renameFile(file) {
  const name = prompt('Name of this file (listeners see it as the title while it plays):', file.name);
  if (name === null || !name.trim()) return;
  await api('PATCH', `/files/${file.id}`, { name: name.trim() }).then(loadFiles).catch(fail);
}

async function removeFile(file) {
  const inUse = file.used_by.length ? ` It is used by ${file.used_by.map((u) => u.station).join(', ')} and will be removed from there.` : '';
  if (!confirm(`Delete "${file.name}"?${inUse}`)) return;
  await api('DELETE', `/files/${file.id}${file.used_by.length ? '?force' : ''}`).then(loadFiles).catch(fail);
}

// ── Settings ───────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await api('GET', '/settings');
  const d = s.storage.dropbox;
  $('settingsForm').elements.ident_max_seconds.value = s.ident_max_seconds;
  $('settingsForm').elements.default_storage_quota_mb.value = s.default_storage_quota_mb;
  const mailForm = $('smtpForm').elements;
  for (const field of ['host', 'port', 'security', 'user', 'from', 'copy_to']) mailForm[field].value = s.smtp[field] ?? '';
  mailForm.password.value = '';
  mailForm.password.placeholder = s.smtp.password_set ? 'Saved. Leave empty to keep it.' : '';
  $('dropboxRedirect').textContent = d.redirect_uri;
  $('dropboxForm').elements.dropbox_app_key.value = d.app_key || '';
  $('dropboxForm').elements.dropbox_app_secret.placeholder = d.app_secret_set ? 'Saved. Leave empty to keep it.' : '';
  $('dropboxForm').hidden = d.connected;
  $('dropboxDisconnect').hidden = !d.connected;
  $('dropboxState').textContent = d.connected
    ? `Connected${d.account ? ` to ${d.account}` : ''}. ${d.files} file(s), ${formatSize(d.bytes)}, are kept in Dropbox; this server keeps up to ${formatSize(s.storage.cache_mb * 1024 ** 2)} of them at hand.${s.storage.local.files ? ` ${s.storage.local.files} file(s) are still being copied.` : ''}`
    : `Not connected. Uploaded files are kept on this server only (${s.storage.local.files} file(s), ${formatSize(s.storage.local.bytes)}).`;
}

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  $('settingsError').textContent = '';
  try {
    await api('PUT', '/settings', { ident_max_seconds: Number(form.ident_max_seconds.value), default_storage_quota_mb: Number(form.default_storage_quota_mb.value) });
    toast('Settings saved');
  } catch (err) {
    $('settingsError').textContent = err.message;
  }
});

$('dropboxForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  $('dropboxError').textContent = '';
  const body = { dropbox_app_key: form.dropbox_app_key.value.trim() };
  if (form.dropbox_app_secret.value.trim()) body.dropbox_app_secret = form.dropbox_app_secret.value.trim();
  try {
    await api('PUT', '/settings', body);
    const { authorize_url: url } = await api('POST', '/storage/dropbox/authorize');
    // Dropbox asks for the approval and sends the browser back here.
    window.location.href = url;
  } catch (err) {
    $('dropboxError').textContent = err.message;
  }
});

$('dropboxDisconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect Dropbox? Every file is first copied back to this server, which needs the disk space for them. The copies in Dropbox are left there.')) return;
  await api('DELETE', '/storage/dropbox').then(() => { toast('Dropbox disconnected'); return loadSettings(); }).catch(fail);
});

$('smtpForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  $('smtpError').textContent = '';
  const smtp = { host: form.host.value.trim(), port: Number(form.port.value) || 587, security: form.security.value, user: form.user.value.trim(), from: form.from.value.trim(), copy_to: form.copy_to.value.trim() };
  if (form.password.value) smtp.password = form.password.value;
  try {
    await api('PUT', '/settings', { smtp });
    toast(smtp.host ? 'Email settings saved' : 'Email is switched off');
    await loadSettings();
  } catch (err) {
    $('smtpError').textContent = err.message;
  }
});

$('smtpTest').addEventListener('click', async () => {
  const to = prompt('Send a test message to which address? (Save the settings first.)', state.user.email || '');
  if (!to) return;
  $('smtpError').textContent = '';
  try {
    await api('POST', '/settings/email/test', { to: to.trim() });
    toast(`Test message sent to ${to.trim()}`);
  } catch (err) {
    $('smtpError').textContent = err.message;
  }
});

// ── Prices ─────────────────────────────────────────────────────────────────

const money = (amount, currency) => (amount === null || amount === undefined ? 'Not set' : `${currency} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

async function loadRates() {
  const r = await api('GET', '/billing/rates');
  const form = $('ratesForm').elements;
  for (const field of ['currency', 'server_monthly_cost', 'server_vcpus', 'server_memory_gb', 'server_port_mbps', 'margin_percent', 'storage_price_per_gb']) form[field].value = r[field];
  $('ratesTable').replaceChildren(
    h('thead', {}, h('tr', {}, ['Stream bitrate', 'Listeners one such server carries', 'What stops it there', 'Price per listener per month', '100 listeners', '1,000 listeners'].map((t, i) => h('th', { class: i && i !== 2 ? 'num' : '' }, t)))),
    h('tbody', {}, r.per_listener.map((row) => h('tr', {},
      h('td', {}, `${row.bitrate_kbps} kbps`),
      h('td', { class: 'num' }, formatNumber(row.listeners_per_server)),
      h('td', {}, row.limited_by),
      h('td', { class: 'num' }, r.configured ? `${r.currency} ${row.price_per_listener.toFixed(4)}` : 'Not set'),
      h('td', { class: 'num' }, r.configured ? money(row.price_per_listener * 100, r.currency) : ''),
      h('td', { class: 'num' }, r.configured ? money(row.price_per_listener * 1000, r.currency) : ''))))
  );
  const m = r.cost_model;
  $('ratesNote').textContent = `Worked out from what a listener costs a server: ${m.engine.percent_of_core_per_1000_listeners + m.proxy.percent_of_core_per_1000_listeners}% of a core per 1,000 listeners${m.engine.measured && m.proxy.measured ? ', as measured on this installation' : ' (starting figures, until this installation has carried enough listeners to measure)'}, with a quarter of each server kept in reserve.`;
}

$('ratesForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  $('ratesError').textContent = '';
  const body = { currency: form.currency.value.trim() };
  for (const field of ['server_monthly_cost', 'server_vcpus', 'server_memory_gb', 'server_port_mbps', 'margin_percent', 'storage_price_per_gb']) body[field] = Number(form[field].value);
  try {
    await api('PUT', '/billing/rates', body);
    toast('Prices saved');
    await loadRates();
  } catch (err) {
    $('ratesError').textContent = err.message;
  }
});

// ── Billing and limits ─────────────────────────────────────────────────────

const STANDING = { ok: ['live', 'Within its limit'], near_limit: ['backup', 'Near its limit'], at_limit: ['off', 'At its limit'], expiring: ['backup', 'Subscription ending'], expired: ['off', 'Subscription ended'] };

async function loadBilling() {
  if (isAdmin() && !$('billingAccount').options.length) {
    const { users } = await api('GET', '/users');
    $('billingAccount').replaceChildren(...users.map((user) => h('option', { value: user.id, selected: user.id === state.user.id }, user.username)));
  }
  const other = isAdmin() && Number($('billingAccount').value) !== state.user.id;
  const bill = await api('GET', `/billing${isAdmin() ? `?user_id=${$('billingAccount').value}` : ''}`);
  state.bill = bill;
  $('billingMonth').textContent = `${new Date(`${bill.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })} so far`;
  const storage = bill.storage;
  tiles($('billingTiles'), [
    ['Per month', bill.monthly_total === null ? 'Not set' : money(bill.monthly_total, bill.currency)],
    ['Stations', bill.stations.length],
    ['Audio storage', storage.quota_bytes === null ? `${formatSize(storage.used_bytes)} used` : `${formatSize(storage.used_bytes)} of ${formatSize(storage.quota_bytes)}`],
    ['Storage per month', storage.monthly_price === null ? 'Not set' : money(storage.monthly_price, bill.currency)],
  ]);
  $('billingRows').replaceChildren(...bill.stations.map((s) => {
    const [kind, label] = STANDING[s.status];
    const limit = s.plan.max_listeners;
    const percent = s.usage.percent_of_limit;
    const ends = s.plan.subscription_ends_on;
    return h('tr', {},
      h('td', {}, h('div', { class: 'station-name' }, s.name), h('code', {}, `/${s.station}`)),
      h('td', {}, h('span', { class: `status ${kind}` }, label)),
      h('td', {}, limit
        ? [`${formatNumber(s.usage.peak_listeners_this_month)} of ${formatNumber(limit)} (${percent}%)`, h('span', { class: `meter${percent >= 75 ? ' warn' : ''}`, role: 'img', 'aria-label': `${percent}% of the limit` }, h('i', { style: `width:${Math.min(100, percent)}%` })), h('small', {}, `${formatNumber(s.usage.listeners_now)} listening now`)]
        : [`${formatNumber(s.usage.peak_listeners_this_month)}, no limit`, h('small', {}, `${formatNumber(s.usage.listeners_now)} listening now`)]),
      h('td', { class: 'num' }, `${s.plan.bitrate_kbps} kbps`, s.plan.bitrate_source === 'default' && h('small', {}, 'assumed until the station plays')),
      h('td', { class: 'num' }, formatNumber(s.usage.listener_hours_this_month)),
      h('td', { class: 'num' }, `${s.usage.gigabytes_this_month.toFixed(2)} GB`),
      h('td', {}, ends ? [ends, h('small', {}, s.plan.days_left < 0 ? 'Ended' : s.plan.days_left === 0 ? 'Ends today' : `${s.plan.days_left} days left`)] : h('span', { class: 'muted' }, 'No end date')),
      h('td', { class: 'num' }, s.monthly_price === null ? 'Not set' : money(s.monthly_price, bill.currency),
        s.plan.price_override !== null ? h('small', {}, 'Fixed price') : s.plan.discount_percent > 0 && h('small', {}, `${s.plan.discount_percent}% discount`))
    );
  }));
  const notes = [];
  if (!bill.prices_set) notes.push('Prices have not been set, so only usage and limits are shown.');
  else notes.push(`A station is charged for the listeners it is allowed, at its stream's bitrate${bill.stations.some((s) => !s.plan.max_listeners) ? '; one with no limit is charged for the most listeners it had at once this month' : ''}.`);
  if (bill.discount_percent > 0) notes.push(`A discount of ${bill.discount_percent}% is taken off the account's total.`);
  notes.push('Listener limits, bitrates, prices and subscription dates are set by the administrator.');
  $('billingNote').textContent = notes.join(' ');
  $('emailForm').elements.email.value = bill.email || '';
  $('emailForm').dataset.user = other ? bill.user_id : '';
}

$('billingAccount').addEventListener('change', () => loadBilling().catch(fail));

$('emailForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('emailError').textContent = '';
  const email = event.target.elements.email.value.trim() || null;
  try {
    // An administrator looking at another account sets that account's address.
    if (event.target.dataset.user) await api('PATCH', `/users/${event.target.dataset.user}`, { email });
    else await api('PATCH', '/auth/me', { email });
    toast(email ? 'Notices will be sent to that address' : 'No notices will be sent');
    if (!event.target.dataset.user) state.user.email = email;
  } catch (err) {
    $('emailError').textContent = err.message;
  }
});

// Dropbox sends the administrator back with the outcome in the address.
function dropboxReturn() {
  const query = new URLSearchParams(window.location.search);
  if (!query.has('dropbox')) return;
  history.replaceState(null, '', window.location.pathname);
  document.querySelector('[data-tab=settings]').click();
  toast(query.get('dropbox') === 'connected' ? 'Dropbox is connected' : `Dropbox was not connected: ${query.get('reason') || 'unknown error'}`);
}

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
    h('td', {}, user.username, user.email && h('small', {}, user.email), Number(user.discount_percent) > 0 && h('small', {}, `${Number(user.discount_percent)}% discount`)),
    h('td', {}, user.role === 'admin' ? 'Administrator' : 'Tenant'),
    h('td', {}, user.external_id || h('span', { class: 'muted' }, 'None')),
    h('td', { class: 'num' }, user.role === 'admin' ? user.station_count : `${user.station_count} of ${user.max_stations}`),
    h('td', { class: 'num' }, user.role === 'admin' ? formatSize(user.storage_used_bytes)
      : `${formatSize(user.storage_used_bytes)} of ${user.storage_quota_mb === null ? 'default' : formatSize(user.storage_quota_mb * 1024 ** 2)}`),
    h('td', {}, h('span', { class: `status ${user.is_active ? 'live' : 'off'}` }, user.is_active ? 'Active' : 'Disabled')),
    h('td', { class: 'row-actions' }, user.id !== state.user.id && [
      user.role !== 'admin' && h('button', { onclick: () => changeStationLimit(user) }, 'Station limit'),
      user.role !== 'admin' && h('button', { onclick: () => changeStorageQuota(user) }, 'Storage'),
      h('button', { onclick: () => changeEmail(user) }, 'Email'),
      user.role !== 'admin' && h('button', { onclick: () => changeDiscount(user) }, 'Discount'),
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
  if (form.get('storage_quota_mb') !== '') body.storage_quota_mb = Number(form.get('storage_quota_mb'));
  if (form.get('email').trim()) body.email = form.get('email').trim();
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

async function changeEmail(user) {
  const answer = prompt(`Email address for notices to ${user.username} (limits and subscriptions). Leave empty for none.`, user.email || '');
  if (answer === null) return;
  await api('PATCH', `/users/${user.id}`, { email: answer.trim() || null }).then(loadUsers).catch(fail);
}

async function changeDiscount(user) {
  const answer = prompt(`Discount on everything ${user.username} is charged, in percent (0 to 100).`, Number(user.discount_percent));
  if (answer === null) return;
  const discount = Number(answer);
  if (!(discount >= 0 && discount <= 100)) return toast('Enter a number from 0 to 100.');
  await api('PATCH', `/users/${user.id}`, { discount_percent: discount }).then(loadUsers).catch(fail);
}

async function changeStorageQuota(user) {
  const answer = prompt(`Storage for ${user.username}'s uploaded audio, in MB (1024 MB is 1 GB). Leave empty to use the default from Settings.`, user.storage_quota_mb ?? '');
  if (answer === null) return;
  const quota = answer.trim() === '' ? null : Number(answer);
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) return toast('Enter a whole number of MB, or leave it empty.');
  await api('PATCH', `/users/${user.id}`, { storage_quota_mb: quota }).then(loadUsers).catch(fail);
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
  showCosts(report);
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
      h('td', {}, res && res.engine
        ? [`${res.engine.cpu_percent.toFixed(0)}% of a core, ${formatSize(res.engine.memory_bytes)}`,
          h('small', {}, server.cost_per_listener ? `${(server.cost_per_listener.percent_of_core * 1000).toFixed(1)}% of a core per 1,000 listeners` : 'Too few listeners to cost one')]
        : h('span', { class: 'muted' }, 'No data')),
      h('td', { class: 'num' }, direct ? '' : server.weight),
      h('td', { class: 'row-actions' },
        h('button', { onclick: () => changePort(server) }, `Port: ${server.port_mbps >= 1000 ? `${server.port_mbps / 1000} Gbit` : `${server.port_mbps} Mbit`}`),
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

// What listeners cost here, as measured, and what the servers as they are can carry.
function showCosts(report) {
  const p = report.proxy;
  $('proxyLine').textContent = p
    ? `The master's HAProxy, which every listener's audio passes through unless they are on an edge server, is holding ${formatNumber(p.connections)} connections and using ${p.processor_percent}% of the master's ${p.machine.cores} cores and ${formatSize(p.memory_bytes)} of memory, sending ${((p.bytes_out_per_second * 8) / 1e6).toFixed(1)} Mbit/s on a ${p.machine.port_mbps >= 1000 ? `${p.machine.port_mbps / 1000} Gbit` : `${p.machine.port_mbps} Mbit`} port.`
    : 'HAProxy is not reporting, so its share of the work is not known.';
  // A master with no engine beside it has no row above to set its port on.
  $('masterPort').hidden = !p || p.machine.has_engine;
  $('masterPort').dataset.port = p ? p.machine.port_mbps : 1000;
  const m = report.cost_model;
  const part = (name, c) => `${name}: ${c.percent_of_core_per_1000_listeners}% of a core and ${formatSize(c.kilobytes_per_listener * 1024 * 1000)} per 1,000 listeners (${c.measured ? `measured here, ${formatNumber(c.samples)} readings` : 'not yet measured here: a starting figure, replaced once a server has carried 25 listeners'})`;
  $('costLine').textContent = `${part('The engine', m.engine)}. ${part('The master\'s proxying', m.proxy)}.`;
  $('capacityTable').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Stream bitrate'), h('th', { class: 'num' }, 'Listeners these servers can carry'), h('th', {}, 'What stops it there'))),
    h('tbody', {}, report.listener_capacity.map((row) => h('tr', {}, h('td', {}, `${row.bitrate_kbps} kbps`), h('td', { class: 'num' }, formatNumber(row.listeners)), h('td', {}, row.limited_by))))
  );
}

$('masterPort').addEventListener('click', async (event) => {
  const answer = prompt("Speed of the master's network port, in Mbit/s (1000 for 1 Gbit). Every listener who is not on an edge server is carried by it.", event.target.dataset.port);
  if (answer === null) return;
  await api('PUT', '/settings', { master_port_mbps: Number(answer) }).then(loadServers).catch(fail);
});

async function changePort(server) {
  const answer = prompt(`Speed of ${server.name}'s network port, in Mbit/s (1000 for 1 Gbit). It is used to work out how many listeners the server has room for.`, server.port_mbps);
  if (answer === null) return;
  await updateServer(server, { port_mbps: Number(answer) });
}

$('estimateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  $('estimateError').textContent = '';
  try {
    const result = await api('POST', '/capacity/estimate', {
      vcpus: Number(form.vcpus.value), memory_gb: Number(form.memory_gb.value), port_mbps: Number(form.port_mbps.value),
      mode: form.mode.value, bitrate_kbps: Number(form.bitrate_kbps.value),
    });
    $('estimateNotes').replaceChildren(...result.notes.map((note) => h('li', {}, note)));
    const names = Object.keys(result.load_now.after.servers);
    const cell = (side, name) => {
      const s = result.load_now[side].servers[name];
      return h('td', { class: 'num' }, s ? `${formatNumber(s.listeners)}${s.processor_percent === null ? '' : ` (${s.processor_percent}% CPU)`}` : '');
    };
    const masterRow = (label, pick) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, pick(result.load_now.before.master)), h('td', { class: 'num' }, pick(result.load_now.after.master)));
    $('estimateTable').replaceChildren(
      h('thead', {}, h('tr', {}, h('th', {}, `With today's ${formatNumber(result.listeners_now)} listeners`), h('th', { class: 'num' }, 'Now'), h('th', { class: 'num' }, 'With the new server'))),
      h('tbody', {},
        ...names.map((name) => h('tr', {}, h('td', {}, `Listeners on ${name}`), cell('before', name), cell('after', name))),
        masterRow('Master: processor in use', (m) => `${m.processor_percent}%`),
        masterRow('Master: traffic', (m) => `${m.traffic_mbps} Mbit/s (${m.port_percent}% of its port)`),
        h('tr', {}, h('td', {}, `Most listeners possible at ${result.bitrate_kbps} kbps`), h('td', { class: 'num' }, formatNumber(result.capacity.before.listeners)), h('td', { class: 'num' }, formatNumber(result.capacity.after.listeners))),
        h('tr', {}, h('td', {}, 'What stops it there'), h('td', { class: 'num' }, result.capacity.before.limited_by), h('td', { class: 'num' }, result.capacity.after.limited_by)))
    );
    $('estimateResult').hidden = false;
  } catch (err) {
    $('estimateError').textContent = err.message;
  }
});

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
