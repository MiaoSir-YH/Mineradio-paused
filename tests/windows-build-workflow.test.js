'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/release-windows.yml'), 'utf8'));
const build = workflow.jobs.installer;
const publish = workflow.jobs['publish-draft'];

test('main builds its pushed commit with read-only permissions and never publishes a release', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.push.paths, undefined, 'application changes must also trigger a build');
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(build.permissions?.contents, undefined);
  const checkout = build.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.sha }}");
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(build.env.GH_TOKEN, undefined);
  for (const step of build.steps) {
    if (/gh release/.test(step.run || '')) assert.equal(step.if, "github.event_name == 'workflow_dispatch'");
    assert.doesNotMatch(step.run || '', /gh release (?:upload|create|edit|delete)/);
    if (/npm run build:win/.test(step.run || '')) assert.match(step.run, /--publish never/);
  }
  assert.equal(publish.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(publish.needs, 'installer');
  assert.equal(publish.permissions.contents, 'write');
});

test('manual publishing consumes the same build artifacts and the recorded source commit', () => {
  const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, '.');
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const artifact of ['dist/*-Setup.exe', 'dist/*-Setup.exe.sha256', 'dist/*-build-info.json', 'regression-tests.tap', 'native-media-smoke.log']) {
    assert(upload.with.path.split('\n').includes(artifact), artifact);
  }
  assert.equal(build.outputs.source_sha, '${{ steps.source.outputs.sha }}');
  assert.equal(publish.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ needs.installer.outputs.source_sha }}');
});

test('release upload generates metadata only for stable drafts and refuses published releases', { skip: process.platform !== 'win32' }, t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-workflow-test-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const upload = publish.steps.find(step => /gh release upload/.test(step.run || ''));
  const fakeGh = `param([string]$Mode)
function gh {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
  $global:LASTEXITCODE = 0
  if ($CommandArgs[1] -eq 'view') {
    return (@{ isDraft = ($Mode -ne 'published'); isPrerelease = ($Mode -eq 'preview') } | ConvertTo-Json -Compress)
  }
  if ($CommandArgs[1] -ne 'upload') { throw 'Unexpected gh action' }
  ConvertTo-Json -InputObject $CommandArgs | Set-Content -LiteralPath uploads.json -Encoding utf8
}
`;
  for (const mode of ['stable', 'preview', 'published']) {
    const cwd = path.join(fixtureRoot, mode);
    fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"2.2.2"}');
    fs.writeFileSync(path.join(cwd, 'upload.ps1'), fakeGh + upload.run);
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(cwd, 'upload.ps1'), mode], {
      cwd, env: { ...process.env, RELEASE_TAG: 'v2.2.2' }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.ifError(result.error);
    if (mode === 'published') {
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(cwd, 'uploads.json')), false);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    const assets = JSON.parse(fs.readFileSync(path.join(cwd, 'uploads.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(assets.includes('dist/latest.yml'), mode === 'stable');
    const metadataPath = path.join(cwd, 'dist/latest.yml');
    assert.equal(fs.existsSync(metadataPath), mode === 'stable');
    if (mode === 'stable') {
      const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
      assert.equal(metadata.version, '2.2.2');
      assert.match(metadata.releaseDate, /^\d{4}-\d{2}-\d{2}T.+Z$/);
    }
  }
});
