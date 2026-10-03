// Keeps uploaded audio in the administrator's Dropbox. The administrator
// creates an app in the Dropbox developer console, enters its key and secret
// here, and approves it once; the refresh token from that approval is what
// the gateway uses from then on.

const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const settings = require('./settings');
const { HttpError } = require('./errors');

const CHUNK = 8 * 1024 * 1024;
let token = null; // { value, expires, for }

const unavailable = (message) => new HttpError(502, 'dropbox_error', message);

async function state() {
  const all = await settings.all();
  return {
    appKey: all.dropbox_app_key || '',
    appSecret: all.dropbox_app_secret || '',
    refreshToken: all.dropbox_refresh_token || '',
    account: all.dropbox_account || null,
  };
}

const connected = async () => Boolean((await state()).refreshToken);

async function authorizeUrl(redirectUri, stateToken) {
  const { appKey, appSecret } = await state();
  if (!appKey || !appSecret) throw new HttpError(409, 'dropbox_not_configured', 'Save the Dropbox app key and app secret first.');
  const query = new URLSearchParams({
    client_id: appKey, response_type: 'code', token_access_type: 'offline', redirect_uri: redirectUri, state: stateToken,
  });
  return `${config.dropboxAuthUrl}/oauth2/authorize?${query}`;
}

async function tokenRequest(params) {
  const { appKey, appSecret } = await state();
  let response;
  try {
    response = await fetch(`${config.dropboxApiUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw unavailable(`Dropbox could not be reached: ${err.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw unavailable(`Dropbox refused the request: ${body.error_description || body.error || `HTTP ${response.status}`}`);
  return body;
}

// Completes the approval: trades the code Dropbox sent back for a refresh token.
async function connect(code, redirectUri) {
  const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!body.refresh_token) throw unavailable('Dropbox did not return a refresh token.');
  token = body.access_token ? { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000, for: body.refresh_token } : null;
  await settings.set({ dropbox_refresh_token: body.refresh_token, dropbox_account: null });
  try {
    const account = await rpc('/2/users/get_current_account', null);
    await settings.set({ dropbox_account: account.email || (account.name && account.name.display_name) || null });
  } catch {
    // The name is only for display.
  }
}

async function disconnect() {
  token = null;
  await settings.set({ dropbox_refresh_token: null, dropbox_account: null });
}

async function accessToken() {
  const { refreshToken } = await state();
  if (!refreshToken) throw new HttpError(409, 'dropbox_not_connected', 'Dropbox is not connected.');
  if (token && token.for === refreshToken && token.expires - Date.now() > 60000) return token.value;
  const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  token = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000, for: refreshToken };
  return token.value;
}

async function call(url, { arg, body, contentType, timeout = 120000 }) {
  const headers = { Authorization: `Bearer ${await accessToken()}` };
  // Header values must be ASCII, so anything else in a path is escaped.
  if (arg) headers['Dropbox-API-Arg'] = JSON.stringify(arg).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (contentType) headers['Content-Type'] = contentType;
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw unavailable(`Dropbox could not be reached: ${err.message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let summary = text.slice(0, 200);
    try {
      summary = JSON.parse(text).error_summary || summary;
    } catch {
      // Not JSON: the text is the message.
    }
    if (response.status === 401) token = null;
    const error = unavailable(/insufficient_space/.test(summary) ? 'The Dropbox account is full.' : `Dropbox error: ${summary || `HTTP ${response.status}`}`);
    error.notFound = /not_found/.test(summary);
    throw error;
  }
  return response;
}

const rpc = async (path, json) =>
  (await call(`${config.dropboxApiUrl}${path}`, { body: json === null ? 'null' : JSON.stringify(json), contentType: 'application/json' })).json();

const content = (path, arg, body) =>
  call(`${config.dropboxContentUrl}${path}`, { arg, body, contentType: 'application/octet-stream', timeout: 600000 });

// Sends a local file, in pieces so that memory use does not grow with its size.
async function upload(localPath, remotePath, size) {
  const handle = await fs.promises.open(localPath, 'r');
  try {
    const read = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const commit = { path: remotePath, mode: 'overwrite', mute: true };
    if (size <= CHUNK) {
      await content('/2/files/upload', commit, await read(0, size));
      return;
    }
    const started = await (await content('/2/files/upload_session/start', { close: false }, await read(0, CHUNK))).json();
    let offset = CHUNK;
    while (size - offset > CHUNK) {
      await content('/2/files/upload_session/append_v2', { cursor: { session_id: started.session_id, offset }, close: false }, await read(offset, CHUNK));
      offset += CHUNK;
    }
    await content('/2/files/upload_session/finish', { cursor: { session_id: started.session_id, offset }, commit }, await read(offset, size - offset));
  } finally {
    await handle.close();
  }
}

async function download(remotePath, localPath) {
  const response = await content('/2/files/download', { path: remotePath });
  const partial = `${localPath}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    await fs.promises.rename(partial, localPath);
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw unavailable(`The download from Dropbox failed: ${err.message}`);
  }
}

async function remove(remotePath) {
  try {
    await rpc('/2/files/delete_v2', { path: remotePath });
  } catch (err) {
    if (!err.notFound) throw err;
  }
}

module.exports = { state, connected, authorizeUrl, connect, disconnect, upload, download, remove };
