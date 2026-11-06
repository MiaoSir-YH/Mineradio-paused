'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

const serverText = read('server.js');
const htmlText = read('public/index.html');

test('the fork exposes a single Release action and keeps its local music controls', () => {
  assert.match(htmlText, /id="update-entry"[^>]*\bhidden>/);
  assert.match(htmlText, /id="update-modal"/);
  assert.match(htmlText, /onclick="openUpdateReleasePage\(\)">前往项目发布页<\/button>/);
  assert.doesNotMatch(htmlText, /id="update-download-sources"|下载线路|赞助|作者支持|QQ群/);
  assert.doesNotMatch(read('public/css/index.css'), /(?:[.#])update-(?:download-source|progress-ring)/);
  assert.match(read('public/js/index-loader.js'), /00-update-preview\.js/);
  assert.match(read('public/js/modules/10-shell/05-startup-bindings.js'), /setTimeout\(initUpdatePreview,/);
  assert.match(read('public/js/modules/08-account/01-login-modal-utils.js'), /\['update-modal', closeUpdatePanel\]/);
  assert.match(htmlText, /id="visual-guide-btn"/);
  assert.match(htmlText, /id="file-input"/);
});

test('removed local update routes stay disabled and their workers stay absent', () => {
  assert.match(serverText, /pn === '\/api\/update\/download'/);
  assert.match(serverText, /pn === '\/api\/update\/patch'/);
  assert.match(serverText, /error:\s*'UPDATE_DISABLED'/);
  assert.match(serverText, /\},\s*410\);/);
  assert.doesNotMatch(serverText, /startUpdateDownloadJob/);
  assert.doesNotMatch(serverText, /startUpdatePatchJob/);
  assert.doesNotMatch(serverText, /updateDownloadJobs/);
  assert.doesNotMatch(serverText, /PATCH_ALLOWED/);
  assert.doesNotMatch(serverText, /UPDATE_DOWNLOAD_DIR/);
  assert.doesNotMatch(serverText, /pickPatchAsset/);
});
