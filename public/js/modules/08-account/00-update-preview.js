var updateReleaseUrl = '';

function forkReleasePageUrl(value) {
  try {
    var url = new URL(String(value || ''));
    if (url.origin !== 'https://github.com' || url.username || url.password) return '';
    if (!/^\/MiaoSir-YH\/Mineradio-paused\/releases(?:\/(?:latest|tag\/[^/]+))?\/?$/i.test(url.pathname)) return '';
    return url.origin + url.pathname;
  } catch (e) {
    return '';
  }
}

function applyLatestUpdateInfo(info) {
  var release = info && info.release;
  updateReleaseUrl = info && info.updateAvailable && release ? forkReleasePageUrl(release.htmlUrl) : '';
  var entry = document.getElementById('update-entry');
  if (entry) entry.hidden = !updateReleaseUrl;
  var version = document.getElementById('update-modal-version');
  if (version) {
    version.textContent = updateReleaseUrl
      ? ('当前版本 ' + info.currentVersion + ' · 最新版本 ' + info.latestVersion)
      : '';
  }
}

async function initUpdatePreview() {
  try {
    applyLatestUpdateInfo(await apiJson('/api/update/latest'));
  } catch (e) {
    applyLatestUpdateInfo(null);
  }
}

function openUpdatePanel() {
  if (updateReleaseUrl) openGsapModal(document.getElementById('update-modal'));
}

function closeUpdatePanel() {
  closeGsapModal(document.getElementById('update-modal'));
}

async function openUpdateReleasePage() {
  if (!updateReleaseUrl) return;
  try {
    if (window.desktopWindow && typeof window.desktopWindow.openExternalUrl === 'function') {
      var result = await window.desktopWindow.openExternalUrl(updateReleaseUrl);
      if (!result || result.ok !== true) throw new Error('UPDATE_RELEASE_OPEN_FAILED');
    } else {
      window.open(updateReleaseUrl, '_blank', 'noopener,noreferrer');
    }
    closeUpdatePanel();
  } catch (e) {
    showToast('无法打开当前项目发布页');
  }
}
