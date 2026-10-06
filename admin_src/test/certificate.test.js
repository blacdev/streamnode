const test = require('node:test');
const assert = require('node:assert');
const { parseCert } = require('../src/certificate');

// As printed by HAProxy 2.8's "show ssl cert <file>".
const LETS_ENCRYPT = `Filename: /etc/haproxy/certs/stream.pem
Status: Used
Serial: 04A1B2C3D4E5F6
notBefore: Sep  1 10:00:00 2026 GMT
notAfter: Nov 30 10:00:00 2099 GMT
Subject Alternative Name: DNS:stream.example.com
Algorithm: EC256
SHA1 FingerPrint: 0123456789ABCDEF0123456789ABCDEF01234567
Subject: /CN=stream.example.com
Issuer: /C=US/O=Let's Encrypt/CN=E5
Chain Subject: /C=US/O=Let's Encrypt/CN=E5
Chain Issuer: /C=US/O=Internet Security Research Group/CN=ISRG Root X1`;

test('a Let\'s Encrypt certificate', () => {
  const cert = parseCert(LETS_ENCRYPT);
  assert.strictEqual(cert.issuer, "/C=US/O=Let's Encrypt/CN=E5");
  assert.deepStrictEqual(cert.names, ['stream.example.com']);
  assert.strictEqual(cert.expires_at, '2099-11-30T10:00:00.000Z');
  assert.strictEqual(cert.self_signed, false);
  assert.strictEqual(cert.lets_encrypt, true);
  assert.ok(cert.days_left > 1000);
});

test('a self-signed certificate', () => {
  const cert = parseCert(`Filename: /etc/haproxy/certs/stream.pem
notAfter: Jan  2 03:04:05 2020 GMT
Subject Alternative Name: DNS:stream.example.com
Subject: /CN=stream.example.com
Issuer: /CN=stream.example.com`);
  assert.strictEqual(cert.self_signed, true);
  assert.strictEqual(cert.lets_encrypt, false);
  assert.ok(cert.days_left < 0);
});

test('no certificate loaded', () => {
  assert.strictEqual(parseCert("Can't display the certificate: Not found or the certificate is a bundle!"), null);
});
