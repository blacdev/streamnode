const test = require('node:test');
const assert = require('node:assert');
const image = require('../src/image');

const png = (width, height) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

test('PNG and GIF state their size at the start', () => {
  assert.deepStrictEqual(image.inspect(png(600, 400)), { type: 'png', width: 600, height: 400 });
  const gif = Buffer.alloc(16);
  gif.write('GIF89a', 0, 'latin1');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(240, 8);
  assert.deepStrictEqual(image.inspect(gif), { type: 'gif', width: 320, height: 240 });
});

test('a JPEG is read past the segments before its frame', () => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  // An embedded preview could hold bytes that look like a frame header: it is skipped by its length.
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x0b, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01]);
  const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, ...Buffer.alloc(9)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, sof]);
  assert.deepStrictEqual(image.inspect(jpeg), { type: 'jpeg', width: 800, height: 600 });
  // Cut short before the frame: still a JPEG, of unknown size.
  assert.deepStrictEqual(image.inspect(jpeg.subarray(0, 24)), { type: 'jpeg', width: null, height: null });
});

test('the three kinds of WebP', () => {
  const webp = (chunk, fill) => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.write('WEBP', 8, 'latin1');
    b.write(chunk, 12, 'latin1');
    fill(b);
    return b;
  };
  assert.deepStrictEqual(image.inspect(webp('VP8 ', (b) => { b.writeUInt16LE(640, 26); b.writeUInt16LE(480, 28); })), { type: 'webp', width: 640, height: 480 });
  assert.deepStrictEqual(image.inspect(webp('VP8L', (b) => { b[20] = 0x2f; b.writeUInt32LE((500 - 1) | ((300 - 1) << 14), 21); })), { type: 'webp', width: 500, height: 300 });
  assert.deepStrictEqual(image.inspect(webp('VP8X', (b) => { b.writeUIntLE(1023, 24, 3); b.writeUIntLE(767, 27, 3); })), { type: 'webp', width: 1024, height: 768 });
});

test('anything else is not an image', () => {
  assert.strictEqual(image.inspect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.strictEqual(image.inspect(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null);
  assert.strictEqual(image.inspect(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.strictEqual(image.describe({ codec: 'jpeg', width: 800, height: 600 }), 'JPEG image, 800 × 600');
});
