// Community catalog: the decomp/recomp port lists maintained at
// github.com/tgeorgiadis/quiver-community-app-catalog (also used by Quiver Launcher).
'use strict';

const recompendium = require('./recompendium');

const INDEX_URL = 'https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/index.json';
const SOURCE_PAGE = 'https://github.com/tgeorgiadis/quiver-community-app-catalog';

// tag -> our system id (first match wins, most specific first)
const SYSTEM_TAGS = [
  // specific names first: "xbox" is also on every Xbox 360 entry, "nintendo ds" before "ds" and so on
  ['switch 2', 'switch2'], ['switch2', 'switch2'], ['ps5', 'ps5'], ['playstation 5', 'ps5'], ['ps4', 'ps4'], ['playstation 4', 'ps4'],
  ['xbox series', 'xsx'], ['xsx', 'xsx'], ['xbox one', 'xone'], ['xone', 'xone'],
  ['switch', 'switch'], ['nintendo switch', 'switch'], ['nsw', 'switch'], ['wiiu', 'wiiu'], ['wii u', 'wiiu'], ['3ds', '3ds'], ['nintendo 3ds', '3ds'],
  ['n64dd', 'n64dd'], ['64dd', 'n64dd'], ['n64', 'n64'], ['snes', 'snes'], ['gbc', 'gbc'], ['gba', 'gba'], ['gb', 'gb'], ['fds', 'fds'], ['nes', 'nes'],
  ['nds', 'nds'], ['nintendo ds', 'nds'], ['virtual boy', 'vb'], ['gcn', 'gc'], ['gamecube', 'gc'], ['wii', 'wii'],
  ['ps3', 'ps3'], ['playstation 3', 'ps3'], ['vita', 'vita'], ['ps vita', 'vita'], ['psp', 'psp'], ['ps2', 'ps2'], ['ps1', 'ps1'], ['psx', 'ps1'],
  ['x360', 'x360'], ['xbox 360', 'x360'], ['xbox', 'xbox'],
  ['dreamcast', 'dreamcast'], ['dc', 'dreamcast'], ['saturn', 'saturn'], ['sega saturn', 'saturn'], ['sega cd', 'segacd'], ['mega cd', 'segacd'],
  ['32x', '32x'], ['smd', 'genesis'], ['gen', 'genesis'], ['sega genesis', 'genesis'], ['sega mega drive', 'genesis'],
  ['sms', 'sms'], ['master system', 'sms'], ['game gear', 'gg'], ['sg-1000', 'sg1000'],
  ['pc engine', 'pce'], ['turbografx', 'pce'], ['pce', 'pce'], ['neo geo pocket', 'ngp'], ['neo geo', 'neogeo'], ['neogeo', 'neogeo'],
  ['wonderswan', 'ws'], ['3do', '3do'], ['jaguar', 'jaguar'], ['lynx', 'lynx'], ['atari 2600', 'a2600'], ['atari 7800', 'a7800'],
  ['cps1', 'cps1'], ['cps2', 'cps2'], ['cps3', 'cps3'], ['naomi', 'naomi'], ['naomi2', 'naomi'], ['atomiswave', 'atomiswave'], ['mame', 'arcade'], ['fbneo', 'arcade'], ['arcade', 'arcade'], ['mobile', 'mobile'], ['pc', 'pc'],
];

function systemFromTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  for (const [tag, sys] of SYSTEM_TAGS) if (t.includes(tag)) return sys;
  return 'pc';
}

function kindFromTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  if (t.includes('recomp') || t.includes('recompilation')) return 'Static recompilation';
  if (t.includes('decomp') || t.includes('decompilation')) return 'Native PC port';
  if (t.includes('recreation')) return 'Reimplementation';
  return 'Community port';
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Flatten one list file into candidate entries. */
function candidatesFromList(list) {
  return (list.apps || []).filter((a) => a && a.repository && a.name).map((a) => {
    const tags = a.tags || [];
    return {
      key: `${a.repository.toLowerCase()}#${(a.releaseAssetFilter || '').toLowerCase()}`,
      repo: a.repository,
      name: a.name,
      project: a.project || a.repository.split('/')[1],
      system: systemFromTags(tags),
      kind: kindFromTags(tags),
      tags,
      icon: a.appIconUrl || null,
      assetFilter: a.releaseAssetFilter || null,
      filesToAdd: a.filesToAdd || [],
      harbourMasters: tags.some((t) => /harbour masters/i.test(t)) || /^harbourmasters\//i.test(a.repository),
      list: list.name || '',
      // the Quiver list is made for launchers: every entry has a release to install
      ...recompendium.howToGet(systemFromTags(tags), '', true),
    };
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Fulton-Launcher' } });
  if (!res.ok) throw new Error(`Couldn't load the community catalog (${res.status}).`);
  return res.json();
}

/** Ports found on the web that neither list has yet (checked by hand; the newest Switch and Wii U recomps). */
const EXTRAS = [
  { repo: 'nsmbu-recomp/nsmbu-recomp', name: 'New Super Mario Bros. U', console: 'wiiu', status: 'experimental', author: 'nsmbu-recomp',
    desc: 'Static recompilation of New Super Mario Bros. U (Wii U) into a native PC program.', requirements: 'The game files dumped from your own Wii U copy.' },
  { repo: 'glinesbdev/mh3u-port', name: 'Monster Hunter 3 Ultimate', console: 'wiiu', status: 'experimental', category: 'decomp-port',
    desc: 'Work-in-progress native PC port of Monster Hunter 3 Ultimate (Wii U).', requirements: 'The game files dumped from your own Wii U copy.' },
  { repo: 'raulzrrs/letsgo-recomp', name: "Pok\u00e9mon: Let's Go, Eevee!", console: 'switch', status: 'experimental',
    desc: "Static recompilation of Pok\u00e9mon: Let's Go, Eevee! (Switch) into a native PC program.", requirements: 'The game files dumped from your own Switch copy.' },
];

async function fetchQuiver() {
  let index;
  try { index = await fetchJson(INDEX_URL); } catch (e) {
    if (/fetch failed/i.test(e.message)) throw new Error("Couldn't reach the community catalog. Check your internet connection.");
    throw e;
  }
  const lists = await Promise.all((index.lists || []).map((l) => fetchJson(l.remoteLocation).catch(() => null)));
  const out = [];
  for (const list of lists.filter(Boolean)) out.push(...candidatesFromList(list));
  return out;
}

/** Put the lists together: Quiver first, then Recompendium and the extras for anything new. A port both lists
 *  know keeps Quiver's install details and gains Recompendium's description, status and requirements. */
function mergeCandidates(quiver, others) {
  const seen = new Set();
  const byRepo = new Map();
  const out = [];
  for (const c of quiver) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
    if (!byRepo.has(c.repo.toLowerCase())) byRepo.set(c.repo.toLowerCase(), c);
  }
  for (const c of others) {
    const twin = byRepo.get(c.repo.toLowerCase());
    if (twin) {
      for (const f of ['status', 'desc', 'needs', 'developer', 'year']) if (c[f] && !twin[f]) twin[f] = c[f];
      if (c.needsFiles) twin.needsFiles = true;
      if (twin.system === 'pc' && c.system !== 'pc') twin.system = c.system;
      continue;
    }
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    byRepo.set(c.repo.toLowerCase(), c);
    out.push(c);
  }
  return out;
}

/** Download every list: the Quiver community index plus Recompendium. Either one alone is enough. */
async function fetchCommunity({ recompendiumCache = {}, log = () => {} } = {}) {
  const [q, r] = await Promise.allSettled([fetchQuiver(), recompendium.fetchRecompendium(recompendiumCache, log)]);
  if (q.status === 'rejected' && r.status === 'rejected') throw q.reason;
  const warn = [];
  if (q.status === 'rejected') { warn.push('Quiver'); log(`Quiver list failed: ${q.reason && q.reason.message}`); }
  if (r.status === 'rejected') { warn.push('Recompendium'); log(`Recompendium list failed: ${r.reason && r.reason.message}`); }
  const extras = EXTRAS.map((e) => ({ ...recompendium.candidateFromEntry(e, e.category ? 'ports' : 'recomps'), list: 'Fulton', from: 'cartridge' }));
  const items = mergeCandidates(q.status === 'fulfilled' ? q.value : [], [...(r.status === 'fulfilled' ? r.value : []), ...extras]);
  items.warn = warn; // which list couldn't be loaded, if any: shown on Find more instead of failing quietly
  return items;
}

/** Turn a community entry into a Fulton game entry. */
function gameFromCandidate(c) {
  const id = `community-${slug(c.repo)}${c.assetFilter ? '-' + slug(c.assetFilter) : ''}`;
  return {
    id,
    title: c.name,
    port: c.project,
    system: c.system,
    year: c.year || null,
    developer: c.developer || '',
    publisher: '',
    kind: c.kind,
    credits: [{ role: c.kind === 'Static recompilation' ? 'Recompiled by' : 'Made by', name: c.harbourMasters ? 'Harbour Masters' : (c.author || c.repo.split('/')[0]) }],
    repo: c.repo,
    description: c.desc || `${c.project}, a ${c.kind.toLowerCase()} of ${c.name}. Added from the community catalog.`,
    status: c.status || undefined,
    howToGet: c.get || undefined,
    needsFiles: c.needsFiles || undefined,
    filesToAdd: c.filesToAdd,
    assetMatch: c.assetFilter ? escapeRe(c.assetFilter) : undefined,
    rom: {
      titles: [c.name],
      headerNames: [c.name],
      setup: { type: c.harbourMasters ? 'beside-exe' : 'in-app' },
      note: (c.needs ? `Needs: ${c.needs} ` : '') + 'Added from the community catalog: if your ROM isn\'t matched automatically, pick it from the list in the ROM slot.',
      firstRun: c.harbourMasters
        ? 'On first launch the game finds your ROM next to it and extracts its assets.'
        : 'If the game asks for your ROM or game files, the path is on your clipboard: paste it with Ctrl+V.',
    },
    art: { boxart: [`${c.name} (USA)`, `${c.name} (USA, Europe)`, `${c.name} (Europe)`], icon: c.icon },
    custom: true,
    source: 'community',
  };
}

module.exports = { INDEX_URL, SOURCE_PAGE, RECOMPENDIUM_PAGE: recompendium.SOURCE_PAGE, EXTRAS, fetchCommunity, mergeCandidates, candidatesFromList, gameFromCandidate, systemFromTags, kindFromTags };
