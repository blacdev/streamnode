// Recognises an uploaded picture and reads its size, without decoding it.
//
// A station's image is handed to players and web pages as it is, so only the
// formats every browser and player shows are accepted: JPEG, PNG, WebP and GIF.

const fs = require('fs');

const MB = 1024 * 1024;
// A station image is a logo or a cover; anything bigger than this is a mistake.
const MAX_BYTES = 5 * MB;
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const EXTENSIONS = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
const ACCEPTED = 'JPEG, PNG, WebP or GIF';

function jpegSize(b) {
  // Walks the segments to the one that states the frame's size.
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    at += 2 + b.readUInt16BE(at + 2);
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

/**
 * What kind of picture the bytes are: `{ type, width, height }`, or null when
 * they are not one of the accepted formats. Width and height are null when
 * the file does not state them where expected.
 */
function inspect(b) {
  let type = null;
  let size = null;
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    type = 'png';
    size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    type = 'jpeg';
    size = jpegSize(b);
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) {
    type = 'gif';
    size = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  } else if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    type = 'webp';
    size = webpSize(b);
  }
  if (!type) return null;
  const sane = size && size.width > 0 && size.height > 0;
  return { type, width: sane ? size.width : null, height: sane ? size.height : null };
}

// Whether a file starts like a picture; only then is the whole of it read.
async function inspectFile(path, bytes) {
  if (bytes < 16) return null;
  const handle = await fs.promises.open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    await handle.read(head, 0, head.length, 0);
    const looksLike = (head[0] === 0xff && head[1] === 0xd8) || head.readUInt32BE(0) === 0x89504e47
      || head.toString('latin1', 0, 4) === 'GIF8' || (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP');
    if (!looksLike) return null;
    // The size of a JPEG may sit after an embedded preview, so more than the start is needed.
    const all = Buffer.alloc(Math.min(bytes, MAX_BYTES));
    await handle.read(all, 0, all.length, 0);
    return inspect(all);
  } finally {
    await handle.close();
  }
}

const describe = (row) => `${row.codec === 'jpeg' ? 'JPEG' : row.codec === 'webp' ? 'WebP' : row.codec.toUpperCase()} image${row.width && row.height ? `, ${row.width} × ${row.height}` : ''}`;

module.exports = { inspect, inspectFile, describe, MAX_BYTES, TYPES, EXTENSIONS, ACCEPTED };
