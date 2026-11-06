'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { openPublicMedia, collectMedia, pipeMedia, fetchPublicMedia } = require('../desktop/media-http');

test('media transport rejects local, reserved, mapped and non-HTTP destinations before connecting', async () => {
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'http://0.0.0.0/', 'file:///fixture', 'ftp://example.com/', 'http://user:password@example.com/']) {
    await assert.rejects(openPublicMedia(url), /MEDIA_/, url);
  }
});

test('DNS addresses are checked and the exact validated lookup result is used for connection', async t => {
  let lookups = 0;
  let privateAnswer = false;
  t.mock.method(dns, 'lookup', (_host, options, callback) => {
    lookups++;
    assert.equal(options.all, true);
    callback(null, [{ address: privateAnswer ? '127.0.0.1' : '93.184.216.34', family: 4 }]);
  });
  t.mock.method(http, 'get', (url, options, callback) => {
    assert.equal(url.hostname, 'media.example');
    assert.equal(options.agent, false);
    const request = new EventEmitter();
    process.nextTick(() => options.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) return request.emit('error', error);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      const response = new PassThrough(); response.statusCode = 200; response.headers = {};
      callback(response); response.end();
    }));
    request.destroy = error => request.emit('error', error);
    return request;
  });
  (await openPublicMedia('http://media.example/song.mp3')).destroy();
  assert.equal(lookups, 1);
  privateAnswer = true;
  await assert.rejects(openPublicMedia('http://media.example/song.mp3'), /MEDIA_ADDRESS_NOT_PUBLIC/);
});

test('redirects are revalidated before the next connection', async t => {
  let connections = 0;
  t.mock.method(http, 'get', (_url, _options, callback) => {
    connections++;
    const req = new EventEmitter();
    const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'http://127.0.0.1/private' };
    process.nextTick(() => callback(res));
    req.destroy = error => req.emit('error', error);
    return req;
  });
  await assert.rejects(openPublicMedia('http://93.184.216.34/song'), /MEDIA_ADDRESS_NOT_PUBLIC/);
  assert.equal(connections, 1);
});

function response(headers = {}) {
  const stream = new PassThrough(); stream.statusCode = 206; stream.headers = headers;
  stream.setTimeout = () => {};
  return stream;
}
test('buffered and streamed media enforce byte limits and reject unsolicited compression', async () => {
  const knownLarge = response({ 'content-length': '11' });
  await assert.rejects(collectMedia(knownLarge, 10), /MEDIA_RESPONSE_NOT_ALLOWED/);
  assert.equal(knownLarge.destroyed, true);
  const encoded = response({ 'content-encoding': 'gzip' });
  await assert.rejects(collectMedia(encoded, 10), /MEDIA_RESPONSE_NOT_ALLOWED/);
  const unknownSize = response(); unknownSize.end('01234567890');
  await assert.rejects(collectMedia(unknownSize, 10), /MEDIA_BODY_TOO_LARGE/);
  const normal = response(); normal.end('0123456789');
  assert.equal((await collectMedia(normal, 10)).toString(), '0123456789');
  const source = response(); source.end('01234567890');
  const destination = new Writable({ write(_chunk, _encoding, done) { done(); } });
  destination.writeHead = () => {};
  await assert.rejects(pipeMedia(source, destination, 10, {}), /MEDIA_BODY_TOO_LARGE/);
  assert.equal(destination.destroyed, true);
});

test('streaming preserves bytes and range status with downstream backpressure', async () => {
  const source = response(); const chunks = [];
  const destination = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { chunks.push(chunk); setImmediate(done); } });
  destination.writeHead = (status, headers) => { assert.equal(status, 206); assert.equal(headers['Content-Range'], 'bytes 0-9/10'); };
  const pending = pipeMedia(source, destination, 10, { 'Content-Range': 'bytes 0-9/10' });
  source.write('01234'); source.end('56789');
  await pending;
  assert.equal(Buffer.concat(chunks).toString(), '0123456789');
});

test('offline decoder transport checks HEAD requests and cancels upstream when its Web Stream reader stops', async t => {
  const streams = []; const methods = [];
  let contentType = 'audio/mpeg';
  t.mock.method(http, 'get', (_url, options, callback) => {
    methods.push(options.method);
    const req = new EventEmitter(); const res = response({ 'content-type': contentType, 'content-length': '10' });
    res.statusCode = 200; streams.push(res);
    process.nextTick(() => { callback(res); if (options.method !== 'HEAD' && !res.destroyed) res.write('01234'); });
    req.destroy = error => req.emit('error', error);
    return req;
  });
  const head = await fetchPublicMedia('http://93.184.216.34/song', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.body, null);
  assert.equal(streams[0].destroyed, true);
  const body = await fetchPublicMedia('http://93.184.216.34/song');
  const reader = body.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), '01234');
  await reader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(streams[1].destroyed, true);
  assert.deepEqual(methods, ['HEAD', 'GET']);
  contentType = 'text/html';
  await assert.rejects(fetchPublicMedia('http://93.184.216.34/song'), /MEDIA_RESPONSE_NOT_ALLOWED/);
  assert.equal(streams[2].destroyed, true);
});
