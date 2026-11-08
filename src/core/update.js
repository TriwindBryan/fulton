// Checks GitHub for a newer Fulton release. Pure Node (fetch is passed in), so it can be unit tested.
'use strict';

/** "v1.20" / "1.20.0" / "Fulton 1.20" -> [1, 20, 0]; null if there's no version in it. */
function parseVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** Is version a newer than version b? */
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Is the repo setting a real "owner/name" (and not the placeholder)? */
const repoReady = (repo) => /^[\w.-]+\/[\w.-]+$/.test(String(repo || '')) && !/^YOUR[-_]/i.test(repo);

/**
 * The newest release of the Fulton repo, compared with the running version.
 * Returns { available, version, url, notes, publishedAt } or { available: false } when there's nothing newer.
 */
async function checkForUpdate({ repo, current, fetchImpl, token, platform = process.platform, arch = process.arch }) {
  if (!repoReady(repo)) return { available: false, skipped: 'no-repo' };
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Fulton-Launcher', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (res.status === 404) return { available: false, skipped: 'no-releases' };
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const rel = await res.json();
  const version = (parseVersion(rel.tag_name || rel.name) || []).join('.').replace(/\.0$/, '');
  if (!version || rel.draft || rel.prerelease || !isNewer(version, current)) return { available: false, latest: version || null };
  // the asset people want: the installer first, then the portable exe
  const assets = rel.assets || [];
  const pick = platform === 'darwin'
    // Mac: the disk image for this Mac's chip, or the one that runs on both
    ? (assets.find((a) => /\.dmg$/i.test(a.name) && (arch === 'arm64' ? /arm64/i : /x64|intel|x86_64/i).test(a.name))
      || assets.find((a) => /\.dmg$/i.test(a.name) && /universal/i.test(a.name))
      || assets.find((a) => /\.dmg$/i.test(a.name)) || null)
    : platform === 'linux'
      // Linux: the AppImage (runs on its own, nothing to install), then the tar.gz
      ? (assets.find((a) => /\.appimage$/i.test(a.name) && (arch === 'arm64' ? /arm64|aarch64/i : /^(?!.*(arm64|aarch64))/i).test(a.name))
        || assets.find((a) => /\.tar\.gz$/i.test(a.name)) || null)
    : assets.find((a) => /\.msi$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)) || null;
  return {
    available: true,
    version,
    url: rel.html_url || `https://github.com/${repo}/releases/latest`,
    download: pick ? pick.browser_download_url : null,
    notes: String(rel.body || '').slice(0, 2000),
    publishedAt: rel.published_at || null,
  };
}

module.exports = { parseVersion, isNewer, repoReady, checkForUpdate };
