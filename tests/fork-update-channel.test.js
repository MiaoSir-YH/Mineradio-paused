'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const pkg = require('../package.json');

function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from);
  return source.slice(from, to);
}

test('the configured update and publish channel stays on this fork despite inherited upstream environment', () => {
  assert.equal(pkg.mineradio.update.disabled, false);
  assert.equal(pkg.mineradio.update.provider, 'github');
  assert.equal(pkg.mineradio.update.owner, 'MiaoSir-YH');
  assert.equal(pkg.mineradio.update.repo, 'Mineradio-paused');
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'MiaoSir-YH', repo: 'Mineradio-paused' }]);
  const ctx = vm.createContext({ process: { env: { GITHUB_REPOSITORY: 'fixture/upstream', MINERADIO_UPDATE_OWNER: 'fixture', MINERADIO_UPDATE_REPO: 'upstream', MINERADIO_UPDATE_MANIFEST: 'https://example.invalid/manifest.json' } } });
  vm.runInContext(section('function parseGitHubRepository(', 'function buildMirrorUrl('), ctx);
  const current = ctx.readUpdateConfig(pkg);
  assert.equal(current.disabled, false); assert.equal(current.configured, true);
  assert.equal(current.owner, 'MiaoSir-YH'); assert.equal(current.repo, 'Mineradio-paused');
  assert.equal(current.manifest, ''); assert.equal(current.mirrors.length, 0);
  for (const input of [{}, { mineradio: { update: { disabled: true, provider: 'github', owner: 'fixture', repo: 'upstream' } } }]) {
    const config = ctx.readUpdateConfig(input);
    assert.equal(config.disabled, true);
    assert.equal(config.configured, false);
    assert.equal(config.owner, ''); assert.equal(config.repo, ''); assert.equal(config.manifest, '');
    assert.equal(config.mirrors.length, 0);
  }
});

test('GitHub release discovery uses the current fork and ignores upstream or cloud download links', async () => {
  const calls = [];
  const ctx = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    UPDATE_CONFIG: { configured: true, provider: 'github', owner: 'MiaoSir-YH', repo: 'Mineradio-paused' },
    APP_VERSION: '2.2.1', UPDATE_FALLBACK_NOTES: ['当前项目发布页'],
    fetch: async url => {
      calls.push(url);
      return { ok: true, json: async () => ({ tag_name: 'v2.2.2+main.277f9a6', html_url: 'https://github.com/fixture/upstream/releases/tag/v2.2.2', body: '## 更新内容\n- 修复播放\n<!-- mineradio-download-page: 网盘|https://example.invalid/old-share -->' }) };
    },
  });
  vm.runInContext(section('function normalizeVersion(', 'async function readUpdateManifest(') + '\n' + section('async function fetchLatestUpdateInfo(', 'function readRequestBody('), ctx);
  const result = await ctx.fetchLatestUpdateInfo();
  assert.deepEqual(calls, ['https://api.github.com/repos/MiaoSir-YH/Mineradio-paused/releases/latest']);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.release.tagName, 'v2.2.2+main.277f9a6');
  assert.equal(result.release.htmlUrl, 'https://github.com/MiaoSir-YH/Mineradio-paused/releases/tag/v2.2.2%2Bmain.277f9a6');
  assert.equal(result.release.downloadPageUrl, result.release.htmlUrl);
  assert.equal(result.release.downloadPages.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture\/upstream|example\.invalid/);
  const manifest = ctx.normalizeManifestUpdateInfo({ latestVersion: '2.2.2', release: { htmlUrl: 'https://example.invalid/release', externalUrl: 'https://example.invalid/share', downloadPages: [{ url: 'https://example.invalid/share' }] } });
  assert.equal(manifest.release.htmlUrl, 'https://github.com/MiaoSir-YH/Mineradio-paused/releases/tag/v2.2.2');
  assert.equal(manifest.release.downloadPages.length, 0);
  assert.doesNotMatch(JSON.stringify(manifest), /example\.invalid/);
});

test('disabled latest-update compatibility responses contain no release or external links and never fetch', async () => {
  let fetched = 0;
  const network = () => { fetched++; throw new Error('network must not run'); };
  const ctx = vm.createContext({
    UPDATE_CONFIG: { disabled: true, configured: true, provider: 'github', owner: 'fixture', repo: 'upstream', manifest: 'https://example.invalid/manifest.json' },
    APP_VERSION: pkg.version, fetch: network, fetchManifestUpdateInfo: network, fetchLatestYmlUpdateInfo: network,
  });
  vm.runInContext(section('function localUpdateFallback(', 'function updateError(') + '\n' + section('async function fetchLatestUpdateInfo(', 'function readRequestBody('), ctx);
  const result = await ctx.fetchLatestUpdateInfo();
  assert.equal(fetched, 0);
  assert.equal(result.disabled, true);
  assert.equal(result.configured, false);
  assert.equal(result.provider, 'none');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.currentVersion, pkg.version);
  assert.equal(result.release, null);
  assert.doesNotMatch(JSON.stringify(result), /https?:/);
});

test('retired download and patch endpoints return gone without directing clients to another download', async () => {
  const body = section("  if (\n    pn === '/api/update/download'", "  if (pn === '/api/beatmap/cache/status')");
  for (const route of ['/api/update/download', '/api/update/download/status', '/api/update/patch', '/api/update/patch/status']) {
    let response;
    const ctx = vm.createContext({ pn: route, res: {}, sendJSON: (_res, value, status) => { response = { value, status }; } });
    await vm.runInContext('(async () => {' + body + '})()', ctx);
    assert.equal(response.status, 410);
    assert.equal(response.value.error, 'UPDATE_DISABLED');
    assert.equal(response.value.disabled, true);
    assert.equal(response.value.externalOnly, undefined);
    assert.doesNotMatch(JSON.stringify(response.value), /https?:|外部下载页面/);
  }
});
