// Asks a streaming server to try a stream or a title address, so that a
// station's owner can see what the gateway reads from it before saving.
//
// The request goes to the engines through Redis and whichever is free takes
// it. The engine fetches the address through the same guard as any source, so
// this cannot be used to reach addresses the gateway would not play.

const crypto = require('crypto');
const { redis } = require('./cache');
const stations = require('./stations');
const { HttpError } = require('./errors');

const WAIT_MS = 12000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Plain words for what an engine reports when an address cannot be used.
function explain(kind, result) {
  if (result.ok) return result;
  const what = kind === 'titles' ? 'title address' : 'stream';
  const raw = String(result.error || 'no reason was given');
  const status = raw.match(/HTTP (\d{3})/);
  const reason = /refused/i.test(raw) ? 'nothing is answering at that address (the connection was refused)'
    : /timed out/i.test(raw) ? 'it did not answer in time'
      : /dns|resolve|lookup|name or service/i.test(raw) ? 'that name could not be found. Check the spelling of the address'
        : /certificate|tls|ssl/i.test(raw) ? 'its HTTPS certificate was not accepted'
          : status ? `the server answered with error ${status[1]}`
            : raw.replace(/\.$/, '');
  return { ok: false, error: `The ${what} could not be read: ${reason}.`, detail: raw };
}

async function run(kind, url) {
  if (!(await stations.activeNodes()).length) {
    throw new HttpError(503, 'no_streaming_server', 'No streaming server is running to try the address with. Try again in a moment.');
  }
  const id = crypto.randomBytes(12).toString('hex');
  await redis.multi()
    .rPush('probe:requests', JSON.stringify({ id, kind, url, at: Math.floor(Date.now() / 1000) }))
    // Requests nobody took are not left to pile up.
    .expire('probe:requests', 30)
    .exec();
  const key = `probe:result:${id}`;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const raw = await redis.get(key);
    if (!raw) continue;
    await redis.del(key);
    return explain(kind, JSON.parse(raw));
  }
  throw new HttpError(504, 'probe_timeout', 'The streaming server did not answer in time. Try again.');
}

module.exports = { run };
