// A stand-in radio station for local testing. It serves two looping MP3
// streams (a "primary" and a "backup" that sound different), embeds song
// titles the way a real encoder does, and offers a now-playing endpoint.
//
//   /primary            stream (can be switched off to demonstrate failover)
//   /backup             stream
//   /nowplaying.json    current title, artist and artwork
//   /control?primary=down|up
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT) || 8000;
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, 'audio');
const BYTES_PER_SECOND = 12000; // 96 kbps
const METAINT = 8192;
const TRACKS = [
  { artist: 'The Test Tones', title: 'Four Forty' },
  { artist: 'Sine Wave Collective', title: 'Looping Forever' },
  { artist: 'DJ Loopback', title: 'Localhost Nights' },
];

const audio = {
  primary: fs.readFileSync(path.join(AUDIO_DIR, 'primary.mp3')),
  backup: fs.readFileSync(path.join(AUDIO_DIR, 'backup.mp3')),
};
const listeners = { primary: new Set(), backup: new Set() };
let primaryUp = true;

const track = () => TRACKS[Math.floor(Date.now() / 20000) % TRACKS.length];

function metadataBlock(text) {
  const body = Buffer.from(`StreamTitle='${text}';`);
  const blocks = Math.ceil(body.length / 16);
  const out = Buffer.alloc(1 + blocks * 16);
  out[0] = blocks;
  body.copy(out, 1);
  return out;
}

function stream(name, req, res) {
  const withMeta = req.headers['icy-metadata'] === '1';
  const headers = {
    'Content-Type': 'audio/mpeg',
    'icy-name': `Demo Station (${name})`,
    'icy-genre': 'Test Tones',
    'icy-br': '96',
    'Cache-Control': 'no-cache',
  };
  if (withMeta) headers['icy-metaint'] = String(METAINT);
  res.writeHead(200, headers);

  const data = audio[name];
  let offset = 0;
  let untilMeta = METAINT;
  let lastTitle = null;
  const timer = setInterval(() => {
    let wanted = BYTES_PER_SECOND / 10;
    const parts = [];
    while (wanted > 0) {
      let n = Math.min(wanted, data.length - offset);
      if (withMeta) n = Math.min(n, untilMeta);
      parts.push(data.subarray(offset, offset + n));
      offset = (offset + n) % data.length;
      wanted -= n;
      if (withMeta && (untilMeta -= n) === 0) {
        const now = track();
        const title = `${now.artist} - ${now.title}`;
        parts.push(title === lastTitle ? Buffer.from([0]) : metadataBlock(title));
        lastTitle = title;
        untilMeta = METAINT;
      }
    }
    res.write(Buffer.concat(parts));
  }, 100);

  listeners[name].add(res);
  res.on('close', () => {
    clearInterval(timer);
    listeners[name].delete(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://demo');
  if (url.pathname === '/primary') {
    if (!primaryUp) {
      res.writeHead(503);
      return res.end('primary is switched off');
    }
    return stream('primary', req, res);
  }
  if (url.pathname === '/backup') return stream('backup', req, res);
  if (url.pathname === '/nowplaying.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...track(), artwork: '/artwork.svg' }));
  }
  if (url.pathname === '/artwork.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2563eb"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="4"/><circle cx="32" cy="32" r="4" fill="#fff"/></svg>');
  }
  if (url.pathname === '/control') {
    const wanted = url.searchParams.get('primary');
    if (wanted === 'down') {
      primaryUp = false;
      for (const client of listeners.primary) client.destroy();
    } else if (wanted === 'up') primaryUp = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ primary: primaryUp ? 'up' : 'down', connections: { primary: listeners.primary.size, backup: listeners.backup.size } }));
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => console.log(`demo source listening on ${PORT}`));
