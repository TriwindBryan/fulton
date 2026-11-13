'use strict';
/* global cartridge */
const api = window.cartridge;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ui = { view: 'shelf', filter: 'all', system: null, kind: null, query: '', selected: null, selRow: null, layout: 'rows', sort: 'smart' };
// only the layout and sort are remembered; Fulton always opens on the Games tab (older builds also saved the page, which is ignored now)
try { const sv = JSON.parse(localStorage.getItem('cartridge.view') || '{}'); if (sv.layout) ui.layout = sv.layout; if (sv.sort) ui.sort = sv.sort; } catch { /* storage unavailable */ }
function saveViewPrefs() { try { localStorage.setItem('cartridge.view', JSON.stringify({ layout: ui.layout, sort: ui.sort })); } catch { /* ignore */ } }
let S = null; // latest snapshot from the main process

// ---------------------------------------------------------------- art
const artCache = new Map(); // gameId|cover -> Promise<{src, file, kind}>

function tryImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 8 ? src : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Covers are found and saved by the main process (libretro-thumbnails, SteamGridDB or your own picture).
function resolveArt(g) {
  const key = `${g.id}|${g.cover || ''}`;
  if (artCache.has(key)) return artCache.get(key);
  const p = (async () => {
    let file = g.cover;
    if (!file) { try { file = await api.cover('game', g.id); } catch { file = null; } }
    if (file) return { src: fileUrl(file), file, kind: 'box' };
    if (g.art && g.art.icon && await tryImage(g.art.icon)) return { src: g.art.icon, kind: 'icon' };
    return { src: null, kind: 'cover' };
  })();
  artCache.set(key, p);
  return p;
}

/** Covers for ROMs and Find more entries: <div data-cover-kind="rom|title" data-ref|data-system+data-title data-file> */
// Covers are only looked up for pictures that are on screen (or about to be), so a big library doesn't ask for thousands at once
const coverSeen = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { coverSeen.unobserve(e.target); loadCover(e.target); }
}, { root: null, rootMargin: '600px' }) : null;
function hydrateCovers(root = document) {
  root.querySelectorAll('[data-cover-kind]:not(.has-art)').forEach((el) => {
    if (coverSeen && !el.dataset.file) coverSeen.observe(el); else loadCover(el);
  });
}
async function loadCover(el) {
  {
    const kind = el.dataset.coverKind;
    let file = el.dataset.file || null;
    if (!file) {
      const ref = kind === 'title' ? { system: el.dataset.system, title: el.dataset.title } : el.dataset.ref;
      try { file = await api.cover(kind, ref); } catch { file = null; }
    }
    if (!file || !el.isConnected || el.classList.contains('has-art')) return;
    el.classList.add('has-art');
    el.insertAdjacentHTML('afterbegin', `<img class="cover-img" alt="" loading="lazy" src="${esc(fileUrl(file))}">`);
  }
}

// 90s palette for generated box fronts
const PALETTE = ['#c8161d', '#19e3ff', '#ff7b1c', '#ffd23f', '#9dff3b', '#8a0f14', '#e2342b', '#1484ff'];
function hashOf(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

function artMarkup(g, large = false) {
  return `<div class="art-slot" data-art="${esc(g.id)}">${coverMarkup(g, large)}</div>`;
}
function coverMarkup(g, large) {
  const sys = S.systems[g.system] || {};
  const h = hashOf(g.id);
  const c1 = PALETTE[h % PALETTE.length];
  const c2 = PALETTE[(h >> 4) % PALETTE.length] === c1 ? PALETTE[(h + 3) % PALETTE.length] : PALETTE[(h >> 4) % PALETTE.length];
  return `<div class="cover${large ? ' lg' : ''}${g.title.length > 22 ? ' long' : ''}" style="--c1:${c1};--c2:${c2};--rot:${h % 30}deg"><b>${esc(g.title)}</b><small>${esc(sys.name || '')}${g.year ? ' · ' + g.year : ''}</small></div>`;
}
function hydrateArt(root = document) {
  root.querySelectorAll('.art-slot[data-art]').forEach(async (el) => {
    const g = S.games.find((x) => x.id === el.dataset.art);
    if (!g) return;
    const art = await resolveArt(g);
    if (!art.src || !el.isConnected) return;
    el.innerHTML = `<div class="art-blur" style="background-image:url('${art.src.replace(/'/g, '%27')}')"></div><img class="art-img${art.kind === 'icon' ? ' icon' : ''}" alt="" src="${esc(art.src)}">`;
    const bg = document.querySelector(`.hero-bg[data-for="${CSS.escape(g.id)}"] div`);
    if (bg) fillBackdrop(bg, art.file, art.src);
  });
}

// ---------------------------------------------------------------- the backdrop behind the selected game
// Customize → Colors → Game backdrop: 'wash' (a soft glow in the cover's main color), 'theme' (nothing), 'blur' (the cover, blurred)
const backdropMode = () => (S && S.settings.heroBackdrop) || 'wash';
const washCache = new Map();
/** The cover's main color, measured on a small copy of it (null for gray covers, or when there's no cover file). */
function coverColor(file) {
  if (!file || !window.cartColor) return Promise.resolve(null);
  if (!washCache.has(file)) {
    washCache.set(file, (async () => {
      try {
        const img = new Image();
        img.src = await api.imageData(file);
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 32, 32);
        return window.cartColor.dominantColor(x.getImageData(0, 0, 32, 32).data);
      } catch { return null; }
    })());
  }
  return washCache.get(file);
}
async function fillBackdrop(div, file, src) {
  const mode = backdropMode();
  const box = div.parentElement;
  if (box) box.className = `hero-bg ${mode}`;
  div.style.backgroundImage = '';
  div.style.removeProperty('--wash');
  if (mode === 'blur' && src) div.style.backgroundImage = `url('${src.replace(/'/g, '%27')}')`;
  if (mode === 'wash') {
    const color = await coverColor(file);
    if (color && div.isConnected) div.style.setProperty('--wash', color);
  }
}

// ---------------------------------------------------------------- helpers
// Steam artwork is drawn on a canvas: use the bundled heavy font on a Mac, Arial Black elsewhere
const CANVAS_FONT = document.documentElement.classList.contains('os-mac') ? '"Cartridge Heavy", "Arial Black", sans-serif' : '"Arial Black", "Cartridge Heavy", "Segoe UI", sans-serif';
const isMac = () => !!S && S.platform === 'darwin';
/** What people see as the version: the label ("Beta 0.0001") when there is one, otherwise v1.xx. */
const verLabel = () => (S && S.label) || (S && S.version ? `v${S.version}` : '');
const osName = () => (!S ? 'Windows' : S.platform === 'darwin' ? 'Mac' : S.platform === 'linux' ? 'Linux' : 'Windows');
const thisComputer = () => (isMac() ? 'Mac' : 'PC');
const sysColor = (g) => (S.systems[g.system] || {}).color || '#c8161d';
const fmtBytes = (n) => !n ? '' : n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtTime = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`; };

// One simple original icon per kind of system (how its games come), tinted with the system's own color
const SYS_FORM = (() => {
  const m = {};
  const set = (form, ids) => ids.split(' ').forEach((id) => { m[id] = form; });
  set('cart', 'nes fds snes vb n64 n64dd sg1000 sms genesis 32x pce sgx a2600 a5200 a7800 pokemini');
  set('handheld', 'gb gbc gba gg ngp ngpc ws wsc lynx psp vita');
  set('dual', 'nds 3ds wiiu');
  set('disc', 'gc ps1 ps2 ps3 dreamcast saturn segacd pcecd neocd xbox x360 3do');
  set('pad', 'wii switch switch2 xone xsx ps4 ps5 jaguar');
  set('box', 'coleco intv vectrex msx');
  set('arcade', 'cps1 cps2 cps3 zn neogeo naomi atomiswave sys16 sys18 sys24 sys32 model1 model2 model3 stv namcos1 namcos2 namcos11 namcos12 namcos22 konamigx sys573 taitof3 pgm cave psikyo toaplan irem midway arcade');
  set('pc', 'pc');
  set('phone', 'mobile');
  return m;
})();
const iconsOn = () => !S || !S.settings || S.settings.systemIcons !== false;
const sysIcon = (id, cls = 'sys-ic') => `<svg class="${cls}" aria-hidden="true"><use href="#ic-${SYS_FORM[id] || 'cart'}"/></svg>`;
const NEW_DAYS = [3, 7, 14, 21, 30, 60];
const newDays = () => { const n = Number(S && S.settings && S.settings.newWindowDays); return NEW_DAYS.includes(n) ? n : 30; };
const isFresh = (c) => !!(c.isNew || (c.released && c.released >= Date.now() - newDays() * DAY));
const notifyOn = () => !S || !S.settings || S.settings.notifyUpdates !== false;
/** Starburst badge for a game, or null. */
function burstOf(g) {
  if (g.job) return { cls: 'cyan', text: g.job.progress != null ? `${Math.round(g.job.progress * 100)}%` : 'WAIT' };
  if (g.running) return { cls: 'lime', text: 'NOW<br>PLAYING' };
  if (g.updateAvailable && notifyOn()) return { cls: 'pink', text: 'NEW<br>UPDATE!' };
  if (g.installed) return null;
  if (g.romMatch && !g.sourceOnly && !(g.release && !g.release.asset)) return { cls: '', text: 'READY<br>TO GO!' };
  return null;
}
/** Does this port ask for the ROM itself when it starts? (Then loading it in Fulton is optional.) */
const asksForRom = (g) => !g.sourceOnly && (((g.rom && g.rom.setup) || {}).type || 'in-app') === 'in-app';
const burstHtml = (b) => (b ? `<div class="burst ${b.cls}"><span>${b.text}</span></div>` : '');

const KIND_GROUP = (k = '') => (/recomp/i.test(k) ? 'recomp' : /reimplement|remake|recreation/i.test(k) ? 'remake' : 'decomp');
// What the Games screen shows: [id, label, tooltip, colour, cover badge]
const TYPES = [
  ['', 'All', 'Every game, all types together', 'red', ''],
  ['decomp', 'Decomps', 'Rebuilt from the original code by hand', 'cyan', 'DECOMP'],
  ['recomp', 'Recomps', 'Machine code recompiled to run on PC', 'gold', 'RECOMP'],
  ['remake', 'Remakes', 'Recreated from scratch', 'lime', 'REMAKE'],
];
const SHOW = [...TYPES, ['roms', 'My ROMs', 'Only the ROM files and discs you have', 'rom', 'ROM'], ['favorites', '★ Favorites', 'Only your favorite games', 'fav', '★']];
const typeOf = (kind) => TYPES.find((t) => t[0] === KIND_GROUP(kind));
const romMode = () => ui.kind === 'roms';
/** One row of chunky buttons: All · Decomps · Recomps · Remakes (· My ROMs). */
function showChips(list, current, count, attr) {
  return `<div class="show-chips" role="group" aria-label="Show">${list.map(([id, label, tip, col], i) =>
    `${id === 'roms' ? '<span class="show-sep"></span>' : ''}<button class="show-chip t-${col}${(current || '') === id ? ' on' : ''}" ${attr}="${id}" title="${esc(tip)} (key ${i + 1})"><i></i>${label}<span class="n">${count(id)}</span></button>`).join('')}</div>`;
}
const SORTS = {
  smart: ['Best first', (a, b) => (!!b.installed - !!a.installed) || (!!b.romMatch - !!a.romMatch) || (!!a.sourceOnly - !!b.sourceOnly) || a.title.localeCompare(b.title) || a.port.localeCompare(b.port)],
  az: ['A to Z', (a, b) => a.title.localeCompare(b.title) || a.port.localeCompare(b.port)],
  za: ['Z to A', (a, b) => b.title.localeCompare(a.title) || b.port.localeCompare(a.port)],
  added: ['Recently added', (a, b) => (b.addedAt || 0) - (a.addedAt || 0) || a.title.localeCompare(b.title)],
  played: ['Recently played', (a, b) => (lastPlayed(b) - lastPlayed(a)) || (!!b.installed - !!a.installed) || a.title.localeCompare(b.title)],
  most: ['Most played', (a, b) => (playTime(b) - playTime(a)) || a.title.localeCompare(b.title)],
  newest: ['Release year (newest)', (a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title)],
  oldest: ['Release year (oldest)', (a, b) => (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title)],
  console: ['Console', (a, b) => sysIndex(a) - sysIndex(b) || a.title.localeCompare(b.title)],
  score: ['Metascore', (a, b) => metaScore(b) - metaScore(a) || a.title.localeCompare(b.title)],
};
const metaScore = (g) => (g.metacritic && g.metacritic.score) || 0;
const lastPlayed = (g) => (g.installed && g.installed.lastPlayed) || 0;
const playTime = (g) => (g.installed && g.installed.playTime) || 0;
const sysIndex = (g) => { const i = Object.keys(S.systems).indexOf(g.system); return i < 0 ? 999 : i; };
const filtersActive = () => ui.filter !== 'all' || !!ui.system || !!ui.kind || !!ui.query.trim();

const romName = (r) => (r.arcade && r.arcade.desc) || r.datName || r.internalName || r.originalName || '';
const romUnlocks = (r) => S.games.filter((g) => g.romMatch && g.romMatch.romId === r.id);
const ROM_SORTS = {
  az: (a, b) => romName(a).localeCompare(romName(b)),
  za: (a, b) => romName(b).localeCompare(romName(a)),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0) || romName(a).localeCompare(romName(b)),
  console: (a, b) => sysIndex(a) - sysIndex(b) || romName(a).localeCompare(romName(b)),
  smart: (a, b) => (romUnlocks(b).length > 0) - (romUnlocks(a).length > 0) || romName(a).localeCompare(romName(b)),
};
function filteredRoms() {
  const q = ui.query.trim().toLowerCase();
  return S.roms.filter((r) => {
    if (ui.system && r.system !== ui.system) return false;
    if (!q) return true;
    const hay = [romName(r), r.originalName, (S.systems[r.system] || {}).name, (S.systems[r.system] || {}).short, r.serial].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }).sort(ROM_SORTS[ui.sort] || ROM_SORTS.smart);
}

function filtered() {
  if (romMode()) return filteredRoms();
  const q = ui.query.trim().toLowerCase();
  const list = S.games.filter((g) => {
    if (ui.system && g.system !== ui.system) return false;
    if (ui.kind === 'favorites' ? !g.favorite : ui.kind && KIND_GROUP(g.kind) !== ui.kind) return false;
    if (ui.filter === 'installed' && !g.installed) return false;
    if (ui.filter === 'ready' && !(g.romMatch && !g.installed && !g.sourceOnly)) return false;
    if (ui.filter === 'needs' && (g.romMatch || g.sourceOnly)) return false;
    if (ui.filter === 'available' && !runsHere(g)) return false;
    if (!q) return true;
    const hay = [g.title, g.port, g.developer, g.publisher, g.kind, g.repo, g.year, ...(g.credits || []).map((c) => c.name), (S.systems[g.system] || {}).name, (S.systems[g.system] || {}).short].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
  const sort = ui.sort === 'score' && !S.settings.showMetacritic ? 'smart' : ui.sort;
  return list.sort((SORTS[sort] || SORTS.smart)[1]);
}

function toast(title, body = '', kind = '', actions = []) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<p>${esc(body)}</p>` : ''}`;
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'btn3d small'; b.textContent = label;
    b.onclick = () => { fn(); el.remove(); };
    b.dataset.toastAction = '1';
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), actions.length ? 14000 : 6500);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast('Something went wrong', e.message, 'bad'); return null; }
}

// ---------------------------------------------------------------- header
function renderHeader() {
  const ver = $('#ver'); if (ver && S.version) { ver.textContent = verLabel(); ver.title = `About Fulton (build ${S.version})`; }
  $('#c-all').textContent = S.games.length;
  $('#c-roms').textContent = S.roms.length || '';
  const nUpd = S.games.filter((g) => g.updateAvailable).length;
  const cu = $('#c-upd');
  if (cu) { cu.hidden = !(nUpd && notifyOn()); cu.textContent = nUpd > 99 ? '99+' : String(nUpd || ''); cu.title = `${nUpd} game${nUpd === 1 ? '' : 's'} can be updated`; }
  const topSearch = $('#search');
  if (topSearch && document.activeElement !== topSearch) {
    topSearch.placeholder = ui.view === 'discover' ? 'Search Find more by game name' : 'Search games';
    const want = ui.view === 'discover' ? disc.q : (ui.query || '');
    if (topSearch.value !== want) topSearch.value = want;
  }
  document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));
  const up = S.appUpdate;
  const pill = $('#update-pill');
  if (pill) {
    pill.hidden = !up;
    if (up) pill.textContent = 'Update available';
  }
  $('#btn-support').hidden = !(S.links || {}).kofi;
  if (up && !ui.updateToasted) {
    ui.updateToasted = true;
    toast('A new Fulton is out!', "Your games, ROMs and saves carry over. Download it and run the installer.", 'ok', [['Download', () => api.openUrl(up.download || up.url)], ["What's new", () => api.openUrl(up.url)]]);
  }
  if (!S.settings.welcomeSeen && !ui.welcomeShown) showWelcome();
  else if ($('#modal').hidden) maybeTour();
}

// ---------------------------------------------------------------- first run
function showWelcome() {
  ui.welcomeShown = true;
  const m = $('#modal');
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
    <img class="modal-icon" src="../build/icon.png" alt="">
    <h2 id="welcome-title"><span class="chrome">Welcome to Fulton</span></h2>
    <p class="tagline">Your home base for recomps, decomps and remakes</p>
    <p class="lead">Fulton finds fan-made PC ports of classic games, installs them from their official releases, and starts them for you.</p>
    <ul class="welcome-list">
      <li><b>No games are included.</b> Fulton doesn't include, download or share any games, ROMs, BIOS files or keys. Each port needs files from your own copy of the game.</li>
      <li><b>Add your ROMs</b> from <em>My ROMs</em> (add a folder or choose files), or drop them on the window. Fulton checks each one and shows which ports it unlocks.</li>
      <li><b>Covers stay on this ${thisComputer()}.</b> Box art is downloaded from libretro-thumbnails for your own library and isn't shared anywhere.</li>
      <li><b>Fulton is free.</b> If it saves you some time, you can support it on Ko-fi from the ♥ button. Nothing is locked behind it.</li>
    </ul>
    <div class="modal-actions"><button class="btn3d" data-act-welcome="ok">Let's go</button><button class="btn-link" data-act-welcome="about">About &amp; credits</button></div>
  </div>`;
  m.hidden = false;
  setTimeout(() => { const b = m.querySelector('.btn3d'); if (b) b.focus(); }, 30);
}

// A short, skippable tour of the things people tend to miss. Shown once; replay it from Settings.
const TOUR = [
  { t: 'Find more games', b: 'Browse decomp, recomp and remake ports for every console. Open <b>filters</b> to narrow by type, release date, or Windows and Mac downloads. Type <b>new</b> or <b>updated</b> in the search box to see what just changed.', tip: 'Add one to your shelf, then install it like any other game.' },
  { t: 'Updates in one click', b: 'The <b>Updates</b> page lists every game that has a new version, with a preview of what changed. <b>Update all</b> does them in one go. Update alerts can be turned off in Settings.', tip: 'Mark a game as a favorite and Fulton tells you first when it has a new version.' },
  { t: 'Make it yours', b: 'The <b>Customize</b> button at the top changes Fulton\'s colors, lets you pick your own background picture, and fades its edges into any color you like. Card sizes and system icons are on Find more.', tip: 'Try a dark background picture with a soft fade, then adjust Darken and See-through.', go: ['Open Customize', 'customize'] },
  { t: 'Your shelf', b: 'Favorite the games you play most, add them to <b>Steam</b> for Big Picture and Steam Input, and Fulton backs up your saves automatically. A controller works everywhere in the app.', tip: 'Drop a ROM on the window and Fulton works out which ports it unlocks.' },
];
function showTour(i = 0) {
  const st = TOUR[i];
  const m = $('#modal');
  m.innerHTML = `<div class="modal tip tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
    <div class="tour-dots" aria-label="Step ${i + 1} of ${TOUR.length}">${TOUR.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
    <h2 id="tour-title">${esc(st.t)}</h2>
    <p>${st.b}</p>
    <p class="tour-tip">${esc(st.tip)}</p>
    <div class="modal-actions">
      <span class="tour-left">${i ? `<button class="btn-link" data-tour="${i - 1}">Back</button>` : ''}<button class="btn-link" data-tour-skip="1">Skip tour</button></span>
      <span>${st.go ? `<button class="btn3d purple small" data-tour-go="${st.go[1]}">${esc(st.go[0])}</button> ` : ''}<button class="btn3d" data-tour="${i + 1}">${i === TOUR.length - 1 ? 'Done' : 'Next'}</button></span>
    </div>
  </div>`;
  m.hidden = false;
  setTimeout(() => { const b = m.querySelector('button.btn3d[data-tour]'); if (b) b.focus(); }, 30);
}
async function endTour() {
  const m = $('#modal');
  m.hidden = true; m.innerHTML = '';
  if (!S.settings.tourSeen) await guard(() => api.settings({ tourSeen: true, welcomeSeen: true }));
}
// existing users see the tour once after updating; new users see it after the welcome
const maybeTour = () => { if (S.settings.welcomeSeen && !S.settings.tourSeen && !ui.tourShown) { ui.tourShown = true; showTour(0); } };

// One friendly support card, once, after something good happened (the 5th game installed). Never during play or an install.
function maybeAskSupport() {
  if (S.settings.supportAsked || !(S.links || {}).kofi) return;
  if (S.games.filter((x) => x.installed).length < 5) return;
  guard(() => api.settings({ supportAsked: Date.now() }));
  S.settings.supportAsked = Date.now();
  toast('Enjoying Fulton?', "It's free, with no ads and nothing locked. If it's saved you some time, you can help pay to sign it for Windows and Mac.", 'ok', [['♥ Support on Ko-fi', () => api.openUrl(S.links.kofi)], ['No thanks', () => {}]]);
}

async function closeWelcome(next) {
  const m = $('#modal');
  m.hidden = true; m.innerHTML = '';
  await guard(() => api.settings({ welcomeSeen: true }));
  S.settings.welcomeSeen = true;
  if (next) setView(next);
  else maybeTour();
}

// ---------------------------------------------------------------- help
const HELP_TOPICS = window.HELP || [];
const helpUi = { topic: 'start', q: '' };

function helpTopicHtml(t, { inModal = false } = {}) {
  const acts = (t.actions || []).map(([label, target]) => `<button class="btn3d small ${target === 'log' ? 'purple' : ''}" data-help-act="${esc(target)}">${esc(label)}</button>`).join('');
  return `<div class="help-topic">
    <h2>${esc(t.title)}</h2>
    <p class="lead">${esc(t.lead)}</p>
    <ol>${t.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    <div class="help-actions">${acts}${inModal ? `<button class="btn-link" data-help-go="${esc(t.id)}">Open in Help</button>` : ''}</div>
  </div>`;
}

function helpMatches() {
  const words = helpUi.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return HELP_TOPICS;
  return HELP_TOPICS.filter((t) => {
    const hay = `${t.title} ${t.lead} ${t.keywords || ''} ${t.steps.join(' ')}`.replace(/<[^>]+>/g, ' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function renderHelp() {
  $('#view').innerHTML = `<div class="panel wide" id="help-page">
    ${panelHead('Help', 'How Fulton works, in a few steps per topic.')}
    <label class="search help-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
      <input id="help-q" placeholder="Search help, e.g. ROM, Steam, build" value="${esc(helpUi.q)}" autocomplete="off"></label>
    <div class="help-grid"><nav class="help-toc" id="help-toc"></nav><div id="help-body"></div></div>
  </div>`;
  renderHelpBody();
}

function renderHelpBody() {
  const toc = $('#help-toc'), body = $('#help-body');
  if (!toc) return;
  const list = helpMatches();
  if (!list.some((t) => t.id === helpUi.topic) && list.length) helpUi.topic = list[0].id;
  toc.innerHTML = list.map((t) => `<button class="${t.id === helpUi.topic ? 'on' : ''}" data-help-topic="${esc(t.id)}">${esc(t.title)}</button>`).join('');
  const t = list.find((x) => x.id === helpUi.topic);
  body.innerHTML = t ? helpTopicHtml(t) + (t.special === 'setup' ? `<div class="setup-box"><button class="btn3d" data-act="check-setup">${setupState.running ? 'Checking…' : setupState.result ? 'Check again' : 'Check now'}</button><div id="setup-results">${setupResultsHtml()}</div></div>` : '')
    : '<p class="help-empty">Nothing matches that. Try another word, like ROM, install or Steam.</p>';
}

// ---------------------------------------------------------------- check my setup
const setupState = { running: false, result: null, error: null };
function setupResultsHtml() {
  const r = setupState.result;
  if (setupState.error) return `<p class="setup-bad">${esc(setupState.error)}</p>`;
  if (!r) return '';
  const issues = r.issues.map((x) => `<div class="setup-issue ${x.level}">
      <b>${esc(x.title)}</b><p>${esc(x.detail)}</p>
      ${x.fix ? `<button class="btn3d small ${x.level === 'bad' ? '' : 'purple'}" data-setup-fix="${esc(x.fix.id)}">${esc(x.fix.label)}</button>` : ''}
    </div>`).join('');
  const good = r.ok.map((x) => `<li>${esc(x)}</li>`).join('');
  return `${r.issues.length ? `<h3 class="setup-h">${r.issues.length} thing${r.issues.length > 1 ? 's' : ''} to look at</h3>${issues}` : '<h3 class="setup-h good">Everything looks good</h3>'}
    ${good ? `<ul class="setup-ok">${good}</ul>` : ''}`;
}
async function runSetupCheck() {
  setupState.running = true; setupState.error = null;
  renderHelpBody();
  try { setupState.result = await api.checkSetup(); } catch (e) { setupState.error = e.message; }
  setupState.running = false;
  if (ui.view === 'help') renderHelpBody();
}

function openHelp(topic) {
  helpUi.topic = topic || helpUi.topic; helpUi.q = '';
  closeTip();
  if (ui.view === 'help' && $('#help-page')) { const q = $('#help-q'); if (q) q.value = ''; renderHelpBody(); }
  else setView('help');
}

/** The small "?" buttons: one help topic in a pop-up, without leaving the screen. */
function showTip(topic) {
  const t = HELP_TOPICS.find((x) => x.id === topic);
  if (!t) return openHelp(topic);
  const m = $('#modal');
  m.innerHTML = `<div class="modal tip" role="dialog" aria-modal="true">${helpTopicHtml(t, { inModal: true })}<div class="modal-actions"><button class="btn3d" data-tip-close="1">Got it</button></div></div>`;
  m.hidden = false;
  setTimeout(() => { const b = m.querySelector('[data-tip-close]'); if (b) b.focus(); }, 30);
}
function closeTip() { const m = $('#modal'); if (m.querySelector('.modal.tour')) return endTour(); if (m.querySelector('.modal.tip')) { m.hidden = true; m.innerHTML = ''; } }

// ---------------------------------------------------------------- about & credits
let creditsCache = null;
function renderAbout() {
  const links = S.links || {};
  const up = S.appUpdate;
  const repoReady = /^[\w.-]+\/[\w.-]+$/.test(links.repo || '') && !/^YOUR[-_]/i.test(links.repo || '');
  $('#view').innerHTML = `<div class="panel" id="about-page">
    ${panelHead('About Fulton', 'Your home base for recomps, decomps and remakes')}
    <div class="about-top">
      <img class="about-icon" src="../build/icon.png" alt="">
      <div>
        <p class="about-name">Fulton <b>${esc(verLabel())}</b> <small class="sub">build ${esc(S.version || '')}</small></p>
        <p class="tagline"><b>Your home base for recomps, decomps and remakes</b></p>
        <p>A launcher for decompiled, recompiled and remade PC ports of classic games. You bring the ROMs, Fulton does the rest.</p>
        <div class="inline about-btns">
          ${links.kofi ? `<button class="support-btn big" data-url="${esc(links.kofi)}"><span aria-hidden="true">♥</span> Support Fulton on Ko-fi</button>` : ''}
          <button class="btn-link" data-open-path="${esc(S.changelog || '')}">What's new</button>
          ${repoReady ? `<button class="btn-link" data-url="https://github.com/${esc(links.repo)}">Source code</button>` : ''}
          ${links.itch ? `<button class="btn-link" data-url="${esc(links.itch)}">itch.io page</button>` : ''}
        </div>
        <small class="sub">Fulton is free and always will be. Supporting it doesn't unlock anything; it just helps keep it going.</small>
        <p class="sub about-made"><b>How Fulton is made:</b> designed, tested and maintained by a retro gamer of 40+ years. The code was written with the help of an AI assistant (Claude). Every feature, fix and release is decided and tested by hand.</p>
      </div>
    </div>

    <h3 class="about-h">Updates</h3>
    <div class="inline about-update">
      <span id="update-status">${up ? `<b class="gold">A new Fulton is out (build ${esc(up.version)}).</b>` : repoReady ? "You're on the latest version." : 'Update checks start once Fulton has its GitHub home.'}</span>
      ${up ? `<button class="btn3d small" data-url="${esc(up.download || up.url)}">Download it</button>` : ''}
      ${repoReady ? '<button class="btn3d small purple" data-act-about="check">Check now</button>' : ''}
    </div>

    <h3 class="about-h">Thanks</h3>
    <p class="sub">Fulton only installs other people's work. These are the teams and people who decompiled and ported the games in the catalog. Their projects are free too, so consider supporting them.</p>
    <div class="credits" id="credits"><span class="sub">Loading…</span></div>

    <h3 class="about-h">Data used by Fulton</h3>
    <ul class="about-list">
      <li><button class="btn-link" data-url="https://github.com/libretro-thumbnails">libretro-thumbnails</button>: box art, downloaded to your ${thisComputer()} as you need it</li>
      <li><button class="btn-link" data-url="https://github.com/libretro/libretro-database">libretro-database</button> and <button class="btn-link" data-url="https://www.no-intro.org">No-Intro</button>: checksums used to recognise your ROMs</li>
      <li><button class="btn-link" data-url="https://www.mamedev.org">MAME</button> and <button class="btn-link" data-url="https://github.com/finalburnneo/FBNeo">FinalBurn Neo</button>: the list of arcade games</li>
      <li><button class="btn-link" data-url="https://github.com/tgeorgiadis/quiver-community-app-catalog">Quiver community catalog</button> and <button class="btn-link" data-url="https://recompendium.com/en/">Recompendium</button> (by Nio03, data under <button class="btn-link" data-url="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</button>): the ports on Find more</li>
      <li><button class="btn-link" data-url="https://www.steamgriddb.com">SteamGridDB</button>: extra covers, only if you add your own key</li>
      <li>GitHub: where every port, and Fulton itself, is downloaded from</li>
      <li>Fonts: <button class="btn-link" data-url="https://github.com/googlefonts/AntonFont">Anton</button>, <button class="btn-link" data-url="https://github.com/Omnibus-Type/ArchivoBlack">Archivo Black</button> and <button class="btn-link" data-url="https://rsms.me/inter/">Inter</button>, under the SIL Open Font License</li>
    </ul>

    <h3 class="about-h">Legal</h3>
    <div class="callout legal">
      <p>Fulton doesn't include, download or share any games, ROMs, BIOS files, firmware or keys. Use files dumped from games you own.</p>
      <p>Fulton isn't affiliated with or endorsed by Nintendo, Sony, Microsoft, Sega, Capcom, SNK or any other game company, or by the teams who make the ports. Game names, logos and box art belong to their owners.</p>
      <p>Metacritic scores are off unless you turn them on in Settings.</p>
      <p>Fulton is open source under the MIT license.</p>
    </div>
    <p class="sub" style="margin-top:14px">Something slow or broken? <button class="btn-link" data-act-about="log">Open the log file</button> and send it along with your report.</p>
  </div>`;
  loadCredits();
}

async function loadCredits() {
  if (!creditsCache) creditsCache = await guard(() => api.credits()) || [];
  const box = $('#credits');
  if (!box) return;
  box.innerHTML = creditsCache.length ? creditsCache.map((c) => `<div class="credit">
      ${c.url ? `<button class="btn-link credit-name" data-url="${esc(c.url)}">${esc(c.name)}</button>` : `<b class="credit-name">${esc(c.name)}</b>`}
      <small>${esc(c.roles.join(' · '))}</small>
      <span>${esc(c.games.join(', '))}</span>
    </div>`).join('') : '<span class="sub">No credits in the catalog yet.</span>';
}

// ---------------------------------------------------------------- shelf
function cardMarkup(g, row = '') {
  const p = g.job && g.job.progress != null ? Math.round(g.job.progress * 100) : null;
  const sys = S.systems[g.system] || {};
  return `<button class="card" data-id="${esc(g.id)}" data-row="${esc(row)}" style="--c:${sysColor(g)}">
    ${burstHtml(burstOf(g))}
    <div class="card-art">${artMarkup(g)}
      <span class="sys-tag">${esc(sys.short || '')}</span>
      <span class="type-tag t-${typeOf(g.kind)[3]}">${typeOf(g.kind)[4]}</span>
      ${g.favorite ? '<span class="fav-tag" title="Favorite">★</span>' : ''}
      ${g.job ? `<div class="card-bar"><span style="width:${p ?? 100}%"></span></div>` : ''}
    </div>
    <span class="card-name">${esc(g.port)}<small>${g.installed ? '✓ Installed' : esc(g.title)}</small></span>
  </button>`;
}

function romCardMarkup(r, row = '') {
  const sys = S.systems[r.system] || {};
  const unlocks = romUnlocks(r);
  const name = (r.arcade && r.internalName) || romName(r).replace(/\s*[([].*$/, '') || romName(r);
  return `<button class="card rom-card" data-id="rom:${esc(r.id)}" data-row="${esc(row)}" style="--c:${sys.color || '#c8161d'}">
    <div class="card-art"><div class="art-slot" data-cover-kind="rom" data-ref="${esc(r.id)}" data-file="${esc(r.cover || '')}">${coverMarkup({ id: r.id, title: name, system: r.system }, false)}</div>
      <span class="sys-tag">${esc(sys.short || '')}</span>
      <span class="type-tag t-rom">${r.datName ? '✓ ROM' : 'ROM'}</span>
    </div>
    <span class="card-name">${esc(name)}<small>${unlocks.length ? '▶ ' + esc(unlocks.map((g) => g.port).join(', ')) : 'No port yet'}</small></span>
  </button>`;
}

/** Build the sections shown on the Games screen. Each is { key, title, games }. */
function shelfSections(list) {
  const groupByConsole = (games) => Object.keys(S.systems)
    .map((id) => ({ key: `sys-${id}`, title: S.systems[id].name, games: games.filter((g) => g.system === id) }))
    .filter((r) => r.games.length);

  if (ui.layout === 'grid') {
    return ui.sort === 'console' ? groupByConsole(list) : [{ key: 'all', title: '', games: list }];
  }
  if (romMode()) return groupByConsole(list);
  if (filtersActive()) {
    const rows = groupByConsole(list);
    return rows.length > 1 ? rows : [{ key: 'results', title: rows[0] ? rows[0].title : 'Results', games: list }];
  }
  // Home rows: what you're playing, what's new, what's ready, then a row per console
  const rows = [];
  const playing = S.games.filter((g) => lastPlayed(g)).sort(SORTS.played[1]).slice(0, 24);
  if (playing.length) rows.push({ key: 'playing', title: 'Recently played', games: playing });
  const favs = list.filter((g) => g.favorite);
  if (favs.length) rows.push({ key: 'favorites', title: '★ Favorites', games: favs });
  const added = S.games.filter((g) => g.addedAt).sort(SORTS.added[1]).slice(0, 24);
  if (added.length) rows.push({ key: 'added', title: 'Recently added', games: added });
  const installed = list.filter((g) => g.installed);
  if (installed.length) rows.push({ key: 'installed', title: 'Installed', games: installed });
  const ready = list.filter((g) => g.romMatch && !g.installed && !g.sourceOnly && !(g.release && !g.release.asset));
  if (ready.length) rows.push({ key: 'ready', title: 'Ready to install', games: ready });
  return rows.concat(groupByConsole(list));
}

const SHORT = { '': 'All', decomp: 'Decomp', recomp: 'Recomp', remake: 'Remake', roms: 'ROMs', favorites: '★ Favorites' };
/** Can this game be played on this computer? Installed, or its latest release has a download for this system. */
const runsHere = (g) => !!g.installed || (!g.sourceOnly && !!(g.release && g.release.asset));
const STATUS = [['available', () => `Works on this ${thisComputer()}`], ['installed', 'Installed'], ['ready', 'ROM ready'], ['needs', 'No ROM loaded']];
const statusLabel = (l) => (typeof l === 'function' ? l() : l);

/** One slim row: what to show on the left, Filters (a small menu) and Updates on the right, active filters as tags below. */
/** Two slim lines: what to show (All · Decomp · Recomp · Remake · ROMs), then Layout · Sort · Console · Status dropdowns. */
function shelfBar() {
  const count = (fn) => S.games.filter(fn).length;
  const statusN = { favorites: count((x) => x.favorite), available: count(runsHere), installed: count((x) => x.installed), ready: count((x) => x.romMatch && !x.installed && !x.sourceOnly), needs: count((x) => !x.romMatch && !x.sourceOnly) };
  const pool = romMode() ? S.roms : S.games;
  const consoles = Object.entries(S.systems).map(([id, s]) => [id, s, pool.filter((x) => x.system === id).length]).filter(([, , n]) => n);
  const tabs = `<div class="fb-tabs" role="group" aria-label="Show">${SHOW.map(([id, , tip], i) =>
    `<button class="fb-tab${(ui.kind || '') === id ? ' on' : ''}" data-type="${id}" title="${esc(tip)} (key ${i + 1})"><span>${SHORT[id]}</span><sup>${id === 'roms' ? S.roms.length : id === 'favorites' ? count((x) => x.favorite) : count((x) => !id || KIND_GROUP(x.kind) === id)}</sup></button>`).join('')}</div>`;
  const pick = (key, label, on, options) => `<label class="fb-pk${on ? ' on' : ''}"><span class="fb-m">${label}</span><select data-pick="${key}">${options}</select></label>`;
  const opt = (value, label, cur) => `<option value="${esc(value)}"${cur === value ? ' selected' : ''}>${esc(label)}</option>`;
  const dropdowns = [
    pick('system', 'Console', !!ui.system, opt('', `All consoles (${pool.length})`, ui.system || '') + consoles.map(([id, sy, n]) => opt(id, `${sy.name} (${n})`, ui.system)).join('')),
    romMode() ? '' : pick('filter', 'Status', ui.filter !== 'all', opt('all', `Any (${S.games.length})`, ui.filter) + STATUS.map(([id, label]) => opt(id, `${statusLabel(label)} (${statusN[id]})`, ui.filter)).join('')),
    pick('sort', 'Sort', ui.sort !== 'smart', Object.entries(SORTS).filter(([k]) => (!romMode() || ROM_SORTS[k]) && (k !== 'score' || S.settings.showMetacritic)).map(([k, [label]]) => opt(k, label, ui.sort)).join('')),
    pick('layout', 'Layout', false, opt('rows', 'Rows', ui.layout) + opt('grid', 'Grid', ui.layout)),
  ].join('');
  const extras = (ui.system || ui.filter !== 'all' || ui.sort !== 'smart' || ui.query.trim())
    ? `${ui.query.trim() ? `<button class="ftag" data-clear="query" title="Clear the search">“${esc(ui.query.trim())}”<b>×</b></button>` : ''}<button class="fb-reset" data-act="reset-filters">Reset</button>` : '';
  const shown = filtered().length;
  return `<div class="fbar">
    <div class="fb-row">${tabs}<span class="fb-sp"></span>${extras}<button class="fb-ico" data-act="refresh" title="Check every game for updates">↻</button></div>
    <div class="fb-spec"><span class="fb-show"><i class="fb-m">Showing</i><b>${shown.toLocaleString()} ${romMode() ? (shown === 1 ? 'ROM' : 'ROMs') : (shown === 1 ? 'game' : 'games')}</b></span>${dropdowns}</div>
  </div>`;
}

// Big ROM libraries: draw a section's first cards, with a "show more" card at the end
const sectionLimit = {};
const SECTION_STEP = 120;
const limitOf = (key) => sectionLimit[key] || (ui.layout === 'grid' ? SECTION_STEP : 40);
const capped = (r) => (romMode() ? r.games.slice(0, limitOf(r.key)) : r.games);
function moreCard(r) {
  if (!romMode() || r.games.length <= limitOf(r.key)) return '';
  const left = r.games.length - limitOf(r.key);
  return `<button class="card more-card" data-more="${esc(r.key)}"><span>+${left.toLocaleString()}</span><small>Show ${Math.min(left, SECTION_STEP * 2).toLocaleString()} more</small></button>`;
}

function renderShelf() {
  const list = filtered();
  const sections = shelfSections(list);
  const all = sections.flatMap((r) => r.games);
  const idOf = (x) => (romMode() ? `rom:${x.id}` : x.id);
  // one console picked on the shelf (and not searching): offer a way to go find more for it
  // (not while Favorites, a type or Installed is picked: those lists are about games you already have)
  const canFindMore = !romMode() && !ui.query.trim() && ui.filter === 'all' && ui.kind !== 'favorites';
  if (!all.some((g) => idOf(g) === ui.selected)) { ui.selected = all.length ? idOf(all[0]) : null; ui.selRow = null; }
  const body = !all.length && romMode()
    ? `<div class="panel empty"><h2>${S.roms.length ? 'No ROMs match' : 'No ROMs yet'}</h2><p>${S.roms.length ? 'Try a different search or console.' : 'Point Fulton at the folder where you keep your ROMs and they all show up here with their covers.'}</p>${S.roms.length ? '<button class="btn3d" data-act="clear-filters">Show everything</button>' : '<button class="btn3d" data-act="add-folder">+ Add your ROM folder</button>'}</div>`
    : !all.length && !S.games.length
    ? '<div class="panel empty"><h2>Your shelf is empty</h2><p class="tagline">Your home base for recomps, decomps and remakes</p><p>Fulton doesn\'t come with any games. Open <b>Find more</b> to browse decomp, recomp and remake ports and add the ones you want. Each one needs your own ROM or game files.</p><button class="btn3d" data-view-go="discover">Find more games</button></div>'
    : !all.length
    ? ui.kind === 'favorites' && !S.games.some((g) => g.favorite)
      ? '<div class="panel empty"><h2>No favorites yet</h2><p>Open any game and click <b>☆ Add to favorites</b>. They all show up here, one click away.</p><button class="btn3d" data-type="">Show all games</button></div>'
      : `<div class="panel empty"><h2>${ui.filter === 'installed' && !ui.query ? 'Nothing installed yet' : 'No games match'}</h2><p>${ui.filter === 'installed' && !ui.query ? 'Pick a game and smash Install.' : 'Try a different search or filter.'}</p>${filtersActive() ? '<button class="btn3d" data-act="clear-filters">Clear filters</button>' : ''}${canFindMore ? `<button class="btn3d purple" data-find-more="1" data-fm-system="${esc(ui.system || '')}" data-fm-kind="${esc(FM_KINDS.includes(ui.kind) ? ui.kind : '')}">+ Find more like this</button>` : ''}</div>`
    : sections.map((r, i) => `<section class="row-sec is-${ui.layout}" data-row="${r.key}">
        ${r.title ? `<h2 class="row-title"><span>${esc(r.title)}</span><small>${r.games.length}</small></h2>` : ''}
        ${ui.layout === 'grid' ? '' : '<div class="shelf-wrap"><button class="row-arrow left" data-row-scroll="-1" aria-label="Scroll left" tabindex="-1">‹</button>'}
        <div class="${ui.layout === 'grid' ? 'grid' : 'shelf'}">${capped(r).map((g) => (romMode() ? romCardMarkup(g, r.key) : cardMarkup(g, r.key))).join('')}${moreCard(r)}${canFindMore && i === sections.length - 1 ? findMoreCard(S.systems[ui.system] ? ui.system : '', FM_KINDS.includes(ui.kind) ? ui.kind : '') : ''}</div>
        ${ui.layout === 'grid' ? '' : '<button class="row-arrow right" data-row-scroll="1" aria-label="Scroll right" tabindex="-1">›</button></div>'}
      </section>`).join('');
  const prevScroll = $('#view').scrollTop;
  lastRomsSig = '';
  stashInfo();
  $('#view').innerHTML = shelfBar() + body;
  $('#view').scrollTop = prevScroll;
  hydrateArt($('#view'));
  hydrateCovers($('#view'));
  markSelected(false);
  placeInfo();
  updateRowArrows();
}

// ---------------------------------------------------------------- hero (selected game)
function primaryAction(g) {
  if (g.sourceOnly) {
    if (!g.installed) return `<button class="btn3d huge purple" data-act="open-repo">View source</button>
      <span class="note">No prebuilt download. You build this one yourself with your ROM, following the project's readme. Built it already? <button class="btn-link" data-act="link-exe">Add your copy</button><button class="help-q" data-help-tip="own" title="How this works">?</button></span>`;
  }
  if (g.job) {
    const p = g.job.progress;
    const pct = p != null ? Math.round(p * 100) : null;
    const amount = g.job.total ? `${fmtBytes(g.job.got)} / ${fmtBytes(g.job.total)}` : pct != null ? `${pct}%` : '';
    return `<div class="progress" data-job="${esc(g.id)}">
      <div class="progress-top"><span>${esc(g.job.phase)}</span><span>${esc(amount)}</span></div>
      <div class="bar${pct == null ? ' indet' : ''}"><span style="width:${pct ?? 0}%"></span></div>
    </div>${g.job.cancel ? '<button class="btn-link" data-act="cancel">Cancel</button>' : ''}`;
  }
  if (g.installed) {
    const play = g.running
      ? '<button class="btn3d huge lime" disabled>Playing…</button>'
      : '<button class="btn3d huge lime" data-act="play">▶ Play</button>';
    const upd = g.updateAvailable ? `<button class="btn3d pink" data-act="install">Update to ${esc(g.release.tag)}</button>` : '';
    // (built-in catalog games always have a proper download; added games may be build-it-yourself ports)
    const own = g.installed.manual
      ? '<span class="note">Your own copy. <button class="btn-link" data-act="link-exe">Pick a different file</button></span>'
      : g.custom ? '<span class="note">Built or installed it yourself? <button class="btn-link" data-act="link-exe">Use your own copy instead</button><button class="help-q" data-help-tip="own" title="How this works">?</button></span>' : '';
    return `${play}${upd}${own}`;
  }
  const linkIt = ' <button class="btn-link" data-act="link-exe">Already have it? Add your copy</button><button class="help-q" data-help-tip="own" title="How this works">?</button>';
  if (g.release && !g.release.asset) {
    return `<button class="btn3d huge" disabled>No ${osName()} build yet</button><span class="note">The latest release (${esc(g.release.tag)}) has nothing for ${osName()} yet.${isMac() ? ' Many ports are Windows-only; check the project page for Mac plans.' : ''}${linkIt}</span>`;
  }
  const bits = [g.release && `Version ${g.release.tag}`, g.release && g.release.asset && fmtBytes(g.release.asset.size)].filter(Boolean).join(' · ');
  const err = g.releaseError && !g.release ? g.releaseError : '';
  return `<button class="btn3d huge" data-act="install">Install</button><span class="note">${esc(err || bits)}${linkIt}</span>`;
}

function romCart(g) {
  if (g.sourceOnly && !g.romMatch) return '';
  const m = g.romMatch;
  const candidates = S.roms.filter((r) => r.system === g.system);
  const picker = candidates.length > 1 || (candidates.length && !m)
    ? `<select data-act="assign" title="Use a different ROM"><option value="">${m ? 'Change ROM…' : 'Pick from my ROMs…'}</option>${candidates.map((r) => `<option value="${esc(r.id)}"${m && m.romId === r.id ? ' selected' : ''}>${esc(r.datName || r.originalName)}</option>`).join('')}</select>` : '';
  if (m) {
    return `<div class="romcart ${m.level}" data-drop="${esc(g.id)}">
      <span class="cart-icon"></span>
      <div class="romcart-text"><b>${m.level === 'ok' ? 'ROM loaded' : 'ROM found, check version'}</b><span>${esc(m.label)}</span><em>${esc(m.level === 'warn' && g.rom && g.rom.note ? g.rom.note : m.reason)}</em></div>
      ${picker}<button class="btn3d small purple" data-act="load-rom" title="Pick a different ROM file for this game">Load ROM</button>
    </div>`;
  }
  if (asksForRom(g)) {
    return `<div class="romcart optional" data-drop="${esc(g.id)}">
    <span class="cart-icon"></span>
    <div class="romcart-text"><b>ROM optional</b><span>The game asks for your ${DISC_SYSTEMS.has(g.system) ? 'disc image' : 'ROM'} when it starts. Load it here to check it's the right version first.</span>${g.rom && g.rom.note ? `<em>${esc(g.rom.note)}</em>` : ''}<button class="btn-link rh-link" data-act="rom-help">How do I get this ${DISC_SYSTEMS.has(g.system) ? 'disc' : 'ROM'}?</button></div>
    ${picker}<button class="btn3d small purple" data-act="load-rom">Load ROM</button>
  </div>`;
  }
  return `<div class="romcart" data-drop="${esc(g.id)}">
    <span class="cart-icon"></span>
    <div class="romcart-text"><b>Insert ${DISC_SYSTEMS.has(g.system) ? 'disc image or game dump' : 'ROM'}</b><span>Drop it on the window, or load it here</span>${g.rom && g.rom.note ? `<em>${esc(g.rom.note)}</em>` : ''}<button class="btn-link rh-link" data-act="rom-help">How do I get this ${DISC_SYSTEMS.has(g.system) ? 'disc' : 'ROM'}?</button></div>
    ${picker}<button class="btn3d small cyan" data-act="load-rom">Load ROM</button>
  </div>`;
}

/** Pick ROM files and attach the right one to the selected game (even if its name doesn't match automatically). */
async function loadRomForSelected() {
  const g = S.games.find((x) => x.id === ui.selected);
  const report = await guard(() => api.pickRoms('files'));
  if (!report) return;
  if (g) {
    const mine = report.filter((r) => (r.status === 'added' || r.status === 'duplicate') && r.system === g.system);
    if (mine.length) {
      await guard(() => api.assignRom(g.id, mine[0].id));
      toast(`ROM loaded for ${g.port}`, mine[0].name || '', 'ok');
      return;
    }
    if (report.some((r) => r.status !== 'error')) toast(`That ROM isn't for ${(S.systems[g.system] || {}).name || 'this system'}`, `${g.port} needs a ${(S.systems[g.system] || {}).name || ''} ${DISC_SYSTEMS.has(g.system) ? 'disc image or game dump' : 'ROM'}.`, 'warn');
  }
  showRomReport(report);
}

// File types each system's ROMs come in (first = preferred). Games can override with rom.formats.
const SYSTEM_FORMATS = {
  nes: ['.nes'], fds: ['.fds'], snes: ['.sfc', '.smc'], vb: ['.vb'], n64: ['.z64', '.n64', '.v64'], n64dd: ['.ndd'],
  gb: ['.gb'], gbc: ['.gbc'], gba: ['.gba'], pokemini: ['.min'], nds: ['.nds'], '3ds': ['.3ds', '.cia', '.cxi'],
  gc: ['.iso', '.rvz', '.gcm'], wii: ['.iso', '.rvz', '.wbfs'], wiiu: ['.wua', '.wud', '.wux', 'game folder'], switch: ['.nsp', '.xci', '.nsz', '.xcz'],
  sg1000: ['.sg'], sms: ['.sms'], gg: ['.gg'], genesis: ['.md', '.bin', '.gen'], '32x': ['.32x'],
  segacd: ['.bin + .cue', '.chd'], saturn: ['.bin + .cue', '.chd'], dreamcast: ['.gdi', '.chd', '.cdi'],
  ps1: ['.bin + .cue', '.chd'], ps2: ['.iso', '.chd'], ps3: ['game folder', '.iso', '.pkg'], psp: ['.iso', '.cso'], vita: ['game folder', '.vpk'],
  xbox: ['.iso', 'game folder'], x360: ['.iso', 'game folder'],
  pce: ['.pce'], pcecd: ['.bin + .cue', '.chd'], sgx: ['.sgx'], neogeo: ['.zip'], neocd: ['.bin + .cue', '.chd'], ngp: ['.ngp'], ngpc: ['.ngc'],
  ws: ['.ws'], wsc: ['.wsc'], a2600: ['.a26', '.bin'], a5200: ['.a52'], a7800: ['.a78'], lynx: ['.lnx'], jaguar: ['.j64'], '3do': ['.iso', '.bin + .cue', '.chd'],
  coleco: ['.col'], intv: ['.int'], vectrex: ['.vec'], msx: ['.mx1', '.mx2'], arcade: ['.zip'], pc: ['original game files'],
};
const DISC_SYSTEMS = new Set(['gc', 'wii', 'wiiu', 'switch', '3ds', 'segacd', 'saturn', 'dreamcast', 'ps1', 'ps2', 'ps3', 'psp', 'vita', 'xbox', 'x360', 'pcecd', 'neocd', '3do']);
const FORMAT_NOTES = {
  arcade: 'Arcade games come as a .zip "set" named after the game, like sf2.zip or sfiii3.zip. Keep the name exactly as it is: emulators find games by it. Neo Geo, NAOMI, PGM and a few other boards also need their BIOS set (neogeo.zip, naomi.zip…) in the same folder.',
  n64: '.z64 is the standard. Load a .n64 or .v64 dump in Fulton and it is converted to .z64 for you.',
  snes: '.sfc is the standard. Old .smc dumps with a copier header work too; Fulton strips the header.',
  switch: 'Your own dumped game (.nsp or .xci; compressed .nsz/.xcz too). Fulton reads the name and title ID only; it never needs or touches console keys.',
  wiiu: 'A .wua file, a .wud/.wux disc image, or a dumped game folder (with code, content and meta inside).',
  ps3: 'A dumped game folder (with PS3_GAME inside), a disc .iso or a .pkg.',
  vita: 'A dumped game folder (with sce_sys inside) or a .vpk.',
  ps4: 'A .pkg, or a dumped game folder (with sce_sys and eboot.bin inside).',
  ps5: 'A dumped game folder (with sce_sys/param.json and eboot.bin inside).',
  xone: 'A dumped game folder (with MicrosoftGame.config or appxmanifest.xml inside).',
  xsx: 'A dumped game folder (with MicrosoftGame.config inside), in a folder named Xbox Series.',
  switch2: 'A .nsp or .xci in a folder named Switch 2. Fulton reads the name only and never needs or touches console keys.',
  dreamcast: '.gdi with its track files is the most common dump; .chd and .cdi work too.',
  xbox: 'A disc .iso (full or "xiso") or an extracted folder with default.xbe.',
  x360: 'A disc .iso or an extracted folder with default.xex.',
};
function romFormats(g) {
  const spec = g.rom || {};
  const arcadeBoard = (S.systems[g.system] || {}).arcade;
  const types = spec.formats || SYSTEM_FORMATS[g.system] || (arcadeBoard ? ['.zip set (MAME / FBNeo)'] : []);
  let note = spec.formatNote || '';
  if (!note && arcadeBoard) note = FORMAT_NOTES.arcade;
  if (!note) note = FORMAT_NOTES[g.system] || '';
  return { types, note };
}
function romVersion(g) {
  const spec = g.rom || {};
  if (g.id === 'dusklight') return 'Any (not Korean Wii)';
  if (spec.regions) return spec.regions.join(' or ') + (spec.requireTags ? ` (${spec.requireTags.join(', ')})` : '');
  if (spec.excludeTags) return `1.0 (not ${spec.excludeTags.join(', ')})`;
  if (g.source === 'community') return null;
  return spec.titles && spec.titles.length ? 'Several versions' : null;
}

function renderDetail() {
  renderInfo();
  restorePanelFocus();
  const el = $('#detail');
  el.hidden = ui.view !== 'shelf';
  if (!el.hidden && String(ui.selected || '').startsWith('rom:')) return renderRomDetail(el);
  const g = S.games.find((x) => x.id === ui.selected);
  if (el.hidden || !g) { el.innerHTML = ''; return; }
  el.style.setProperty('--c', sysColor(g));
  const sys = S.systems[g.system] || {};
  const plates = [
    ['SYSTEM', sys.name, 'sys'],
    ['RELEASED', g.year],
    ['DEVELOPER', g.developer],
    ['PUBLISHER', g.publisher],
    g.installed && g.installed.playTime ? ['PLAYED', fmtTime(g.installed.playTime)] : null,
  ].filter((p) => p && p[1]);
  const rf = romFormats(g);
  if (rf.types.length) plates.push(['ROM FILE', rf.types.join(' · '), 'rom', rf.note]);
  const rv = romVersion(g);
  if (rv) plates.push(['ROM VERSION', rv, 'rom', (g.rom && g.rom.note) || '']);
  const credits = (g.credits || []).map((c) => `<span class="credits">${esc(c.role)} <b>${esc(c.name)}</b></span>`).join('');

  el.innerHTML = `
    <div class="hero-bg ${backdropMode()}" data-for="${esc(g.id)}"><div></div></div>
    <div class="box3d">
      ${burstHtml(burstOf(g))}
      <div class="box">
        <div class="box-front">${artMarkup(g, true)}</div>
        <div class="box-side"><b>${esc(g.title)}</b></div>
      </div>
      <div class="box-shadow"></div>
      <span class="hz-spine">${esc(g.port)}</span>
    </div>
    <div class="hero-info">
      <h1 class="hero-title${g.title.length > 24 ? ' long' : ''}"><span class="chrome">${esc(g.title)}</span></h1>
      <p class="hero-port">${esc(g.port)}<small>${esc(g.kind)}</small></p>
      <div class="plates">${plates.map(([k, v, c, tip]) => `<div class="plate ${c || ''}"${tip ? ` title="${esc(tip)}"` : ''}><small>${k}${tip ? ' ⓘ' : ''}</small><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="hero-actions">${primaryAction(g)}</div>
      ${romCart(g)}
      <div class="hero-more">
        ${credits}
        ${g.description ? `<p class="desc">${esc(g.description)}</p>` : ''}
        <button class="btn-link fav-btn${g.favorite ? ' on' : ''}" data-act="favorite">${g.favorite ? '★ Favorite' : '☆ Add to favorites'}</button>
        <button class="btn-link" data-act="open-repo">Project page</button>
        ${g.site ? '<button class="btn-link" data-act="open-site">Website</button>' : ''}
        ${g.release && g.release.url ? '<button class="btn-link" data-act="open-notes">Release notes</button>' : ''}
        ${g.installed ? `<span>${g.installed.manual ? 'Your own copy' : `Installed ${esc(g.installed.tag)}`}</span><button class="btn-link" data-act="open-folder">Open folder</button><button class="btn-link" data-act="game-shots">Screenshots</button>${g.installed.manual ? '' : '<button class="btn-link" data-act="move-drive" title="Copies the game to another drive on your list, checks it, then removes the old copy">Move</button>'}<button class="btn-link danger" data-act="uninstall">${g.installed.manual ? 'Remove from Fulton' : 'Uninstall'}</button>` : ''}
        ${g.installed && !g.inSteam ? '<button class="btn-link steam" data-act="add-steam">＋ Add to Steam</button>' : ''}
        ${g.inSteam ? '<span class="in-steam">✓ In Steam</span><button class="btn-link danger" data-act="remove-steam">Remove from Steam</button>' : ''}
        <button class="btn-link danger" data-act="remove-shelf" title="${g.installed ? 'Uninstalls the game (after asking), then takes it off your shelf' : 'Takes it off your shelf; add it back any time from Find more'}">Remove from shelf</button>
      </div>
    </div>`;
  hydrateArt(el);
}

function renderRomDetail(el) {
  const r = S.roms.find((x) => `rom:${x.id}` === ui.selected);
  if (!r) { el.innerHTML = ''; return; }
  const sys = S.systems[r.system] || {};
  el.style.setProperty('--c', sys.color || '#c8161d');
  const name = romName(r);
  const short = (r.arcade && r.internalName) || name.replace(/\s*[([].*$/, '') || name;
  const unlocks = romUnlocks(r);
  const ext = (r.originalName || r.file || '').match(/\.[^.]+$/);
  const a = r.arcade;
  const plates = a ? [
    ['BOARD', sys.name, 'sys'],
    ['SET', `${a.set}.${r.format || 'zip'}`],
    a.year ? ['RELEASED', a.year] : null,
    a.maker ? ['MAKER', a.maker] : null,
    a.parent ? ['VERSION OF', a.parent] : null,
    a.bios ? ['BIOS', a.biosMissing ? `${a.bios}.zip missing` : `${a.bios}.zip found`, a.biosMissing ? 'warn' : 'rom'] : null,
    ['SIZE', fmtBytes(r.size)],
  ].filter((p) => p && p[1]) : [
    ['SYSTEM', sys.name, 'sys'],
    ['FILE', r.format === 'folder' ? 'Game folder' : ext ? ext[0].toLowerCase() : ''],
    ['SIZE', fmtBytes(r.size)],
    ['CHECKED', r.datName ? 'Verified (No-Intro)' : r.byName ? 'By file name' : 'By ROM header', 'rom'],
    r.serial ? ['SERIAL', r.serial] : null,
    r.addedAt ? ['ADDED', fmtDate(r.addedAt)] : null,
  ].filter((p) => p && p[1]);
  const first = unlocks[0];
  el.innerHTML = `
    <div class="hero-bg ${backdropMode()}" data-for="rom:${esc(r.id)}"><div></div></div>
    <div class="box3d">
      <div class="box">
        <div class="box-front"><div class="art-slot" data-cover-kind="rom" data-ref="${esc(r.id)}" data-file="${esc(r.cover || '')}">${coverMarkup({ id: r.id, title: short, system: r.system }, true)}</div></div>
        <div class="box-side"><b>${esc(short)}</b></div>
      </div>
      <div class="box-shadow"></div>
      <span class="hz-spine">${esc(short)}</span>
    </div>
    <div class="hero-info">
      <h1 class="hero-title${short.length > 24 ? ' long' : ''}"><span class="chrome">${esc(short)}</span></h1>
      <p class="hero-port">${esc(name !== short ? name : r.originalName || '')}<small>${a ? 'ARCADE SET' : 'YOUR ROM'}</small></p>
      <div class="plates">${plates.map(([k, v, c]) => `<div class="plate ${c || ''}"><small>${k}</small><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="hero-actions">
        ${first ? `<button class="btn3d huge" data-goto="${esc(first.id)}">▶ ${first.installed ? 'Play' : 'Get'} ${esc(first.port)}</button>` : '<button class="btn3d huge purple" data-view-go="discover">Find a port</button>'}
      </div>
      <div class="hero-more">
        ${unlocks.length > 1 ? `<span>Also works with ${unlocks.slice(1).map((g) => `<button class="btn-link" data-goto="${esc(g.id)}">${esc(g.port)}</button>`).join(' ')}</span>` : ''}
        ${!unlocks.length ? '<span>No port in your collection uses this yet. It will be matched as soon as one is added.</span>' : ''}
        <button class="btn-link" data-rom-reveal="${esc(r.id)}">Show file</button>
        <button class="btn-link" data-rom-cover="${esc(r.id)}">Change cover</button>
        ${r.customCover ? `<button class="btn-link" data-rom-cover-reset="${esc(r.id)}">Automatic cover</button>` : ''}
        <button class="btn-link danger" data-rom-remove="${esc(r.id)}">Remove</button>
      </div>
    </div>`;
  hydrateCovers(el);
  if (r.cover) { const bg = el.querySelector('.hero-bg div'); if (bg) fillBackdrop(bg, r.cover, fileUrl(r.cover)); }
}

/** The card element that is currently selected (a game can appear in several rows). */
function selectedEl() {
  const id = CSS.escape(ui.selected || '');
  return (ui.selRow && document.querySelector(`.card[data-id="${id}"][data-row="${CSS.escape(ui.selRow)}"]`))
    || document.querySelector(`.card[data-id="${id}"]`);
}

function markSelected(smooth, reveal = true) {
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  const el = selectedEl();
  if (!el) return;
  el.classList.add('selected');
  ui.selRow = el.dataset.row;
  if (reveal) revealCard(el, smooth);
}

/** Bring a card into view: sideways inside its row, and up/down within the page. */
function revealCard(card, smooth) {
  const behavior = smooth ? 'smooth' : 'auto';
  const shelf = card.closest('.shelf');
  if (shelf) shelf.scrollTo({ left: card.offsetLeft - shelf.clientWidth / 2 + card.offsetWidth / 2, behavior });
  const view = $('#view');
  const v = view.getBoundingClientRect();
  const sec = card.closest('.row-sec');
  const r = (ui.layout === 'grid' ? card : sec || card).getBoundingClientRect();
  const bar = document.querySelector('#view .fbar');
  const pad = (bar ? bar.offsetHeight : 60) + 50; // keep the row title clear of the sticky filter bar
  if (r.top < v.top + pad) view.scrollBy({ top: r.top - v.top - pad, behavior });
  else if (r.bottom > v.bottom - 20) view.scrollBy({ top: r.bottom - v.bottom + 40, behavior });
}

/** reveal = false when you clicked the card yourself: it is already on screen, so nothing should scroll or fold the banner */
function select(id, el, reveal = true) {
  ui.selected = id;
  ui.selRow = el ? el.dataset.row : null;
  markSelected(true, reveal);
  renderDetail();
}

/** Move the selection: left/right along a row, up/down to the row above or below. */
function moveSelection(dir) {
  const cur = selectedEl();
  const cards = [...document.querySelectorAll('#view .card')];
  if (!cards.length) return;
  if (!cur) return cards[0].dataset.id ? select(cards[0].dataset.id, cards[0]) : undefined;
  let next = null;
  if (dir === 'left' || dir === 'right') {
    const scope = ui.layout === 'grid' ? cards : [...cur.parentElement.children];
    const i = scope.indexOf(cur) + (dir === 'right' ? 1 : -1);
    next = scope[i] || null;
  } else {
    const c = cur.getBoundingClientRect();
    const cx = c.left + c.width / 2;
    const down = dir === 'down';
    const cand = cards.filter((x) => x !== cur).map((x) => ({ x, r: x.getBoundingClientRect() }))
      .filter(({ r }) => (down ? r.top >= c.bottom - 8 : r.bottom <= c.top + 8));
    if (cand.length) {
      const edge = down ? Math.min(...cand.map(({ r }) => r.top)) : Math.max(...cand.map(({ r }) => r.bottom));
      const row = cand.filter(({ r }) => Math.abs((down ? r.top : r.bottom) - edge) < 24);
      row.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx));
      next = row[0].x;
    }
  }
  // reaching a "show more" card (controller or arrow keys) draws the next batch, then you keep going
  if (next && next.dataset.more) { sectionLimit[next.dataset.more] = limitOf(next.dataset.more) + SECTION_STEP * 2; renderShelf(); return moveSelection(dir); }
  if (next && next.dataset.findMore) { next.focus(); return; }
  if (next) { select(next.dataset.id, next); next.focus({ preventScroll: true }); }
}

// ---------------------------------------------------------------- info pop-up (everything about the selected game)
const KIND_EXPLAINED = {
  native: 'The original game code was reverse-engineered back into readable C (decompiled), then rebuilt to run directly on your computer. Your ROM supplies the art, music and levels; the port supplies the code, plus modern options like widescreen and high frame rates.',
  recomp: 'Every instruction of the original N64 program is translated ahead of time into native PC code, so the game runs without an emulator. Your ROM supplies the game data.',
  reimpl: 'The game is rewritten from the ground up to behave exactly like the original, using the data from your own copy.',
};
function kindExplained(kind = '') {
  const k = kind.toLowerCase();
  if (k.includes('recomp')) return KIND_EXPLAINED.recomp;
  if (k.includes('reimplement')) return KIND_EXPLAINED.reimpl;
  return KIND_EXPLAINED.native;
}
const cleanNotes = (md) => String(md || '')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/^#{1,6}\s*/gm, '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '• ').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();


/** The details drawer is one element that lives between the selected game's row and the next row. */
function stashInfo() { const el = $('#info'); if (el && el.parentElement !== document.body) document.body.appendChild(el); if (el) el.classList.remove('inline'); }
function placeInfo() {
  const el = $('#info');
  const card = ui.infoOpen && ui.view === 'shelf' ? selectedEl() : null;
  if (!el || !card) { stashInfo(); return; }
  const wrap = card.parentElement;
  let anchor;
  if (wrap.classList.contains('grid')) {
    const top = card.offsetTop;
    anchor = [...wrap.children].filter((c) => c.classList.contains('card') && Math.abs(c.offsetTop - top) < 40).pop() || card;
  } else anchor = card.closest('.shelf-wrap') || wrap;
  el.classList.add('inline');
  if (anchor.nextElementSibling !== el) anchor.after(el);
  if (el.dataset.placed !== ui.selected) { el.dataset.placed = ui.selected; el.classList.remove('grow'); void el.offsetWidth; el.classList.add('grow'); }
}
window.addEventListener('resize', () => { if (ui.infoOpen) placeInfo(); });

function renderInfo() {
  const el = $('#info');
  const g = ui.infoOpen && ui.view === 'shelf' ? S.games.find((x) => x.id === ui.selected) : null;
  el.classList.toggle('open', !!g);
  el.setAttribute('aria-hidden', g ? 'false' : 'true');
  if (!g) { stashInfo(); return; }
  placeInfo();
  el.style.setProperty('--c', sysColor(g));
  const sys = S.systems[g.system] || {};
  const m = g.romMatch;
  const spec = g.rom || {};
  const facts = (rows) => `<dl class="facts">${rows.filter((r) => r && r[1]).map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${esc(v)}</dd>`).join('')}</dl>`;
  const howRom = { 'beside-exe': 'Fulton puts your ROM next to the game, which finds it on first launch and extracts its assets.', file: `Fulton copies your ROM to ${spec.setup && spec.setup.path} inside the game folder.`, 'in-app': "The game asks for the ROM the first time you play, so you don't have to load it here. If you do, Fulton checks it's the right version and copies its location to your clipboard so you can paste it in.", none: 'You supply the ROM when you build the project yourself.' }[(spec.setup && spec.setup.type) || 'in-app'];
  const notes = g.release && cleanNotes(g.release.notes);

  const live = g.installed && !g.running ? primaryAction(g).replace(/<button class="btn3d huge lime"[^>]*>[^<]*<\/button>/, '') : g.installed ? primaryAction(g).replace(/<button class="btn3d huge lime"[^>]*>[^<]*<\/button>/, '') : primaryAction(g);
  const rb = (ic, t, act, cls = '', tip = '') => `<div class="dr-rb ${cls}"><button data-act="${act}" title="${esc(tip || t)}">${ic}</button><span>${esc(t)}</span></div>`;
  const noRom = !m && !asksForRom(g);
  const round = [
    g.sourceOnly ? '' : rb('◉', 'ROM', 'load-rom', noRom ? 'warn' : m ? 'ok' : '', m ? 'Load a different ROM' : 'Load ROM'),
    g.updateAvailable && g.installed ? rb('⬇', 'Update', 'install', 'hot', 'Update to ' + (g.release && g.release.tag)) : '',
    g.installed ? rb('↺', 'Saves', 'backup-now', '', 'Back up your saves now') : '',
    rb('▣', 'Shots', 'game-shots', '', 'Screenshots'),
    g.installed && !g.installed.manual ? rb('⇄', 'Move', 'move-drive', '', 'Move to another drive') : '',
    rb(g.favorite ? '★' : '☆', 'Favorite', 'favorite', g.favorite ? 'on' : ''),
    g.installed ? rb('⌂', 'Folder', 'open-folder', '', 'Open game folder') : '',
  ].join('');
  const chip = (t, c = '') => t ? `<span class="${c}">${esc(String(t))}</span>` : '';
  const status = g.running ? chip('Playing now', 'ok') : g.installed ? chip('Installed ' + g.installed.tag, 'ok') : '';
  const where = g.installed && g.installed.dir ? esc(g.installed.dir) : '';

  el.innerHTML = `
    <div class="dr-glow"></div>
    <div class="dr-head">
      <div class="dr-cover"><div class="dr-art">${artMarkup(g, true)}</div><i class="dr-sheen"></i></div>
      <div class="dr-main">
        <p class="dr-eyebrow">${esc(g.port)} · ${esc(g.kind || 'Native PC port')}</p>
        <h2 class="dr-title">${esc(g.title)}</h2>
        <div class="dr-chips">${chip(sys.short)}${chip(g.year)}${chip(g.developer)}${status}</div>
        ${live.trim() ? `<div class="info-actions dr-live">${live.replace(/btn3d huge/g, 'btn3d')}</div>` : ''}
        <div class="dr-round">${round}</div>
        ${g.installed && !g.running ? '<p class="dr-hint">Double-click the game or press Enter to play</p>' : ''}
      </div>
      <button class="info-close" data-act="close-info" title="Close (Esc)">✕</button>
    </div>
    <div class="info-body">
      ${metaBlock(g)}

      <section class="info-sec"><h3>The original game</h3>
        ${g.about ? `<p>${esc(g.about)}</p>` : ''}
        ${facts([['System', sys.name], ['Released', g.year], ['Developer', g.developer], ['Publisher', g.publisher]])}
      </section>

      <section class="info-sec"><h3>This port</h3>
        ${g.description ? `<p>${esc(g.description)}</p>` : ''}
        ${facts([['Type', g.kind], ...(g.credits || []).map((c) => [c.role, c.name]), ['Project', g.repo]])}
        <p style="margin-top:10px;font-size:12.5px">${esc(kindExplained(g.kind))}</p>
      </section>

      <section class="info-sec"><h3>What you need <button class="help-q" data-help-tip="${g.needsFiles ? 'files' : 'roms'}" title="Help">?</button></h3>
        ${g.needsFiles || g.howToGet === 'build' || g.sourceOnly ? `<p class="callout" style="margin:0 0 10px;font-size:13px">${g.howToGet === 'build' || g.sourceOnly ? '<b>Build it yourself:</b> there\'s no ready-made download. Build it from the project\'s instructions, then click <b>Add your copy</b>. ' : ''}${g.needsFiles ? '<b>Needs your game files:</b> this port wants files taken from your own console or disc (extracted game folders, sometimes keys), not just a ROM.' : ''} <button class="btn-link" data-help-go="${g.howToGet === 'build' || g.sourceOnly ? 'own' : 'files'}">How this works</button></p>` : ''}
        ${facts([
          ['Your ROM', m ? m.label : asksForRom(g) ? 'Optional: the game asks for it' : 'Not added yet', m ? m.level : asksForRom(g) ? '' : 'warn'],
          m ? ['Check', m.reason, m.level] : null,
          ['Accepts', spec.regions ? `${spec.regions.join(' or ')} version${spec.requireTags ? ` (${spec.requireTags.join(', ')})` : ''}` : (spec.discIds ? 'A disc image (.iso or .rvz)' : null)],
        ])}
        ${g.sourceOnly ? '' : `<div class="info-actions" style="margin:10px 0 4px"><button class="btn3d small ${m ? 'purple' : 'cyan'}" data-act="load-rom">${m ? 'Load a different ROM' : 'Load ROM'}</button></div>`}
        ${spec.note ? `<p style="margin-top:8px">${esc(spec.note)}</p>` : ''}
        <p style="font-size:12.5px">${esc(howRom)}</p>
        ${spec.firstRun && !g.sourceOnly ? `<p style="font-size:12.5px"><b style="color:#fff">First launch:</b> ${esc(spec.firstRun)}</p>` : ''}
        <div class="rom-help" id="romhelp-${esc(g.id)}">${romHelpHtml(g)}</div>
      </section>

      ${g.sourceOnly ? '' : `<section class="info-sec"><h3>Version</h3>
        ${facts([
          ['Installed', g.installed ? g.installed.tag : 'Not installed', g.installed ? 'ok' : ''],
          ['Latest', g.release ? `${g.release.tag}${g.release.published ? ` · ${fmtDate(g.release.published)}` : ''}` : (g.releaseError || 'Checking…'), g.updateAvailable ? 'warn' : ''],
          ['Download', g.release && g.release.asset ? `${g.release.asset.name} (${fmtBytes(g.release.asset.size)})` : null],
          g.installed && g.installed.playTime ? ['Play time', fmtTime(g.installed.playTime)] : null,
          g.installed && g.installed.lastPlayed ? ['Last played', fmtDate(g.installed.lastPlayed)] : null,
        ])}
        ${notes ? `<p style="margin:12px 0 6px;color:#fff;font-weight:800">What's new in ${esc(g.release.tag)}</p><div class="notes">${esc(notes.slice(0, 1800))}${notes.length > 1800 ? '…' : ''}</div>` : ''}
      </section>`}

      ${g.installed || backupsCache.has(g.id) ? `<section class="info-sec"><h3>Your saves</h3><div id="saves-${esc(g.id)}">${savesHtml(g)}</div></section>` : ''}

      <div class="info-links">
        <button class="btn-link" data-act="pick-cover" title="Or drop a picture onto the window">Change cover</button>
        ${g.customCover ? '<button class="btn-link" data-act="reset-cover">Automatic cover</button>' : ''}
        <button class="btn-link fav-btn${g.favorite ? ' on' : ''}" data-act="favorite">${g.favorite ? '★ Favorite' : '☆ Add to favorites'}</button>
        <button class="btn-link" data-act="open-repo">Project page</button>
        ${g.site ? '<button class="btn-link" data-act="open-site">Website</button>' : ''}
        ${g.release && g.release.url ? '<button class="btn-link" data-act="open-notes">Full release notes</button>' : ''}
        ${g.installed ? `<button class="btn-link" data-act="open-folder">Open game folder</button>` : ''}
        ${g.installed && !g.inSteam ? '<button class="btn-link steam" data-act="add-steam">＋ Add to Steam</button>' : ''}
        ${g.inSteam ? '<button class="btn-link danger" data-act="remove-steam">Remove from Steam</button>' : ''}
      </div>
      <div class="info-foot">
        ${g.installed && !g.installed.manual ? `<button class="btn-link" data-act="move-drive" title="Copies the game to another drive on your list, checks it, then removes the old copy">Move to another drive</button>` : ''}
        ${g.installed ? `<button class="btn-link danger" data-act="uninstall">${g.installed.manual ? 'Remove from Fulton' : 'Uninstall'}</button>` : ''}
        <button class="btn-link danger" data-act="remove-shelf" title="${g.installed ? 'Uninstalls the game (after asking), then takes it off your shelf' : 'Takes it off your shelf; add it back any time from Find more'}">Remove from shelf</button>
      </div>
    </div>
    ${where ? `<div class="dr-path">${where}</div>` : ''}`;
  hydrateArt(el);
}

/** Big gold Metascore for the info panel. Games without a stored score are looked up on Metacritic once. */
const metaLoading = new Set();
function metaBlock(g) {
  if (!S.settings.showMetacritic) return '';
  const mc = g.metacritic;
  const searchUrl = `https://www.metacritic.com/search/${encodeURIComponent(g.title)}/`;
  if (!mc && !g.metaChecked) {
    if (!metaLoading.has(g.id)) {
      metaLoading.add(g.id);
      api.metascore(g.id).catch(() => {}).finally(() => { metaLoading.delete(g.id); });
    }
    return `<div class="meta none loading"><div class="meta-score">···</div>
      <div class="meta-text"><small>METASCORE</small><b>Checking Metacritic…</b></div></div>`;
  }
  const verdictOf = (n) => (n >= 90 ? 'Universal acclaim' : n >= 75 ? 'Generally favorable' : n >= 50 ? 'Mixed or average' : n >= 20 ? 'Generally unfavorable' : 'Overwhelming dislike');
  const fmtN = (n) => Number(n || 0).toLocaleString();

  // Critic score (0-100)
  let critic;
  if (mc && mc.score != null) {
    critic = `<div class="meta-col">
      <div class="meta-score">${mc.score}</div>
      <div class="meta-text"><small>METASCORE</small><b>${verdictOf(mc.score)}</b><span>${mc.reviews ? `${fmtN(mc.reviews)} critic review${mc.reviews === 1 ? '' : 's'}` : 'Critic score'}${mc.platform ? ` · ${esc(mc.platform)}` : ''}</span></div>
    </div>`;
  } else {
    critic = `<div class="meta-col empty">
      <div class="meta-score">N/A</div>
      <div class="meta-text"><small>METASCORE</small><b>No critic score</b><span>${mc ? 'Too few critic reviews' : 'Not listed on Metacritic'}</span></div>
    </div>`;
  }
  // User score (0-10)
  const u = mc && mc.user;
  let user;
  if (u && u.score != null) {
    user = `<div class="meta-col">
      <div class="meta-score user">${Number(u.score).toFixed(1)}</div>
      <div class="meta-text"><small>USER SCORE</small><b>${verdictOf(u.score * 10)}</b><span>${fmtN(u.ratings)} user rating${u.ratings === 1 ? '' : 's'}${u.platform ? ` · ${esc(u.platform)}` : ''}</span></div>
    </div>`;
  } else {
    user = `<div class="meta-col empty">
      <div class="meta-score user">${u ? 'tbd' : 'N/A'}</div>
      <div class="meta-text"><small>USER SCORE</small><b>No user score</b><span>${u ? `Only ${fmtN(u.ratings)} rating${u.ratings === 1 ? '' : 's'} so far` : 'Not listed on Metacritic'}</span></div>
    </div>`;
  }
  const url = mc ? mc.url : searchUrl;
  return `<div class="meta-wrap">
    <div class="meta two${mc && (mc.score != null || (u && u.score != null)) ? '' : ' none'}" data-url="${esc(url)}" role="link" tabindex="0" title="Open on Metacritic">${critic}${user}</div>
    <div class="meta-links"><button class="btn-link" data-url="${esc(url)}">${mc ? 'Open on Metacritic' : 'Search Metacritic'}</button>${!mc || mc.score == null ? '<button class="btn-link" data-act="meta-retry">Check again</button>' : ''}</div>
  </div>`;
}

// ---------------------------------------------------------------- save backups
const backupsCache = new Map(); // gameId -> list | 'loading'
const REASONS = { manual: 'Backed up by you', 'after playing': 'After playing', 'before update': 'Before an update', 'before uninstall': 'Before uninstalling', 'before restore': 'Before a restore' };
function loadBackups(id, force = false) {
  if (!force && backupsCache.has(id)) return;
  backupsCache.set(id, 'loading');
  api.listBackups(id).then((list) => {
    backupsCache.set(id, list || []);
    const el = document.getElementById(`saves-${id}`);
    const g = S.games.find((x) => x.id === id);
    if (el && g) el.innerHTML = savesHtml(g);
  }).catch(() => backupsCache.set(id, []));
}
function savesHtml(g) {
  const list = backupsCache.get(g.id);
  if (!list) { loadBackups(g.id); return '<p>Checking backups…</p>'; }
  if (list === 'loading') return '<p>Checking backups…</p>';
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const rows = list.slice(0, 8).map((b) => `<div class="save-row">
      <div><b>${esc(when(b.createdAt))}</b><span>${esc(REASONS[b.reason] || b.reason)} · ${b.files} file${b.files === 1 ? '' : 's'} · ${esc(fmtBytes(b.size) || '0 KB')}</span></div>
      ${g.installed ? `<button class="btn3d small purple" data-restore="${esc(b.id)}">Restore</button>` : ''}
    </div>`).join('');
  return `${list.length ? `<div class="save-list">${rows}</div>${list.length > 8 ? `<p class="save-more">${list.length - 8} older backups in the backups folder.</p>` : ''}` : `<p>No backups yet. ${S.settings.autoBackup !== false ? 'Fulton backs up automatically after you play and before updates.' : 'Automatic backups are off in Settings.'}</p>`}
    <div class="info-actions">${g.installed ? '<button class="btn3d small cyan" data-act="backup-now">Back up now</button>' : ''}<button class="btn-link" data-act="open-backups">Open backups folder</button></div>`;
}

// ---------------------------------------------------------------- getting the ROM the right way
const romHelpCache = new Map(); // gameId -> help | 'loading' | null
const guideOpen = {}; // gameId -> true/false once the reader opens or closes the guide
function loadRomHelp(id) {
  if (romHelpCache.has(id)) return;
  romHelpCache.set(id, 'loading');
  api.romHelp(id).then((h) => {
    romHelpCache.set(id, h || null);
    const el = document.getElementById(`romhelp-${id}`);
    const g = S.games.find((x) => x.id === id);
    if (el && g) el.innerHTML = romHelpHtml(g);
  }).catch(() => romHelpCache.set(id, null));
}

function romHelpHtml(g) {
  const h = romHelpCache.get(g.id);
  if (h === undefined) { loadRomHelp(g.id); return ''; }
  if (!h || h === 'loading') return '';
  const sys = S.systems[g.system] || {};
  const disc = DISC_SYSTEMS.has(g.system) || !!h.discIds;
  let versions = '';
  if (h.discIds) {
    const kinds = { G: 'GameCube', R: 'Wii', S: 'Wii' };
    const ids = h.discIds.map((x) => `<code>${esc(x)}</code>${kinds[x[0]] ? ` (${kinds[x[0]]})` : ''}`).join(' or ');
    versions = `<p class="rh-label">Discs that work</p><p class="rh-note">Your own disc of ${esc(g.title)} whose game ID starts with ${ids}. Fulton reads the ID when you load it, so you don't need to check it yourself.</p>`;
  } else if (h.targets.length) {
    versions = `<p class="rh-label">Exact version${h.targets.length > 1 ? 's' : ''} that work${h.targets.length > 1 ? '' : 's'}</p>
      <ul class="rh-targets">${h.targets.map((t) => `<li><span>${esc(t.name)}</span><span class="rh-sha"><code title="SHA-1 ${esc(t.sha1)}">SHA-1 ${esc(t.sha1.slice(0, 8).toLowerCase())}…</code><button class="btn-link" data-copy="${esc(t.sha1.toLowerCase())}">Copy</button></span></li>`).join('')}</ul>
      ${h.more ? `<p class="rh-note">…and ${h.more} more.</p>` : ''}
      <p class="rh-note">Fulton checks this for you when you load a ROM. The SHA-1 is the file's fingerprint${g.system === 'n64' ? ' (of the .z64 file)' : ''}, if you'd like to check it yourself.</p>`;
  }
  const guide = h.guide;
  const open = guideOpen[g.id] ?? !g.romMatch;
  const guideHtml = guide ? `<details class="dump-guide" data-guide="${esc(g.id)}"${open ? ' open' : ''}>
      <summary>How do I get this ${disc ? 'disc image' : 'ROM'}?</summary>
      <p class="rh-note">Make a copy of a game you own. It's called "dumping", and it's easier than it sounds:</p>
      <ol>${guide.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
      <div class="rh-links">${guide.links.map((l) => `<button class="btn-link" data-url="${esc(l.url)}">${esc(l.label)}</button>`).join('')}</div>
      <p class="rh-buy">Don't have the game? <button class="btn-link" data-url="${esc(h.buyUrl)}">Find the original ${sys.name ? esc(sys.name) + ' ' : ''}${disc ? 'disc' : 'cartridge'} on eBay</button></p>
    </details>` : '';
  return `${versions}${guideHtml}`;
}

function openInfo(open = true) { ui.infoOpen = open; if (!open) { const e = $('#info'); if (e) delete e.dataset.placed; } if (!open) panelFocusSig = null; renderInfo(); restorePanelFocus(); if (pad.connected) updatePadHints(); }

// ---------------------------------------------------------------- Steam artwork (drawn here, saved by the main process)
function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}
function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** One Steam image: blurred backdrop + box art (or a 90s cover) + optional title. */
function drawSteamImage(img, g, w, h, { artBox, title, titleBox, hero } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const col = sysColor(g);
  // backdrop
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, col); grad.addColorStop(1, '#12060a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  if (img) {
    const s = Math.max(w / img.width, h / img.height) * 1.15;
    ctx.save(); ctx.filter = 'blur(28px) brightness(0.55) saturate(1.3)';
    ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
    ctx.restore();
  } else {
    // sunburst like the in-app covers
    ctx.save(); ctx.translate(w / 2, h * 1.15); ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let a = 0; a < 360; a += 14) { ctx.rotate((14 * Math.PI) / 180); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-w, -h * 2); ctx.lineTo(-w * 0.82, -h * 2); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  // box art
  if (img && artBox && !hero) {
    const [bx, by, bw, bh] = artBox;
    const s = Math.min(bw / img.width, bh / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 12;
    ctx.drawImage(img, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
    ctx.restore();
  }
  if (hero && img) {
    const s = Math.min((h * 0.9) / img.height, (w * 0.45) / img.width);
    const dw = img.width * s, dh = img.height * s;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40;
    ctx.drawImage(img, w - dw - w * 0.08, (h - dh) / 2, dw, dh);
    ctx.restore();
  }
  // title
  if (title && titleBox) {
    const [tx, ty, tw, th] = titleBox;
    let size = Math.round(th / 2.2);
    ctx.font = `900 ${size}px ${CANVAS_FONT}`;
    let lines = wrapLines(ctx, title.toUpperCase(), tw);
    while ((lines.length * size * 1.1 > th || lines.some((l) => ctx.measureText(l).width > tw)) && size > 12) {
      size -= 2; ctx.font = `900 ${size}px ${CANVAS_FONT}`; lines = wrapLines(ctx, title.toUpperCase(), tw);
    }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const startY = ty + th / 2 - ((lines.length - 1) * size * 1.1) / 2;
    lines.forEach((l, i) => ctx.fillText(l, tx + tw / 2, startY + i * size * 1.1));
  }
  try { return c.toDataURL('image/png'); } catch { return null; } // a cross-origin image without CORS taints the canvas
}
function drawLogo(g) {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 400;
  const ctx = c.getContext('2d');
  let size = 120;
  ctx.font = `900 ${size}px ${CANVAS_FONT}`;
  let lines = wrapLines(ctx, g.title.toUpperCase(), 1200);
  while (lines.length * size * 1.05 > 380 && size > 30) { size -= 6; ctx.font = `900 ${size}px ${CANVAS_FONT}`; lines = wrapLines(ctx, g.title.toUpperCase(), 1200); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const y0 = 200 - ((lines.length - 1) * size * 1.05) / 2;
  lines.forEach((l, i) => {
    ctx.lineWidth = size / 6; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(l, 640, y0 + i * size * 1.05);
    ctx.fillStyle = '#fff'; ctx.fillText(l, 640, y0 + i * size * 1.05);
  });
  return c.toDataURL('image/png');
}
async function buildSteamArt(g) {
  // canvas text only uses a bundled font once it has loaded
  try { await document.fonts.load('900 40px "Cartridge Heavy"'); } catch { /* falls back to system fonts */ }
  const found = await resolveArt(g);
  let src = found && found.src;
  if (found && found.file) src = await api.imageData(found.file).catch(() => null);
  let img = src ? await loadImg(src) : null;
  const name = g.title;
  const make = (im) => ({
    portrait: drawSteamImage(im, g, 600, 900, { artBox: [40, 60, 520, im ? 560 : 0], title: name, titleBox: im ? [40, 650, 520, 200] : [40, 250, 520, 400] }),
    wide: drawSteamImage(im, g, 920, 430, { artBox: [30, 30, 420, 370], title: name, titleBox: im ? [480, 60, 410, 310] : [60, 60, 800, 310] }),
    hero: drawSteamImage(im, g, 1920, 620, { hero: true }),
    logo: drawLogo(g),
  });
  let art = make(img);
  if (img && (!art.portrait || !art.wide || !art.hero)) art = make(null); // image couldn't be used, fall back to a drawn cover
  return art;
}

async function addToSteam(games) {
  const status = await guard(() => api.steamStatus());
  if (!status) return;
  if (!status.found) { toast("Couldn't find Steam", 'Install Steam and sign in once, then try again.', 'warn'); return; }
  toast(games.length > 1 ? `Preparing ${games.length} games for Steam…` : `Preparing ${games[0].port} for Steam…`, 'Making the library artwork.');
  const items = [];
  for (const g of games) items.push({ id: g.id, art: await buildSteamArt(g) });
  const res = await guard(() => api.addToSteam(items));
  if (!res || res.cancelled) return;
  const names = res.added.map((id) => (S.games.find((x) => x.id === id) || {}).port).filter(Boolean);
  toast(names.length > 1 ? `${names.length} games added to Steam!` : `${names[0]} added to Steam!`,
    res.restarted ? 'Steam is reopening. Find them in your library under Non-Steam games.' : 'Start Steam and find them in your library under Non-Steam games.', 'ok');
}

// ---------------------------------------------------------------- ROMs view
function panelHead(title, sub) {
  return `<div class="panel-head"><h1><span class="chrome">${esc(title)}</span></h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
}

let romsLimit = 300;
let lastRomsSig = '';
function renderRoms() {
  // state updates arrive often; only redraw the list when something on it changed
  const missing = S.roms.filter((r) => r.missing).length;
  const sig = [S.roms.length, S.scanning, missing, (S.settings.romFolders || []).join('|'), romsLimit, S.roms.filter((r) => r.customCover).length, S.roms.slice(0, romsLimit).filter((r) => r.cover).length].join('#');
  if (sig === lastRomsSig && $('#view .rom-drop')) return;
  lastRomsSig = sig;
  const shown = S.roms.slice(0, romsLimit);
  const rows = shown.map((r) => {
    const unlocks = S.games.filter((g) => g.romMatch && g.romMatch.romId === r.id);
    const sys = S.systems[r.system] || {};
    return `<div class="row rom-row${r.missing ? ' is-missing' : ''}">
      <div class="rom-art" data-cover-kind="rom" data-ref="${esc(r.id)}" data-file="${esc(r.cover || '')}" style="--c:${sys.color || '#c8161d'}"><span>${esc(sys.short || '')}</span></div>
      <span class="dot ${r.datName ? 'ok' : 'warn'}" title="${r.datName ? 'Verified against No-Intro' : 'Unverified dump'}"></span>
      <div><div class="name">${esc(r.datName || r.internalName || r.originalName)}</div>
        <div class="sub">${r.missing ? '<b class="missing-tag" title="The file was moved, deleted, or is on a drive that isn\'t connected">File missing</b> · ' : ''}${esc(sys.name || r.system)} · ${esc(fmtBytes(r.size))}${r.format && r.format !== 'z64' && r.system === 'n64' ? ` · converted from .${esc(r.format)}` : ''}</div></div>
      <div class="tags">${unlocks.length ? unlocks.map((g) => `<span class="tag">${esc(g.port)}</span>`).join('') : '<span class="sub">No matching port yet</span>'}</div>
      <div class="inline"><button class="btn-link" data-rom-cover="${esc(r.id)}" title="Use your own picture as this ROM's cover">Cover</button>${r.customCover ? `<button class="btn-link" data-rom-cover-reset="${esc(r.id)}" title="Go back to the automatic cover">Auto</button>` : ''}<button class="btn-link" data-rom-reveal="${esc(r.id)}">Show</button><button class="btn-link danger" data-rom-remove="${esc(r.id)}">Remove</button></div>
    </div>`;
  }).join('');
  $('#view').innerHTML = `<div class="panel">
    ${panelHead('My ROMs', 'Everything you add is checked and matched to the ports that use it. Your ROM files stay where they are; Fulton never copies your collection.')}
    <div class="rom-drop">
      <p><b>Point Fulton at your ROM folder</b>It searches every subfolder and zip, matches each ROM to its game, and checks the folder again every time it starts.</p>
      <button class="btn3d small cyan" data-act="add-folder">+ Add a folder</button>
      <button class="btn3d small purple" data-act="pick-files">Choose files</button>
    </div>
    ${missing ? `<div class="callout warn-callout"><b>${missing.toLocaleString()} ROM${missing > 1 ? 's\'' : '\'s'} file${missing > 1 ? 's are' : ' is'} missing.</b> ${missing > 1 ? 'They were' : 'It was'} moved, deleted, or ${missing > 1 ? 'are' : 'is'} on a drive that isn't connected. If you moved them, add the new folder and Fulton finds them again. <button class="btn-link" data-act="forget-missing">Remove missing from the list</button> <button class="help-q" data-help-tip="setup" title="Help">?</button></div>` : ''}
    ${(S.settings.romFolders || []).length ? `<div class="folders">
      <div class="folders-head"><b>Watched folders</b><button class="btn-link" data-act="rescan">${S.scanning ? 'Scanning…' : 'Rescan now'}</button></div>
      ${S.settings.romFolders.map((f) => `<div class="folder-row"><span class="folder-ico"></span><span class="folder-path">${esc(f)}</span><button class="btn-link" data-open-path="${esc(f)}">Open</button><button class="btn-link danger" data-folder-remove="${esc(f)}">Stop watching</button></div>`).join('')}
    </div>` : ''}
    ${S.roms.length ? `<div class="rows">${rows}</div>${S.roms.length > romsLimit ? `<div class="roms-more"><span>Showing ${romsLimit.toLocaleString()} of ${S.roms.length.toLocaleString()} ROMs.</span><button class="btn3d small purple" data-roms-more="1">Show 300 more</button><span class="sub">Tip: the Games screen's ROMs view can filter by console and search.</span></div>` : ''}<p class="cover-credit">Box art from <button class="btn-link" data-url="https://github.com/libretro-thumbnails">libretro-thumbnails</button>${S.settings.steamGridKey ? ' and <button class="btn-link" data-url="https://www.steamgriddb.com">SteamGridDB</button>' : ''}. Click <b>Cover</b> to use your own picture.</p>` : '<div class="empty"><h2>No ROMs yet</h2><p>Point Fulton at the folder where you keep the ROMs you\'ve dumped from your own cartridges and discs. It finds them all and unlocks the matching games.</p><button class="btn3d" data-act="add-folder">+ Add your ROM folder</button></div>'}
  </div>`;
  hydrateCovers($('#view'));
}

// ---------------------------------------------------------------- discover
// "Find more": browse the community catalog of ports, plus a GitHub search for anything brand new.
let discoverResults = null;
let communityData = null; // { source, items }
let discoverSeen = false; // Find more opened this session (what's "new" is counted from the visit before)
let communityError = null;
const disc = { q: '', system: null, kind: null, get: null, range: 0, os: null, status: null, hideShelf: false, sort: 'best', size: 3, limit: 60 };
// only the Sort and card Size come back between launches; the console and filters always start on All
try { const saved = JSON.parse(localStorage.getItem('fulton.disc') || '{}'); if (['best', 'released', 'name'].includes(saved.sort)) disc.sort = saved.sort; { const legacy = { list: 0, small: 2, normal: 3, large: 7, huge: 10 }; const v = typeof saved.size === 'number' ? saved.size : legacy[saved.size]; if (Number.isFinite(v) && v >= 0 && v <= 10) disc.size = Math.round(v); } } catch { /* fine */ }
// Card size is a slider: 0 = one compact line per port (List), then 1 to 10 from small to huge cards (3 is Normal)
const SIZE_NAMES = ['List', 'Tiny', 'Small', 'Normal', 'Medium', 'Medium', 'Large', 'Large', 'Big', 'Big', 'Huge'];
const sizeVars = (v) => { const art = 40 + (v - 1) * 14; return `--art:${art}px;--cw:${230 + (v - 1) * 45}px;--k:${Math.max(0.85, Math.min(2.4, art / 64)).toFixed(2)}`; };
function applySize() {
  const g = $('.cgrid');
  if (g) { g.classList.toggle('sz-list', disc.size === 0); g.classList.toggle('sz-var', disc.size > 0); g.style.cssText = disc.size > 0 ? sizeVars(disc.size) : ''; }
  const l = $('#size-label'); if (l) l.textContent = SIZE_NAMES[disc.size] || 'Normal';
  try { localStorage.setItem('fulton.disc', JSON.stringify({ sort: disc.sort, size: disc.size })); } catch { /* fine */ }
}
// range: 0 = any time, N = updated within N days, -1 = older than a year
const RANGES = [[0, 'Any time'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [-1, 'Older than a year']];
const inRange = (c, r) => !r || (c.released && (r > 0 ? c.released >= Date.now() - r * DAY : c.released < Date.now() - 365 * DAY));
const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const discActive = () => !!(disc.q.trim() || disc.system || disc.kind || disc.get || disc.range || disc.os || disc.status || disc.hideShelf);
// Games page → Find more: open it with the same console and type, and the ports already on your shelf hidden
const FM_KINDS = ['decomp', 'recomp', 'remake'];
function findMoreFor(system, kind) {
  Object.assign(disc, { q: '', system: system || null, kind: kind || null, get: null, range: 0, os: null, status: null, hideShelf: true, limit: 60 });
  ui.filtersOpen = false;
  setView('discover');
}
const fmMatches = (system, kind) => communityData ? communityData.items.filter((c) => (!system || c.system === system) && (!kind || KIND_GROUP(c.kind) === kind) && !c.onShelf).length : null;
function findMoreCard(system, kind) {
  const sy = S.systems[system] || {};
  const kindName = kind ? (TYPES.find((t) => t[0] === kind) || [0, kind])[1] : '';
  const what = [system && sy.short, kindName].filter(Boolean).join(' ');
  const n = fmMatches(system, kind);
  return `<button class="card find-more-card" data-find-more="1" data-fm-system="${esc(system || '')}" data-fm-kind="${esc(kind || '')}" style="--c:${sy.color || 'var(--accent)'}" title="Open Find more${what ? ' with the same filters' : ''}"><span class="fm-plus">+</span><b>Find more ${what ? esc(what) + (kind ? '' : ' games') : 'games'}</b><small>${n == null ? 'Browse the Find more list' : n ? `${n.toLocaleString()} you don't have yet` : 'You have them all'}</small></button>`;
}
const DAY = 86400000;
const ago = (t) => { const d = Math.max(0, Math.floor((Date.now() - t) / DAY)); return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : d < 700 ? `${Math.round(d / 30)} months ago` : `${Math.round(d / 365)} years ago`; };
let platformsStarted = false;
let platformProgress = null; // { done, total } while the Windows / Mac check runs
// How you get a port running, from the Find more lists: tags of [label, tooltip, class]
function getTags(c) {
  const tags = [];
  if (c.get === 'download') tags.push(['Download', 'Has a release Fulton can install.', 'dl']);
  if (c.get === 'build') tags.push(['Build it yourself', "No release to download: you build it from the project's instructions, then use Add your copy. See Help → Games you build yourself.", 'build']);
  if (c.needsFiles) tags.push(['Needs game files', 'Needs files from your own console or disc (extracted game files, sometimes keys), not just a ROM. See Help → Games that need your game files.', 'files']);
  return tags;
}

async function loadCommunity(force = false, quiet = false) {
  communityError = null;
  try { communityData = await api.communityList(force); } catch (e) { communityError = e.message; }
  if (communityData && !quiet && !platformsStarted) { platformsStarted = true; guard(() => api.checkPlatforms()); }
  const fresh = communityData ? communityData.items.filter((c) => c.isNew).length : 0;
  const badge = $('#c-new');
  if (badge) {
    badge.textContent = fresh > 99 ? '99+' : String(fresh || '');
    badge.title = `${fresh} new port${fresh === 1 ? '' : 's'} since your last visit`;
    badge.hidden = !fresh;
  }
  if (ui.view === 'discover') renderDiscoverList();
}

function communityFiltered() {
  const out = communityFilteredRaw();
  if (disc.sort === 'released') return out.slice().sort((a, b) => (b.released || 0) - (a.released || 0));
  if (disc.sort === 'name') return out.slice().sort((a, b) => a.name.localeCompare(b.name));
  const q = plain(disc.q);
  if (/\b(new|updates?|updated|latest|recent|recently)\b/.test(q)) return out.slice().sort((a, b) => (b.released || 0) - (a.released || 0));
  if (!q) return out;
  // searching: matches on the game's own name come first, then project, team and console
  const rank = (c) => { const n = plain(c.name); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : plain(c.project).includes(q) ? 3 : 4; };
  return out.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

function communityFilteredRaw() {
  if (!communityData) return [];
  let words = plain(disc.q).split(' ').filter(Boolean);
  // typing "new" or "updated" (also update, latest, recent) finds new and recently updated ports
  const wantNew = words.includes('new'), wantUpd = words.some((w) => ['update', 'updated', 'updates', 'latest', 'recent', 'recently'].includes(w));
  if (wantNew || wantUpd) words = words.filter((w) => !['new', 'update', 'updated', 'updates', 'latest', 'recent', 'recently'].includes(w));
  return communityData.items.filter((c) => {
    if (wantNew && !wantUpd && !isFresh(c)) return false;
    if (wantUpd && !(c.released && c.released >= Date.now() - newDays() * DAY)) return false;
    if (disc.system && c.system !== disc.system) return false;
    if (disc.kind && KIND_GROUP(c.kind) !== disc.kind) return false;
    if (disc.get === 'new' ? !c.isNew : disc.get && c.get !== disc.get) return false;
    if (disc.range && !inRange(c, disc.range)) return false;
    if (disc.os && !c[disc.os]) return false;
    if (disc.status && (c.status || '') !== disc.status) return false;
    if (disc.hideShelf && c.onShelf) return false;
    if (!words.length) return true;
    const hay = plain(`${c.name} ${c.project} ${c.repo} ${c.tags.join(' ')} ${c.status || ''} ${(S.systems[c.system] || {}).name || ''} ${c.win ? 'windows pc' : ''} ${c.mac ? 'mac macos' : ''}`);
    return words.every((w) => hay.includes(w));
  });
}

function renderDiscover() {
  $('#view').innerHTML = `<div class="panel wide">
    ${panelHead('Find more games', '')}
    <p class="disc-sub">Decomp and recomp ports for every console, from the <button class="btn-link" data-url="${esc((communityData && communityData.source) || 'https://github.com/tgeorgiadis/quiver-community-app-catalog')}">Quiver community catalog</button> and <button class="btn-link" data-url="https://recompendium.com/en/">Recompendium</button> (CC BY-SA 4.0). Add one to your shelf, then install it like any other game. Newer ports, especially Switch, Wii U and PS4 ones, often have no download yet or need files from your own console: the label on each card says which. <button class="help-q" data-help-tip="find" title="What the labels mean">?</button></p>
    <div class="disc-bar">
      <label class="search disc-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
        <input id="disc-filter" placeholder="Search by game name, e.g. Ocarina of Time" value="${esc(disc.q)}" autocomplete="off"></label>
      <span id="disc-tools" class="disc-tools"></span>
      <button class="btn-link" data-act="community-refresh">Refresh list</button>
    </div>
    <div class="disc-chips" id="disc-chips"></div>
    <div id="disc-list"></div>

    <div class="gh-search">
      <h3>Not listed? Search GitHub</h3>
      <form class="inline" id="disc-form">
        <label class="search" style="width:auto;flex:1;margin:0"><input id="disc-q" placeholder="Game or project name, e.g. Paper Mario" value="${esc(ui.discoverQ || '')}"></label>
        <button class="btn3d" type="submit">Search GitHub</button>
      </form>
      <div id="add-form-slot"></div>
      <div id="gh-results">${ghResultsHtml()}</div>
    </div>
  </div>`;
  if (!discoverSeen) { discoverSeen = true; guard(() => api.discoverVisited()); }
  else if (communityData) guard(() => api.checkPlatforms()); // anything not checked yet, or out of date
  if (!communityData && !communityError) loadCommunity();
  renderDiscoverList();
}

function ghResultsHtml() {
  if (discoverResults === null) return '';
  if (discoverResults.error) return `<div class="empty"><h2>Search failed</h2><p>${esc(discoverResults.error)}</p></div>`;
  if (!discoverResults.length) return '<div class="empty"><h2>Nothing found</h2><p>Try another search term, or just the game\'s name.</p></div>';
  const known = new Set(S.games.map((g) => (g.repo || '').toLowerCase()));
  return `<div class="rows">${discoverResults.map((r) => `<div class="row disc-row">
      <img src="${esc(r.avatar || '')}" alt="">
      <div><div class="name">${esc(r.repo)}</div><div class="sub">${esc(r.description)}</div></div>
      <span class="stars-n">★ ${r.stars.toLocaleString()}</span>
      ${known.has(r.repo.toLowerCase()) ? '<span class="tag">On your shelf</span>' : `<button class="btn3d small" data-add-repo="${esc(r.repo)}">Add</button>`}
    </div>`).join('')}</div>`;
}

function renderDiscoverList() {
  const listEl = $('#disc-list');
  const chipsEl = $('#disc-chips');
  if (!listEl) return;
  if (communityError && !communityData) {
    listEl.innerHTML = `<div class="empty"><h2>Couldn't load the list</h2><p>${esc(communityError)}</p><button class="btn3d" data-act="community-refresh">Try again</button></div>`;
    chipsEl.innerHTML = '';
    return;
  }
  if (!communityData) { listEl.innerHTML = '<div class="empty"><h2>Loading…</h2><p>Fetching the community catalog.</p></div>'; return; }

  const all = communityData.items;
  const bySys = {};
  for (const c of all) bySys[c.system] = (bySys[c.system] || 0) + 1;
  const sysOrder = Object.keys(S.systems).filter((id) => bySys[id]);
  const statusList = [...new Set(all.map((c) => c.status).filter(Boolean))].sort();
  const countOn = [disc.kind, disc.get, disc.range, disc.os, disc.status].filter(Boolean).length;
  const tagsOn = [];
  if (disc.kind) tagsOn.push(['kind', (TYPES.find((t) => t[0] === disc.kind) || [0, disc.kind])[1]]);
  if (disc.get) tagsOn.push(['get', { new: '✦ New', download: 'Download', build: 'Build it yourself' }[disc.get] || disc.get]);
  if (disc.range) tagsOn.push(['range', 'Updated: ' + (disc.range === -1 ? 'Older than a year' : (RANGES.find((r) => r[0] === disc.range) || [0, `Last ${disc.range} days`])[1] === 'Any time' ? '' : (RANGES.find((r) => r[0] === disc.range) || [0, `Last ${disc.range} days`])[1])]);
  if (disc.os) tagsOn.push(['os', disc.os === 'win' ? 'Windows download' : 'Mac download']);
  if (disc.status) tagsOn.push(['status', disc.status]);
  if (disc.hideShelf) tagsOn.push(['hideShelf', 'Not on my shelf']);
  const tools = $('#disc-tools');
  if (tools) tools.innerHTML = `<button type="button" class="filters-btn${ui.filtersOpen ? ' open' : ''}" data-act="disc-filters" aria-expanded="${!!ui.filtersOpen}" title="Show or hide the filters: type, how to get it, release date, Windows or Mac, status"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c-3.6 0-6 2.6-6 5.7 0 2.7 1.8 4.7 4.4 5.5l-.9 2.3h5l-.9-2.3c2.6-.8 4.4-2.8 4.4-5.5 0-3.1-2.4-5.7-6-5.7z" fill="currentColor"/><path d="M10 15.2l-1.5 2.6M14 15.2l1.5 2.6M12 15.5v2.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><rect x="8.4" y="18" width="7.2" height="3.6" rx=".8" fill="currentColor" opacity=".75"/></svg><span>${ui.filtersOpen ? 'Hide filters' : 'Open filters'}</span>${countOn ? `<b class="fcount">${countOn}</b>` : ''}</button><span class="disc-spacer"></span><label class="range-sort">System icons <select id="set-sysicons"><option value="on"${iconsOn() ? ' selected' : ''}>Show icons</option><option value="off"${iconsOn() ? '' : ' selected'}>Hide icons</option></select></label><label class="size-pick" title="Make the cards smaller or bigger. All the way left is a compact list.">Size <input type="range" id="disc-size" min="0" max="10" step="1" value="${disc.size}" aria-label="Card size"><b id="size-label">${SIZE_NAMES[disc.size] || 'Normal'}</b></label><label class="range-sort">Sort <select id="disc-sort"><option value="best"${disc.sort === 'best' ? ' selected' : ''}>List order</option><option value="released"${disc.sort === 'released' ? ' selected' : ''}>Newest release</option><option value="name"${disc.sort === 'name' ? ' selected' : ''}>Name</option></select></label>`;
  const panel = ui.filtersOpen ? `<div class="filters-panel"><div class="fp-row"><span class="range-label">Type</span>${showChips(TYPES, disc.kind, (id) => all.filter((c) => (!disc.system || c.system === disc.system) && (!id || KIND_GROUP(c.kind) === id)).length, 'data-disc-type')}</div><div class="fp-row"><span class="range-label">How to get it</span>${`<span class="get-chips" role="group" aria-label="How to get it">${[['', 'Any'], ...(all.some((c) => c.isNew) ? [['new', '✦ New']] : []), ['download', 'Download'], ['build', 'Build it yourself']].map(([id, label]) => `<button class="chip${(disc.get || '') === id ? ' active' : ''}${id === 'new' ? ' new-chip' : ''}" data-disc-get="${id}"${id === 'new' ? ' title="Ports added to the lists since your last visit"' : ''}>${label}<span class="n">${all.filter((c) => (!id || (id === 'new' ? c.isNew : c.get === id)) && (!disc.system || c.system === disc.system) && (!disc.kind || KIND_GROUP(c.kind) === disc.kind)).length}</span></button>`).join('')}</span>`}</div><div class="fp-row">${`<span class="range-chips" role="group" aria-label="Updated within"><span class="range-label">Updated</span>${RANGES.map(([d, label]) => `<button class="chip${disc.range === d ? ' active' : ''}" data-disc-range="${d}">${label}${d ? `<span class="n">${all.filter((c) => inRange(c, d) && (!disc.system || c.system === disc.system)).length}</span>` : ''}</button>`).join('')}<label class="range-custom${disc.range > 0 && !RANGES.some((r) => r[0] === disc.range) ? ' active' : ''}" title="Type any number of days">Last <input type="number" id="disc-days" min="1" max="5000" inputmode="numeric" placeholder="days" value="${disc.range > 0 && !RANGES.some((r) => r[0] === disc.range) ? disc.range : ''}"> days</label></span>`}</div><div class="fp-row">${`<span class="range-chips" role="group" aria-label="Works on"><span class="range-label">Download for</span>${[['', 'Any'], ['win', 'Windows'], ['mac', 'Mac']].map(([id, l]) => `<button class="chip${(disc.os || '') === id ? ' active' : ''}" data-disc-os="${id}">${l}${id ? `<span class="n">${all.filter((c) => c[id] && (!disc.system || c.system === disc.system)).length}</span>` : ''}</button>`).join('')}${statusList.length ? `<label class="range-sort">Status <select id="disc-status"><option value="">Any</option>${statusList.map((st) => `<option value="${esc(st)}"${disc.status === st ? ' selected' : ''}>${esc(st)}</option>`).join('')}</select></label>` : ''}</span>`}</div></div>` : '';
  const activeLine = tagsOn.filter((t) => t[1]).length ? `<div class="active-line"><span class="range-label">Showing</span>${tagsOn.filter((t) => t[1]).map(([k, l]) => `<button class="tag-on" data-disc-unset="${k}" title="Remove this filter">${esc(l)} <span aria-hidden="true">×</span></button>`).join('')}<button class="btn-link" data-act="disc-clear">Clear all</button></div>` : '';
  const winOf = (list) => list.filter((c) => c.win).length;
  const sysBox = !iconsOn() ? '' : (() => {
    const list = disc.system ? all.filter((c) => c.system === disc.system) : all;
    const sy = disc.system ? S.systems[disc.system] : null;
    const f = (disc.system && (window.SYS_FACTS || {})[disc.system]) || {};
    const col = sy ? sy.color : 'var(--accent)';
    const win = list.filter((c) => c.win).length;
    const bits = sy ? [f.maker, f.gen && `${f.gen} generation`, f.designer && `designed by ${f.designer}`, f.note].filter(Boolean) : ['Every console in the list'];
    const sub = `${esc(bits.join(' · '))}${bits.length ? ' · ' : ''}${win} with a Windows download`;
    const stats = [[list.length.toLocaleString(), list.length === 1 ? 'port in Fulton' : 'ports in Fulton']];
    if (!disc.system) { stats.push([String(new Set(all.map((c) => c.system)).size), 'consoles covered']); stats.push([String(all.filter((c) => c.released && c.released >= Date.now() - newDays() * DAY).length), `updated in ${newDays()} days`]); }
    if (f.soldM) stats.push([`≈ ${f.soldM}M${f.soldPlus ? '+' : ''}`, 'consoles sold']);
    if (f.usGames) stats.push([`≈ ${f.usGames}`, 'licensed US games']);
    // the line under the header is the system's timeline: from launch to the end of production (or today)
    const nowY = new Date().getFullYear(), y0 = 1970, span = nowY - y0;
    const pos = (y) => Math.max(0, Math.min(100, ((y - y0) / span) * 100));
    let tl = '<div class="fade-line"></div>';
    let miniChart = '';
    if (!disc.system) {
      // All systems: how many ports published a new release in each of the last 12 months
      const now = new Date(), cur = now.getFullYear() * 12 + now.getMonth();
      const counts = new Array(12).fill(0);
      let known = 0;
      for (const c of all) {
        if (!c.released) continue;
        known++;
        const d = new Date(c.released), idx = 11 - (cur - (d.getFullYear() * 12 + d.getMonth()));
        if (idx >= 0 && idx < 12) counts[idx]++;
      }
      const mx = Math.max(1, ...counts), pk = counts.indexOf(Math.max(...counts));
      const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mon = (i) => names[(now.getMonth() - 11 + i + 120) % 12];
      const bars = counts.map((n, i) => `<i class="${i === pk && n ? 'pk' : ''}" style="height:${Math.max(4, (n / mx) * 44)}px" title="${mon(i)} · ${n} port${n === 1 ? '' : 's'} got a new release"></i>`).join('');
      const collecting = known < all.filter((c) => c.get !== 'build').length * 0.9;
      miniChart = `<div class="mini-act" title="${collecting ? 'Still collecting release dates, so older months can grow' : 'New releases per month'}"><div class="mini-bars">${bars}</div><span>new releases · last 12 months${collecting ? ' · still counting' : ''}</span></div>`;
    }
    if (f.from) {
      const live = f.to === 'now', ended = f.to === 'ended', to = live ? nowY : ended ? null : f.to, fadeTo = ended && f.fadeTo ? f.fadeTo : null;
      const ticks = [1970, 1980, 1990, 2000, 2010, 2020].filter((y) => Math.abs(y - f.from) > 3 && (!to || Math.abs(y - to) > 3)).map((y) => `<span class="tl-yr" style="left:${pos(y)}%">${y}</span>`).join('');
      const label = live ? 'still on sale' : ended ? `launched ${f.from} · no longer in production (no official end date)` : to ? `${to - f.from} year${to - f.from === 1 ? '' : 's'} in production` : `launched ${f.from}`;
      tl = `<div class="sys-tl" style="--c:${col}"><div class="tl-track"></div>${to ? `<div class="tl-span" style="left:${pos(f.from)}%;width:${Math.max(1, pos(to) - pos(f.from))}%"></div>` : ''}${fadeTo ? `<div class="tl-span fade" style="left:${pos(f.from)}%;width:${Math.max(1, pos(fadeTo) - pos(f.from))}%"></div>` : ''}<span class="tl-dot" style="left:${pos(f.from)}%"></span>${to ? `<span class="tl-dot" style="left:${pos(to)}%"></span>` : ''}<span class="tl-mid" style="left:${to ? (pos(f.from) + pos(to)) / 2 : fadeTo ? (pos(f.from) + pos(fadeTo)) / 2 : pos(f.from)}%">${label}</span><span class="tl-yr k" style="left:${pos(f.from)}%">${f.from}</span>${to ? `<span class="tl-yr k" style="left:${pos(to)}%">${live ? 'Now' : to}</span>` : ''}${ticks}</div>`;
    }
    return `<div class="sys-info"><div class="sys-head" style="--c:${col}"><div class="sys-left"><div class="sys-tile">${disc.system ? sysIcon(disc.system, 'sys-ic-lg') : '<svg class="sys-ic-lg" aria-hidden="true"><use href="#ic-pad"/></svg>'}<em>${esc(sy ? sy.short : 'ALL')}</em></div><div class="sys-nm"><b>${esc(sy ? sy.name : 'All systems')}</b><span>${sub}</span></div></div><div class="sys-stats">${stats.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}${miniChart}</div></div>${tl}</div>`;
  })();
  chipsEl.innerHTML = panel + activeLine + `<div class="sys-row">` + '<span class="show-break"></span>' + `<button class="chip${!disc.system ? ' active' : ''}" data-disc-system="">All<span class="n">${all.length}</span></button>` + sysOrder.map((id) => `<button class="chip${disc.system === id ? ' active' : ''}" data-disc-system="${id}" style="--pc:${S.systems[id].color}">${iconsOn() ? sysIcon(id) : '<span class="pip"></span>'}${esc(S.systems[id].short)}<span class="n">${bySys[id]}</span></button>`).join('') + `</div>${sysBox}`;

  const items = communityFiltered();
  const shown = items.slice(0, disc.limit);
  const pc = communityData.platformCheck;
  const running = platformProgress && platformProgress.done < platformProgress.total;
  const checking = running
    ? `<p class="os-note">Checking which ports have Windows and Mac downloads… ${platformProgress.done} of ${platformProgress.total}. The Windows and Mac labels appear on the cards as it goes.</p>`
    : pc && pc.failed
      ? `<p class="os-note warn">${pc.failed} port${pc.failed > 1 ? 's' : ''} couldn't be checked yet (GitHub didn't answer), so ${pc.failed > 1 ? 'they don\'t' : 'it doesn\'t'} show Windows or Mac yet. <button class="btn-link" data-act="recheck-platforms">Check again</button></p>`
      : '';
  const listWarn = (communityData.warn || []).length
    ? `<p class="os-note warn">${communityData.warn.join(' and ')}'s list couldn't be loaded just now, so some ports may be missing from this page. Fulton will try again in about an hour. <button class="btn-link" data-act="community-refresh">Try again now</button></p>`
    : '';
  const unknown = disc.range ? all.filter((c) => !c.released && c.get !== 'build').length : 0;
  const dateNote = disc.range && (unknown || running) ? `<p class="os-note">Release dates are still being collected for ${unknown} port${unknown === 1 ? '' : 's'}, so the list can grow in a minute or two.</p>` : '';
  const counter = `<div class="disc-count"><b>${items.length.toLocaleString()}</b> port${items.length === 1 ? '' : 's'} ${discActive() ? 'match' : 'in the list'}${all.some((c) => c.isNew) ? '<button class="btn-link" data-act="disc-seen" title="Clear the NEW tags">Mark all as seen</button>' : ''}</div>`;
  try { localStorage.setItem('fulton.disc', JSON.stringify({ sort: disc.sort, size: disc.size })); } catch { /* fine */ }
  listEl.innerHTML = counter + listWarn + checking + dateNote + (items.length
    ? `<div class="cgrid ${disc.size === 0 ? 'sz-list' : 'sz-var'}" style="${disc.size > 0 ? sizeVars(disc.size) : ''}">${shown.map((c) => {
        const sys = S.systems[c.system] || {};
        const tip = [c.desc, c.needs && `Needs: ${c.needs}`].filter(Boolean).join('\n\n');
        const how = getTags(c);
        if (c.platformsKnown && c.get !== 'build') {
          // once the downloads are known, "Windows" / "Mac" say more than "Download"
          if (c.win || c.mac) { const i = how.findIndex((t) => t[2] === 'dl'); if (i >= 0) how.splice(i, 1); }
          if (c.win) how.push(['Windows', 'Has a Windows download', 'os']);
          if (c.mac) how.push(['Mac', 'Has a Mac download', 'os']);
          if (!c.win && !c.mac) how.push(['No download yet', 'The latest release has nothing for Windows or Mac', 'none']);
        }
        return `<div class="ccard" style="--c:${sys.color || '#c8161d'}"${tip ? ` title="${esc(tip)}"` : ''}>
          ${c.isNew ? '<span class="new-badge" title="Added to the lists since your last visit">NEW</span>' : ''}<div class="ccard-art" data-cover-kind="title" data-system="${esc(c.system)}" data-title="${esc(c.name)}">${c.icon ? `<img class="icon-img" src="${esc(c.icon)}" alt="" loading="lazy">` : ''}<span class="sys-tag">${esc(sys.short || '')}</span></div>
          <div class="ccard-text"><b>${esc(c.name)}</b><span>${esc(c.project)}</span><em><span class="type-dot t-${typeOf(c.kind)[3]}"></span>${esc(typeOf(c.kind)[4].charAt(0) + typeOf(c.kind)[4].slice(1).toLowerCase())} · ${esc(c.repo.split('/')[0])}${c.status ? ` · <span class="ccard-status${/early/i.test(c.status) ? ' early' : ''}">${esc(c.status)}</span>` : ''}</em>${c.released ? `<span class="rel-date" title="${esc(fmtDate(c.released))}">Updated ${ago(c.released)}</span>` : ''}${how.length ? `<span class="get-tags">${how.map(([l, tip, cls]) => `<i class="get-tag get-${cls}" title="${esc(tip)}">${esc(l)}</i>`).join('')}</span>` : ''}</div>
          ${c.onShelf ? `<button class="btn3d small lime" data-goto="${esc(c.onShelf)}">✓ On shelf</button>` : `<button class="btn3d small" data-add-community="${esc(c.key)}">+ Add</button>`}
        </div>`;
      }).join('')}</div>${items.length > shown.length ? `<div style="text-align:center;margin-top:16px"><button class="btn3d purple" data-act="disc-more">Show ${Math.min(60, items.length - shown.length)} more of ${items.length - shown.length}</button></div>` : ''}`
    : `<div class="empty"><h2>No matches</h2><p>Try another word, or search GitHub below.</p>${discActive() ? '<button class="btn3d" data-act="disc-clear">Clear all filters</button>' : ''}</div>`);
  hydrateCovers(listEl);
}

function renderAddForm(repo) {
  const slot = $('#add-form-slot');
  const sysOpts = Object.entries(S.systems).map(([id, s]) => `<option value="${id}">${esc(s.name)}</option>`).join('');
  slot.innerHTML = `<form class="form callout" id="add-form" style="margin-bottom:20px">
    <b>Add ${esc(repo)}</b>
    <input type="hidden" name="repo" value="${esc(repo)}">
    <div class="grid2">
      <label class="field"><span>Game</span><input name="title" required placeholder="Paper Mario"></label>
      <label class="field"><span>Port name</span><input name="port" value="${esc(repo.split('/')[1])}"></label>
      <label class="field"><span>System</span><select name="system">${sysOpts}</select></label>
      <label class="field"><span>Year released</span><input name="year" type="number" min="1970" max="2030"></label>
      <label class="field"><span>Original developer</span><input name="developer"></label>
      <label class="field"><span>How the game takes the ROM</span><select name="romSetup"><option value="in-app">The game asks for it</option><option value="beside-exe">Next to the game's ${isMac() ? 'app' : '.exe'}</option></select></label>
    </div>
    <label class="field"><span>No-Intro name of the ROM</span><input name="romTitle" placeholder="Paper Mario"><small>Used to match your ROM. Leave it empty to choose the ROM by hand.</small></label>
    <div class="inline"><button class="btn3d" type="submit">Add to shelf</button><button class="btn-link" type="button" data-act="cancel-add">Cancel</button></div>
  </form>`;
  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------- settings
function renderCustomize() {
  const s = S.settings;
  $('#view').innerHTML = `<div class="panel">
    ${panelHead('Customize', 'Colors, your background picture and the edge fades. Changes show straight away.')}
    <div class="form">
      <div class="field" id="appearance"><span>Colors</span>${themeSettingsHtml()}</div>
      <div class="field"><span>Background</span>
        <div class="bg-row">
          <div class="bg-thumb" style="${s.backgroundImage ? `background-image:url('${fileUrl(s.backgroundImage).replace(/'/g, '%27')}')` : ''}">${s.backgroundImage ? '' : '<em>Default wallpaper</em>'}</div>
          <div class="bg-controls">
            <div class="inline"><button class="btn3d small cyan" data-act="pick-bg">Choose image</button><button class="btn3d small" data-act="pick-bg-shot">From my screenshots</button>${s.backgroundImage ? '<button class="btn-link" data-act="clear-bg">Back to default</button>' : ''}</div>
            <label class="bg-dim"><span>Darken</span><input type="range" id="set-dim" min="0" max="90" step="5" value="${s.backgroundDim ?? 55}"><b id="dim-val">${s.backgroundDim ?? 55}%</b></label>
            <label class="bg-dim"><span>See-through</span><input type="range" id="set-clear" min="0" max="100" step="5" value="${s.backgroundClear ?? 45}"><b id="clear-val">${s.backgroundClear ?? 45}%</b></label>
            <small>PNG, JPG, WebP or GIF. Darken keeps text readable on bright pictures; See-through lets more of the picture show behind the panels.</small>
            ${fadeHtml()}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderSettings() {
  const s = S.settings;
  $('#view').innerHTML = `<div class="panel">
    ${panelHead('Settings')}
    <div class="form">
      <div class="callout">Colors, your background picture and the edge fades have their own page. <button class="btn-link" data-act="customize">Open Customize</button></div>
      <div class="field"><span>Drives (where games are installed)</span>
        <div id="drives-box" class="drives"><small>Looking at your drives…</small></div>
        <div class="inline" style="margin-top:8px"><button class="btn3d small purple" data-act="drive-add">Add a drive or folder</button><button class="btn-link" data-act="open-lib">Open default</button><button class="btn3d small" data-act="scan-library">Look for my games</button><button class="btn-link" data-act="library-moved">I renamed or moved my folder</button></div>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="set-ask-drive" ${s.askInstallDrive === false ? '' : 'checked'}> <span>Ask me which drive to use when I install a game (only when more than one is listed)</span></label>
        <small>Each drive gets its own Games and Downloads folders. Updates stay on the drive the game is already on. Your own ROM files are never moved or changed.</small></div>
      <div class="field"><span>Converted ROM copies</span>
        <div class="inline"><input value="${esc(S.dirs.roms)}" readonly><button class="btn3d small purple" data-act="pick-romcopy-dir">Change</button>${s.romCopyDir ? '<button class="btn-link" data-act="reset-romcopy-dir">Use default</button>' : ''}</div>
        <small>Only used when a game needs a converted copy of your ROM (a different format, or one pulled out of an archive). Your original ROMs stay where they are.</small></div>
      <div class="field"><span>Screenshots</span>
        <label class="check"><input type="checkbox" id="set-shots" ${s.screenshots === false ? '' : 'checked'}> <span>Take a screenshot with one key while a game is running</span></label>
        <div class="inline" style="margin:8px 0"><span>Key</span><button class="btn3d small purple" id="shot-key" data-act="shot-key">${esc(window.cartShots.prettyAccel(s.screenshotKey || window.cartShots.DEFAULT_KEY))}</button>${(s.screenshotKey || 'F8') !== 'F8' ? '<button class="btn-link" data-act="shot-key-reset">Use F8</button>' : ''}</div>
        <label class="check"><input type="checkbox" id="set-shotsound" ${s.screenshotSound === false ? '' : 'checked'}> <span>Play a click sound when one is taken</span></label>
        <div class="inline" style="margin-top:8px"><button class="btn-link" data-act="view-shots">See all screenshots</button><button class="btn-link" data-act="open-shots-folder">Open the screenshots folder</button></div>
        <small>Click the key button, then press the key you want (Esc cancels). The key only works while a game started from Fulton is running, so it never takes the key from your other programs. Pictures are saved on the same drive as the game.</small></div>
      <label class="field"><span>GitHub token (optional)</span>
        <div class="inline"><input id="set-token" type="password" placeholder="ghp_…" value="${esc(s.githubToken)}"><button class="btn3d small purple" data-act="save-token">Save</button></div>
        <small>Without a token GitHub allows 60 checks an hour. A classic token with no scopes raises that to 5,000.</small></label>
      <label class="field"><span>Extra catalog URL (optional)</span>
        <div class="inline"><input id="set-catalog" placeholder="https://raw.githubusercontent.com/you/list/main/games.json" value="${esc(s.extraCatalogUrl)}"><button class="btn3d small purple" data-act="save-catalog">Save</button></div>
        <small>A games.json in the same format as the built-in catalog. Use it to share a list with friends.</small></label>
      <div class="field"><span>Save backups</span>
        <div class="inline"><input value="${esc(S.dirs.backups)}" readonly><button class="btn3d small purple" data-act="pick-backup-dir">Change</button><button class="btn-link" data-act="open-all-backups">Open</button></div>
        <div class="inline" style="margin-top:6px"><input type="checkbox" id="set-autobackup"${s.autoBackup === false ? '' : ' checked'} style="flex:none;width:20px;height:20px;accent-color:var(--gold)"><small>Back up automatically after playing, before updates and before uninstalling (keeps the last 10 per game)</small></div>
        <div class="inline" style="margin-top:6px"><button class="btn3d small cyan" data-act="backup-all">Back up all games now</button></div>
        <small>Tip: choose a folder inside OneDrive or Google Drive and your saves are copied to the cloud too.</small></div>
      <div class="field"><span>Cover art</span>
        <div class="inline"><button class="btn3d small cyan" data-act="find-covers">Find missing covers</button><span class="sub" id="cover-progress"></span></div>
        <small>Box art comes from libretro-thumbnails and is matched to every game and ROM by name, then kept on your ${thisComputer()}. To change one cover, open a game's info panel and click <b>Change cover</b>, or drop a picture onto the window while the game is selected.</small>
        <div class="inline" style="margin-top:8px"><input id="set-sgdb" type="password" placeholder="SteamGridDB API key (optional)" value="${esc(s.steamGridKey)}"><button class="btn3d small purple" data-act="save-sgdb">Save</button></div>
        <small>Fills the gaps libretro doesn't cover, such as Switch games. Get a free key at <button class="btn-link" data-url="https://www.steamgriddb.com/profile/preferences/api">steamgriddb.com</button> (sign in, then Preferences → API).</small></div>
      <div class="field"><span>Controller</span>
        <div id="pad-live" class="pad-live"></div>
        <div id="pad-setup" class="pad-setup" hidden></div>
        <small>Xbox controllers work straight away. PlayStation, Switch Pro, 8BitDo and other controllers work too; if one does the wrong thing, use <b>Set up buttons</b> and press each button when asked. If Steam is open and the controller moves the mouse pointer instead, that's Steam's desktop controller layout: change it in Steam → Settings → Controller, or close Steam while using Fulton.</small></div>
      <div class="field"><span>ROM copies</span>
        <div id="rom-copies" class="sub">Checking…</div>
        <small>Fulton uses your ROMs where they are and never copies your collection. A copy is only made for a game that needs a different format (for example a .v64 converted to .z64), and only for that game's ROM.</small></div>
      <div class="field"><span>Steam</span>
        <div class="inline"><button class="btn3d small purple" data-act="steam-all">Add all installed games to Steam</button></div>
        <small>Each game appears in your Steam library as a non-Steam game with box art, and works with Big Picture and Steam Input. Steam closes for a moment while games are added.</small></div>
      <label class="field toggle"><span>Metacritic scores</span>
        <div class="inline"><input type="checkbox" id="set-meta"${s.showMetacritic ? ' checked' : ''}><small>Show the Metascore in each game's info panel. Scores not in the catalog are looked up on metacritic.com. Off unless you turn it on.</small></div></label>
      <label class="field toggle"><span>Recently updated means</span>
        <div class="inline"><select id="set-newdays">${NEW_DAYS.map((d) => `<option value="${d}"${newDays() === d ? ' selected' : ''}>Last ${d} days</option>`).join('')}</select><small>Typing "new" or "updated" in the Find more search shows ports released within this many days. Default 30.</small></div></label>
      <label class="field toggle"><span>Update alerts</span>
        <div class="inline"><input type="checkbox" id="set-notify"${s.notifyUpdates === false ? '' : ' checked'}><small>Show update badges and the count in the sidebar, and tell me when a game, especially a favorite, has a new version. On by default. The Updates page always works.</small></div></label>
      <label class="field toggle"><span>Fulton updates</span>
        <div class="inline"><input type="checkbox" id="set-updates"${s.checkUpdates === false ? '' : ' checked'}><small>Tell me when a new version of Fulton is out (checks GitHub twice a day)</small></div></label>
      <p class="about-ver">Fulton <b>${esc(verLabel())}</b> <small>(build ${esc(S.version || '')})</small> · <button class="btn-link" data-open-path="${esc(S.changelog || '')}">What's new</button> · <button class="btn-link" data-view-go="about">About &amp; credits</button> · <button class="btn-link" data-act="tour">Take the tour</button> · <button class="btn-link" data-act="report-problem" title="Saves one zip with your log and version to send to the developer">Report a problem</button>${(S.links || {}).kofi ? ` · <button class="btn-link" data-url="${esc(S.links.kofi)}">♥ Support on Ko-fi</button>` : ''}</p>
      <div class="callout">Fulton never downloads ROMs or game data. It installs open-source ports from their official GitHub releases and uses ROMs you dump from games you own.</div>
    </div>
  </div>`;
  loadDrives();
}

const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
// ---------------------------------------------------------------- screenshots
let shotsCache = [];
const shotDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
async function renderScreenshots() {
  $('#view').innerHTML = `<div class="panel" id="shots-page">${panelHead('Screenshots')}<div id="shots-body"><p class="sub">Looking for your screenshots…</p></div></div>`;
  shotsCache = await api.allShots().catch(() => []);
  if (ui.view === 'screenshots' && $('#shots-page')) drawScreenshots();
}
function shotsFiltered() { return shotsCache.filter((x) => !ui.shotGame || x.gameId === ui.shotGame); }
function drawScreenshots() {
  const body = $('#shots-body'); if (!body) return;
  const games = [...new Map(shotsCache.map((x) => [x.gameId, x.game]))].sort((a, b) => a[1].localeCompare(b[1]));
  const list = shotsFiltered();
  const key = window.cartShots.prettyAccel((S.settings.screenshotKey) || window.cartShots.DEFAULT_KEY);
  body.innerHTML = `<div class="shots-bar">
      <label>Game <select id="shot-filter"><option value="">All games (${shotsCache.length})</option>${games.map(([id, name]) => `<option value="${esc(id)}"${ui.shotGame === id ? ' selected' : ''}>${esc(name)} (${shotsCache.filter((x) => x.gameId === id).length})</option>`).join('')}</select></label>
      <span class="grow"></span><button class="btn-link" data-act="open-shots-folder">Open folder</button>
    </div>
    ${list.length ? `<div class="shots-grid">${list.map((x, i) => `<button class="shot-card" data-shot="${i}" title="${esc(x.name)}"><img src="${fileUrl(x.thumb || x.file)}" alt="" loading="lazy" decoding="async"><span>${esc(x.game)}</span><small>${esc(shotDate(x.time))}</small></button>`).join('')}</div>`
      : `<div class="empty-shots"><b>No screenshots yet</b><p>Start a game from Fulton and press <kbd>${esc(key)}</kbd> to take one. They show up here, and you can use any of them as your background in Customize. You can change the key in Settings.</p></div>`}`;
}
function showShot(i) {
  const list = shotsFiltered(); const x = list[i]; if (!x) return;
  ui.shotView = list; ui.shotIdx = i;
  const m = $('#modal');
  m.innerHTML = `<div class="modal tip shot-view" role="dialog" aria-modal="true">
    <img class="shot-big" src="${fileUrl(x.file)}" alt="">
    <div class="shot-meta"><b>${esc(x.game)}</b> <span>${esc(shotDate(x.time))}</span></div>
    <div class="modal-actions shot-actions">
      <button class="btn3d small" data-shot-act="prev"${i > 0 ? '' : ' disabled'}>‹</button><button class="btn3d small" data-shot-act="next"${i < list.length - 1 ? '' : ' disabled'}>›</button>
      <button class="btn3d small cyan" data-shot-act="copy">Copy</button><button class="btn3d small" data-shot-act="open">Open</button><button class="btn3d small" data-shot-act="reveal">Show in folder</button>
      <button class="btn3d small pink" data-shot-act="bg">Use as background</button><button class="btn-link danger" data-shot-act="delete">Delete</button><button class="btn-link" data-tip-close="1">Close</button>
    </div></div>`;
  m.hidden = false;
}
async function shotAction(a) {
  const list = ui.shotView || []; const x = list[ui.shotIdx];
  if (a === 'prev') return showShot(Math.max(0, ui.shotIdx - 1));
  if (a === 'next') return showShot(Math.min(list.length - 1, ui.shotIdx + 1));
  if (!x) return;
  if (a === 'copy') { await guard(() => api.copyShot(x.file)); return toast('Copied', 'Paste it anywhere.', 'ok'); }
  if (a === 'open') return api.openShot(x.file);
  if (a === 'reveal') return api.revealShot(x.file);
  if (a === 'bg') { const p = await guard(() => api.useBackground(x.file)); if (p) { S.settings.backgroundImage = p; applyBackground(); toast('Background changed', 'Using your screenshot.', 'ok'); } return; }
  if (a === 'delete') {
    if (!window.confirm('Delete this screenshot? This cannot be undone.')) return;
    await guard(() => api.deleteShot(x.gameId, x.file));
    shotsCache = shotsCache.filter((y) => y.file !== x.file);
    closeTip(); drawScreenshots();
    toast('Screenshot deleted');
  }
}
async function pickBackgroundFromShots() {
  const list = await api.allShots().catch(() => []);
  if (!list.length) return toast('No screenshots yet', `Start a game from Fulton and press ${window.cartShots.prettyAccel(S.settings.screenshotKey || 'F8')} to take one.`, 'warn');
  ui.shotPick = list;
  const m = $('#modal');
  m.innerHTML = `<div class="modal tip shot-pick" role="dialog" aria-modal="true"><div class="help-topic"><h2>Pick a screenshot for your background</h2>
    <div class="shots-grid small">${list.map((x, i) => `<button class="shot-card" data-shot-bg="${i}" title="${esc(x.game)}"><img src="${fileUrl(x.thumb || x.file)}" alt="" loading="lazy" decoding="async"><span>${esc(x.game)}</span></button>`).join('')}</div></div>
    <div class="modal-actions"><button class="btn-link" data-tip-close="1">Cancel</button></div></div>`;
  m.hidden = false;
}
function recordShotKey(btn) {
  btn.textContent = 'Press a key… (Esc cancels)'; btn.disabled = true;
  const done = (accel) => {
    window.removeEventListener('keydown', onKey, true);
    btn.disabled = false;
    if (accel) { S.settings.screenshotKey = accel; guard(() => api.settings({ screenshotKey: accel })); toast('Screenshot key set', `${window.cartShots.prettyAccel(accel)} takes a screenshot while a game is running.`, 'ok'); }
    renderSettings();
  };
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') return done(null);
    const a = window.cartShots.accelFromEvent(e);
    if (a) done(a);
  };
  window.addEventListener('keydown', onKey, true);
}
api.onShot && api.onShot((d) => {
  toast('Screenshot saved', d.game, 'ok', [['View', () => { shotsCache = []; setView('screenshots', { shotGame: d.gameId }); }], ['Show', () => api.revealShot(d.file)]]);
  if (ui.view === 'screenshots') renderScreenshots();
});

// ---------------------------------------------------------------- drives
const driveFree = (d) => (d.free == null ? 'size unknown' : `${fmtSize(d.free)} free${d.total ? ` of ${fmtSize(d.total)}` : ''}`);
const driveBar = (d) => (d.free != null && d.total ? `<span class="drive-bar"><i style="width:${Math.max(2, Math.min(100, Math.round((1 - d.free / d.total) * 100)))}%" class="${d.free < 5e9 ? 'low' : ''}"></i></span>` : '');
async function loadDrives() {
  const box = $('#drives-box');
  if (!box) return;
  const list = await api.drives().catch(() => null);
  if (!$('#drives-box') || !list) return;
  ui.drives = list;
  box.innerHTML = list.map((d, i) => `<div class="drive-row${d.connected ? '' : ' gone'}">
      <div class="drive-main"><b class="drive-path">${esc(d.dir)}</b>
        <span class="drive-meta">${d.isDefault ? '<span class="tag-chip">Default</span>' : ''}${d.connected ? '' : '<span class="tag-chip warn">Not connected</span>'}${driveFree(d)} · ${d.games} game${d.games === 1 ? '' : 's'}</span>${driveBar(d)}</div>
      <div class="drive-btns">${d.isDefault ? '' : `<button class="btn-link" data-drive-default="${i}">Make default</button><button class="btn-link" data-drive-remove="${i}">Remove</button>`}<button class="btn-link" data-drive-open="${i}">Open</button></div>
    </div>`).join('');
}

/** Which drive should this game go on? Shown for a new install when more than one location is listed. */
async function showDrivePicker(g, mode = 'install') {
  let list = await api.drives().catch(() => []);
  const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase();
  if (mode === 'move') { // every drive except the one the game is on now
    const here = norm(g.installed && g.installed.dir) + '/';
    list = list.filter((d) => !here.startsWith(norm(d.dir) + '/'));
    if (!list.length) { toast('No other drive on your list', 'Add another drive in Settings > Drives first.', 'warn'); return; }
  }
  ui.drives = list; ui.pendingDriveGame = g.id; ui.drivePickMode = mode;
  const m = $('#modal');
  m.innerHTML = `<div class="modal tip drive-pick" role="dialog" aria-modal="true">
    <div class="help-topic">
      <h2>${mode === 'move' ? `Move ${esc(g.port)} to…` : `Where should ${esc(g.port)} go?`}</h2>
      <p class="lead">${mode === 'move' ? 'Fulton copies the game there, checks the copy, then removes the old one. Your saves inside the game folder come along. If anything goes wrong, the original stays as it is.' : 'Pick a drive. Updates will stay on the same one.'}</p>
      <div class="drives">${list.map((d, i) => `<button class="drive-choice${d.isDefault ? ' rec' : ''}" data-drive-go="${i}" ${d.connected ? '' : 'disabled'}>
        <b>${esc(d.dir)}</b><span>${d.isDefault ? 'Default · ' : ''}${d.connected ? driveFree(d) : 'Not connected'}</span>${driveBar(d)}</button>`).join('')}</div>
      ${mode === 'move' ? '' : `<label class="check" style="margin-top:12px"><input type="checkbox" id="drive-dont-ask"> <span>Don't ask again, always use the default</span></label>`}
    </div>
    <div class="modal-actions"><button class="btn-link" data-tip-close="1">Cancel</button></div>
  </div>`;
  m.hidden = false;
  setTimeout(() => { const b = m.querySelector('.drive-choice.rec:not([disabled])') || m.querySelector('.drive-choice:not([disabled])'); if (b) b.focus(); }, 30);
}

async function loadRomCopies() {
  const box = $('#rom-copies');
  if (!box) return;
  const c = await api.romCopies().catch(() => null);
  if (!$('#rom-copies')) return;
  if (!c) { box.textContent = ''; return; }
  box.innerHTML = c.count
    ? `<b>${c.count.toLocaleString()} ROMs</b> are still stored as copies made by an older version (${fmtSize(c.bytes)}). Their originals weren't found in a watched ROM folder. <button class="btn-link danger" data-act="remove-rom-copies">Remove copies</button>`
    : `No ROM copies.${c.freed ? ` ${fmtSize(c.freed)} was freed by removing old copies.` : ''}`;
}

// ---------------------------------------------------------------- colors (Settings)
const swatch = (c) => `<span class="sw" style="background:${c.accent}"></span><span class="sw" style="background:${c.wall1}"></span><span class="sw" style="background:${c.wall2}"></span>`;
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
function hexToHsv(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), mx ? d / mx : 0, mx];
}
function hsvToHex(h, sat, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * sat * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}

function colorPickHtml(k, label, tip, hex) {
  const [h, sat, val] = hexToHsv(hex);
  const [r, g, b] = hexToRgb(hex);
  return `<div class="color-pick" data-ck="${k}" data-h="${h}" title="${esc(tip)}">
      <button type="button" class="cp-sw" data-cp-toggle="1" style="background:${hex}" aria-label="Open the ${esc(label)} color picker"></button>
      <span class="cp-txt"><b>${esc(label)}</b><small>${esc(tip)}</small></span>
      <input type="text" class="cp-hex" data-theme-color="${k}" value="${hex}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="${esc(label)} color code">
      <div class="cp-pop" hidden>
        <div class="cp-sv" style="background-color:hsl(${h},100%,50%)"><i class="cp-knob" style="left:${sat * 100}%;top:${(1 - val) * 100}%"></i></div>
        <div class="cp-hue"><i class="cp-knob" style="left:${(h / 360) * 100}%"></i></div>
        <div class="cp-nums">${[['R', r, 'r'], ['G', g, 'g'], ['B', b, 'b']].map(([l, v, c]) => `<label>${l}<input type="number" min="0" max="255" value="${v}" data-num="${c}"></label>`).join('')}</div>
      </div></div>`;
}
const FADE_SIDES = [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right'], ['t', 'Top edge'], ['b', 'Bottom edge'], ['l', 'Left edge'], ['r', 'Right edge']];
const fadeOf = () => ({ color: '#000000', sides: [], strength: 70, reach: 50, ...(S.settings.backgroundFade || {}) });
function fadeHtml() {
  const f = fadeOf();
  return `<div class="bg-fade"><b>Color fade</b>
    <small>Fades a color in from the corners or edges over your picture. Pick any combination.</small>
    <div class="fade-sides">${FADE_SIDES.map(([id, l]) => `<button type="button" class="fade-side fs-${id}${f.sides.includes(id) ? ' on' : ''}" data-fade-side="${id}" aria-pressed="${f.sides.includes(id)}">${l}</button>`).join('')}</div>
    <div class="theme-custom">${colorPickHtml('fade', 'Fade color', 'The color that fades in', /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#000000')}</div>
    <label class="bg-dim"><span>Strength</span><input type="range" id="set-fade-strength" min="5" max="100" step="5" value="${f.strength}"><b id="fade-strength-val">${f.strength}%</b></label>
    <label class="bg-dim"><span>Reach</span><input type="range" id="set-fade-reach" min="10" max="100" step="5" value="${f.reach}"><b id="fade-reach-val">${f.reach}%</b></label></div>`;
}
function fadeCss(f) {
  if (!f || !f.sides || !f.sides.length) return 'none';
  const [r, g, b] = hexToRgb(/^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#000000');
  const c = `rgba(${r},${g},${b},${(f.strength ?? 70) / 100})`, t = `rgba(${r},${g},${b},0)`, R = f.reach ?? 50;
  const at = { tl: '0% 0%', tr: '100% 0%', bl: '0% 100%', br: '100% 100%' };
  const dir = { t: 'to bottom', b: 'to top', l: 'to right', r: 'to left' };
  return f.sides.map((id) => at[id] ? `radial-gradient(ellipse ${R}% ${R}% at ${at[id]}, ${c} 0%, ${t} 100%)` : `linear-gradient(${dir[id]}, ${c} 0%, ${t} ${R}%)`).join(', ');
}

function themeSettingsHtml() {
  const t = S.settings.theme || { preset: window.THEMES[0].id };
  const cur = window.themeColors(t);
  const presets = window.THEMES.map((x) => `<button class="theme-chip${t.preset === x.id ? ' on' : ''}" data-theme="${x.id}" title="${esc(x.name)}"><span class="sws">${swatch(x.colors)}</span>${esc(x.name)}</button>`).join('');
  const custom = `<button class="theme-chip${t.preset === 'custom' ? ' on' : ''}" data-theme="custom" title="Pick your own colors${t.saved ? ' (your colors are remembered)' : ''}"><span class="sws">${swatch(t.preset !== 'custom' && t.saved ? window.themeColors({ preset: 'custom', base: t.saved.base, custom: t.saved.custom }) : cur)}</span>Custom</button>`;
  const pickers = t.preset === 'custom' ? `<div class="theme-custom">${window.THEME_KEYS.map(([k, label, tip]) => colorPickHtml(k, label, tip, /^#[0-9a-f]{6}$/i.test(cur[k] || '') ? cur[k] : '#888888')).join('')}</div>
    <div class="inline"><button class="btn-link" data-act="theme-reset">Start again from ${esc((window.THEMES.find((x) => x.id === t.base) || window.THEMES[0]).name)}</button></div>` : '';
  const mode = backdropMode();
  const backdrop = [['wash', 'Color wash', 'A soft glow in the main color of the selected game\'s cover'], ['theme', 'Theme only', 'Just your theme behind the selected game'], ['blur', 'Blurred cover', 'The selected game\'s cover, blurred, behind it']]
    .map(([id, label, tip]) => `<button class="${mode === id ? 'on' : ''}" data-backdrop="${id}" title="${esc(tip)}">${label}</button>`).join('');
  return `<div class="theme-row">${presets}${custom}</div>${pickers}<small>Pick a color theme, or Custom to choose each color yourself. Changes show straight away.</small>
    <div class="backdrop-row"><b>Behind the selected game</b><div class="seg">${backdrop}</div></div>`;
}
async function setTheme(theme) {
  S.settings.theme = theme;
  applyBackground();
  const box = $('#appearance');
  if (box) box.innerHTML = `<span>Colors</span>${themeSettingsHtml()}`;
  clearTimeout(setTheme.t);
  setTheme.t = setTimeout(() => guard(() => api.settings({ theme })), 250);
}

// ---------------------------------------------------------------- render
function render() {
  if (!S) return;
  stashInfo();
  applyBackground();
  renderHeader();
  $('#view').classList.toggle('is-shelf', ui.view === 'shelf');
  const cb = $('#btn-customize'); if (cb) cb.classList.toggle('on', ui.view === 'customize');
  if (ui.view === 'shelf') {
    renderShelf();
  } else if (ui.view === 'roms') renderRoms();
  else if (ui.view === 'updates') renderUpdates();
  else if (ui.view === 'screenshots') { if (!$('#shots-page')) renderScreenshots(); }
  else if (ui.view === 'discover') { if (!$('#disc-form')) renderDiscover(); }
  else if (ui.view === 'customize') { if (!$('#appearance')) renderCustomize(); }
  else if (ui.view === 'settings') { if (!$('#set-token')) { renderSettings(); loadRomCopies(); } }
  else if (ui.view === 'about') { if (!$('#about-page')) renderAbout(); else refreshAboutUpdate(); }
  else if (ui.view === 'help') { if (!$('#help-page')) renderHelp(); }
  renderDetail();
  if (pad.connected) updatePadHints();
}

// Customize: jump straight to the colors and background in Settings
function openCustomize() { setView('customize'); }
function setView(view, extra = {}) {
  Object.assign(ui, { view }, extra);
  heroReset();
  stashInfo();
  $('#view').innerHTML = '';
  render();
  $('#view').scrollTop = 0;
}

// ---------------------------------------------------------------- updates
function renderUpdates() {
  const list = S.games.filter((g) => g.updateAvailable && g.installed).sort((a, b) => (b.favorite - a.favorite) || a.port.localeCompare(b.port));
  const busy = list.filter((g) => g.job).length;
  const rows = list.map((g) => {
    const notes = cleanNotes(g.release && g.release.notes);
    const sys = S.systems[g.system] || {};
    return `<div class="upd-row" style="--c:${sys.color || '#c8161d'}">
      <div class="upd-main"><b>${g.favorite ? '<span class="upd-fav" title="One of your favorites">★</span> ' : ''}${esc(g.port)}</b>
        <span>${esc(g.installed.tag)} → <b>${esc(g.release.tag)}</b>${g.release.published ? ` · released ${esc(ago(g.release.published))}` : ''} · ${esc(sys.short || '')}</span>
        ${notes ? `<details><summary>What's new</summary><div class="notes">${esc(notes.slice(0, 1800))}${notes.length > 1800 ? '…' : ''}</div></details>` : '<small class="sub">No release notes from the project.</small>'}</div>
      ${g.job ? '<span class="tag">Updating…</span>' : `<button class="btn3d small pink" data-upd-one="${esc(g.id)}">Update</button>`}
    </div>`;
  }).join('');
  $('#view').innerHTML = `<div class="panel wide" id="upd-page">
    ${panelHead('Updates for my games', '')}
    <div class="upd-bar">
      <b>${list.length ? `${list.length} game${list.length === 1 ? '' : 's'} can be updated` : 'Everything is up to date'}</b>
      ${list.length > 1 ? `<button class="btn3d pink" data-act="update-all"${busy ? ' disabled' : ''}>Update all (${list.length})</button>` : ''}
      <button class="btn-link" data-act="upd-check">Check now</button>
    </div>
    <p class="disc-sub">Saves are backed up before each update. Games you built or added yourself aren't listed. Favorites show first.</p>
    ${list.length ? `<div class="upd-list">${rows}</div>` : '<div class="empty"><h2>Nothing to update</h2><p>Fulton checks your installed games when it starts and every few hours.</p></div>'}
  </div>`;
}

async function updateAll() {
  const list = S.games.filter((g) => g.updateAvailable && g.installed && !g.job);
  if (!list.length) return;
  toast(`Updating ${list.length} game${list.length === 1 ? '' : 's'}…`, 'You can keep using Fulton while it works.');
  let ok = 0, failed = [];
  for (const g of list) {
    const res = await guard(() => api.install(g.id));
    if (res && res.ok) ok++; else failed.push(g.port);
  }
  toast(failed.length ? `${ok} updated, ${failed.length} didn't work` : `${ok} game${ok === 1 ? '' : 's'} updated!`, failed.length ? failed.join(', ') : '', failed.length ? 'bad' : 'ok');
}

// Tell the person about updates once per version: favorites by name (and an OS notification), the rest in one line
function notifyUpdates() {
  if (!S || !notifyOn()) return;
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('fulton.notified') || '{}'); } catch { /* fine */ }
  const fresh = S.games.filter((g) => g.updateAvailable && g.installed && seen[g.id] !== g.release.tag);
  if (!fresh.length) return;
  for (const g of fresh) seen[g.id] = g.release.tag;
  try { localStorage.setItem('fulton.notified', JSON.stringify(seen)); } catch { /* fine */ }
  const favs = fresh.filter((g) => g.favorite);
  for (const g of favs) {
    toast(`${g.port} has an update`, `${g.installed.tag} → ${g.release.tag}`, 'ok', [['See updates', () => setView('updates')]]);
    try { if (window.Notification) new Notification(`${g.port} has an update`, { body: `${g.installed.tag} → ${g.release.tag}` }); } catch { /* fine */ }
  }
  const rest = fresh.length - favs.length;
  if (rest > 0) toast(`${rest} game${rest === 1 ? '' : 's'} can be updated`, '', 'ok', [['See updates', () => setView('updates')]]);
}

// ---------------------------------------------------------------- actions
async function addRomPaths(paths) {
  if (!paths.length) return;
  toast('Checking ROMs…', `${paths.length} item${paths.length > 1 ? 's' : ''}`);
  showRomReport(await guard(() => api.addRoms(paths)));
}

function showRomReport(report, isScan = false) {
  if (!report) return;
  const added = report.filter((r) => r.status === 'added');
  const dup = report.filter((r) => r.status === 'duplicate').length;
  const bad = report.filter((r) => r.status === 'error');
  const relinked = report.filter((r) => r.status === 'relinked').length;
  const forgot = report.filter((r) => r.status === 'forgotten').reduce((n, r) => n + r.count, 0);
  if (relinked) toast(`Found ${relinked.toLocaleString()} ROM${relinked > 1 ? 's' : ''} in a new place`, 'Fulton now uses your own files for them.', 'ok');
  if (forgot) toast(`${forgot.toLocaleString()} missing ROM${forgot > 1 ? 's' : ''} removed from the list`, 'Their files are gone from your watched folders. Your other files weren\'t touched.');
  report = report.filter((r) => r.status !== 'relinked' && r.status !== 'forgotten');
  if (isScan || added.length > 4) {
    const unlocks = new Set(added.flatMap((r) => r.unlocks));
    if (added.length) toast(`Found ${added.length} new ROM${added.length > 1 ? 's' : ''}!`, unlocks.size ? `Unlocked ${unlocks.size} game${unlocks.size > 1 ? 's' : ''}: ${[...unlocks].slice(0, 6).join(', ')}${unlocks.size > 6 ? '…' : ''}` : 'None of them match a game in the catalog yet.', 'ok');
    else toast('No new ROMs found', dup ? `${dup} ROM${dup > 1 ? 's were' : ' was'} already in your library.` : 'Fulton recognises games for every Nintendo, Sega, Sony and Xbox console up to Switch, plus PC Engine, Neo Geo, Atari and more: cartridge ROMs, disc images (.cue/.bin, .chd, .iso, .gdi), Switch .nsp/.xci, dumped game folders, and arcade .zip sets (CPS1/2/3, Neo Geo, NAOMI and more).', dup ? '' : 'warn');
    if (bad.length) toast(`${bad.length} file${bad.length > 1 ? 's' : ''} skipped`, bad.slice(0, 2).map((r) => `${r.file}: ${r.error}`).join(' · '), 'warn');
    return;
  }
  for (const r of added.slice(0, 4)) {
    toast(r.name, r.unlocks.length ? `Unlocks ${r.unlocks.join(', ')}` : 'Added. No port in the catalog uses this ROM yet.', r.verified ? 'ok' : 'warn');
  }
  if (added.length > 4) toast(`${added.length - 4} more ROMs added`, '', 'ok');
  if (dup) toast(`${dup} already in your library`);
  for (const r of bad.slice(0, 3)) toast(`Skipped ${r.file}`, r.error, 'bad');
  if (!report.length) toast('No ROMs found', 'Fulton recognises games for every Nintendo, Sega, Sony and Xbox console up to Switch, plus PC Engine, Neo Geo, Atari and more: cartridge ROMs, disc images (.cue/.bin, .chd, .iso, .gdi), Switch .nsp/.xci, dumped game folders, and arcade .zip sets (CPS1/2/3, Neo Geo, NAOMI and more).', 'warn');
}

/** Before an update: what changed, so you can decide. */
function showUpdateNotes(g) {
  const notes = cleanNotes(g.release && g.release.notes);
  const m = $('#modal');
  m.innerHTML = `<div class="modal tip" role="dialog" aria-modal="true">
    <div class="help-topic">
      <h2>Update ${esc(g.port)}?</h2>
      <p class="lead">${esc(g.installed.tag)} → <b>${esc(g.release.tag)}</b>${g.release.published ? ` · released ${esc(fmtDate(g.release.published))}` : ''}. Your saves are backed up first and kept.</p>
      ${notes ? `<p style="margin:0 0 6px;color:#fff;font-weight:800">What's new</p><div class="notes">${esc(notes.slice(0, 2400))}${notes.length > 2400 ? '…' : ''}</div>` : '<p class="sub">The project didn\'t write any notes for this version.</p>'}
      ${g.release.url ? '<button class="btn-link" data-act="open-notes" style="margin-top:8px">Full release notes on GitHub</button>' : ''}
    </div>
    <div class="modal-actions"><button class="btn3d pink" data-update-go="${esc(g.id)}">Update now</button><button class="btn-link" data-tip-close="1">Not now</button></div>
  </div>`;
  m.hidden = false;
  setTimeout(() => { const b = m.querySelector('[data-update-go]'); if (b) b.focus(); }, 30);
}

async function onAction(act, g, opts = {}) {
  switch (act) {
    case 'favorite': await guard(() => api.setFavorite(g.id, !g.favorite)); break;
    case 'install': {
      if (g.updateAvailable && !opts.confirmed && g.installed) { showUpdateNotes(g); break; }
      if (!g.installed && !opts.root && (S.locations || []).length > 1 && S.settings.askInstallDrive !== false) { await showDrivePicker(g); break; }
      const res = await guard(() => api.install(g.id, opts.root ? { root: opts.root } : {}));
      if (res && res.ok) setTimeout(maybeAskSupport, 2500);
      if (res && res.ok) toast(`${g.port} is installed!`, g.romMatch ? 'Hit Play to start.' : asksForRom(g) ? 'Hit Play. The game asks for your ROM the first time.' : 'Load its ROM, then hit Play.', 'ok');
      else if (res && res.error) {
        const folder = `${opts.root || S.dirs.root}${isMac() || S.platform === 'linux' ? '/' : '\\'}Games${isMac() || S.platform === 'linux' ? '/' : '\\'}${g.id}`;
        toast(`Couldn't install ${g.port}`, res.error, 'bad', [['Open folder', () => api.openPath(folder)]]);
      }
      break;
    }
    case 'cancel': await guard(() => api.cancel(g.id)); break;
    case 'play': {
      const res = await guard(() => api.launch(g.id));
      if (res && res.needsRom) {
        // Only games that can't ask for the ROM themselves (like Perfect Dark) end up here
        toast(`${g.port} needs its ROM loaded here`, "This game doesn't ask for a ROM itself. Load it once and Fulton puts it where the game expects.", 'warn', [['Load ROM', () => loadRomForSelected()]]);
        break;
      }
      if (res && res.ok && !res.alreadyRunning) {
        if (res.tip) toast(`Starting ${g.port} for the first time`, res.tip + (res.romFile ? ' The ROM path is on your clipboard.' : ''), 'ok');
        else toast(`Starting ${g.port}`);
      }
      break;
    }
    case 'uninstall': await guard(() => api.uninstall(g.id)); break;
    case 'move-drive': await showDrivePicker(g, 'move'); break;
    case 'open-folder': await guard(() => api.openFolder(g.id)); break;
    case 'game-shots': setView('screenshots', { shotGame: g.id }); break;
    case 'open-repo': api.openUrl(`https://github.com/${g.repo}`); break;
    case 'link-exe': {
      const linked = await guard(() => api.linkExe(g.id));
      if (linked) toast(`${g.port} added. Press Play to start it.`);
      break;
    }
    case 'pick-cover': await guard(() => api.pickCover('game', g.id)); break;
    case 'reset-cover': await guard(() => api.resetCover('game', g.id)); break;
    case 'open-site': api.openUrl(g.site); break;
    case 'open-notes': api.openUrl(g.release.url); break;
    case 'pick-rom': await loadRomForSelected(); break;
    case 'backup-now': {
      const b = await guard(() => api.backupNow(g.id));
      if (b) toast(`${g.port} saves backed up`, `${b.files} file${b.files === 1 ? '' : 's'} saved.`, 'ok');
      else if (b === null) toast('Nothing to back up yet', `${g.port} has no saves or settings in its folder yet. Play it first.`);
      loadBackups(g.id, true);
      break;
    }
    case 'open-backups': api.openBackups(g.id); break;
    case 'add-steam': await addToSteam([g]); break;
    case 'remove-steam': {
      const r = await guard(() => api.removeFromSteam(g.id));
      if (r && !r.cancelled) toast(`${g.port} removed from Steam`);
      break;
    }
    case 'remove-custom': await guard(() => api.removeUserGame(g.id)); ui.selected = null; break;
    case 'remove-shelf': try { if (g.installed && !(await api.uninstall(g.id))) break; await api.removeFromShelf(g.id); ui.selected = null; toast(`${g.port || g.title} removed from your shelf`, 'You can add it back from Find more.', 'ok'); } catch (e) { toast('Couldn\'t remove it', e.message, 'bad'); } break;
    default: break;
  }
}

async function refreshReleases(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  await guard(() => api.refresh(true));
  if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '↻ Updates'; }
  const n = S.games.filter((g) => g.updateAvailable).length;
  toast(n ? `${n} update${n > 1 ? 's' : ''} ready!` : 'Everything is up to date', '', n ? 'ok' : '');
}

document.addEventListener('dblclick', (e) => {
  const c = e.target.closest('.card');
  if (!c || !c.dataset.id || c.dataset.id.startsWith('rom:')) return;
  const g = S.games.find((x) => x.id === c.dataset.id);
  if (g && g.installed && !g.job && !g.running) onAction('play', g);
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .card, [data-url]');
  if (!t) return;
  if (t.dataset.more) { sectionLimit[t.dataset.more] = limitOf(t.dataset.more) + SECTION_STEP * 2; return renderShelf(); }
  if (t.dataset.findMore) return findMoreFor(t.dataset.fmSystem, t.dataset.fmKind);
  if (t.classList.contains('card')) {
    if (!t.dataset.id) return;
    const same = ui.selected === t.dataset.id && ui.infoOpen;
    if (same && e.detail > 1) return;
    if (same && !t.dataset.id.startsWith('rom:')) return openInfo(false);
    select(t.dataset.id, t, false); return t.dataset.id.startsWith('rom:') ? undefined : openInfo(true);
  }
  if (t.dataset.padSetup !== undefined) return startPadSetup(Number(t.dataset.padSetup));
  if (t.dataset.padSkip) return skipPadStep();
  if (t.dataset.padCancel) return finishPadSetup(null, false);
  if (t.dataset.padReset !== undefined) {
    const gp = (navigator.getGamepads() || [])[Number(t.dataset.padReset)];
    if (gp) { try { localStorage.removeItem(`padmap:${gp.id}`); } catch { /* ignore */ } toast('Back to the automatic layout', padName(gp), 'ok'); }
    return;
  }
  if (t.dataset.tour !== undefined && t.dataset.tour !== '') { const n = Number(t.dataset.tour); return n >= TOUR.length ? endTour() : showTour(n); }
  if (t.dataset.tourSkip) return endTour();
  if (t.dataset.tourGo) { await endTour(); return openCustomize(); }
  if (t.dataset.actWelcome) return closeWelcome(t.dataset.actWelcome === 'about' ? 'about' : null);
  if (t.dataset.tipClose) return closeTip();
  if (t.dataset.backdrop) {
    S.settings.heroBackdrop = t.dataset.backdrop;
    const box = $('#appearance');
    if (box) box.innerHTML = `<span>Colors</span>${themeSettingsHtml()}`;
    return guard(() => api.settings({ heroBackdrop: t.dataset.backdrop }));
  }
  if (t.dataset.fadeSide) {
    const f = fadeOf(), id = t.dataset.fadeSide;
    f.sides = f.sides.includes(id) ? f.sides.filter((x) => x !== id) : [...f.sides, id];
    saveFade(f); t.classList.toggle('on', f.sides.includes(id)); t.setAttribute('aria-pressed', String(f.sides.includes(id)));
    return undefined;
  }
  if (t.dataset.cpToggle) {
    const pop = t.closest('.color-pick').querySelector('.cp-pop');
    const open = pop.hidden;
    document.querySelectorAll('.cp-pop').forEach((x) => { x.hidden = true; });
    pop.hidden = !open;
    return undefined;
  }
  if (t.dataset.theme) {
    const cur = S.settings.theme || { preset: window.THEMES[0].id };
    // your custom colors are remembered while you try other themes
    const saved = cur.preset === 'custom' ? { base: cur.base, custom: cur.custom || {} } : cur.saved;
    if (t.dataset.theme !== 'custom') return setTheme({ preset: t.dataset.theme, ...(saved ? { saved } : {}) });
    if (cur.preset === 'custom') return undefined;
    if (saved) return setTheme({ preset: 'custom', base: saved.base, custom: saved.custom, saved });
    return setTheme({ preset: 'custom', base: cur.preset || window.THEMES[0].id, custom: {} });
  }
  if (t.dataset.shot !== undefined) return showShot(Number(t.dataset.shot));
  if (t.dataset.shotAct) return shotAction(t.dataset.shotAct);
  if (t.dataset.shotBg !== undefined) {
    const x = (ui.shotPick || [])[Number(t.dataset.shotBg)]; closeTip();
    if (!x) return;
    const p = await guard(() => api.useBackground(x.file));
    if (p) { S.settings.backgroundImage = p; applyBackground(); toast('Background changed', 'Using your screenshot.', 'ok'); if (ui.view === 'customize') renderCustomize(); }
    return;
  }
  if (t.dataset.driveGo) {
    const d = (ui.drives || [])[Number(t.dataset.driveGo)]; const game = S.games.find((x) => x.id === ui.pendingDriveGame);
    const dont = $('#drive-dont-ask') && $('#drive-dont-ask').checked;
    closeTip();
    if (ui.drivePickMode === 'move') {
      if (!d || !game) return;
      toast(`Moving ${game.port}`, `To ${d.dir}. You can keep using Fulton; big games take a while.`);
      const r = await guard(() => api.moveGame(game.id, d.dir));
      if (r) toast(`${game.port} moved`, `${r.leftover ? `The old copy at ${r.leftover} couldn't be deleted; you can delete that folder yourself. ` : ''}${r.inSteam ? 'It is also in Steam: remove it from Steam and add it again so the shortcut points to the new place.' : 'Everything points to the new place.'}`, r.leftover || r.inSteam ? 'warn' : 'ok');
      return;
    }
    if (dont) { S.settings.askInstallDrive = false; api.settings({ askInstallDrive: false }); }
    return d && game ? onAction('install', game, { root: d.dir }) : undefined;
  }
  if (t.dataset.driveDefault) { const d = (ui.drives || [])[Number(t.dataset.driveDefault)]; if (d) { await guard(() => api.setDefaultLibraryDir(d.dir)); renderSettings(); } return; }
  if (t.dataset.driveRemove) {
    const d = (ui.drives || [])[Number(t.dataset.driveRemove)];
    if (d) { await guard(() => api.removeLibraryDir(d.dir)); toast('Removed from the list', d.games ? `The ${d.games} game${d.games === 1 ? '' : 's'} installed there still work and stay where they are.` : '', 'ok'); renderSettings(); }
    return;
  }
  if (t.dataset.driveOpen) { const d = (ui.drives || [])[Number(t.dataset.driveOpen)]; if (d) api.openPath(d.dir); return; }
  if (t.dataset.updateGo) { closeTip(); const g = S.games.find((x) => x.id === t.dataset.updateGo); return g ? onAction('install', g, { confirmed: true }) : undefined; }
  if (t.dataset.helpTip) return showTip(t.dataset.helpTip);
  if (t.dataset.helpGo) return openHelp(t.dataset.helpGo);
  if (t.dataset.setupFix) {
    t.disabled = true; t.textContent = 'Working…';
    const fix = t.dataset.setupFix;
    const r = await guard(() => (fix === 'forget-missing' ? api.forgetMissing() : fix === 'remove-copies' ? api.removeRomCopies() : api.fixSetup(fix)));
    if (r != null) toast('Done', '', 'ok');
    return runSetupCheck();
  }
  if (t.dataset.helpTopic) { helpUi.topic = t.dataset.helpTopic; renderHelpBody(); $('#view').scrollTop = 0; return; }
  if (t.dataset.helpAct) { closeTip(); return t.dataset.helpAct === 'log' ? guard(() => api.openLog()) : setView(t.dataset.helpAct); }
  if (t.dataset.actAbout === 'log') return guard(() => api.openLog());
  if (t.dataset.actAbout === 'check') {
    t.disabled = true; t.textContent = 'Checking…';
    const r = await guard(() => api.checkAppUpdate(true));
    t.disabled = false; t.textContent = 'Check now';
    if (r && !r.available) { const st = $('#update-status'); if (st) st.textContent = r.skipped === 'no-releases' ? 'No releases published yet.' : `You're on the latest version (${verLabel()}).`; }
    return;
  }
  if (t.dataset.view) return setView(t.dataset.view);
  if (t.dataset.more) { sectionLimit[t.dataset.more] = limitOf(t.dataset.more) + SECTION_STEP * 2; return renderShelf(); }
  if (t.dataset.romsMore) { romsLimit += 300; lastRomsSig = ''; return renderRoms(); }
  if (t.dataset.rowScroll) {
    const sh = t.parentElement.querySelector('.shelf');
    if (sh) sh.scrollBy({ left: Number(t.dataset.rowScroll) * sh.clientWidth * 0.8, behavior: 'smooth' });
    return;
  }
  if (t.dataset.filter) return setView('shelf', { filter: t.dataset.filter });
  if (t.dataset.clear) {
    const k = t.dataset.clear;
    if (k === 'query') $('#search').value = '';
    if (k === 'sort') { ui.sort = 'smart'; saveViewPrefs(); }
    return setView('shelf', k === 'system' ? { system: null } : k === 'filter' ? { filter: 'all' } : k === 'query' ? { query: '' } : {});
  }
  if (t.dataset.type != null) return setView('shelf', { kind: t.dataset.type || null });
  if (t.dataset.discRange != null) { disc.range = Number(t.dataset.discRange) || 0; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.updOne) { const g = S.games.find((x) => x.id === t.dataset.updOne); return g ? onAction('install', g, { confirmed: true }) : undefined; }
  if (t.dataset.discUnset) { const k = t.dataset.discUnset; disc[k] = (k === 'range') ? 0 : k === 'hideShelf' ? false : null; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.discOs != null) { disc.os = t.dataset.discOs || null; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.discGet != null) { disc.get = t.dataset.discGet || null; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.discType != null) { disc.kind = t.dataset.discType || null; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.viewGo) return setView(t.dataset.viewGo);
  if (t.dataset.layout) { ui.layout = t.dataset.layout; saveViewPrefs(); $('#view').scrollTop = 0; return renderShelf(); }
  if (t.dataset.system) return setView('shelf', { system: ui.system === t.dataset.system ? null : t.dataset.system, filter: 'all' });
  if (t.dataset.romRemove) return guard(() => api.removeRom(t.dataset.romRemove));
  if (t.dataset.restore && ui.selected) {
    const g = S.games.find((x) => x.id === ui.selected);
    const r = await guard(() => api.restoreBackup(ui.selected, t.dataset.restore));
    if (r && r.restored) { toast(`${g.port} saves restored`, 'Your previous saves were backed up first, in case you change your mind.', 'ok'); loadBackups(ui.selected, true); }
    return;
  }
  if (t.dataset.folderRemove) return guard(() => api.removeRomFolder(t.dataset.folderRemove));
  if (t.dataset.openPath) return api.openPath(t.dataset.openPath);
  if (t.dataset.romCover) { await guard(() => api.pickCover('rom', t.dataset.romCover)); return; }
  if (t.dataset.romCoverReset) { await guard(() => api.resetCover('rom', t.dataset.romCoverReset)); return; }
  if (t.dataset.romReveal) { const r = S.roms.find((x) => x.id === t.dataset.romReveal); return r && api.reveal(r.file); }
  if (t.dataset.addRepo) return renderAddForm(t.dataset.addRepo);
  if (t.dataset.copy) { await guard(() => api.copy(t.dataset.copy)); toast('Copied', t.dataset.copy); return; }
  if (t.dataset.url) return api.openUrl(t.dataset.url);
  if (t.dataset.discSystem !== undefined) { disc.system = t.dataset.discSystem || null; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.discKind) { disc.kind = disc.kind === t.dataset.discKind ? null : t.dataset.discKind; disc.limit = 60; return renderDiscoverList(); }
  if (t.dataset.goto) return setView('shelf', { filter: 'all', system: null, kind: null, query: '', selected: t.dataset.goto, infoOpen: true });
  if (t.dataset.addCommunity) {
    t.disabled = true; t.textContent = 'Adding…';
    const g = await guard(() => api.addCommunityGame(t.dataset.addCommunity));
    if (g) { toast(`${g.port} added to your shelf!`, 'Find it under Games, then hit Install.', 'ok'); await loadCommunity(); }
    else { t.disabled = false; t.textContent = '+ Add'; }
    return;
  }
  const act = t.dataset.act;
  if (!act) return;
  if (act === 'close-info') return openInfo(false);
  if (act === 'refresh') return refreshReleases(t);
  if (act === 'meta-retry' && ui.selected) { t.textContent = 'Checking…'; return guard(() => api.metascore(ui.selected, true)); }
  if (act === 'reset-filters') { $('#search').value = ''; ui.sort = 'smart'; saveViewPrefs(); return setView('shelf', { filter: 'all', system: null, query: '' }); }
  if (act === 'clear-filters') { $('#search').value = ''; return setView('shelf', { filter: 'all', system: null, kind: null, query: '' }); }
  if (act === 'community-refresh') { communityData = null; renderDiscoverList(); return loadCommunity(true); }
  if (act === 'recheck-platforms') { platformProgress = { done: 0, total: 1 }; renderDiscoverList(); return guard(() => api.checkPlatforms()); }
  if (act === 'disc-filters') { ui.filtersOpen = !ui.filtersOpen; return renderDiscoverList(); }
  if (act === 'update-all') return updateAll();
  if (act === 'upd-check') { await refreshReleases(null); return renderUpdates(); }
  if (act === 'disc-seen') { await guard(() => api.markDiscoverSeen()); communityData = null; return loadCommunity(true); }
  if (act === 'disc-clear') { Object.assign(disc, { q: '', system: null, kind: null, get: null, range: 0, os: null, status: null, hideShelf: false, sort: 'best', limit: 60 }); const f = $('#disc-filter'); if (f) f.value = ''; const ts = $('#search'); if (ts) ts.value = ''; return renderDiscoverList(); }
  if (act === 'customize') return openCustomize();
  if (act === 'report-problem') { const f = await guard(() => api.reportProblem()); if (f) toast('Problem report saved', 'Send that zip to the developer. It has no ROMs, saves or tokens.', 'ok'); return; }
  if (act === 'tour') return showTour(0);
  if (act === 'disc-more') { disc.limit += 60; return renderDiscoverList(); }
  if (act === 'pick-files') return showRomReport(await guard(() => api.pickRoms('files')));
  if (act === 'pick-folder') return showRomReport(await guard(() => api.pickRoms('folder')));
  if (act === 'add-folder') return addFolder();
  if (act === 'theme-reset') { const cur = S.settings.theme || {}; return setTheme({ preset: 'custom', base: cur.base || window.THEMES[0].id, custom: {} }); }
  if (act === 'check-setup') { if (!setupState.running) runSetupCheck(); return; }
  if (act === 'forget-missing') { const n = await guard(() => api.forgetMissing()); if (n) toast(`Removed ${n.toLocaleString()} missing ROM${n > 1 ? 's' : ''} from the list`, '', 'ok'); return; }
  if (act === 'rescan') { t.textContent = 'Scanning…'; const r = await guard(() => api.scanRomFolders(true)); showRomReport(r || [], true); return render(); }
  if (act === 'library-moved') { const n = await guard(() => api.relocateLibrary()); if (n !== null && n !== undefined) toast('Library folder updated', n ? `Fixed ${n.toLocaleString()} saved path${n === 1 ? '' : 's'}. Your games should be back.` : 'Nothing needed changing.', 'ok'); return renderSettings(); }
  if (act === 'scan-library') { t.disabled = true; t.textContent = 'Looking…'; const n = await guard(() => api.scanLibrary()); toast(n ? `Found ${n} game${n === 1 ? '' : 's'}` : 'No new games found', n ? 'They are back on your shelf and ready to play.' : 'Fulton looked in every drive on the list. If your folder was renamed or moved, use "I renamed or moved my folder".', n ? 'ok' : 'warn'); return renderSettings(); }
  if (act === 'view-shots') return setView('screenshots', { shotGame: '' });
  if (act === 'open-shots-folder') return api.openShotsFolder(ui.view === 'screenshots' && ui.shotGame ? ui.shotGame : '');
  if (act === 'shot-key-reset') { S.settings.screenshotKey = 'F8'; await guard(() => api.settings({ screenshotKey: 'F8' })); return renderSettings(); }
  if (act === 'shot-key') return recordShotKey(t);
  if (act === 'pick-bg-shot') return pickBackgroundFromShots();
  if (act === 'drive-add') { const d = await guard(() => api.addLibraryDir()); if (d) toast('Drive added', 'You can pick it when you install a game, or make it the default.', 'ok'); return renderSettings(); }
  if (act === 'pick-romcopy-dir') { await guard(() => api.pickRomCopyDir()); return renderSettings(); }
  if (act === 'reset-romcopy-dir') { await guard(() => api.settings({ romCopyDir: '' })); return renderSettings(); }
  if (act === 'pick-backup-dir') { await guard(() => api.pickBackupDir()); return renderSettings(); }
  if (act === 'open-all-backups') return api.openBackups();
  if (act === 'backup-all') {
    t.disabled = true; t.textContent = 'Backing up…';
    const ids = await guard(() => api.backupAll());
    t.disabled = false; t.textContent = 'Back up all games now';
    backupsCache.clear();
    return toast(ids && ids.length ? `Backed up ${ids.length} game${ids.length > 1 ? 's' : ''}` : 'Nothing to back up yet', ids && ids.length ? '' : 'No installed game has saves in its folder yet.', ids && ids.length ? 'ok' : '');
  }
  if (act === 'steam-all') {
    const list = S.games.filter((x) => x.installed && !x.inSteam);
    if (!list.length) return toast('Nothing to add', S.games.some((x) => x.installed) ? 'All your installed games are already in Steam.' : 'Install a game first.');
    return addToSteam(list);
  }
  if (act === 'pick-bg') { const p = await guard(() => api.pickBackground()); if (p) { S.settings.backgroundImage = p; applyBackground(); toast('Background changed', '', 'ok'); renderCustomize(); } return; }
  if (act === 'clear-bg') { await guard(() => api.clearBackground()); S.settings.backgroundImage = ''; applyBackground(); toast('Background reset to the default'); return renderCustomize(); }
  if (act === 'load-rom') return loadRomForSelected();
  if (act === 'remove-rom-copies') {
    const r = await guard(() => api.removeRomCopies());
    if (r) toast(`Removed ${r.removed.toLocaleString()} copies`, `${fmtSize(r.freed)} freed.`, 'ok');
    return loadRomCopies();
  }
  if (act === 'rom-help' && ui.selected) {
    guideOpen[ui.selected] = true;
    openInfo(true);
    setTimeout(() => { const d = document.querySelector(`#info details[data-guide="${CSS.escape(ui.selected)}"]`) || document.getElementById(`romhelp-${ui.selected}`); if (d) { if (d.tagName === 'DETAILS') d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 120);
    return;
  }
  if (act === 'open-lib') return api.openPath();
  if (act === 'find-covers') {
    t.disabled = true;
    const res = await guard(() => api.findAllCovers());
    t.disabled = false;
    if (res) { artCache.clear(); toast('Covers checked', `${res.found} of ${res.total} games and ROMs have box art.${res.missing ? ` ${res.missing} still use a generated cover${S.settings.steamGridKey ? '' : '; a SteamGridDB key may find more'}.` : ''}`, 'ok'); }
    const pr = $('#cover-progress'); if (pr) pr.textContent = '';
    return;
  }
  if (act === 'save-sgdb') { await guard(() => api.settings({ steamGridKey: $('#set-sgdb').value.trim() })); artCache.clear(); toast('SteamGridDB key saved', 'Click Find missing covers to look again.', 'ok'); return; }
  if (act === 'save-token') { await guard(() => api.settings({ githubToken: $('#set-token').value.trim() })); toast('GitHub token saved', '', 'ok'); return guard(() => api.refresh(true)); }
  if (act === 'save-catalog') { await guard(() => api.settings({ extraCatalogUrl: $('#set-catalog').value.trim() })); return toast('Catalog saved', 'Its games now appear on your shelf.', 'ok'); }
  if (act === 'cancel-add') { $('#add-form-slot').innerHTML = ''; return; }
  const g = S.games.find((x) => x.id === ui.selected);
  if (g) onAction(act, g);
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'set-ask-drive') { S.settings.askInstallDrive = e.target.checked; await guard(() => api.settings({ askInstallDrive: e.target.checked })); return; }
  if (e.target.id === 'set-shots') { S.settings.screenshots = e.target.checked; await guard(() => api.settings({ screenshots: e.target.checked })); return; }
  if (e.target.id === 'set-shotsound') { S.settings.screenshotSound = e.target.checked; await guard(() => api.settings({ screenshotSound: e.target.checked })); return; }
  if (e.target.id === 'shot-filter') { ui.shotGame = e.target.value; return drawScreenshots(); }
  if (e.target.id === 'set-autobackup') { await guard(() => api.settings({ autoBackup: e.target.checked })); return; }
  if (e.target.id === 'set-meta') { await guard(() => api.settings({ showMetacritic: e.target.checked })); return; }
  if (e.target.id === 'set-newdays') { const n = Number(e.target.value); S.settings.newWindowDays = n; if (disc.range && NEW_DAYS.includes(disc.range)) disc.range = n; renderHeader(); await guard(() => api.settings({ newWindowDays: n })); loadCommunity(); return; }
  if (e.target.id === 'set-sysicons') { const on = e.target.value === 'on'; S.settings.systemIcons = on; renderDiscoverList(); await guard(() => api.settings({ systemIcons: on })); return; }
  if (e.target.id === 'set-notify') { S.settings.notifyUpdates = e.target.checked; renderHeader(); await guard(() => api.settings({ notifyUpdates: e.target.checked })); return; }
  if (e.target.id === 'set-updates') { await guard(() => api.settings({ checkUpdates: e.target.checked })); return; }
  const pick = e.target.dataset && e.target.dataset.pick;
  if (pick) {
    ui[pick] = e.target.value || ({ sort: 'smart', filter: 'all', layout: 'rows' }[pick] ?? null);
    if (pick === 'sort' || pick === 'layout') saveViewPrefs();
    $('#view').scrollTop = 0;
    renderShelf(); renderDetail();
    return;
  }
  if (e.target.dataset.act === 'assign' && ui.selected) await guard(() => api.assignRom(ui.selected, e.target.value || null));
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'disc-form') {
    ui.discoverQ = $('#disc-q').value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.textContent = 'Searching…'; btn.disabled = true;
    try { discoverResults = await api.discover(ui.discoverQ); } catch (err) { discoverResults = { error: err.message }; }
    btn.textContent = 'Search GitHub'; btn.disabled = false;
    $('#gh-results').innerHTML = ghResultsHtml();
  } else if (e.target.id === 'add-form') {
    const entry = Object.fromEntries(new FormData(e.target));
    const g = await guard(() => api.addUserGame(entry));
    if (g) { toast(`${g.port} added to your shelf!`, '', 'ok'); setView('shelf', { filter: 'all', system: null, selected: g.id }); }
  }
});

// The big game banner shrinks once you scroll down and grows back at the top.
// Two thresholds (shrink past 60px, grow below 8px) plus the empty space under the last row
// stop it flipping back and forth when the list is short.
// Scrolling with the mouse or trackpad over the big game banner scrolls the games below it
// (on a laptop screen the banner can fill most of the window, and it doesn't scroll itself)
// The banner on top (cover, facts, ROM info) shrinks smoothly as you scroll, in step with your wheel, instead of snapping.
// Scrolling down first folds the banner away, then the list moves. Scrolling back up at the top brings it back.
const HERO_TRAVEL = 220; // pixels of scrolling that fold the banner away
let heroP = 0, heroTarget = 0, heroRaf = 0, heroWheelAt = 0;
function setHeroP(p) {
  heroP = Math.max(0, Math.min(1, p));
  document.body.style.setProperty('--p', heroP.toFixed(3));
  document.body.classList.toggle('hero-gone', heroP >= 0.999);
}
function heroStep() {
  heroRaf = 0;
  const d = heroTarget - heroP;
  if (Math.abs(d) < 0.003) { setHeroP(heroTarget); return; }
  setHeroP(heroP + d * 0.3);
  heroRaf = requestAnimationFrame(heroStep);
}
function heroTo(t) { heroTarget = Math.max(0, Math.min(1, t)); if (!heroRaf) heroRaf = requestAnimationFrame(heroStep); }
function heroReset() { heroTarget = 0; cancelAnimationFrame(heroRaf); heroRaf = 0; setHeroP(0); }
function measureHero() {
  // generous on purpose: the fold shrinks these blocks from this height down to nothing, and a block that grows a little
  // after it was measured (fonts, the ROM dropdown, cover art) must never get its last line sliced off
  document.querySelectorAll('#detail .plates, #detail .romcart, #detail .hero-more').forEach((el) => el.style.setProperty('--h', `${Math.ceil(el.scrollHeight * 1.4) + 32}px`));
}
let measureTimer = 0;
function measureHeroSoon() { measureHero(); clearTimeout(measureTimer); measureTimer = setTimeout(measureHero, 350); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureHero);
function heroWheel(e) {
  if (ui.view !== 'shelf' || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  if (e.target.closest && e.target.closest('select')) return;
  const view = $('#view');
  const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
  heroWheelAt = Date.now();
  if (dy > 0 && heroTarget < 1) {
    e.preventDefault();
    const use = Math.min(dy, (1 - heroTarget) * HERO_TRAVEL);
    heroTo(heroTarget + use / HERO_TRAVEL);
    if (dy > use) view.scrollTop += dy - use;
    return;
  }
  if (dy < 0 && view.scrollTop <= 0 && heroTarget > 0) { e.preventDefault(); heroTo(heroTarget + dy / HERO_TRAVEL); return; }
  if (e.currentTarget === $('#detail')) { e.preventDefault(); view.scrollTop += dy; } // the banner doesn't scroll itself
}
$('#detail').addEventListener('wheel', heroWheel, { passive: false });
$('#view').addEventListener('wheel', heroWheel, { passive: false });
new MutationObserver(measureHeroSoon).observe($('#detail'), { childList: true });
window.addEventListener('resize', measureHero);

$('#view').addEventListener('scroll', () => {
  const top = $('#view').scrollTop;
  if (ui.view !== 'shelf') { if (heroP || heroTarget) heroReset(); return; }
  if (top > 0 && heroTarget < 1) heroTo(1); // scrolled by the scroll bar or keys: the banner folds up too
  else if (top <= 0 && heroTarget > 0 && Date.now() - heroWheelAt > 200) heroTo(0); // dragged back to the top
}, { passive: true });

document.addEventListener('input', (e) => {
  if (e.target.id === 'set-dim') {
    document.querySelector('.sky').style.setProperty('--bg-dim', String(e.target.value / 100));
    $('#dim-val').textContent = `${e.target.value}%`;
    clearTimeout(window.__dimSave);
    window.__dimSave = setTimeout(() => api.settings({ backgroundDim: Number(e.target.value) }), 300);
  }
  if (e.target.id === 'set-fade-strength' || e.target.id === 'set-fade-reach') {
    const k = e.target.id === 'set-fade-reach' ? 'reach' : 'strength';
    $(`#fade-${k}-val`).textContent = `${e.target.value}%`;
    saveFade({ ...fadeOf(), [k]: Number(e.target.value) });
  }
  if (e.target.id === 'disc-size') { disc.size = Number(e.target.value); applySize(); return; }
  if (e.target.id === 'set-clear') {
    document.body.style.setProperty('--clear', String(e.target.value / 100));
    $('#clear-val').textContent = `${e.target.value}%`;
    clearTimeout(window.__clearSave);
    window.__clearSave = setTimeout(() => api.settings({ backgroundClear: Number(e.target.value) }), 300);
  }
  if (e.target.id === 'disc-sort') { disc.sort = e.target.value; disc.limit = 60; renderDiscoverList(); }
  if (e.target.id === 'disc-status') { disc.status = e.target.value || null; disc.limit = 60; renderDiscoverList(); }
  if (e.target.id === 'disc-days') { const n = Math.floor(Number(e.target.value)); disc.range = n > 0 ? n : 0; disc.limit = 60; const keep = e.target.value; renderDiscoverList(); const d = $('#disc-days'); if (d) { d.value = keep; if (e.type === 'input') { d.focus(); } } }
  if (e.target.id === 'disc-filter') { const ts = $('#search'); if (ts) ts.value = e.target.value; }
  if (e.target.id === 'disc-filter') { disc.q = e.target.value; disc.limit = 60; renderDiscoverList(); }
  if (e.target.id === 'help-q') { helpUi.q = e.target.value; renderHelpBody(); }
  if (e.target.dataset && (e.target.dataset.themeColor || e.target.dataset.num)) {
    // a color code typed in, or the R / G / B numbers
    const row = e.target.closest('.color-pick');
    let hex;
    if (e.target.dataset.num) {
      hex = rgbToHex(...['r', 'g', 'b'].map((c) => Number(row.querySelector(`[data-num="${c}"]`).value) || 0));
    } else {
      hex = e.target.value.trim();
      if (/^[0-9a-f]{6}$/i.test(hex)) hex = '#' + hex;
      if (!/^#[0-9a-f]{6}$/i.test(hex)) return; // still typing
    }
    setCustomColor(row, hex.toLowerCase(), { keep: e.target });
  }
});

/** Show a color everywhere it appears (swatch, code, numbers, picker) and use it live; saved a moment after you stop. */
function saveFade(f) {
  S.settings.backgroundFade = f;
  applyBackground();
  clearTimeout(saveFade.t);
  saveFade.t = setTimeout(() => guard(() => api.settings({ backgroundFade: f })), 300);
}

function setCustomColor(row, hex, { keep, keepHue } = {}) {
  const key = row.dataset.ck;
  let [h, sat, val] = hexToHsv(hex);
  if (keepHue || !sat || !val) h = Number(row.dataset.h) || h; // grays have no hue of their own: keep the slider where it was
  row.dataset.h = String(h);
  row.querySelector('.cp-sw').style.background = hex;
  const hexIn = row.querySelector('.cp-hex'); if (hexIn !== keep) hexIn.value = hex;
  hexToRgb(hex).forEach((v, i) => { const n = row.querySelector(`[data-num="${'rgb'[i]}"]`); if (n !== keep) n.value = v; });
  const sv = row.querySelector('.cp-sv'); sv.style.backgroundColor = `hsl(${h},100%,50%)`;
  const k = sv.querySelector('.cp-knob'); k.style.left = `${sat * 100}%`; k.style.top = `${(1 - val) * 100}%`;
  row.querySelector('.cp-hue .cp-knob').style.left = `${(h / 360) * 100}%`;
  if (key === 'fade') { saveFade({ ...fadeOf(), color: hex }); return; }
  const cur = S.settings.theme || { preset: 'custom', base: window.THEMES[0].id };
  const theme = { ...cur, preset: 'custom', custom: { ...(cur.custom || {}), [key]: hex } };
  S.settings.theme = theme;
  window.applyTheme(theme);
  applyBackground.themeSig = JSON.stringify(theme);
  document.querySelectorAll('[data-theme="custom"] .sws').forEach((el) => { el.innerHTML = swatch(window.themeColors(theme)); });
  clearTimeout(setTheme.t);
  setTheme.t = setTimeout(() => guard(() => api.settings({ theme })), 300);
}

// dragging in the color square or on the hue strip
let cpDrag = null;
function cpMove(e) {
  if (!cpDrag) return;
  const { row, kind, box } = cpDrag;
  const r = box.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  const [h0, s0, v0] = hexToHsv(row.querySelector('.cp-hex').value.match(/^#[0-9a-f]{6}$/i) ? row.querySelector('.cp-hex').value : '#888888');
  const h = Number(row.dataset.h) || h0;
  const hex = kind === 'sv' ? hsvToHex(h, x, 1 - y) : hsvToHex(x * 360, s0 || 0.001, v0 || 0.001);
  if (kind === 'hue') row.dataset.h = String(Math.round(x * 360));
  setCustomColor(row, hex, { keepHue: true });
  if (kind === 'hue') row.dataset.h = String(Math.round(x * 360));
  if (kind === 'hue') { row.querySelector('.cp-sv').style.backgroundColor = `hsl(${row.dataset.h},100%,50%)`; row.querySelector('.cp-hue .cp-knob').style.left = `${x * 100}%`; }
}
document.addEventListener('pointerdown', (e) => {
  const box = e.target.closest && e.target.closest('.cp-sv, .cp-hue');
  if (!box) return;
  e.preventDefault();
  cpDrag = { row: box.closest('.color-pick'), kind: box.classList.contains('cp-sv') ? 'sv' : 'hue', box };
  cpMove(e);
});
document.addEventListener('pointermove', cpMove);
document.addEventListener('pointerup', () => { cpDrag = null; });

$('#search').addEventListener('input', (e) => {
  if (ui.view === 'discover') {
    // on Find more the top box searches Find more instead of jumping to your games
    disc.q = e.target.value; disc.limit = 60;
    const f = $('#disc-filter'); if (f) f.value = disc.q;
    renderDiscoverList();
    return;
  }
  ui.query = e.target.value;
  if (ui.view !== 'shelf') Object.assign(ui, { view: 'shelf' });
  render();
});
$('#btn-support').addEventListener('click', () => { if ((S.links || {}).kofi) api.openUrl(S.links.kofi); });
$('#update-pill').addEventListener('click', () => { if (S.appUpdate) api.openUrl(S.appUpdate.download || S.appUpdate.url); });

/** Keep the About page's update line current without re-rendering the credits. */
function refreshAboutUpdate() {
  const st = $('#update-status');
  if (st && S.appUpdate) st.innerHTML = `<b class="gold">A new Fulton is out (build ${esc(S.appUpdate.version)}).</b>`;
}

async function addFolder() {
  toast('Pick your ROM folder', 'Choose the top folder. Every subfolder and zip inside is searched, and new ROMs are picked up each time Fulton starts.');
  const report = await guard(() => api.addRomFolder());
  if (report) showRomReport(report, true);
}

// The mouse wheel always scrolls the page up and down. Rows move sideways with their ‹ › arrows,
// Shift + wheel, a trackpad swipe, the arrow keys or a controller.
document.addEventListener('wheel', (e) => {
  const shelf = e.target.closest && e.target.closest('.shelf');
  if (shelf && e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { shelf.scrollBy({ left: e.deltaY * 2, behavior: 'smooth' }); e.preventDefault(); }
}, { passive: false });

/** Show a row's ‹ › arrows only when there is more to see that way. */
function updateRowArrows(root = document) {
  root.querySelectorAll('.shelf-wrap').forEach((w) => {
    const sh = w.querySelector('.shelf');
    if (!sh) return;
    w.classList.toggle('can-left', sh.scrollLeft > 4);
    w.classList.toggle('can-right', sh.scrollLeft + sh.clientWidth < sh.scrollWidth - 4);
  });
}
document.addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('shelf')) updateRowArrows(e.target.parentElement.parentElement); }, true);
window.addEventListener('resize', () => updateRowArrows());

// keyboard / controller-style navigation: left/right moves along the shelf, Enter plays or installs
document.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) { if (e.key === 'Escape') { if ($('#modal .modal.tip')) closeTip(); else closeWelcome(null); } return; }
  if (e.key === 'Escape' && ui.infoOpen) { openInfo(false); return; }
  if (ui.view !== 'shelf' || /input|select|textarea/i.test(document.activeElement.tagName)) return;
  if (e.key === 'i' || e.key === 'I') { openInfo(!ui.infoOpen); return; }
  if (/^[1-6]$/.test(e.key)) { setView('shelf', { kind: SHOW[+e.key - 1][0] || null }); return; }
  const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' }[e.key];
  if (dir) {
    e.preventDefault();
    moveSelection(dir);
  } else if (e.key === 'Enter' && ui.selected) {
    if (ui.selected.startsWith('rom:')) { const b = $('#detail [data-goto]'); if (b) b.click(); return; }
    const g = S.games.find((x) => x.id === ui.selected);
    if (g && !g.job) onAction(g.installed ? 'play' : g.sourceOnly ? 'open-repo' : 'install', g);
  }
});

// ---------------------------------------------------------------- controller (Xbox / PlayStation / Switch Pro via the Gamepad API)
// Standard mapping: 0 A/Cross, 1 B/Circle, 2 X/Square, 3 Y/Triangle, 4 LB, 5 RB, 6 LT, 7 RT, 8 View/Select, 9 Menu/Start, 12-15 D-pad.
const pad = { held: {}, next: {}, connected: false };
const TABS = ['shelf', 'updates', 'screenshots', 'roms', 'discover', 'customize', 'settings', 'help'];
const FILTERS = ['all', 'available', 'installed', 'ready', 'needs'];

// Controllers report their buttons in one of two ways:
// - the "standard" layout (Xbox, and most PlayStation / Switch Pro controllers on Windows): fixed button numbers
// - their own layout (many 8BitDo, generic USB and some Bluetooth pads): button numbers vary and the D-pad is often a "hat"
// For the second kind Fulton uses a layout for the brand, or the one you set up in Settings → Controller.
const PAD_KEYS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'start', 'up', 'down', 'left', 'right'];
const btn = (i) => ({ t: 'b', i });
const hat = (dir) => ({ t: 'h', dir });
const STANDARD_MAP = { a: btn(0), b: btn(1), x: btn(2), y: btn(3), lb: btn(4), rb: btn(5), lt: btn(6), rt: btn(7), view: btn(8), start: btn(9), up: btn(12), down: btn(13), left: btn(14), right: btn(15) };
const HAT_DPAD = { up: hat('up'), down: hat('down'), left: hat('left'), right: hat('right') };
// Positional: the bottom face button always confirms (like Steam), whatever letter is printed on it
const BRAND_MAPS = {
  // PlayStation (DirectInput): 0 Square, 1 Cross, 2 Circle, 3 Triangle, 4 L1, 5 R1, 6 L2, 7 R2, 8 Share/Create, 9 Options
  '054c': { a: btn(1), b: btn(2), x: btn(0), y: btn(3), lb: btn(4), rb: btn(5), lt: btn(6), rt: btn(7), view: btn(8), start: btn(9), ...HAT_DPAD },
  // Nintendo Switch Pro / 8BitDo in Switch mode: 0 B, 1 A, 2 Y, 3 X, 4 L, 5 R, 6 ZL, 7 ZR, 8 Minus, 9 Plus
  '057e': { a: btn(0), b: btn(1), x: btn(2), y: btn(3), lb: btn(4), rb: btn(5), lt: btn(6), rt: btn(7), view: btn(8), start: btn(9), ...HAT_DPAD },
};
const GENERIC_MAP = { a: btn(0), b: btn(1), x: btn(2), y: btn(3), lb: btn(4), rb: btn(5), lt: btn(6), rt: btn(7), view: btn(8), start: btn(9), ...HAT_DPAD };

const vendorOf = (gp) => ((gp.id.match(/Vendor:\s*([0-9a-f]{4})/i) || gp.id.match(/^([0-9a-f]{4})-[0-9a-f]{4}-/i) || [])[1] || '').toLowerCase();
const padName = (gp) => gp.id.replace(/\s*\((STANDARD GAMEPAD\s*)?(Vendor|XInput)[^)]*\)\s*/gi, ' ').replace(/\s*\(\s*\)\s*/g, ' ').trim() || 'Controller';

function savedMap(gp) {
  try { const m = JSON.parse(localStorage.getItem(`padmap:${gp.id}`) || 'null'); return m && typeof m === 'object' ? m : null; } catch { return null; }
}
/** The layout used for this controller, and where it came from. */
function mapFor(gp) {
  const mine = savedMap(gp);
  if (mine) return { map: mine, kind: 'yours' };
  if (gp.mapping === 'standard') return { map: STANDARD_MAP, kind: 'standard' };
  const brand = BRAND_MAPS[vendorOf(gp)];
  return { map: brand || GENERIC_MAP, kind: brand ? 'brand' : 'generic' };
}

/** The D-pad "hat": one axis whose value says which of 8 directions is held (and > 1 when nothing is). */
const hatSeen = {}; // controller id -> axis number, remembered once it's been seen at rest
function hatAxis(gp) {
  if (gp.mapping === 'standard') return -1; // standard pads report the D-pad as buttons 12-15
  if (hatSeen[gp.id] !== undefined) return hatSeen[gp.id];
  // most report it as axis 9; otherwise the axis resting above 1 (the hat's "nothing pressed" value)
  const i = gp.axes.length > 9 && Math.abs(gp.axes[9]) <= 1.5 ? 9 : gp.axes.findIndex((v) => v > 1.05 && v < 1.5);
  if (i >= 0) hatSeen[gp.id] = i;
  return i;
}
function hatDirs(v) {
  if (v === undefined || v < -1.05 || v > 1.05) return {};
  const step = Math.round((v + 1) / (2 / 7)) % 8; // 0 up, 1 up-right, 2 right, 3 down-right, 4 down, 5 down-left, 6 left, 7 up-left
  return { up: [7, 0, 1].includes(step), right: [1, 2, 3].includes(step), down: [3, 4, 5].includes(step), left: [5, 6, 7].includes(step) };
}

function pressedBy(gp, m, hd) {
  if (!m) return false;
  if (m.t === 'b') { const b = gp.buttons[m.i]; return !!(b && (b.pressed || b.value > 0.5)); }
  if (m.t === 'h') return !!hd[m.dir];
  if (m.t === 'a') { const v = gp.axes[m.i] || 0; return m.s < 0 ? v < -0.55 : v > 0.55; }
  return false;
}

function readPad() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
  if (!pads.length) return null;
  const st = {};
  for (const gp of pads) { // any connected controller can drive the launcher
    const { map } = mapFor(gp);
    const hi = hatAxis(gp);
    const hd = hi >= 0 ? hatDirs(gp.axes[hi]) : {};
    for (const k of PAD_KEYS) st[k] = st[k] || pressedBy(gp, map[k], hd);
    // the left stick always moves too
    const x = gp.axes[0] || 0;
    const y = gp.axes[1] || 0;
    st.left = st.left || x < -0.55; st.right = st.right || x > 0.55;
    st.up = st.up || y < -0.55; st.down = st.down || y > 0.55;
    if (gp.mapping === 'standard') {
      const ry = gp.axes[3] || 0;
      st.rsUp = st.rsUp || ry < -0.4; st.rsDown = st.rsDown || ry > 0.4;
    }
  }
  return st;
}

// ---------- Settings → Controller: live view and button setup
const padSetup = { active: false, gpIndex: null, step: 0, map: {}, base: null, wait: 0 };
const SETUP_STEPS = [['a', 'A: play / select (bottom button)'], ['b', 'B: back (right button)'], ['x', 'X: check for updates (left button)'], ['y', 'Y: load ROM (top button)'],
  ['up', 'D-pad up'], ['down', 'D-pad down'], ['left', 'D-pad left'], ['right', 'D-pad right'],
  ['lb', 'LB / L1 (left shoulder)'], ['rb', 'RB / R1 (right shoulder)'], ['lt', 'LT / L2 (left trigger)'], ['rt', 'RT / R2 (right trigger)'],
  ['view', 'View / Select / Share / Minus'], ['start', 'Menu / Start / Options / Plus']];

function padSnapshot(gp) { return { b: gp.buttons.map((x) => !!(x.pressed || x.value > 0.5)), a: [...gp.axes] }; }

/** While setting up, watch for the next button, axis or hat movement that wasn't held a moment ago. */
function padSetupTick(now) {
  const gp = (navigator.getGamepads() || [])[padSetup.gpIndex];
  if (!gp) return;
  const snap = padSnapshot(gp);
  if (!padSetup.base || now < padSetup.wait) { padSetup.base = snap; return; }
  let found = null;
  const hi = hatAxis(gp);
  snap.b.forEach((on, i) => { if (!found && on && !padSetup.base.b[i]) found = btn(i); });
  if (!found && hi >= 0) {
    const was = hatDirs(padSetup.base.a[hi]); const d = hatDirs(snap.a[hi]);
    for (const dir of ['up', 'down', 'left', 'right']) if (!found && d[dir] && !was[dir]) found = hat(dir);
  }
  if (!found) snap.a.forEach((v, i) => { if (!found && i !== hi && Math.abs(v) > 0.75 && Math.abs(padSetup.base.a[i] || 0) < 0.4) found = { t: 'a', i, s: Math.sign(v) }; });
  if (!found) return;
  padSetup.map[SETUP_STEPS[padSetup.step][0]] = found;
  padSetup.step++;
  padSetup.base = null; padSetup.wait = now + 350;
  if (padSetup.step >= SETUP_STEPS.length) finishPadSetup(gp, true); else renderPadSetup();
}

function startPadSetup(index) {
  Object.assign(padSetup, { active: true, gpIndex: index, step: 0, map: {}, base: null, wait: performance.now() + 400 });
  renderPadSetup();
}
function finishPadSetup(gp, save) {
  if (save && gp) {
    try { localStorage.setItem(`padmap:${gp.id}`, JSON.stringify(padSetup.map)); } catch { /* storage unavailable */ }
    toast('Controller set up', `${padName(gp)} now uses your buttons.`, 'ok');
    api.log && api.log(`Controller set up by hand: ${gp.id} -> ${JSON.stringify(padSetup.map)}`).catch(() => {});
  }
  padSetup.active = false;
  renderPadSetup();
}
function skipPadStep() {
  padSetup.step++; padSetup.base = null;
  const gp = (navigator.getGamepads() || [])[padSetup.gpIndex];
  if (padSetup.step >= SETUP_STEPS.length) finishPadSetup(gp, true); else renderPadSetup();
}
function renderPadSetup() {
  const box = $('#pad-setup');
  if (!box) return;
  if (!padSetup.active) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const [, label] = SETUP_STEPS[padSetup.step];
  box.innerHTML = `<div class="pad-setup-step"><small>Step ${padSetup.step + 1} of ${SETUP_STEPS.length}</small><b>Press: ${esc(label)}</b>
    <div class="inline"><button class="btn-link" data-pad-skip="1">Skip this one</button><button class="btn-link danger" data-pad-cancel="1">Cancel</button></div></div>`;
}

let padViewAt = 0;
function renderPadView(now) {
  const box = $('#pad-live');
  if (!box || now - padViewAt < 100) return;
  padViewAt = now;
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
  if (!pads.length) { box.innerHTML = `<p class="sub">No controller found yet. Connect one and <b>press any button</b>: ${isMac() ? 'macOS' : 'Windows'} only shows a controller to apps after a button press.</p>`; return; }
  const st = readPad() || {};
  box.innerHTML = pads.map((gp) => {
    const { kind } = mapFor(gp);
    const label = { standard: 'Standard layout (works automatically)', brand: 'Brand layout (guessed). Set up buttons if anything is off.', generic: 'Unknown layout (guessed). Set up buttons for best results.', yours: 'Your own button setup' }[kind];
    const pressed = gp.buttons.map((x, i) => (x.pressed || x.value > 0.5 ? i : null)).filter((x) => x !== null);
    return `<div class="pad-card">
      <div class="pad-card-head"><b>${esc(padName(gp))}</b><span class="pad-kind ${kind}">${esc(label)}</span></div>
      <div class="pad-keys">${PAD_KEYS.map((k) => `<span class="pad-key${st[k] ? ' on' : ''}">${k.toUpperCase()}</span>`).join('')}</div>
      <small class="sub">Raw: buttons ${gp.buttons.length}, axes ${gp.axes.length}${pressed.length ? ` · pressed ${pressed.join(', ')}` : ''}</small>
      <div class="inline">${padSetup.active ? '' : `<button class="btn3d small cyan" data-pad-setup="${gp.index}">Set up buttons</button>`}${kind === 'yours' && !padSetup.active ? `<button class="btn-link" data-pad-reset="${gp.index}">Use the automatic layout</button>` : ''}</div>
    </div>`;
  }).join('');
}

// ---------- the info panel with a controller: move between its buttons, press them, scroll it
const PANEL_FOCUSABLE = '#info button:not([disabled]), #info select, #info summary, #info [data-url][role="link"]';
let panelFocusSig = null;
const panelItems = () => [...document.querySelectorAll(PANEL_FOCUSABLE)].filter((el) => el.offsetParent !== null && !el.closest('details:not([open]) > :not(summary)'));
const sigOf = (el) => (el ? [el.tagName, el.dataset.act || '', el.dataset.url || '', el.dataset.copy || '', el.dataset.restore || '', el.textContent.trim().slice(0, 40)].join('|') : null);
function panelFocused() { return document.querySelector('#info .pad-focus'); }
function setPanelFocus(el) {
  document.querySelectorAll('#info .pad-focus').forEach((x) => x.classList.remove('pad-focus'));
  if (!el) { panelFocusSig = null; return; }
  el.classList.add('pad-focus');
  panelFocusSig = sigOf(el);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
/** After the panel redraws (state updates), put the highlight back on the same button. */
function restorePanelFocus() {
  if (!panelFocusSig || !ui.infoOpen) return;
  const el = panelItems().find((x) => sigOf(x) === panelFocusSig);
  if (el) el.classList.add('pad-focus');
}
function movePanelFocus(step) {
  const items = panelItems();
  if (!items.length) return;
  const cur = panelFocused();
  const i = cur ? items.indexOf(cur) : -1;
  // nothing highlighted yet: start on the main button (Play / Install), not the ✕
  const start = Math.max(0, items.findIndex((x) => !x.classList.contains('info-close')));
  const next = items[Math.max(0, Math.min(items.length - 1, i < 0 ? start : i + step))];
  setPanelFocus(next);
}
function panelPress(key) {
  const cur = panelFocused();
  switch (key) {
    case 'up': movePanelFocus(-1); return true;
    case 'down': movePanelFocus(1); return true;
    case 'left': case 'right':
      if (cur && cur.tagName === 'SELECT') {
        const n = cur.options.length;
        cur.selectedIndex = Math.max(0, Math.min(n - 1, cur.selectedIndex + (key === 'right' ? 1 : -1)));
        cur.dispatchEvent(new Event('change', { bubbles: true }));
      } else movePanelFocus(key === 'right' ? 1 : -1);
      return true;
    case 'a':
      if (!cur) { movePanelFocus(0); return true; }
      if (cur.tagName === 'SELECT') { panelPress('right'); return true; }
      cur.click();
      setTimeout(restorePanelFocus, 50);
      return true;
    case 'b': case 'view': setPanelFocus(null); openInfo(false); return true;
    case 'rsUp': case 'rsDown': { const body = $('#info .info-body'); if (body) body.scrollBy({ top: key === 'rsUp' ? -140 : 140, behavior: 'smooth' }); return true; }
    default: return false;
  }
}

function padPress(key) {
  if (!S) return;
  // the welcome note: A or B closes it
  if (!$('#modal').hidden) {
    if ($('#modal .modal.tip')) { // a help pop-up: the D-pad moves between its buttons, A presses one, B closes it
      const btns = [...$('#modal').querySelectorAll('button')];
      const at = btns.indexOf(document.activeElement);
      if (key === 'b' || key === 'start') closeTip();
      else if (key === 'a') (at >= 0 ? btns[at] : btns[btns.length - 1]).click();
      else if (['left', 'up', 'right', 'down'].includes(key) && btns.length) btns[(at + (key === 'left' || key === 'up' ? -1 : 1) + btns.length) % btns.length].focus();
      return;
    }
    if (key === 'a' || key === 'b' || key === 'start') closeWelcome(null);
    return;
  }
  // A presses the button on a pop-up message that's waiting for an answer
  const toastBtn = [...document.querySelectorAll('[data-toast-action]')].pop();
  const g = S.games.find((x) => x.id === ui.selected);
  const cycle = (list, cur, d) => list[(list.indexOf(cur) + d + list.length) % list.length];
  // the info panel is open: the controller works inside it (a pop-up message waiting for an answer still comes first)
  if (ui.infoOpen && ui.view === 'shelf' && !(toastBtn && (key === 'a' || key === 'b')) && panelPress(key)) { updatePadHints(); return; }
  if (key === 'rsUp' || key === 'rsDown') { $('#view').scrollBy({ top: key === 'rsUp' ? -160 : 160, behavior: 'smooth' }); return; }
  // on the Controller settings you're trying buttons out: only B (back) and the triggers (menus) do anything
  if ((ui.view === 'settings' || ui.view === 'customize') && !['b', 'lt', 'rt', 'up', 'down'].includes(key)) return;
  // Help: left / right go through the topics, up / down scroll
  if (ui.view === 'help' && (key === 'left' || key === 'right')) {
    const list = helpMatches();
    const i = list.findIndex((x) => x.id === helpUi.topic);
    if (list.length) { helpUi.topic = list[(i + (key === 'left' ? -1 : 1) + list.length) % list.length].id; renderHelpBody(); $('#view').scrollTop = 0; }
    return;
  }

  switch (key) {
    case 'left': case 'right': if (ui.view === 'shelf') moveSelection(key); break;
    case 'up': if (ui.view === 'shelf') moveSelection('up'); else $('#view').scrollBy({ top: -160, behavior: 'smooth' }); break;
    case 'down': if (ui.view === 'shelf') moveSelection('down'); else $('#view').scrollBy({ top: 160, behavior: 'smooth' }); break;
    case 'a':
    case 'start':
      if (toastBtn) { toastBtn.click(); break; }
      if (ui.view !== 'shelf') { setView('shelf'); break; }
      if (String(ui.selected).startsWith('rom:')) { const b = $('#detail [data-goto]'); if (b) b.click(); break; }
      if (g && !g.job) onAction(g.installed ? 'play' : g.sourceOnly ? 'open-repo' : 'install', g);
      break;
    case 'b':
      if (toastBtn) { toastBtn.closest('.toast').remove(); break; }
      if (ui.infoOpen && ui.view === 'shelf') { openInfo(false); break; }
      if (ui.view !== 'shelf') setView('shelf');
      else if (g && g.job && g.job.cancel) onAction('cancel', g);
      else if (filtersActive()) { $('#search').value = ''; setView('shelf', { filter: 'all', system: null, kind: null, query: '' }); }
      break;
    case 'x':
      if (ui.view === 'shelf' && g && g.updateAvailable && !g.job) onAction('install', g);
      else refreshReleases(document.querySelector('[data-act="refresh"]'));
      break;
    case 'y': if (ui.view === 'shelf' && ui.selected) loadRomForSelected(); else guard(() => api.pickRoms('files')).then(showRomReport); break;
    case 'lb': case 'rb': {
      const step = key === 'lb' ? -1 : 1;
      const ids = (ui.view === 'discover' ? TYPES : SHOW).map((t) => t[0]);
      if (ui.view === 'discover') { disc.kind = cycle(ids, disc.kind || '', step) || null; disc.limit = 60; renderDiscoverList(); }
      else setView('shelf', { kind: cycle(ids, ui.kind || '', step) || null });
      break;
    }
    case 'lt': setView(cycle(TABS, ui.view, -1)); break;
    case 'rt': setView(cycle(TABS, ui.view, 1)); break;
    case 'view': if (ui.view === 'shelf') { openInfo(!ui.infoOpen); if (ui.infoOpen) setTimeout(() => movePanelFocus(0), 60); } else setView('shelf'); break;
    default: break;
  }
  updatePadHints();
}

function padLoop(now) {
  if (padSetup.active) { if (document.hasFocus()) padSetupTick(now); renderPadView(now); requestAnimationFrame(padLoop); return; }
  renderPadView(now);
  const st = readPad();
  if (st && !pad.connected) { pad.connected = true; updatePadHints(); }
  // Only listen while the launcher is the focused window, so button presses inside a game never reach it.
  if (st && document.hasFocus()) {
    for (const [k, down] of Object.entries(st)) {
      const dir = ['left', 'right', 'up', 'down', 'rsUp', 'rsDown'].includes(k);
      if (down && !pad.held[k]) { padPress(k); pad.next[k] = now + 380; }
      else if (down && dir && now >= pad.next[k]) { padPress(k); pad.next[k] = now + 110; } // hold to scroll
      pad.held[k] = down;
    }
  } else pad.held = {};
  requestAnimationFrame(padLoop);
}
requestAnimationFrame(padLoop);

function updatePadHints() {
  let el = $('#pad-hints');
  if (!pad.connected) { if (el) el.remove(); document.body.classList.remove('has-pad'); return; }
  document.body.classList.add('has-pad');
  if (!el) { el = document.createElement('div'); el.id = 'pad-hints'; el.className = 'pad-hints'; document.body.appendChild(el); }
  const g = S && S.games.find((x) => x.id === ui.selected);
  let a = 'Select';
  if (ui.view === 'shelf' && g) a = g.job ? '…' : g.installed ? (g.running ? 'Playing' : 'Play') : g.sourceOnly ? 'Source' : 'Install';
  const hints = ui.view === 'shelf' && ui.infoOpen
    ? [['a', 'Press'], ['b', 'Close panel'], ['view', 'Close'], ['lb', 'LB RB Show']]
    : ui.view === 'shelf'
    ? [['a', a], ['b', ui.infoOpen ? 'Close' : g && g.job && g.job.cancel ? 'Cancel' : 'Back'], ['view', ui.infoOpen ? 'Hide info' : 'Info'], ['x', g && g.updateAvailable ? 'Update' : 'Check updates'], ['y', 'Load ROM'], ['lb', 'LB RB Show'], ['rt', 'LT RT Menu']]
    : [['a', 'Games'], ['b', 'Back'], ['rt', 'LT RT Menu']];
  el.innerHTML = hints.map(([k, t]) => k === 'view' ? `<span class="hint"><i class="pb sh">⧉</i>${esc(t)}</span>` : k === 'lb' || k === 'rt' ? `<span class="hint"><i class="pb sh">${k === 'lb' ? 'LB·RB' : 'LT·RT'}</i>${esc(t.replace(/^(LB RB|LT RT) /, ''))}</span>` : `<span class="hint"><i class="pb ${k}">${k.toUpperCase()}</i>${esc(t)}</span>`).join('');
}

window.addEventListener('gamepadconnected', (e) => {
  const gp = e.gamepad;
  const { kind } = mapFor(gp);
  toast('Controller connected', kind === 'generic' ? `${padName(gp)} is connected. If the buttons don't do the right thing, set it up in Settings → Controller.` : `${padName(gp)} is ready. Ⓐ plays, Ⓑ goes back, ⧉ opens the info panel.`, 'ok');
  api.log && api.log(`Controller connected: "${gp.id}" mapping=${gp.mapping || 'none'} buttons=${gp.buttons.length} axes=${gp.axes.length} layout=${kind}`).catch(() => {});
  pad.connected = true; updatePadHints();
});
window.addEventListener('gamepaddisconnected', () => {
  pad.connected = navigator.getGamepads && [...navigator.getGamepads()].some((p) => p && p.connected);
  if (!pad.connected) toast('Controller disconnected');
  updatePadHints();
});

// ---------------------------------------------------------------- drag & drop
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#dropzone').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
  const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length === 1 && /\.(png|jpe?g|webp|gif)$/i.test(paths[0])) {
    const g = ui.view === 'shelf' ? S.games.find((x) => x.id === ui.selected) : null;
    if (!g) return toast('Drop the picture on a game', 'Select a game on the Games screen first, then drop a picture to make it the cover.', 'warn');
    if (await guard(() => api.setCoverFile('game', g.id, paths[0]))) toast('New cover', `${g.port} now uses your picture.`, 'ok');
    return;
  }
  const before = new Set(S.roms.map((r) => r.id));
  const target = ui.view === 'shelf' ? S.games.find((x) => x.id === ui.selected) : null;
  await addRomPaths(paths);
  // A ROM dropped while a game is selected that didn't auto-match gets assigned to that game.
  if (target && !target.romMatch) {
    const fresh = S.roms.filter((r) => !before.has(r.id) && r.system === target.system);
    const now = S.games.find((x) => x.id === target.id);
    if (now && !now.romMatch && fresh.length) await guard(() => api.assignRom(target.id, fresh[0].id));
  }
});

// ---------------------------------------------------------------- live updates
function fileUrl(p) { return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F'); }
function applyBackground() {
  if (!S) return;
  const themeSig = JSON.stringify(S.settings.theme || null);
  if (themeSig !== applyBackground.themeSig) { applyBackground.themeSig = themeSig; window.applyTheme(S.settings.theme); }
  const img = S.settings.backgroundImage;
  document.body.classList.toggle('custom-bg', !!img);
  const sky = document.querySelector('.sky');
  sky.style.setProperty('--bg-url', img ? `url("${fileUrl(img)}")` : 'none');
  sky.style.setProperty('--bg-dim', String((S.settings.backgroundDim ?? 55) / 100));
  document.body.style.setProperty('--clear', String((S.settings.backgroundClear ?? 45) / 100));
  sky.style.setProperty('--fade-bg', fadeCss(S.settings.backgroundFade));
}

api.onState((s) => { S = s; render(); notifyUpdates(); });
// the Windows / Mac check fills in as it goes: reload the (cached) list now and then
api.onPlatformProgress && api.onPlatformProgress(async (p) => {
  platformProgress = p;
  try { communityData = await api.communityList(); } catch { /* keep what's there */ }
  if (ui.view === 'discover') renderDiscoverList();
});
api.onCoverProgress && api.onCoverProgress(({ done, total }) => { const el = $('#cover-progress'); if (el) el.textContent = done < total ? `Checking ${done} of ${total}…` : ''; });
api.onScanReport((r) => showRomReport(r, true));
api.onNotice && api.onNotice((n) => { toast(n.title, n.body, n.kind || ''); if (ui.view === 'settings') loadRomCopies(); });
api.onBackup((id, b) => {
  backupsCache.delete(id);
  const g = S && S.games.find((x) => x.id === id);
  if (g && b.reason === 'before update') toast(`${g.port} saves backed up before updating`, '', 'ok');
  if (ui.infoOpen && ui.selected === id) loadBackups(id, true);
});
api.onJob((id, job) => {
  if (!S) return;
  const g = S.games.find((x) => x.id === id);
  if (!g) return;
  const hadJob = !!g.job;
  g.job = job;
  if (!job || !hadJob) return render();
  // cheap in-place progress updates while downloading
  const pct = job.progress != null ? Math.round(job.progress * 100) : null;
  document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"] .burst span, .hero .box3d .burst span`).forEach((s) => {
    if (s.closest('.hero') && ui.selected !== id) return;
    s.textContent = pct != null ? `${pct}%` : 'WAIT';
  });
  const bar = document.querySelector(`.card[data-id="${CSS.escape(id)}"] .card-bar span`);
  if (bar) bar.style.width = `${pct ?? 100}%`;
  const progs = document.querySelectorAll(`.progress[data-job="${CSS.escape(id)}"]`);
  for (const prog of progs) {
    prog.querySelector('.progress-top span').textContent = job.phase;
    prog.querySelector('.progress-top span:last-child').textContent = job.total ? `${fmtBytes(job.got)} / ${fmtBytes(job.total)}` : pct != null ? `${pct}%` : '';
    prog.querySelector('.bar').classList.toggle('indet', pct == null);
    prog.querySelector('.bar span').style.width = `${pct ?? 0}%`;
  }
  if (!progs.length && ui.selected === id) renderDetail();
});

api.state().then((s) => {
  S = s;
  // Mac: most ports are Windows-only, so start on the games that work here (the Status dropdown or Reset shows everything)
  if (S.platform === 'darwin' && ui.filter === 'all') ui.filter = 'available';
  render();
  // the Find more tab says how many ports are new since your last visit (the list is cached for a day)
  setTimeout(() => { if (!communityData) loadCommunity(); }, 8000);
});

// remember whether the reader opened or closed a game's dumping guide, so a refresh doesn't flip it back
document.addEventListener('toggle', (e) => { const d = e.target; if (d.matches && d.matches('details[data-guide]')) guideOpen[d.dataset.guide] = d.open; }, true);
