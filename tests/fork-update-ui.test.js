'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/08-account/00-update-preview.js'), 'utf8');
const releaseUrl = 'https://github.com/MiaoSir-YH/Mineradio-paused/releases/tag/v2.2.2%2Bmain.1234567';

function renderer(payload) {
  const nodes = {
    'update-entry': { hidden: true },
    'update-modal': {},
    'update-modal-version': { textContent: '' },
  };
  const opened = [];
  const context = vm.createContext({
    URL,
    document: { getElementById: (id) => nodes[id] || null },
    apiJson: async (url) => { assert.equal(url, '/api/update/latest'); return payload; },
    window: {
      desktopWindow: { openExternalUrl: async (url) => { opened.push(url); return { ok: true }; } },
    },
    openGsapModal: (node) => { node.open = true; },
    closeGsapModal: (node) => { node.open = false; },
    showToast: (message) => assert.fail(message),
  });
  vm.runInContext(source, context);
  return { context, nodes, opened };
}

test('a new version opens only the current fork Release and ignores other download fields', async () => {
  const { context, nodes, opened } = renderer({
    updateAvailable: true,
    currentVersion: '2.2.1',
    latestVersion: '2.2.2+main.1234567',
    release: {
      htmlUrl: releaseUrl + '?source=fixture#assets',
      downloadPageUrl: 'https://example.invalid/old-download',
      downloadPages: [{ label: 'Legacy', url: 'https://example.invalid/old-download' }],
    },
  });
  await context.initUpdatePreview();
  assert.equal(nodes['update-entry'].hidden, false);
  assert.equal(nodes['update-modal-version'].textContent, '当前版本 2.2.1 · 最新版本 2.2.2+main.1234567');
  context.openUpdatePanel();
  assert.equal(nodes['update-modal'].open, true);
  await context.openUpdateReleasePage();
  assert.deepEqual(opened, [releaseUrl]);
  assert.equal(nodes['update-modal'].open, false);
});

test('foreign releases and older versions do not show or open an update entry', async () => {
  const payload = { updateAvailable: true, release: {} };
  const { context, nodes, opened } = renderer(payload);
  for (const htmlUrl of [
    'https://github.com/upstream/Mineradio/releases/latest',
    'https://github.com/MiaoSir-YH/Mineradio-paused/issues/123',
    'https://github.com.evil.invalid/MiaoSir-YH/Mineradio-paused/releases',
    'https://user@github.com/MiaoSir-YH/Mineradio-paused/releases',
    'http://github.com/MiaoSir-YH/Mineradio-paused/releases',
  ]) {
    payload.release = { htmlUrl, downloadPageUrl: releaseUrl };
    await context.initUpdatePreview();
    assert.equal(nodes['update-entry'].hidden, true);
    context.openUpdatePanel();
    await context.openUpdateReleasePage();
    assert.equal(nodes['update-modal'].open, undefined);
  }
  payload.updateAvailable = false;
  payload.release = { htmlUrl: releaseUrl };
  await context.initUpdatePreview();
  assert.equal(nodes['update-entry'].hidden, true);
  assert.deepEqual(opened, []);
});
