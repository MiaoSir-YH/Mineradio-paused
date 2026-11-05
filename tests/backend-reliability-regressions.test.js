'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function extract(file, from, to, name, globals = {}) {
  const source = read(file), start = source.indexOf(from), end = source.indexOf(to, start);
  assert(start >= 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + '\n' + name, globals);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('QQ HTTP helper settles interrupted bodies and enforces a total deadline', async t => {
  const requestText = extract('server.js', 'function requestText(', '\nasync function requestJson', 'requestText', { http, https, URL, Buffer, setTimeout, clearTimeout });
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.end('complete'); return; }
    if (req.url === '/denied') { res.writeHead(403); res.end('denied'); return; }
    res.writeHead(200, { 'Content-Length': 100000 });
    res.write('partial');
    if (req.url === '/abort') { setTimeout(() => res.destroy(), 15); return; }
    const interval = setInterval(() => res.write('more'), 10);
    res.on('close', () => clearInterval(interval));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await requestText(base + '/ok', { timeoutMs: 500 }), 'complete');
  await assert.rejects(requestText(base + '/abort', { timeoutMs: 500 }), { code: 'ECONNRESET' });
  await assert.rejects(requestText(base + '/slow', { timeoutMs: 70 }), { code: 'ETIMEDOUT' });
  await assert.rejects(requestText(base + '/denied', { timeoutMs: 500 }), error => error.statusCode === 403 && error.body === 'denied');
});

test('decrypted audio supports suffix, open-ended, bounded and unsatisfiable byte ranges', () => {
  const send = extract('server.js', 'function sendAudioBuffer(', '\nfunction audioContentTypeForUrl', 'sendAudioBuffer');
  function response(range, data = '0123456789') {
    const res = { writeHead(status, headers) { Object.assign(this, { status, headers }); }, end(body) { this.body = body && body.toString(); } };
    send(res, Buffer.from(data), 'audio/mp4', range);
    return res;
  }
  for (const [range, body, contentRange] of [
    ['bytes=-4', '6789', 'bytes 6-9/10'], ['bytes=-40', '0123456789', 'bytes 0-9/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=8-99', '89', 'bytes 8-9/10']
  ]) {
    const res = response(range);
    assert.equal(res.status, 206, range); assert.equal(res.body, body, range);
    assert.equal(res.headers['Content-Range'], contentRange); assert.equal(res.headers['Content-Length'], body.length);
  }
  for (const range of ['bytes=-0', 'bytes=-', 'bytes=10-', 'bytes=9-2', 'bytes=-9007199254740992']) {
    const res = response(range); assert.equal(res.status, 416, range); assert.equal(res.headers['Content-Range'], 'bytes */10');
  }
  assert.equal(response('bytes=-1', '').status, 416);
  assert.equal(response('').status, 200);
});

test('clearing a library cache rejects stale refill and preserves a newer in-flight request', async () => {
  const createCache = extract('qishui-api.js', 'function createTtlCache(', '\nconst qishuiSearchCache', 'createTtlCache', { Map, Date, Promise });
  const cache = createCache(24, 90000), old = deferred(), fresh = deferred();
  const staleRequest = cache.wrap('library', 90000, () => old.promise);
  await Promise.resolve(); cache.clear();
  let reads = 0;
  const freshRequest = cache.wrap('library', 90000, () => { reads++; return fresh.promise; });
  await Promise.resolve(); old.resolve('old songs'); await staleRequest;
  assert.equal(cache.get('library'), null);
  const shared = cache.wrap('library', 90000, () => { reads++; return 'unexpected duplicate'; });
  await Promise.resolve(); assert.equal(reads, 1);
  fresh.resolve('new songs'); assert.equal(await freshRequest, 'new songs'); assert.equal(await shared, 'new songs');
  assert.equal(cache.get('library'), 'new songs');
  await cache.wrap('no-cache', 0, () => 'short lived'); assert.equal(cache.get('no-cache'), null);
});

test('Qishui song URL selection honors requested quality through the public handler', async t => {
  const api = require('../qishui-api');
  api._test.clearQishuiRuntimeCaches();
  t.after(() => api._test.clearQishuiRuntimeCaches());
  t.mock.method(https, 'request', (target, options, callback) => {
    const req = new EventEmitter(); req.write = () => {}; req.destroy = error => req.emit('error', error);
    req.end = () => process.nextTick(() => {
      assert.equal(new URL(target).pathname, '/luna/pc/track_v2');
      const payload = { data: {
        user_membership: { is_vip: true, vip_end_time: Math.floor(Date.now() / 1000) + 3600 },
        track: { id: 'quality-fixture', duration_ms: 180000, audio_info: { play_info_list: [
          { main_play_url: 'https://fixture.invalid/standard.m4a', duration: 180, bitrate: 128000, quality: 'standard', format: 'm4a' },
          { main_play_url: 'https://fixture.invalid/lossless.flac', duration: 180, bitrate: 999000, quality: 'lossless', format: 'flac' }
        ] } }
      } };
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      callback(res); res.emit('data', Buffer.from(JSON.stringify(payload))); res.emit('end');
    });
    return req;
  });
  for (const [quality, extension] of [['standard', 'standard.m4a'], ['exhigh', 'standard.m4a'], ['lossless', 'lossless.flac']]) {
    const result = await api.handleQishuiSongUrl({ id: 'quality-fixture', quality }, 'sessionid=synthetic; sid_tt=synthetic');
    assert.equal(result.url, 'https://fixture.invalid/' + extension, quality);
    assert.equal(result.playable, true);
  }
});
