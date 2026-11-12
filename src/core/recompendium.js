// Recompendium (recompendium.com): a big, well-kept list of recomps and PC ports, with Switch, Wii U, PS3,
// PS4, Xbox One and Dreamcast games the Quiver catalog doesn't have yet. Its data is CC BY-SA 4.0, credited
// on Find more and About. The whole repository is one ~220 KB download, read here without extra libraries.
'use strict';

const zlib = require('zlib');

const REPO = 'Nio03/unricopie';
const ARCHIVE_URL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
const SOURCE_PAGE = 'https://recompendium.com/en/';
const LICENSE = 'CC BY-SA 4.0';

// Recompendium console id -> Fulton system id
const CONSOLES = {
  n64: 'n64', ps1: 'ps1', ps2: 'ps2', ps3: 'ps3', ps4: 'ps4', ps5: 'ps5', psp: 'psp', vita: 'vita',
  x360: 'x360', xbox: 'xbox', xboxone: 'xone', xsx: 'xsx',
  gamecube: 'gc', wii: 'wii', wiiu: 'wiiu', switch: 'switch', switch2: 'switch2',
  nes: 'nes', snes: 'snes', gb: 'gb', gbc: 'gbc', gba: 'gba', nds: 'nds', '3ds': '3ds',
  megadrive: 'genesis', genesis: 'genesis', saturn: 'saturn', dreamcast: 'dreamcast', segacd: 'segacd', sms: 'sms',
  arcade: 'arcade', pc: 'pc',
};

const STATUS = {
  experimental: 'Early: expect bugs', beta: 'Beta', usable: 'Usable', playable: 'Playable', fully: 'Complete', stable: 'Complete',
};

// ---------- a small YAML reader (enough for Recompendium's files: maps, lists, quoted strings, inline {…}) ----------
function scalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s[0] === '"') return JSON.parse(s.replace(/\\'/g, "'"));
  if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '{') return flow(s.slice(1, -1), true);
  if (s[0] === '[') return flow(s.slice(1, -1), false);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.replace(/\s+#.*$/, '');
}

/** Split "a: 1, b: "x, y"" on top-level commas. */
function flow(s, isMap) {
  const parts = [];
  let cur = '', q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === '\\' && q === '"') { cur += s[++i] || ''; } else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && !depth) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  if (!isMap) return parts.map(scalar);
  const out = {};
  for (const p of parts) {
    const m = p.match(/^\s*([^:]+?)\s*:\s*(.*)$/s);
    if (m) out[m[1].trim()] = scalar(m[2]);
  }
  return out;
}

function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw) || raw.trim() === '---') continue;
    lines.push({ indent: raw.match(/^ */)[0].length, text: raw.trim() });
  }
  let i = 0;
  const keyRe = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:(?:\s+(.*)|\s*)$/;
  function block(indent) {
    if (i >= lines.length || lines[i].indent < indent) return null;
    return lines[i].text.startsWith('- ') || lines[i].text === '-' ? list(lines[i].indent) : map(lines[i].indent);
  }
  function value(rest, parentIndent) {
    if (rest == null || rest === '') return i < lines.length && lines[i].indent > parentIndent ? block(lines[i].indent) : (i < lines.length && lines[i].indent === parentIndent && lines[i].text.startsWith('- ') ? list(parentIndent) : null);
    if (/^[|>][-+]?$/.test(rest)) { // block text
      const parts = [];
      while (i < lines.length && lines[i].indent > parentIndent) parts.push(lines[i++].text);
      return parts.join(rest[0] === '|' ? '\n' : ' ');
    }
    return scalar(rest);
  }
  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const m = lines[i].text.match(keyRe);
      i++;
      if (!m) continue;
      out[m[1].replace(/^["']|["']$/g, '')] = value(m[2], indent);
    }
    return out;
  }
  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const body = lines[i].text.slice(1).trim();
      const itemIndent = indent + 2;
      const m = body.match(keyRe);
      if (m && !/^["'{[]/.test(body)) {
        // "- key: value" starts a map; its other keys sit at the item's indent
        lines[i] = { indent: itemIndent, text: body };
        out.push(map(itemIndent));
      } else {
        i++;
        out.push(body ? scalar(body) : block(itemIndent));
      }
    }
    return out;
  }
  return block(0) || {};
}

// ---------- the archive ----------
/** Read a .tar.gz buffer and return { path: text } for the files `want(path)` accepts. */
function untarGz(buf, want) {
  const tar = zlib.gunzipSync(buf);
  const files = {};
  let off = 0, longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = longName || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === 'x') { // pax header: may carry a long path for the next entry
      const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
    } else if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
    } else if ((type === '0' || type === '\0') && want(name)) {
      files[name] = data.toString('utf8');
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const en = (v) => (v && typeof v === 'object' ? v.en || v.es || '' : v || '');
const cleanName = (n) => String(n || '').replace(/\s*\((?:N64|PS1|PS2|PS3|PS4|PSX|SNES|NES|GBA|GBC|GB|NDS|3DS|Wii U|Wii|GameCube|GCN|Xbox 360|Xbox One|Xbox|Switch|Dreamcast|Mega Drive|Genesis|Arcade|PSP)\)\s*$/i, '');

// Consoles whose ports need files taken from the console or disc (extracted game folders, keys), not just a ROM
const NEEDS_FILES = new Set(['switch', 'switch2', 'wiiu', 'ps3', 'ps4', 'ps5', 'x360', 'xbox', 'xone', 'xsx', 'vita', '3ds']);
const NEEDS_FILES_TEXT = /\b(extract(ed)?|keys?|default\.xex|default\.xbe|exefs|romfs|eboot|title\.tmd|decrypted|dump(ed)? (of )?(the )?(game|disc) (files|folder))\b/i;

/**
 * What it takes to play a port, for the Find more label: 'download' (a release to install), 'build' (no release:
 * you build it yourself), or null (unknown). needsFiles: it wants files from your console, not just a ROM.
 */
function howToGet(system, needs, hasRelease) {
  return {
    get: hasRelease === true ? 'download' : hasRelease === false ? 'build' : null,
    needsFiles: NEEDS_FILES.has(system) || NEEDS_FILES_TEXT.test(needs || ''),
  };
}

/** One Recompendium entry -> a Find more candidate (same shape as the Quiver catalog's), or null to skip it. */
function candidateFromEntry(e, folder, stats) {
  if (!e || !e.name || e.abandoned) return null;
  const repo = String(e.repo || e.repoUrl || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null; // only GitHub projects can be installed
  const console = String(e.console || (Array.isArray(e.consoles) && e.consoles[0]) || 'pc').toLowerCase();
  const system = CONSOLES[console] || 'pc';
  const tags = (Array.isArray(e.tags) ? e.tags : []).map(String);
  const kind = folder === 'recomps' ? 'Static recompilation'
    : e.category === 'fan-remake' ? 'Reimplementation'
      : 'Native PC port';
  return {
    key: `${repo.toLowerCase()}#`,
    repo,
    name: cleanName(e.name),
    project: repo.split('/')[1],
    system,
    kind,
    tags: [...tags, console, folder === 'recomps' ? 'recomp' : 'port'],
    icon: null,
    assetFilter: null,
    filesToAdd: [],
    harbourMasters: /^harbourmasters\//i.test(repo),
    list: 'Recompendium',
    from: 'recompendium',
    status: STATUS[String(e.status || '').toLowerCase()] || '',
    desc: en(e.desc),
    needs: en(e.requirements),
    developer: e.originalDeveloper ? String(e.originalDeveloper) : '',
    year: Number(e.year) || null,
    author: e.author ? String(e.author) : repo.split('/')[0],
    homepage: e.homepage ? String(e.homepage) : '',
    ...howToGet(system, en(e.requirements), stats ? !!(stats[repo] && stats[repo].version) : undefined),
  };
}

/** Candidates from parsed entries [{ folder, e }] and Recompendium's stats.json (GitHub details per repo). */
function candidatesFromEntries(entries, stats) {
  const out = [];
  const seen = new Set();
  for (const { folder, e } of entries) {
    const c = candidateFromEntry(e, folder, stats);
    if (c && !seen.has(c.key)) { seen.add(c.key); out.push(c); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Candidates from a { path: yamlText } map of the repository's data files. */
function candidatesFromFiles(files) {
  let stats = null;
  const statsFile = Object.keys(files).find((p) => /src\/data\/stats\.json$/.test(p));
  if (statsFile) { try { stats = JSON.parse(files[statsFile]); } catch { stats = null; } }
  const entries = [];
  for (const [p, text] of Object.entries(files)) {
    const m = p.match(/src\/data\/(recomps|ports)\/[^/]+\.ya?ml$/);
    if (!m) continue;
    try { entries.push({ folder: m[1], e: parseYaml(text) }); } catch { /* skip a file that doesn't parse */ }
  }
  return candidatesFromEntries(entries, stats);
}

const API_TREE = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main/`;
const HEADERS = { 'User-Agent': 'Fulton-Launcher' };
const DATA_FILE = /^src\/data\/(?:(recomps|ports)\/[^/]+\.ya?ml|stats\.json)$/;

async function getText(url, ms = 25000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

/**
 * The light way: the repository now carries thousands of cover pictures (the whole download is ~26 MB, it used to be a few
 * hundred KB), so ask GitHub for the file list and read only the ~1,300 small data files. `cache` ({ entries: { path: { sha, e } } })
 * remembers files by their hash, so later refreshes only fetch what changed.
 */
async function fetchLight(cache) {
  const tree = JSON.parse(await getText(API_TREE));
  if (!tree || !Array.isArray(tree.tree) || tree.truncated) throw new Error('file list incomplete');
  const wanted = tree.tree.filter((n) => n.type === 'blob' && DATA_FILE.test(n.path));
  if (!wanted.some((n) => /^src\/data\/(recomps|ports)\//.test(n.path))) throw new Error('no data files found');
  const entries = cache.entries || (cache.entries = {});
  const keep = new Set(wanted.map((n) => n.path));
  for (const k of Object.keys(entries)) if (!keep.has(k)) delete entries[k];
  const todo = wanted.filter((n) => !/stats\.json$/.test(n.path) && !(entries[n.path] && entries[n.path].sha === n.sha));
  let failed = 0, next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const n = todo[next++];
      try {
        const e = parseYaml(await getText(RAW_BASE + n.path.split('/').map(encodeURIComponent).join('/')));
        entries[n.path] = { sha: n.sha, folder: n.path.split('/')[2], e };
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  if (failed > Math.max(20, todo.length * 0.05)) throw new Error(`${failed} of ${todo.length} files didn't download`);
  let stats = null;
  try { stats = JSON.parse(await getText(RAW_BASE + 'src/data/stats.json')); } catch { stats = cache.stats || null; }
  if (stats) cache.stats = stats;
  return candidatesFromEntries(Object.values(entries).map((x) => ({ folder: x.folder, e: x.e })), cache.stats || null);
}

/** The old way (one big download), kept as the fallback. */
async function fetchArchive() {
  const res = await fetch(ARCHIVE_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`Couldn't load Recompendium (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  return candidatesFromFiles(untarGz(buf, (p) => /\/src\/data\/((recomps|ports)\/[^/]+\.ya?ml|stats\.json)$/.test(p)));
}

async function fetchRecompendium(cache = {}, log = () => {}) {
  try {
    const out = await fetchLight(cache);
    log(`Recompendium: ${out.length} ports (light download)`);
    return out;
  } catch (e) {
    log(`Recompendium light download failed (${e.message}); trying the full download`);
  }
  const out = await fetchArchive();
  log(`Recompendium: ${out.length} ports (full download)`);
  return out;
}

module.exports = { howToGet, REPO, ARCHIVE_URL, SOURCE_PAGE, LICENSE, CONSOLES, parseYaml, untarGz, candidateFromEntry, candidatesFromEntries, candidatesFromFiles, fetchRecompendium };
