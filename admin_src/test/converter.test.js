const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Writable } = require('stream');

// A stand-in for the container registry: a token, a manifest with one layer per download, and the files.
const FILE = Buffer.from('PK-pretend-zip-'.repeat(1000));
const seen = [];
const registry = http.createServer((req, res) => {
  seen.push(`${req.url} ${req.headers.authorization || '-'}`);
  if (req.url.startsWith('/token')) return res.end(JSON.stringify({ token: 'anon-token' }));
  if (req.headers.authorization !== 'Bearer anon-token') { res.statusCode = 401; return res.end(); }
  if (req.url === '/v2/acme/radio/converter/manifests/latest') {
    return res.end(JSON.stringify({ layers: [
      { mediaType: 'application/gzip', digest: 'sha256:aaa', size: 5, annotations: { 'org.opencontainers.image.title': 'streamnode-converter-linux-x86_64.tar.gz' } },
      { mediaType: 'application/zip', digest: 'sha256:bbb', size: FILE.length, annotations: { 'org.opencontainers.image.title': 'streamnode-converter-windows-x86_64.zip' } },
    ] }));
  }
  if (req.url === '/v2/acme/radio/converter/blobs/sha256:bbb') return res.end(FILE);
  res.statusCode = 404;
  res.end();
});

// What the route hands over: somewhere to write, with the two header calls used.
function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  res.headers = {};
  res.set = (values) => Object.assign(res.headers, values);
  res.attachment = (name) => { res.headers.attachment = name; };
  res.body = () => Buffer.concat(chunks);
  return res;
}

test('the converter is fetched from the registry and passed on under its own name', async (t) => {
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => registry.close());
  process.env.CONVERTER_IMAGE = `127.0.0.1:${registry.address().port}/acme/radio/converter`;
  const converter = require('../src/converter');

  const res = response();
  await converter.send(res, 'windows');
  assert.deepStrictEqual(res.body(), FILE);
  assert.strictEqual(res.headers.attachment, 'streamnode-converter-windows-x86_64.zip');
  assert.strictEqual(res.headers['Content-Length'], String(FILE.length));
  assert.strictEqual(res.headers['Content-Type'], 'application/zip');
  assert.match(seen[0], /^\/token\?scope=repository:acme\/radio\/converter:pull -$/);

  await assert.rejects(converter.send(response(), 'macos'), (err) => err.status === 404);
  const described = converter.describe('https://stream.example.com');
  assert.strictEqual(described.downloads.linux.url, 'https://stream.example.com/api/v1/public/converter/linux');
  assert.match(described.image, /\/acme\/radio\/converter:latest$/);
});
