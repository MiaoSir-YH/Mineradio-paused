'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalRequestSecurity } = require('../desktop/local-request-security');

test('local session credentials are bound to the app and cannot authorize cross-origin requests', () => {
  const gate = createLocalRequestSecurity();
  const request = (headers = {}, url = '/api/login/status') => gate.inspect({ method: 'GET', url, headers: { host: '127.0.0.1:3000', ...headers } }, 3000);
  assert.equal(request().status, 401);
  assert.ok(request(gate.getHeaders()).url);
  for (const headers of [
    { origin: 'https://unrelated.example' }, { origin: 'null' },
    { origin: 'http://127.0.0.1:3001' }, { host: 'unrelated.example:3000' },
    { host: '127.0.0.1:3001' }, { referer: 'http://127.0.0.1:3001/' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(request({ ...gate.getHeaders(), ...headers }).status, 403);
  assert.equal(request({ 'x-mineradio-token': 'é'.repeat(64) }).status, 401);
  assert.equal(request(createLocalRequestSecurity().getHeaders()).status, 401);
  for (const value of ['//[', 'http://127.0.0.1:3000/api', '/\\outside', '/bad url']) assert.equal(request({}, value).status, 400);
  assert.ok(request({}, '/').url);
});

test('standalone browser entry exchanges its one-use link for a strict HttpOnly session', () => {
  const gate = createLocalRequestSecurity({ standalone: true });
  const entry = new URL(gate.bootstrapUrl(3100));
  const req = { method: 'GET', url: entry.pathname + entry.search, headers: { host: entry.host } };
  const result = gate.inspect(req, 3100);
  assert.equal(result.status, 303);
  assert.match(result.cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(gate.bootstrapUrl(3100), '');
  assert.equal(gate.inspect(req, 3100).cookie, undefined);
  const headers = { ...req.headers, cookie: result.cookie, 'sec-fetch-site': 'same-origin' };
  assert.ok(gate.inspect({ method: 'GET', url: '/api/login/status', headers }, 3100).url);
  assert.equal(gate.inspect({ method: 'GET', url: '/api/login/status', headers: { ...headers, origin: 'http://127.0.0.1:3101' } }, 3100).status, 403);
  assert.equal(createLocalRequestSecurity().inspect({ method: 'GET', url: '/api/login/status', headers }, 3100).status, 401);
});

test('HTTP routes reject unauthenticated reads, GET mutations and malformed requests while remaining available', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-http-test-'));
  const environment = {
    PORT: '0', HOST: '127.0.0.1',
    COOKIE_FILE: path.join(directory, 'netease'), QQ_COOKIE_FILE: path.join(directory, 'qq'),
    KUGOU_COOKIE_FILE: path.join(directory, 'kugou'), QISHUI_COOKIE_FILE: path.join(directory, 'qishui'),
    MINERADIO_LOGIN_EASTER_EGG_GATE_FILE: path.join(directory, 'locked.json'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const server = require('../server');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(environment)) {
      if (previous[key] == null) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  assert.equal(server.address().address, '127.0.0.1');
  const port = server.address().port;
  const request = (pathname, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks = [];
      res.on('data', x => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
  const headers = server.getLocalRequestHeaders();
  assert.equal((await request('/api/login/status')).status, 401);
  assert.equal((await request('/api/app/version', headers)).status, 200);
  for (const route of ['/api/logout', '/api/qishui/logout', '/api/song/like', '/api/playlist/create', '/api/playlist/add-song', '/api/album/subscribe', '/api/playlist/subscribe', '/api/song/comments/like', '/api/login/qr/key']) {
    assert.equal((await request(route, headers)).status, 405, route);
  }
  assert.equal((await request('/api/login/qr/key', headers, 'POST')).status, 423);
  assert.equal((await request('/api/login/status', { ...headers, origin: 'http://127.0.0.1:1' })).status, 403);
  for (const malformed of ['//[', 'http://invalid.example/']) assert.equal((await request(malformed)).status, 400);
  for (const kind of ['cover', 'audio']) {
    const blocked = await request('/api/' + kind + '?url=' + encodeURIComponent('http://127.0.0.1:' + port + '/'), headers);
    assert.equal(blocked.status, 502);
    assert.equal(blocked.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request('/api/app/version', headers)).status, 200, 'invalid input must not stop the HTTP listener');
});
