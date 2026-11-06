'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('update candidates retry invalid, oversized and stalled bodies and require valid release metadata', async t => {
  const visited = [];
  const server = http.createServer((req, res) => {
    visited.push(req.url);
    if (req.url === '/html') { res.end('<html>unavailable</html>'); return; }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Length': 300000 }); res.end(); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('version: '); return; }
    res.end('version: 9.8.7\nreleaseDate: 2026-11-06T00:00:00Z\n');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = vm.createContext({
    fetch, AbortController, Buffer, setTimeout, clearTimeout, APP_VERSION: '2.2.2',
    UPDATE_CONFIG: { configured: true, provider: 'github', owner: 'fixture', repo: 'fixture' },
    normalizeVersion: value => value.replace(/^v/, ''), compareVersions: () => 1,
    updateError: (code, message) => Object.assign(new Error(message || code), { code }),
    classifyUpdateError: error => ({ reason: error.message }),
  });
  vm.runInContext(source.slice(source.indexOf('function configuredUpdateReleaseUrl('), source.indexOf('function cleanReleaseLine(')) + '\n' + source.slice(source.indexOf('async function fetchTextFromCandidates('), source.indexOf('async function fetchLatestYmlUpdateInfo(')), context);
  const base = 'http://127.0.0.1:' + server.address().port;
  const candidates = ['/html', '/large', '/slow', '/valid'].map(route => ({ url: base + route, label: route }));
  const result = await context.fetchTextFromCandidates(candidates, 100, text => context.parseLatestYmlUpdateInfo(text, 'test'));
  assert.deepEqual(visited, ['/html', '/large', '/slow', '/valid']);
  assert.equal(result.value.latestVersion, '9.8.7');
  assert.equal(result.candidate.label, '/valid');
  for (const invalid of ['', '<html>error</html>', 'version: nonsense', 'version: 2.2.2\nreleaseDate: not-a-date']) {
    assert.throws(() => context.parseLatestYmlUpdateInfo(invalid), /version|date/i);
  }
  await assert.rejects(context.fetchTextFromCandidates(candidates.slice(0, 1), 100, text => context.parseLatestYmlUpdateInfo(text)), /html/);
});

test('a late NetEase invalid-session reply cannot clear the newly selected account', async () => {
  const pending = deferred(); const cookies = []; const writes = [];
  const context = vm.createContext({
    userCookie: 'account-A', neteaseSessionGeneration: 1,
    login_status: async options => { cookies.push(options.cookie); return { body: {} }; },
    user_account: options => { cookies.push(options.cookie); return pending.promise; },
    promiseWithTimeout: promise => promise,
    normalizeLoginInfo: () => ({ loggedIn: false }),
    isNeteaseAuthInvalidPayload: () => true,
    saveCookie: cookie => writes.push(cookie), console: { warn() {} },
  });
  vm.runInContext(source.slice(source.indexOf('async function fetchNeteaseLoginInfo('), source.indexOf('const NETEASE_LOGIN_INFO_CACHE_TTL_MS')), context);
  const result = context.fetchNeteaseLoginInfo();
  await new Promise(resolve => setImmediate(resolve));
  context.userCookie = 'account-B'; context.neteaseSessionGeneration++;
  pending.resolve({ body: { code: 401 } }); await result;
  assert.deepEqual(cookies, ['account-A', 'account-A']);
  assert.deepEqual(writes, []);
  assert.equal(context.userCookie, 'account-B');
});

test('an old NetEase cache completion joins the current session and does not clear its in-flight request', async () => {
  const requests = { A: deferred(), B: deferred() }; let calls = 0;
  const context = vm.createContext({
    userCookie: 'A', neteaseSessionGeneration: 1,
    fetchNeteaseLoginInfo: () => { calls++; return requests[context.userCookie].promise; },
  });
  vm.runInContext(source.slice(source.indexOf('const NETEASE_LOGIN_INFO_CACHE_TTL_MS'), source.indexOf('async function getPlaybackLoginInfo(')), context);
  const old = context.getLoginInfo();
  context.userCookie = 'B'; context.neteaseSessionGeneration++;
  context.clearNeteaseLoginInfoCache();
  const current = context.getLoginInfo();
  requests.A.resolve({ userId: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  const shared = context.getLoginInfo();
  assert.equal(calls, 2);
  requests.B.resolve({ userId: 'B' });
  assert.equal((await old).userId, 'B');
  assert.equal((await current).userId, 'B');
  assert.equal((await shared).userId, 'B');
});

test('NetEase QR confirmation is invalidated by logout before either upstream check or profile lookup finishes', async () => {
  const start = source.indexOf("  if (pn === '/api/login/qr/check')");
  const end = source.indexOf("  if (pn === '/api/login/status')", start);
  for (const stage of ['upstream', 'profile', 'normal']) {
    const upstream = deferred(); const profile = deferred(); let saved = 0; let result;
    const context = vm.createContext({
      pn: '/api/login/qr/check', url: new URL('http://localhost/api/login/qr/check?key=fixture-key'), res: {},
      neteaseQrGeneration: 1, neteaseActiveQrKey: 'fixture-key', neteaseSessionGeneration: 1,
      login_qr_check: () => upstream.promise, readCookieFromResponse: () => 'fixture-session',
      saveCookie: () => { saved++; context.neteaseSessionGeneration++; context.neteaseQrGeneration++; context.neteaseActiveQrKey = ''; },
      getLoginInfo: () => profile.promise,
      sendJSON: (_res, value) => { result = value; }, console,
    });
    const pending = vm.runInContext('(async () => {' + source.slice(start, end) + '})()', context);
    if (stage === 'upstream') { context.neteaseQrGeneration++; context.neteaseActiveQrKey = ''; }
    upstream.resolve({ body: { code: 803 } });
    await new Promise(resolve => setImmediate(resolve));
    if (stage === 'profile') context.neteaseSessionGeneration++;
    profile.resolve({ loggedIn: true, userId: 'fixture-user' });
    await pending;
    assert.equal(result.code, stage === 'normal' ? 803 : 800, stage);
    assert.equal(saved, stage === 'upstream' ? 0 : 1, stage);
  }
});
