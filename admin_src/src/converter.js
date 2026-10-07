// Hands out StreamNode Converter, the desktop program that converts files
// into a stream's format.
//
// Its two downloads (Windows and Linux) are published to the container
// registry beside the gateway's images, as a package of files. A browser
// cannot fetch from the registry by itself (it wants a token, and names the
// file by its checksum), so this fetches the file there and passes it on
// under its proper name.

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { HttpError } = require('./errors');

const FILES = {
  windows: 'streamnode-converter-windows-x86_64.zip',
  linux: 'streamnode-converter-linux-x86_64.tar.gz',
};
// Passing a download on takes bandwidth; only so many at once.
const MAX_AT_ONCE = 3;
let active = 0;

// "ghcr.io/owner/repo/converter" -> where the registry is and the repository's path in it.
function parts() {
  const [host, ...rest] = config.converterImage.split('/');
  // A registry on this same machine (a test stand-in) is spoken to without TLS.
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  return { origin: `${scheme}://${host}`, path: rest.join('/') };
}

const unavailable = (detail) => new HttpError(502, 'converter_unavailable', `The converter could not be fetched from ${config.converterImage} (${detail}). Try again later.`);

async function registry(url, token, accept) {
  const response = await fetch(url, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(20000) }).catch((err) => {
    throw unavailable(err.message);
  });
  if (response.status === 404) throw new HttpError(404, 'converter_not_published', `No converter has been published at ${config.converterImage} yet.`);
  if (!response.ok) throw unavailable(`the registry answered ${response.status}`);
  return response;
}

// Where the file for a platform is in the registry, and how big it is.
async function locate(platform) {
  const { origin, path } = parts();
  const token = (await (await registry(`${origin}/token?scope=repository:${path}:pull`)).json()).token;
  const manifest = await (await registry(`${origin}/v2/${path}/manifests/${config.converterTag}`, token, 'application/vnd.oci.image.manifest.v1+json')).json();
  const layer = (manifest.layers || []).find((entry) => entry.annotations && entry.annotations['org.opencontainers.image.title'] === FILES[platform]);
  if (!layer) throw new HttpError(404, 'converter_not_published', `The published converter has no ${platform} download.`);
  return { url: `${origin}/v2/${path}/blobs/${layer.digest}`, token, size: layer.size, type: layer.mediaType, name: FILES[platform] };
}

async function send(res, platform) {
  if (!FILES[platform]) throw new HttpError(404, 'not_found', 'The converter is available for "windows" and "linux".');
  if (active >= MAX_AT_ONCE) throw new HttpError(503, 'busy', 'Too many downloads are under way. Try again in a minute.');
  active += 1;
  try {
    const file = await locate(platform);
    const response = await fetch(file.url, { headers: { Authorization: `Bearer ${file.token}` } }).catch((err) => {
      throw unavailable(err.message);
    });
    if (!response.ok || !response.body) throw unavailable(`the registry answered ${response.status}`);
    res.set({ 'Content-Type': file.type || 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'no-store' });
    res.attachment(file.name);
    // Once the headers are out, a failure can only be shown by cutting the response short.
    await pipeline(Readable.fromWeb(response.body), res).catch(() => res.destroy());
  } finally {
    active -= 1;
  }
}

// What the dashboard shows: where each download is, and the registry reference itself.
function describe(base) {
  return {
    image: `${config.converterImage}:${config.converterTag}`,
    downloads: Object.fromEntries(Object.keys(FILES).map((platform) => [platform, { url: `${base}/api/v1/public/converter/${platform}`, file: FILES[platform] }])),
  };
}

module.exports = { send, describe, FILES };
