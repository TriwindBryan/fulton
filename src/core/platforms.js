// Which computers a port has downloads for (Find more's Windows / Mac filter). The latest release's file names are
// read once and cached for a few days. Without a GitHub token this uses github.com's own release pages, which aren't
// limited to 60 lookups an hour like the API; with a token it uses the API.
'use strict';
const gh = require('./github');

const TTL = 3 * 24 * 3600 * 1000;

/** File names in a release page's asset list (the expanded_assets HTML). */
function assetNamesFromHtml(html, repo) {
  const names = new Set();
  const re = new RegExp(`href="/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/download/[^"/]+/([^"?#]+)"`, 'gi');
  let m;
  while ((m = re.exec(html))) { try { names.add(decodeURIComponent(m[1])); } catch { names.add(m[1]); } }
  return [...names];
}

/** When the release's files were published (ms), from the first time stamp in a release page's asset list. */
function releasedFromHtml(html) {
  const m = /datetime="([^"]+)"/.exec(html || '');
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** { tag, names, released } for the latest release, { tag: null } when there's none. Throws when GitHub can't be reached. */
async function latestAssetNames(repo, token, fetchImpl = fetch) {
  if (token) {
    try {
      const rel = await gh.latestRelease(repo, token);
      return { tag: rel.tag_name, names: (rel.assets || []).map((a) => a.name), released: Date.parse(rel.published_at || '') || null };
    } catch (e) {
      if (e.code === 'NOT_FOUND') return { tag: null, names: [] };
      throw e;
    }
  }
  const head = { 'User-Agent': 'Fulton-Launcher', Accept: 'text/html' };
  const res = await fetchImpl(`https://github.com/${repo}/releases/latest`, { headers: head });
  if (res.status === 429) { const e = new Error('GitHub is busy'); e.code = 'RATE_LIMIT'; throw e; }
  if (res.status === 404) return { tag: null, names: [] };
  const m = String(res.url || '').match(/\/releases\/tag\/([^/?#]+)/);
  if (!m) return { tag: null, names: [] }; // no releases: the page falls back to the release list
  const tag = m[1];
  const list = await fetchImpl(`https://github.com/${repo}/releases/expanded_assets/${tag}`, { headers: head });
  if (list.status === 429) { const e = new Error('GitHub is busy'); e.code = 'RATE_LIMIT'; throw e; }
  if (!list.ok) throw new Error(`GitHub answered ${list.status}`);
  const body = await list.text();
  return { tag: decodeURIComponent(tag), names: assetNamesFromHtml(body, repo), released: releasedFromHtml(body) };
}

/** Does this list of downloads have one for Windows / for a Mac? Same rules Install uses. */
function platformsOf(names, assetFilter) {
  const assets = names.map((name) => ({ name, size: 0 }));
  const filter = assetFilter ? assetFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : undefined;
  const win = !!gh.pickAsset(assets, 'win32', filter, 'x64');
  // a Mac build for either kind of Mac counts (Apple Silicon runs Intel builds too)
  const mac = !!(gh.pickAsset(assets, 'darwin', filter, 'arm64') || gh.pickAsset(assets, 'darwin', filter, 'x64'));
  // recorded for later: Linux and Steam Deck support is planned
  const linux = !!gh.pickAsset(assets, 'linux', filter, 'x64');
  return { win, mac, linux };
}

module.exports = { TTL, releasedFromHtml, assetNamesFromHtml, latestAssetNames, platformsOf };
