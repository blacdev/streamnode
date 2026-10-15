const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const config = require('../src/config');
const v = require('../src/validate');
const remoteFiles = require('../src/remote_files');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const fields = (fn) => {
  try {
    fn();
    return [];
  } catch (err) {
    return err.details.map((d) => d.field);
  }
};

// A local server for the downloads. Private addresses are allowed only while it runs.
async function serve(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = config.allowPrivateSources;
  config.allowPrivateSources = true;
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    config.allowPrivateSources = previous;
    server.close();
  }
}

test('addresses and checksums are read only when given', () => {
  assert.deepStrictEqual(remoteFiles.parse({ name: 'x' }), {});
  const good = 'a'.repeat(64);
  assert.deepStrictEqual(remoteFiles.parse({ ident_url: 'https://files.example.com/i.mp3', ident_sha256: good.toUpperCase() }), {
    ident: { url: 'https://files.example.com/i.mp3', sha256: good },
  });
  assert.deepStrictEqual(remoteFiles.parse({ fallback_url: null }), { fallback: { url: null, sha256: null } });
});

test('an address needs a checksum, and a checksum needs an address', () => {
  assert.deepStrictEqual(fields(() => remoteFiles.parse({ ident_url: 'https://files.example.com/i.mp3' })), ['ident_sha256']);
  assert.deepStrictEqual(fields(() => remoteFiles.parse({ fallback_sha256: 'a'.repeat(64) })), ['fallback_sha256']);
  assert.deepStrictEqual(fields(() => remoteFiles.parse({ ident_url: 'ftp://x/i.mp3', ident_sha256: 'a'.repeat(64) })), ['ident_url']);
});

test('private addresses are refused unless private sources are allowed', async () => {
  assert.deepStrictEqual(fields(() => remoteFiles.parse({ ident_url: 'http://127.0.0.1/i.mp3', ident_sha256: 'a'.repeat(64) })), ['ident_url']);
  await assert.rejects(remoteFiles.checkResolved('http://localhost/i.mp3'), /private|could not be found/);
});

test('a download is checked against its checksum', async () => {
  const body = Buffer.from('ID3 pretend audio');
  await serve((req, res) => res.end(body), async (base) => {
    assert.deepStrictEqual(await remoteFiles.download(`${base}/i.mp3`, sha(body)), body);
    await assert.rejects(remoteFiles.download(`${base}/i.mp3`, 'b'.repeat(64)), /SHA-256/);
  });
});

test('redirects, errors and oversized files are refused', async () => {
  await serve((req, res) => {
    if (req.url === '/moved') return res.writeHead(302, { Location: '/i.mp3' }).end();
    if (req.url === '/big') return res.end(Buffer.alloc(2048));
    res.writeHead(404).end();
  }, async (base) => {
    await assert.rejects(remoteFiles.download(`${base}/moved`, 'a'.repeat(64)), /could not be downloaded/);
    await assert.rejects(remoteFiles.download(`${base}/missing`, 'a'.repeat(64)), /answered 404/);
    await assert.rejects(remoteFiles.download(`${base}/big`, 'a'.repeat(64), { maxBytes: 1024 }), /larger than/);
  });
});

test('a downloaded file reads like an upload', async () => {
  const buffer = Buffer.from('hello');
  const body = remoteFiles.asUpload(buffer);
  assert.strictEqual(body.get('Content-Length'), '5');
  const chunks = [];
  for await (const chunk of body.iterator({ destroyOnReturn: false })) chunks.push(chunk);
  assert.deepStrictEqual(Buffer.concat(chunks), buffer);
});

// The payload Airwave OS sends (docs/contracts/airwave-station-sync.json, kept
// identical in both repositories): every field is understood, none is ignored.
test('contract: Airwave OS station payload', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'contracts', 'airwave-station-sync.json'), 'utf8'));
  const previous = config.allowPrivateSources;
  config.allowPrivateSources = false;
  try {
    const station = v.parseStation({ ...contract.example, slug: 'lagos-hits-fm' }, { isAdmin: true });
    const files = remoteFiles.parse(contract.example);
    const understood = new Set([...Object.keys(station), ...Object.keys(files).flatMap((use) => [`${use}_url`, `${use}_sha256`])]);
    for (const key of Object.keys(contract.example)) assert.ok(understood.has(key), `${key} is not understood`);
    assert.deepStrictEqual(Object.keys(files).sort(), ['fallback', 'ident']);
  } finally {
    config.allowPrivateSources = previous;
  }
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
  for (const feature of contract.capabilities_response.features) assert.ok(routes.includes(`'${feature}'`), `capability ${feature} is not advertised`);
});

test('a missing copy is put back only from content that matches its checksum', async () => {
  const media = require('../src/media');
  const row = { id: 999999, name: 'x', sha256: sha(Buffer.from('right')) };
  await assert.rejects(media.restoreCopy(row, Buffer.from('wrong')), /does not match/);
});
