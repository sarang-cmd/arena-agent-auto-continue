/* The settings page: the same panel the on-page gear opens, on a full page. */
(async () => {
  const mount = document.getElementById('mount');
  if (!window.BatonPanel) return;
  const panel = await window.BatonPanel.mount(mount);
  await showUpdateIfAny(panel);
})();

const REPO = 'sarang-cmd/baton';

function currentVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return '0';
  }
}

function parts(v) {
  return String(v || '0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote, local) {
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function showUpdateIfAny(panel) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const cached = await new Promise((resolve) => {
    chrome.storage.local.get(['updateCheck'], (res) => resolve((res && res.updateCheck) || null));
  });

  const apply = (latest) => {
    if (!latest || !isNewer(latest.version, currentVersion())) return;
    panel.showUpdate(latest);
  };

  if (cached && Date.now() - cached.at < SIX_HOURS) {
    apply(cached.latest);
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return;
    const release = await res.json();
    const asset = (release.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
    const latest = {
      version: String(release.tag_name || '').replace(/^v/, ''),
      htmlUrl: release.html_url,
      downloadUrl: asset ? asset.browser_download_url : release.html_url
    };
    chrome.storage.local.set({ updateCheck: { at: Date.now(), latest } });
    apply(latest);
  } catch (_) {
    /* offline is fine, no banner */
  }
}
