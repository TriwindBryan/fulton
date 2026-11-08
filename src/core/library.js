// The launcher's brain: catalog, ROM library, installs and launching.
// Electron-specific bits (clipboard, shell) are injected so this stays testable.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const rom = require('./rom');
const romdb = require('./romdb');
const gh = require('./github');
const inst = require('./install');
const community = require('./community');
const metacritic = require('./metacritic');
const backup = require('./backup');
const covers = require('./covers');
const arcade = require('./arcade');
const crypto = require('crypto');
const update = require('./update');
const disk = require('./disk');
const shots = require('./shots');
const platforms = require('./platforms');

const DAT_BASE = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/';
const RELEASE_TTL = 6 * 60 * 60 * 1000;

/** ~/Fulton for new installs; someone who already has the old ~/Cartridge folder keeps using it (their games are in there). */
function defaultLibraryDir() {
  const home = os.homedir();
  const next = path.join(home, 'Fulton'); const old = path.join(home, 'Cartridge');
  try { if (!fs.existsSync(next) && fs.existsSync(old)) return old; } catch { /* fall through */ }
  return next;
}

class Library extends EventEmitter {
  constructor({ dataDir, catalogFile, platform = process.platform, hooks = {}, startEmpty = false }) {
    super();
    this.startEmpty = startEmpty; // true in the app: a new install starts with an empty shelf
    this.dataDir = dataDir;
    this.catalogFile = catalogFile;
    this.platform = platform;
    this.hooks = hooks; // { copyToClipboard(text), revealFile(path), openExternal(url) }
    try {
      const pkg = require('../../package.json');
      this.version = pkg.version.replace(/\.0$/, '');
      this.links = { ...(pkg.cartridge || {}) };
    } catch { this.version = ''; this.links = {}; }
    this.statePath = path.join(dataDir, 'state.json');
    this.state = {
      settings: { libraryDir: defaultLibraryDir(), screenshotKey: 'F8', screenshotSound: true, screenshots: true, libraryDirs: [], romCopyDir: '', askInstallDrive: true, githubToken: '', extraCatalogUrl: '', romFolders: [], showMetacritic: false, welcomeSeen: false, checkUpdates: true, backgroundImage: '', backgroundDim: 55, backgroundClear: 45, heroBackdrop: 'wash', backupDir: '', autoBackup: true, steamGridKey: '' },
      installed: {}, roms: [], romOverride: {}, releases: {}, userGames: [], scanIndex: {}, steam: {}, covers: {},
    };
    this.dats = {};
    this.running = new Map();
    this.jobs = new Map();
    this.coverJobs = new Map();
    this.thumbIdx = {};
    this.slots = 0;
    this.queue = [];
  }

  // ---------- persistence ----------
  async load() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    let hadState = false;
    try {
      const saved = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      hadState = true;
      this.state = { ...this.state, ...saved, settings: { ...this.state.settings, ...(saved.settings || {}) } };
      // which download fits depends on Fulton's version and the computer, so re-check them when either changes
      const releasesFor = `${this.version}|${this.platform}|${process.arch}`;
      if (this.state.releasesFor !== releasesFor) { this.state.releases = {}; this.state.releasesFor = releasesFor; }
    } catch { /* first run */ }
    if (hadState) {
      const moved = await this.healLibraryName().catch(() => 0);
      const found = await this.healInstalls().catch(() => 0);
      if (moved || found) await this.save();
    }
    const base = JSON.parse(await fsp.readFile(this.catalogFile, 'utf8'));
    this.systems = base.systems;
    this.baseGames = base.games;
    if (!this.arcadeDb) {
      try { this.arcadeDb = arcade.load(path.join(path.dirname(this.catalogFile), 'arcade.json')); } catch { this.arcadeDb = null; }
    }
    this.remoteGames = [];
    if (this.state.settings.extraCatalogUrl) {
      try { this.remoteGames = (await (await fetch(this.state.settings.extraCatalogUrl)).json()).games || []; } catch { /* offline */ }
    }
    // The shelf: only games you added (or installed) show under Games. Someone who already had Fulton keeps their whole shelf.
    if (!this.state.shelf) {
      this.state.shelf = {};
      if (hadState || !this.startEmpty) for (const g of [...this.baseGames, ...this.remoteGames]) this.state.shelf[g.id] = true;
      if (hadState) await this.save();
    }
    // Remember when each game first appeared, for "Recently added". Games present on the very first run count as the starting collection (0).
    const seen = this.state.firstSeen || (this.state.firstSeen = {});
    let changed = false;
    for (const g of this.games) if (!(g.id in seen)) { seen[g.id] = hadState ? Date.now() : 0; changed = true; }
    if (changed && hadState) await this.save();
    return this;
  }

  /** Saves are queued so overlapping callers (e.g. a game exiting mid-install) never collide. */
  save() {
    const run = async () => {
      const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.state, null, 2));
      await fsp.rename(tmp, this.statePath);
    };
    this.saving = (this.saving || Promise.resolve()).then(run, run);
    return this.saving;
  }

  get dirs() {
    const root = this.state.settings.libraryDir;
    return { root, games: path.join(root, 'Games'), roms: this.state.settings.romCopyDir || path.join(root, 'ROMs'), downloads: path.join(root, 'Downloads'), backups: this.state.settings.backupDir || path.join(root, 'Backups') };
  }

  // ---------- renamed or moved library folder ----------
  /**
   * Fulton remembers every game by its full path. When the player renames or moves the library folder
   * (Cartridge -> Fulton), every saved path that starts with the old folder is pointed at the new one.
   * Returns how many paths were changed.
   */
  relocatePaths(oldRoot, newRoot) {
    const ci = this.platform !== 'linux';
    const key = (p) => (ci ? p.toLowerCase() : p);
    const o = key(path.resolve(oldRoot));
    let count = 0;
    const fix = (v) => {
      if (typeof v !== 'string' || v.length < o.length) return v;
      const k = key(v);
      if (k === o) { count++; return newRoot; }
      if (k.startsWith(o) && (v[o.length] === '/' || v[o.length] === '\\')) { count++; return newRoot + v.slice(o.length); }
      return v;
    };
    const walk = (node) => {
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { if (typeof node[i] === 'string') node[i] = fix(node[i]); else if (node[i] && typeof node[i] === 'object') walk(node[i]); } return; }
      for (const k of Object.keys(node)) { const v = node[k]; if (typeof v === 'string') node[k] = fix(v); else if (v && typeof v === 'object') walk(v); }
    };
    walk(this.state);
    return count;
  }

  /** The player picked where the library folder is now. */
  async relocateLibrary(newRoot) {
    const old = this.state.settings.libraryDir;
    if (!newRoot || path.resolve(newRoot).toLowerCase() === path.resolve(old).toLowerCase()) return 0;
    const n = this.relocatePaths(old, newRoot);
    this.state.settings.libraryDir = newRoot;
    await this.healInstalls();
    await this.save();
    const found = await this.scanLibraryForGames().catch(() => 0);
    this.emitChange();
    return n + found;
  }

  /** A game whose folder is gone but which sits in Games/<id> of a listed location gets found again. */
  async healInstalls() {
    let fixed = 0;
    for (const [id, i] of Object.entries(this.state.installed || {})) {
      if (!i || !i.dir || fs.existsSync(i.dir)) continue;
      for (const loc of this.locations) {
        const cand = path.join(loc, 'Games', id);
        if (!fs.existsSync(cand)) continue;
        const rel = i.exe && i.exe.toLowerCase().startsWith(i.dir.toLowerCase()) ? i.exe.slice(i.dir.length).replace(/^[\\/]+/, '') : null;
        let exe = rel ? path.join(cand, rel) : null;
        if (!exe || !fs.existsSync(exe)) exe = await inst.findExecutable(cand, (this.games.find((g) => g.id === id) || {}).exe, this.platform).catch(() => null);
        if (!exe) continue;
        i.dir = cand; i.exe = exe; fixed++;
        break;
      }
    }
    return fixed;
  }

  /**
   * "Look for my games": every folder in Games/ of a listed location that belongs to a known game and isn't (or is no longer)
   * recorded as installed gets recorded again, so games come back after a rename, a restore or a lost settings file.
   */
  async scanLibraryForGames() {
    let found = 0;
    for (const loc of this.locations) {
      let names = [];
      try { names = await fsp.readdir(path.join(loc, 'Games')); } catch { continue; }
      for (const id of names) {
        const g = this.games.find((x) => x.id === id);
        if (!g) continue;
        const dir = path.join(loc, 'Games', id);
        const prev = this.state.installed[id];
        if (prev && fs.existsSync(prev.dir) && fs.existsSync(prev.exe)) continue;
        let st; try { st = await fsp.stat(dir); if (!st.isDirectory()) continue; } catch { continue; }
        const exe = await inst.findExecutable(dir, g.exe, this.platform).catch(() => null);
        if (!exe) continue;
        this.state.installed[id] = {
          ...(prev || {}), tag: (prev && prev.tag) || 'unknown', dir, exe, installedAt: (prev && prev.installedAt) || st.mtimeMs,
          asset: (prev && prev.asset) || '', launchedOnce: prev ? prev.launchedOnce : true, playTime: (prev && prev.playTime) || 0, lastPlayed: (prev && prev.lastPlayed) || null,
        };
        (this.state.shelf || (this.state.shelf = {}))[id] = true;
        found++;
      }
    }
    if (found) { await this.save(); this.emitChange(); }
    return found;
  }

  /** On start: the old "Cartridge" library folder was renamed to "Fulton" next to it. */
  async healLibraryName() {
    const old = this.state.settings.libraryDir;
    if (!old || fs.existsSync(old) || !/^cartridge$/i.test(path.basename(old))) return 0;
    const next = path.join(path.dirname(old), 'Fulton');
    if (!fs.existsSync(next)) return 0;
    const n = this.relocatePaths(old, next);
    this.state.settings.libraryDir = next;
    return n;
  }

  // ---------- screenshots ----------
  /** Where a game's screenshots are kept: on the same drive as the game. */
  screenshotDir(gameId) {
    const i = this.state.installed[gameId];
    const root = i && i.dir ? this.rootOf(i.dir) : this.state.settings.libraryDir;
    return path.join(root, 'Screenshots', gameId.replace(/[^\w.-]+/g, '_'));
  }

  /** A small copy for the gallery (the full picture can be 4K). Sits in a hidden .thumbs folder next to the screenshots. */
  thumbPath(file) { return path.join(path.dirname(file), '.thumbs', path.basename(file).replace(/\.png$/i, '.jpg')); }

  async saveScreenshot(gameId, png, thumb) {
    let g = null; try { g = this.game(gameId); } catch { /* a game that was removed from the shelf */ }
    const dir = this.screenshotDir(gameId);
    await fsp.mkdir(dir, { recursive: true });
    const title = g ? g.port || g.title : gameId;
    let file = path.join(dir, shots.fileName(title));
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, shots.fileName(title).replace(/\.png$/, ` (${n}).png`));
    await fsp.writeFile(file, png);
    if (thumb) { try { await fsp.mkdir(path.dirname(this.thumbPath(file)), { recursive: true }); await fsp.writeFile(this.thumbPath(file), thumb); } catch { /* the gallery falls back to the picture itself */ } }
    return file;
  }

  /** Newest first. */
  async listScreenshots(gameId) {
    const dir = this.screenshotDir(gameId);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!/\.png$/i.test(n)) continue;
      try { const st = await fsp.stat(path.join(dir, n)); out.push({ file: path.join(dir, n), thumb: fs.existsSync(this.thumbPath(path.join(dir, n))) ? this.thumbPath(path.join(dir, n)) : path.join(dir, n), name: n, time: st.mtimeMs, size: st.size }); } catch { /* gone */ }
    }
    return out.sort((a, b) => b.time - a.time);
  }

  /** True only for a .png inside a Screenshots folder of one of the library locations. */
  isScreenshotPath(file) {
    const f = path.resolve(String(file || '')).toLowerCase();
    return /\.png$/.test(f) && this.locations.some((l) => f.startsWith(path.resolve(l, 'Screenshots').toLowerCase() + path.sep));
  }

  /** Every screenshot on every drive, newest first, with the game each belongs to. */
  async listAllScreenshots() {
    const out = [];
    for (const root of this.locations) {
      let games = [];
      try { games = await fsp.readdir(path.join(root, 'Screenshots')); } catch { continue; }
      for (const gid of games) {
        let names = [];
        try { names = await fsp.readdir(path.join(root, 'Screenshots', gid)); } catch { continue; }
        let title = gid;
        const known = this.games.find((x) => x.id.replace(/[^\w.-]+/g, '_') === gid);
        if (known) title = known.port || known.title;
        for (const n of names) {
          if (!/\.png$/i.test(n)) continue;
          try { const st = await fsp.stat(path.join(root, 'Screenshots', gid, n)); out.push({ file: path.join(root, 'Screenshots', gid, n), thumb: fs.existsSync(this.thumbPath(path.join(root, 'Screenshots', gid, n))) ? this.thumbPath(path.join(root, 'Screenshots', gid, n)) : path.join(root, 'Screenshots', gid, n), name: n, gameId: known ? known.id : gid, game: title, time: st.mtimeMs, size: st.size }); } catch { /* gone */ }
        }
      }
    }
    return out.sort((a, b) => b.time - a.time);
  }

  /** Only ever deletes a .png inside that game's own Screenshots folder. */
  async deleteScreenshot(gameId, file) {
    const dirs = [this.screenshotDir(gameId), ...this.locations.map((l) => path.join(l, 'Screenshots', gameId.replace(/[^\w.-]+/g, '_')))].map((d) => path.resolve(d).toLowerCase() + path.sep);
    const f = path.resolve(file);
    if (!dirs.some((d) => f.toLowerCase().startsWith(d)) || !/\.png$/i.test(f)) throw new Error("That isn't one of this game's screenshots.");
    await fsp.rm(f, { force: true });
    await fsp.rm(this.thumbPath(f), { force: true }).catch(() => {});
    return true;
  }

  // ---------- drives (install locations) ----------
  /** Every place games can be installed: the default library folder first, then any drives or folders added. */
  get locations() {
    const st = this.state.settings;
    const out = [];
    const seen = new Set();
    for (const d of [st.libraryDir, ...(st.libraryDirs || [])]) {
      if (!d) continue;
      const key = path.resolve(d).toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(d); }
    }
    return out;
  }

  /** The location an installed game's folder belongs to (the default when it's somewhere else, like a game the player linked). */
  rootOf(dir) {
    const here = path.resolve(dir).toLowerCase() + path.sep;
    for (const l of this.locations) if (here.startsWith(path.resolve(l).toLowerCase() + path.sep)) return l;
    return this.state.settings.libraryDir;
  }

  /** Where a game goes: an update stays in its own folder; a new install goes in the chosen location (the default when none is chosen or it isn't on the list). */
  installTarget(gameId, root) {
    const prev = this.state.installed[gameId];
    const base = prev && prev.dir ? this.rootOf(prev.dir) : (root && this.locations.some((l) => path.resolve(l).toLowerCase() === path.resolve(root).toLowerCase()) ? root : this.state.settings.libraryDir);
    return { root: base, target: prev && prev.dir ? prev.dir : path.join(base, 'Games', gameId), downloads: path.join(base, 'Downloads') };
  }

  /** The drives list for Settings and the "where should it go?" picker: free space, how many games are on each, whether it's connected. */
  async drives() {
    const out = [];
    for (const dir of this.locations) {
      const sp = await disk.space(dir);
      const here = path.resolve(dir).toLowerCase() + path.sep;
      const games = Object.values(this.state.installed || {}).filter((i) => i && i.dir && (path.resolve(i.dir).toLowerCase() + path.sep).startsWith(here)).length;
      out.push({ dir, isDefault: path.resolve(dir).toLowerCase() === path.resolve(this.state.settings.libraryDir).toLowerCase(), connected: fs.existsSync(dir) || fs.existsSync(path.parse(path.resolve(dir)).root) && sp.free != null, free: sp.free, total: sp.total, games });
    }
    return out;
  }

  async addLibraryDir(dir) {
    if (!dir) return this.locations;
    if (!this.locations.some((l) => path.resolve(l).toLowerCase() === path.resolve(dir).toLowerCase())) {
      await this.updateSettings({ libraryDirs: [...(this.state.settings.libraryDirs || []), dir] });
    }
    return this.locations;
  }

  /** Stop listing a location. Games already installed there stay where they are and keep working. The default can't be removed. */
  async removeLibraryDir(dir) {
    const key = path.resolve(dir).toLowerCase();
    if (key === path.resolve(this.state.settings.libraryDir).toLowerCase()) throw new Error("This is your default location. Make another one the default first, then remove this one.");
    await this.updateSettings({ libraryDirs: (this.state.settings.libraryDirs || []).filter((l) => path.resolve(l).toLowerCase() !== key) });
    return this.locations;
  }

  /** Make a location the default for new installs (the old default stays on the list). */
  async setDefaultLibraryDir(dir) {
    const st = this.state.settings;
    const key = path.resolve(dir).toLowerCase();
    if (key === path.resolve(st.libraryDir).toLowerCase()) return this.locations;
    const rest = [st.libraryDir, ...(st.libraryDirs || [])].filter((l) => path.resolve(l).toLowerCase() !== key);
    await this.updateSettings({ libraryDir: dir, libraryDirs: rest });
    return this.locations;
  }

  get games() {
    const byId = new Map();
    for (const g of [...this.baseGames, ...this.remoteGames, ...this.state.userGames]) byId.set(g.id, g);
    return [...byId.values()];
  }

  /** Is this game on your shelf (added by you, or installed)? */
  onShelf(g) {
    const id = typeof g === 'string' ? g : g.id;
    const game = typeof g === 'string' ? this.games.find((x) => x.id === id) : g;
    return !!(this.state.shelf || {})[id] || !!this.state.installed[id] || !!(game && this.state.userGames.some((u) => u.id === id));
  }

  /** Put a built-in port on the shelf. */
  async addToShelf(id) {
    const g = this.game(id);
    (this.state.shelf || (this.state.shelf = {}))[id] = true;
    (this.state.firstSeen || (this.state.firstSeen = {}))[id] = Date.now();
    await this.save();
    this.emitChange();
    this.refreshReleases({ ids: [id] }).catch(() => {});
    return g;
  }

  /** Take a game off the shelf. Installed games must be uninstalled first, so nothing is left behind. */
  async removeFromShelf(id) {
    if (this.state.installed[id]) throw new Error('Uninstall the game first, then remove it from your shelf.');
    if (this.running.has(id)) throw new Error('Close the game first.');
    if (this.state.shelf) delete this.state.shelf[id];
    this.state.userGames = this.state.userGames.filter((x) => x.id !== id);
    if (this.state.favorites) delete this.state.favorites[id];
    await this.save();
    this.emitChange();
  }

  game(id) {
    const g = this.games.find((x) => x.id === id);
    if (!g) throw new Error(`Unknown game ${id}`);
    return g;
  }

  // ---------- view model for the UI ----------
  snapshot() {
    const coverOf = (key) => { const c = (this.state.covers || {})[key]; return c && c.file ? c.file : null; };
    const roms = this.state.roms.map((r) => ({ ...r, cover: coverOf(`rom:${r.id}`), customCover: ((this.state.covers || {})[`rom:${r.id}`] || {}).source === 'custom' }));
    // scores saved by an older, buggier page reader are ignored (and looked up again)
    const metaFresh = (id) => { const c = (this.state.metaCache || {})[id]; return !!c && c.v === metacritic.VERSION; };
    const metaOf = (id) => (metaFresh(id) ? this.state.metaCache[id].data || null : null);
    // Match each game only against ROMs for its own console (13,000 ROMs × every game was slow)
    const bySystem = new Map();
    const arcadeRoms = [];
    for (const r of roms) {
      if (r.missing) continue; // its file is gone: it can't unlock anything
      if (!bySystem.has(r.system)) bySystem.set(r.system, []);
      bySystem.get(r.system).push(r);
      if (r.arcade) arcadeRoms.push(r);
    }
    const candidates = (g) => {
      if (this.state.romOverride[g.id]) return roms; // a ROM you picked by hand can be from anywhere
      const list = [...(bySystem.get(g.system) || [])];
      if (g.system === 'gc' || g.system === 'wii') list.push(...(bySystem.get(g.system === 'gc' ? 'wii' : 'gc') || []));
      if (g.system === 'arcade') list.push(...arcadeRoms.filter((r) => r.system !== 'arcade'));
      return list;
    };
    const games = this.games.filter((g) => this.onShelf(g)).map((g) => {
      const installed = this.state.installed[g.id] || null;
      const rel = this.state.releases[g.id];
      const match = romdb.bestRomForGame(g, candidates(g), this.state.romOverride[g.id]);
      const latest = rel && rel.data ? rel.data : null;
      return {
        ...g,
        installed,
        favorite: !!(this.state.favorites || {})[g.id],
        inSteam: !!(this.state.steam || {})[g.id],
        cover: coverOf(`game:${g.id}`),
        customCover: ((this.state.covers || {})[`game:${g.id}`] || {}).source === 'custom',
        metacritic: g.metacritic || metaOf(g.id),
        metaChecked: !!g.metacritic || metaFresh(g.id),
        addedAt: Math.max((this.state.firstSeen || {})[g.id] || 0, installed ? installed.installedAt || 0 : 0),
        running: this.running.has(g.id),
        job: Library.publicJob(this.jobs.get(g.id)),
        release: latest,
        releaseError: rel && rel.error ? rel.error : null,
        updateAvailable: !!(installed && !installed.manual && latest && latest.tag && latest.tag !== installed.tag),
        romMatch: match ? { romId: match.rom.id, level: match.level, reason: match.reason, label: match.rom.datName || match.rom.originalName, file: match.rom.file } : null,
      };
    });
    return { systems: this.systems, games, roms, scanning: !!this.scanning, settings: { ...this.state.settings, githubToken: this.state.settings.githubToken ? '••••' : '', steamGridKey: this.state.settings.steamGridKey ? '••••' : '' }, dirs: this.dirs, locations: this.locations, platform: this.platform, version: this.version || '', label: (this.links || {}).label || '', links: this.links || {}, appUpdate: (this.state.appUpdate || {}).data || null, changelog: path.join(path.dirname(path.dirname(this.catalogFile)), 'CHANGELOG.md') };
  }

  emitChange() { this.emit('change'); }

  static publicJob(j) {
    return j ? { phase: j.phase, progress: j.progress, got: j.got || 0, total: j.total || 0, cancel: !!j.cancel } : null;
  }

  // ---------- settings ----------
  async updateSettings(patch) {
    const next = { ...patch };
    if (next.githubToken === '••••') delete next.githubToken;
    if (next.steamGridKey === '••••') delete next.steamGridKey;
    if ('steamGridKey' in next) {
      // a new key may find covers that were missing before
      for (const [k, c] of Object.entries(this.state.covers || {})) if (c.none) delete this.state.covers[k];
    }
    this.state.settings = { ...this.state.settings, ...next };
    if ('libraryDir' in next || 'libraryDirs' in next) await this.healInstalls().catch(() => 0);
    await this.save();
    if ('extraCatalogUrl' in patch) await this.load();
    this.emitChange();
  }

  // ---------- releases ----------
  async refreshReleases({ force = false, ids } = {}) {
    const token = this.state.settings.githubToken;
    const todo = this.games.filter((g) => this.onShelf(g) && !g.sourceOnly && g.repo && (!ids || ids.includes(g.id)));
    let changed = false;
    await Promise.all(todo.map(async (g) => {
      const cached = this.state.releases[g.id];
      if (!force && cached && Date.now() - cached.fetchedAt < RELEASE_TTL) return;
      try {
        const rel = await gh.latestRelease(g.repo, token);
        this.state.releases[g.id] = { fetchedAt: Date.now(), data: gh.summariseRelease(rel, g, this.platform) };
      } catch (e) {
        // Keep stale data on rate-limit so the UI still works offline.
        if (cached && cached.data && (e.code === 'RATE_LIMIT' || e.code === 'OFFLINE')) return;
        this.state.releases[g.id] = { fetchedAt: Date.now(), error: e.message, data: cached && cached.data };
      }
      changed = true;
    }));
    if (changed) { await this.save(); this.emitChange(); }
  }

  // ---------- ROM library ----------
  async loadDat(system) {
    const sys = this.systems[system];
    if (!sys || !sys.romDb) return null;
    if (this.dats[system]) return this.dats[system];
    const cache = path.join(this.dataDir, 'romdb', path.basename(sys.romDb));
    let text = null;
    try {
      const st = await fsp.stat(cache);
      if (Date.now() - st.mtimeMs < 30 * 24 * 3600 * 1000) text = await fsp.readFile(cache, 'utf8');
    } catch { /* not cached */ }
    if (!text) {
      try {
        const res = await fetch(DAT_BASE + sys.romDb.split('/').map(encodeURIComponent).join('/'));
        if (res.ok) {
          text = await res.text();
          await fsp.mkdir(path.dirname(cache), { recursive: true });
          await fsp.writeFile(cache, text);
        }
      } catch { /* offline: fall back to cache or header-only */ }
      if (!text) { try { text = await fsp.readFile(cache, 'utf8'); } catch { return null; } }
    }
    this.dats[system] = romdb.parseDat(text);
    return this.dats[system];
  }

  /**
   * Walk files, folders (any depth) and zip/7z archives looking for ROMs.
   * With skipKnown, files already checked in an earlier scan (same size and date) are skipped,
   * so rescanning a big ROM folder at startup is quick.
   */
  async collectRomFiles(paths, tmpDirs, { skipKnown = false, onArchive = null } = {}) {
    const out = [];
    const index = this.state.scanIndex || (this.state.scanIndex = {});
    const ownDirs = [this.dirs.roms, ...this.locations.flatMap((l) => [path.join(l, 'ROMs'), path.join(l, 'Games'), path.join(l, 'Downloads')])].map((d) => path.resolve(d).toLowerCase());
    const SKIP_DIRS = /^(\$recycle\.bin|system volume information|windows|program files( \(x86\))?|programdata|appdata|node_modules|\.git)$/i;
    // On a Mac, walking into these makes macOS ask "Fulton would like to access your Photos / Music / iCloud Drive / other apps' data",
    // and none of them can hold a game, so a scan never goes in unless the person picked that exact folder.
    const MAC_SKIP = /^(library|music|pictures|movies|applications|\.trash|\.spotlight-v100|\.fseventsd|\.documentrevisions-v100|mobile documents|cloudstorage|icloud drive( \(archive\))?)$|\.(photoslibrary|musiclibrary|tvlibrary|app|bundle|framework|photolibrary|imovielibrary|fcpbundle|logicx)$/i;
    const skipByName = (name) => SKIP_DIRS.test(name) || (this.platform === 'darwin' && MAC_SKIP.test(name));
    const stamp = (st) => `${st.size}:${Math.round(st.mtimeMs)}`;
    // a .cue already covers its .bin tracks, so don't list those separately
    const dropTracks = (list) => {
      const tracks = new Set(list.filter((f) => /\.cue$/i.test(f.file)).flatMap((f) => rom.cueTracks(f.file)).map((t) => path.resolve(t).toLowerCase()));
      return tracks.size ? list.filter((f) => !tracks.has(path.resolve(f.file).toLowerCase())) : list;
    };
    const visit = async (p, depth, archive, into = out) => {
      let st;
      try { st = await fsp.stat(p); } catch { return; }
      if (st.isDirectory()) {
        if (depth > 12) return;
        if (!archive && (ownDirs.includes(path.resolve(p).toLowerCase()) || (depth > 0 && skipByName(path.basename(p))))) return;
        let entries = [];
        try { entries = await fsp.readdir(p); } catch { return; }
        // an extracted PS3 / Vita / Wii U / Xbox game is one game, not hundreds of loose files
        const marker = !archive && rom.dumpMarker(p, entries);
        if (marker) {
          let mst; try { mst = await fsp.stat(marker); } catch { return; }
          if (skipKnown && index[marker] === stamp(mst)) return;
          out.push({ file: marker, shown: path.basename(p), indexKey: marker, stamp: stamp(mst), fromArchive: false });
          return;
        }
        for (const e of entries) await visit(path.join(p, e), depth + 1, archive, into);
        return;
      }
      const arc = !archive ? arcade.classify(this.arcadeDb, p) : null;
      if (arc) {
        // an arcade set (sf2.zip): the zip itself is the game, and emulators find it by this exact name, so it stays put
        if (skipKnown && index[p] === stamp(st)) return;
        if (arc === 'bios') { index[p] = stamp(st); return; } // neogeo.zip and friends: needed by games, not games themselves
        out.push({ file: p, shown: path.basename(p), indexKey: p, stamp: stamp(st), fromArchive: false, arcade: true });
        return;
      }
      if (rom.systemForExtension(p) && !/^(param\.sfo|param\.json|meta\.xml|microsoftgame\.config|appxmanifest\.xml)$/i.test(path.basename(p)) && !/\.tmd$/i.test(p)) {
        if (!archive && skipKnown && index[p] === stamp(st)) return;
        into.push({ file: p, shown: archive ? `${path.basename(archive.file)} › ${path.basename(p)}` : path.basename(p), indexKey: archive ? archive.file : p, stamp: archive ? archive.stamp : stamp(st), fromArchive: !!archive,
          ...(archive ? { archiveFile: archive.file, member: path.relative(archive.root, p).split(path.sep).join('/') } : {}) });
      } else if (!archive && /\.(zip|7z)$/i.test(p) && st.size >= (this.bigArchiveBytes || 256 * 1024 * 1024)) {
        // a big archive (a 3DS, Switch or disc game): look at the names inside instead of unpacking gigabytes
        if (skipKnown && index[p] === stamp(st)) return;
        try {
          const before = out.length;
          for (const m of await inst.listArchive(p)) {
            const sys = rom.systemForExtension(m.name);
            if (!sys || !rom.NAME_ONLY.has(sys) || rom.SHARED_EXT_SET.has(path.extname(m.name).toLowerCase())) continue;
            out.push({ file: p, shown: `${path.basename(p)} › ${path.basename(m.name)}`, indexKey: p, stamp: stamp(st), fromArchive: true, listed: { system: sys, size: m.size },
              archiveFile: p, member: m.name.split(path.sep).join('/') });
          }
          if (out.length === before) index[p] = stamp(st);
        } catch { index[p] = stamp(st); }
      } else if (!archive && /\.(zip|7z)$/i.test(p)) {
        if (skipKnown && index[p] === stamp(st)) return;
        // unpacked into a temporary folder, checked, and (with onArchive) deleted again before the next one,
        // so a folder of thousands of zips never needs more than one unpacked zip's worth of space
        await disk.ensureSpace(os.tmpdir(), st.size * 8 + 256e6);
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cartridge-rom-'));
        if (!onArchive) tmpDirs.push(tmp);
        try {
          try { await inst.extract(p, tmp); } catch (e) {
            if (e.code === 'ENOSPC' || /no space|disk full|not enough space/i.test(e.message)) throw disk.friendly(Object.assign(e, { code: 'ENOSPC' }), tmp);
            index[p] = stamp(st); // not an archive we can read
            return;
          }
          const inner = [];
          await visit(tmp, depth + 1, { file: p, stamp: stamp(st), root: tmp }, inner);
          if (!inner.length) index[p] = stamp(st); // a zip with no ROMs: remember it so we don't reopen it
          else if (onArchive) await onArchive(dropTracks(inner));
          else out.push(...inner);
        } finally {
          if (onArchive) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
      }
    };
    for (const p of paths) await visit(p, 0, null);
    return dropTracks(out);
  }

  /** Add ROM files / folders / zips. Returns a per-file report for the UI. */
  async addRoms(paths, opts = {}) {
    const tmpDirs = [];
    const report = [];
    try {
      const index = this.state.scanIndex || (this.state.scanIndex = {});
      const remember = (f) => { if (f.indexKey) index[f.indexKey] = f.stamp; };
      const handle = async (f) => {
        const { file, shown } = f;
        try {
          const info = f.arcade ? arcade.inspect(this.arcadeDb, file)
            // inside a big archive: known by the file name only (nothing unpacked)
            : f.listed ? { system: f.listed.system, size: f.listed.size, sha1: null, format: path.extname(f.member).slice(1).toLowerCase(), byName: true, internalName: rom.nameFromFile(f.member), serial: '' }
            : await (this.hooks.inspectRom || rom.inspectRom)(file);
          const dat = await this.loadDat(info.system);
          let datHit = dat && info.sha1 ? dat.bySha1.get(info.sha1) : null;
          if (!datHit && dat && info.alt && dat.bySha1.get(info.alt.sha1)) {
            // this database lists the dump with its header kept, so keep it too
            datHit = dat.bySha1.get(info.alt.sha1);
            Object.assign(info, { data: info.alt.data, sha1: info.alt.sha1, size: info.alt.data.length, converted: false });
          }
          const id = info.arcade ? `arcade-${info.arcade.set}` : info.sha1 || `${info.system}-${info.serial || ''}-${info.size}-${(info.internalName || path.basename(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          // Fulton never copies ROMs: it remembers where they are (inside a zip if need be),
          // and only makes a converted copy later, for a game that needs one (see romPath)
          const where = {
            file: f.fromArchive ? f.archiveFile : file,
            ...(f.fromArchive ? { member: f.member } : {}),
            ...(info.converted ? { convert: true } : {}),
            ...(info.storeExt ? { storeExt: info.storeExt } : {}),
          };
          const existing = this.state.roms.find((r) => r.id === id);
          if (existing) {
            // an older Fulton kept a copy of this ROM, or the file moved: point at the file found now
            // (a copy is deleted; the player's own files never are)
            if ((this.isRomCopy(existing.file) || !fs.existsSync(existing.file)) && !this.isRomCopy(where.file) && path.resolve(existing.file) !== path.resolve(where.file)) {
              const old = existing.file;
              delete existing.member; delete existing.convert; delete existing.missing;
              Object.assign(existing, where);
              const freed = await this.deleteRomCopy(old);
              this.romCopiesFreed = (this.romCopiesFreed || 0) + freed;
              remember(f);
              report.push({ file: shown, status: 'relinked', id, freed });
              return;
            }
            remember(f); report.push({ file: shown, status: 'duplicate', id, system: info.system, name: datHit ? datHit.name : info.internalName }); return;
          }
          const entry = {
            id, ...where, originalName: path.basename(file), system: info.system, sha1: info.sha1,
            serial: (datHit && datHit.serial) || info.serial, internalName: info.internalName,
            datName: datHit ? datHit.name : null, size: info.size, format: info.format, addedAt: Date.now(), byName: !!info.byName,
            ...(info.arcade ? { arcade: info.arcade } : {}),
          };
          this.state.roms.push(entry);
          remember(f);
          const unlocks = this.games.filter((g) => romdb.matchRomToGame(entry, g).level).map((g) => g.port);
          report.push({ file: shown, status: 'added', id, system: info.system, name: entry.datName || entry.internalName || entry.originalName, verified: !!datHit, unlocks });
        } catch (e) {
          if (e.code === 'ENOSPC') throw disk.friendly(e, os.tmpdir()); // a full drive: stop, and check this file again next time
          remember(f); // don't re-check a bad file on every startup
          report.push({ file: shown, status: 'error', error: e.message });
        }
      };
      // ROMs inside zips are checked as each zip is unpacked (its temporary folder is gone before the next one);
      // loose files after that
      const files = await this.collectRomFiles(paths, tmpDirs, { ...opts, onArchive: async (list) => { for (const f of list) await handle(f); } });
      for (const f of files) await handle(f);
      await this.save();
      this.emitChange();
      return report;
    } finally {
      for (const t of tmpDirs) fsp.rm(t, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Free space where Fulton writes (library, temporary files), for warnings and Check my setup. */
  async diskStatus() {
    const places = [...this.locations.map((l) => ['library', l]), ['temp', os.tmpdir()]];
    const out = [];
    const seen = new Set();
    for (const [what, dir] of places) {
      const free = await disk.freeBytes(dir);
      const drive = disk.driveName(dir);
      if (seen.has(drive) && drive !== 'drive') continue;
      seen.add(drive);
      out.push({ what, dir, drive, free, low: free != null && free < 5 * disk.GB });
    }
    return out;
  }

  // ---------- Check my setup ----------
  /** Bytes used by a folder (0 when it isn't there). */
  async folderBytes(dir) {
    try { return (await inst.walk(dir)).reduce((n, f) => n + (f.size || 0), 0); } catch { return 0; }
  }

  /**
   * Everything that can quietly go wrong, each with a plain explanation and (where Fulton can) a one-click fix.
   * Returns { ok: [...things that are fine], issues: [{ id, level: 'bad'|'warn', title, detail, fix?: { id, label } }] }
   */
  async checkSetup() {
    const issues = [];
    const ok = [];
    const fmt = disk.fmt;
    // 1. free space
    for (const d of await this.diskStatus()) {
      if (d.free == null) continue;
      if (d.free < 2 * disk.GB) issues.push({ id: `space-${d.drive}`, level: 'bad', title: `Your ${d.drive} is almost full`, detail: `Only ${fmt(d.free)} free. Installs, ROM scans and save backups can fail. Free up space on it (the fixes below may help).` });
      else if (d.low) issues.push({ id: `space-${d.drive}`, level: 'warn', title: `Your ${d.drive} is getting full`, detail: `${fmt(d.free)} free. Big games and scans need a few GB.` });
      else ok.push(`${fmt(d.free)} free on your ${d.drive}`);
    }
    // 2. leftovers Fulton can clear: downloads, temporary files, unpacked ROMs for games, old copies
    const busy = this.jobs.size > 0;
    let dl = 0;
    if (!busy) for (const l of this.locations) dl += await this.folderBytes(path.join(l, 'Downloads'));
    if (dl > 50e6) issues.push({ id: 'downloads', level: 'warn', title: `${fmt(dl)} of leftover downloads`, detail: 'Downloads from installs that were cancelled or failed. They are safe to delete.', fix: { id: 'clear-downloads', label: 'Delete leftover downloads' } });
    let tmpBytes = 0;
    if (!this.scanning) {
      try {
        for (const d of await fsp.readdir(os.tmpdir())) if (/^cartridge-(rom|dmg)-/.test(d)) tmpBytes += await this.folderBytes(path.join(os.tmpdir(), d));
      } catch { /* no temp folder access */ }
    }
    if (tmpBytes > 10e6) issues.push({ id: 'temp', level: 'warn', title: `${fmt(tmpBytes)} of temporary files`, detail: 'Left behind when Fulton was closed in the middle of a ROM scan. Safe to delete.', fix: { id: 'clear-temp', label: 'Delete temporary files' } });
    const copies = await this.romCopies();
    if (copies.count) issues.push({ id: 'copies', level: copies.bytes > disk.GB ? 'warn' : 'warn', title: `${copies.count.toLocaleString()} old ROM copies${copies.bytes ? ` (${fmt(copies.bytes)})` : ''}`, detail: 'Older versions of Fulton copied every ROM into its own folder. Fulton now uses your files where they are. Rescan first so ROMs in your watched folders point at your originals; this removes the rest of the copies from the list and the disk.', fix: { id: 'remove-copies', label: 'Remove old copies' } });
    const conv = await this.folderBytes(path.join(this.dirs.roms, 'Converted'));
    if (conv > 2 * disk.GB) issues.push({ id: 'converted', level: 'warn', title: `${fmt(conv)} of converted ROMs`, detail: 'Copies made for games that need a different format (or a ROM out of a zip). They are made again the next time a game needs one.', fix: { id: 'clear-converted', label: 'Delete converted copies' } });
    // 3. ROM folders that can't be reached
    const reach = (f) => Promise.race([fsp.stat(f).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
    const folders = this.state.settings.romFolders || [];
    const reachable = await Promise.all(folders.map(reach));
    folders.forEach((f, i) => {
      if (!reachable[i]) issues.push({ id: `folder-${f}`, level: 'warn', title: `ROM folder not found: ${f}`, detail: "It's on a drive that isn't connected, or it was moved or renamed. Connect the drive, or stop watching it if it's gone for good.", fix: { id: `unwatch:${f}`, label: 'Stop watching it' } });
    });
    if (folders.length && reachable.every(Boolean)) ok.push(`All ${folders.length} ROM folder${folders.length > 1 ? 's' : ''} found`);
    if (!folders.length) issues.push({ id: 'no-folders', level: 'warn', title: 'No ROM folder yet', detail: 'Add the folder where you keep your ROMs (ROM Folder at the top), and Fulton finds new ones by itself every time it starts.' });
    // 4. ROMs whose file is gone
    const missing = await this.markMissing();
    if (missing) issues.push({ id: 'missing', level: 'warn', title: `${missing.toLocaleString()} ROM${missing > 1 ? 's' : ''} with a missing file`, detail: "Moved, deleted, or on a drive that isn't connected. If you moved them, add the new folder and they're found again. Otherwise, take them off the list (no files are deleted).", fix: { id: 'forget-missing', label: 'Remove missing from the list' } });
    else ok.push(`All ${this.state.roms.length.toLocaleString()} ROMs found`);
    // 5. installed games whose files are gone
    let broken = 0;
    for (const [id, i] of Object.entries(this.state.installed)) {
      if (fs.existsSync(i.exe)) continue;
      broken++;
      const g = this.game(id);
      const name = g ? g.port : id;
      issues.push({ id: `install-${id}`, level: 'bad', title: `${name}: its files are missing`, detail: i.manual ? `Your own copy isn't at ${i.exe} any more. Pick where it is now, or take it off the list.` : 'The game folder was moved or deleted. Reinstall it, or take it off the list (your save backups are kept).', fix: { id: `forget-install:${id}`, label: 'Take it off the list' } });
    }
    if (!broken && Object.keys(this.state.installed).length) ok.push(`All ${Object.keys(this.state.installed).length} installed games found`);
    if (missing) await this.save();
    this.emitChange();
    return { ok, issues };
  }

  /** Run one of Check my setup's fixes. Only ever deletes Fulton's own leftovers. */
  async fixSetup(fixId) {
    const [what, arg] = [fixId.split(':')[0], fixId.slice(fixId.indexOf(':') + 1)];
    switch (what) {
      case 'clear-downloads':
        if (this.jobs.size) throw new Error('Wait for the install that is running to finish.');
        for (const l of this.locations) {
          await fsp.rm(path.join(l, 'Downloads'), { recursive: true, force: true });
          await fsp.mkdir(path.join(l, 'Downloads'), { recursive: true }).catch(() => {});
        }
        return true;
      case 'clear-temp':
        if (this.scanning) throw new Error('Wait for the ROM scan to finish.');
        for (const d of await fsp.readdir(os.tmpdir())) if (/^cartridge-(rom|dmg)-/.test(d)) await fsp.rm(path.join(os.tmpdir(), d), { recursive: true, force: true }).catch(() => {});
        return true;
      case 'clear-converted':
        await fsp.rm(path.join(this.dirs.roms, 'Converted'), { recursive: true, force: true });
        return true;
      case 'remove-copies':
        return this.removeRomCopies();
      case 'forget-missing':
        return this.forgetMissing();
      case 'unwatch':
        return this.removeRomFolder(arg);
      case 'forget-install': {
        if (!this.state.installed[arg]) return false;
        delete this.state.installed[arg]; // its folder is already gone; backups stay
        await this.save();
        this.emitChange();
        return true;
      }
      default: throw new Error('Unknown fix.');
    }
  }

  // ---------- ROM folders (scanned now and on every start) ----------
  async addRomFolder(dir) {
    const folders = this.state.settings.romFolders || [];
    if (!folders.some((f) => path.resolve(f).toLowerCase() === path.resolve(dir).toLowerCase())) {
      this.state.settings.romFolders = [...folders, dir];
      await this.save();
    }
    return this.addRoms([dir], { skipKnown: true });
  }

  // ---------- ROM files: originals stay where they are ----------
  /** Is this inside one of the folders you told Fulton to watch? Those are your own files, always. */
  inWatchedFolder(p) {
    const f = path.resolve(p).toLowerCase();
    return (this.state.settings.romFolders || []).some((d) => {
      const root = path.resolve(d).toLowerCase();
      return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    });
  }

  /** Is this a copy Fulton made in its own ROMs folder (older versions did, for every ROM)? */
  isRomCopy(p) {
    if (!p) return false;
    const root = path.resolve(this.dirs.roms) + path.sep;
    const f = path.resolve(p).toLowerCase();
    if (!f.startsWith(root.toLowerCase()) || f.startsWith(path.join(root, 'Converted').toLowerCase() + path.sep)) return false;
    return !this.inWatchedFolder(p); // someone keeping their own ROMs in there (and watching it): never a copy
  }

  /**
   * Delete one old copy, and only that: the file itself, plus a disc's track files listed in its .cue, each only if
   * it's a copy too. A folder is removed only once it's empty. Returns the bytes freed.
   */
  async deleteRomCopy(p) {
    if (!this.isRomCopy(p)) return 0;
    const files = [path.resolve(p)];
    if (/\.cue$/i.test(p)) { try { files.push(...rom.cueTracks(p).map((t) => path.resolve(t))); } catch { /* no tracks listed */ } }
    let bytes = 0;
    for (const f of files) {
      if (!this.isRomCopy(f)) continue;
      try { const st = await fsp.stat(f); if (!st.isFile()) continue; bytes += st.size; } catch { continue; }
      await fsp.rm(f, { force: true }).catch(() => {});
    }
    // an older version kept each disc in its own folder: tidy it away once nothing is left in it
    const dir = path.dirname(path.resolve(p));
    if (dir.toLowerCase() !== path.resolve(this.dirs.roms).toLowerCase() && this.isRomCopy(path.join(dir, 'x'))) {
      try { if (!(await fsp.readdir(dir)).length) await fsp.rmdir(dir); } catch { /* not empty or gone */ }
    }
    return bytes;
  }

  // ---------- ROMs whose file is gone ----------
  /** Look for each ROM's file and mark the ones that are gone (moved, deleted, or on a drive that's unplugged). */
  async markMissing() {
    const roms = this.state.roms;
    let i = 0, missing = 0;
    const exists = async (f) => { try { await fsp.access(f); return true; } catch { return false; } };
    const worker = async () => {
      while (i < roms.length) {
        const r = roms[i++];
        if (await exists(r.file)) delete r.missing; else { r.missing = true; missing++; }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    return missing;
  }

  /**
   * Forget missing ROMs. auto (after a scan): only ones that were in a watched folder that's there right now, so its
   * files really are gone (an unplugged drive is left alone). Otherwise every missing ROM. Files are never touched.
   */
  async forgetMissing({ auto = false, reachable = null } = {}) {
    const folders = (reachable || this.state.settings.romFolders || []).map((d) => path.resolve(d).toLowerCase());
    const under = (f) => folders.some((d) => path.resolve(f).toLowerCase().startsWith(d.endsWith(path.sep) ? d : d + path.sep));
    const gone = this.state.roms.filter((r) => r.missing && (!auto || under(r.file)));
    if (!gone.length) return 0;
    const ids = new Set(gone.map((r) => r.id));
    this.state.roms = this.state.roms.filter((r) => !ids.has(r.id));
    for (const [g, rid] of Object.entries(this.state.romOverride)) if (ids.has(rid)) delete this.state.romOverride[g];
    // a forgotten ROM may still be somewhere in a watched folder under another name: the next scan looks at
    // everything again so it comes back (after a scan, only the exact files that are gone are forgotten)
    if (auto) for (const r of gone) delete (this.state.scanIndex || {})[r.file];
    else this.state.scanIndex = {};
    await this.save();
    this.emitChange();
    return gone.length;
  }



  /** Where the converted copy of a ROM lives, if it needs one. */
  convertedPathOf(r) {
    if (!r.member && !r.convert) return null;
    const base = String(r.datName || path.basename(r.member || r.file, path.extname(r.member || r.file))).replace(/[<>:"/\\|?*]/g, '_');
    if (r.member && !r.convert) return path.join(this.dirs.roms, 'Converted', `${base} (${r.id.slice(0, 8)})`, r.member);
    return path.join(this.dirs.roms, 'Converted', base + (r.storeExt || path.extname(r.member || r.file)));
  }

  /**
   * The file to hand to a game. Usually the user's own ROM, untouched. Only when the game needs something different
   * (a .v64/.n64 that must be .z64, a header removed, or a ROM inside a zip) is one copy made, for that ROM only.
   */
  async romPath(r) {
    const out = this.convertedPathOf(r);
    if (!out) return r.file;
    if (fs.existsSync(out)) return out;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    let src = r.file;
    let tmp = null;
    try {
      if (r.member) {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cartridge-rom-'));
        await inst.extract(r.file, tmp);
        src = path.join(tmp, ...r.member.split('/'));
        if (!r.convert) {
          // a disc inside a zip: keep the unpacked disc (with its tracks) for this game
          await fsp.cp(path.dirname(src), path.dirname(out), { recursive: true, force: true });
          return out;
        }
      }
      const info = await (this.hooks.inspectRom || rom.inspectRom)(src);
      const data = info.alt && info.alt.sha1 === r.sha1 ? info.alt.data : info.data;
      await fsp.writeFile(out, data);
      return out;
    } finally {
      if (tmp) fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Copies older versions of Fulton made: how many and how big. */
  async romCopies() {
    const list = this.state.roms.filter((r) => this.isRomCopy(r.file));
    let bytes = 0;
    for (const r of list) { try { bytes += (await fsp.stat(r.file)).size; } catch { /* gone */ } }
    return { count: list.length, bytes, freed: this.romCopiesFreed || 0 };
  }

  /**
   * One-time clean-up after updating from a version that copied every ROM: rescan the watched folders so each ROM
   * points at the original, deleting the copy. Copies whose original isn't in a watched folder are left alone.
   */
  async migrateRomCopies() {
    if (this.state.romCopiesMigrated) return null;
    const before = await this.romCopies();
    if (!before.count) { this.state.romCopiesMigrated = 1; await this.save(); return null; }
    if (!(this.state.settings.romFolders || []).length) return { relinked: 0, freed: 0, left: before };
    this.romCopiesFreed = 0;
    const report = await this.scanRomFolders({ full: true });
    this.state.romCopiesMigrated = 1;
    await this.save();
    this.emitChange();
    return { relinked: (report || []).filter((r) => r.status === 'relinked').length, freed: this.romCopiesFreed, left: await this.romCopies() };
  }

  /** Delete the remaining old copies and forget those ROMs (their originals weren't found in a watched folder). */
  async removeRomCopies() {
    // first point every ROM that's in a watched folder at the original, so only true leftovers are removed
    if ((this.state.settings.romFolders || []).length) await this.scanRomFolders({ full: true });
    let freed = 0;
    const keep = [];
    for (const r of this.state.roms) {
      if (this.isRomCopy(r.file)) freed += await this.deleteRomCopy(r.file);
      else keep.push(r);
    }
    const removed = this.state.roms.length - keep.length;
    this.state.roms = keep;
    for (const [g, rid] of Object.entries(this.state.romOverride)) if (!keep.some((r) => r.id === rid)) delete this.state.romOverride[g];
    await this.save();
    this.emitChange();
    return { removed, freed };
  }

  async removeRomFolder(dir) {
    this.state.settings.romFolders = (this.state.settings.romFolders || []).filter((f) => f !== dir);
    await this.save();
    this.emitChange();
  }

  /** Rescan every saved folder; only new or changed files are opened. */
  async scanRomFolders({ full = false } = {}) {
    if (this.scanning) return this.scanning;
    const log = this.hooks.log || (() => {});
    // A sleeping or disconnected drive (a NAS, a USB disk) can take a long time to answer, so check without waiting on it forever
    const reachable = (f) => Promise.race([fsp.stat(f).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 15000))]);
    const all = this.state.settings.romFolders || [];
    const ok = await Promise.all(all.map(reachable));
    const folders = all.filter((_, i) => ok[i]);
    for (const f of all.filter((_, i) => !ok[i])) log(`ROM folder not reachable, skipped: ${f}`);
    if (!folders.length || this.scanning) return this.scanning || [];
    this.emit('scan', true);
    const t0 = Date.now();
    this.scanning = this.addRoms(folders, { skipKnown: !full })
      .then(async (report) => {
        const missing = await this.markMissing();
        const forgot = missing ? await this.forgetMissing({ auto: true, reachable: folders }) : 0;
        if (missing) { await this.save(); this.emitChange(); }
        log(`Scanned ${folders.length} ROM folder(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${report.filter((r) => r.status === 'added').length} added, ${report.length} checked, ${missing} missing (${forgot} forgotten)`);
        if (forgot) report.push({ status: 'forgotten', count: forgot });
        return report;
      })
      .finally(() => { this.scanning = null; this.emit('scan', false); });
    return this.scanning;
  }

  async removeRom(id) {
    const r = this.state.roms.find((x) => x.id === id);
    if (!r) return;
    this.state.roms = this.state.roms.filter((x) => x.id !== id);
    if (this.isRomCopy(r.file)) await this.deleteRomCopy(r.file); // a copy made by an older Fulton
    const conv = this.convertedPathOf(r);
    if (conv) await fsp.rm(conv, { force: true }).catch(() => {});
    for (const [g, rid] of Object.entries(this.state.romOverride)) if (rid === id) delete this.state.romOverride[g];
    await this.save();
    this.emitChange();
  }

  async assignRom(gameId, romId) {
    if (romId) this.state.romOverride[gameId] = romId; else delete this.state.romOverride[gameId];
    await this.save();
    this.emitChange();
  }

  // ---------- install / update / uninstall ----------
  setJob(id, job) {
    if (job) this.jobs.set(id, job); else this.jobs.delete(id);
    this.emit('job', id, job);
  }

  async install(gameId, opts = {}) {
    if (this.jobs.has(gameId)) return;
    const g = this.game(gameId);
    const controller = new AbortController();
    this.setJob(gameId, { phase: 'Checking for the latest release', progress: 0, cancel: true });
    this.jobs.get(gameId).abort = controller;
    let archive;
    try {
      await this.refreshReleases({ force: true, ids: [gameId] });
      const rel = this.state.releases[gameId];
      if (!rel || !rel.data) throw new Error(rel && rel.error ? rel.error : 'No release found');
      const { asset, tag } = rel.data;
      if (!asset) throw new Error(`This release has no ${{ darwin: 'Mac', linux: 'Linux' }[this.platform] || 'Windows'} download yet. Check the project page.`);

      // where it goes: an update stays in its folder; a new install goes in the drive the player picked (or the default)
      const where = this.installTarget(gameId, opts.root);
      try { await fsp.mkdir(where.downloads, { recursive: true }); } catch (e) {
        const gone = new Error(`Can't reach ${where.root}. If it's on an external drive, plug it in and try again.`);
        gone.friendly = true; throw gone;
      }
      // the download, its unpacked files and the installed game can all be on the drive at once
      if (asset.size) await disk.ensureSpace(where.downloads, asset.size * 4 + 200e6);
      archive = path.join(where.downloads, `${gameId}-${asset.name}`);
      await inst.download(asset.url, archive, {
        signal: controller.signal, digest: asset.digest,
        onProgress: (p, got, total) => this.setJob(gameId, { phase: 'Downloading', progress: p, got, total, cancel: true, abort: controller }),
      });

      this.setJob(gameId, { phase: 'Unpacking', progress: null });
      const target = where.target;
      const staging = path.join(where.downloads, `${gameId}-staging`);
      await fsp.rm(staging, { recursive: true, force: true });
      if (/\.(exe|appimage)$/i.test(asset.name)) {
        await fsp.mkdir(staging, { recursive: true });
        await fsp.copyFile(archive, path.join(staging, asset.name));
      } else {
        await inst.extract(archive, staging);
      }
      // Mac: a zip holding a disk image (or a zipped app) gets opened too
      if (this.platform === 'darwin' && await inst.expandNested(staging).catch((e) => { throw new Error(`Couldn't open the game's disk image: ${e.message}`); })) {
        this.setJob(gameId, { phase: 'Unpacking', progress: null });
      }
      const content = await inst.unwrap(staging);
      const prevInstall = this.state.installed[gameId];
      if (prevInstall && fs.existsSync(target)) {
        this.setJob(gameId, { phase: 'Backing up your saves', progress: null });
        await this.backupGame(gameId, 'before update').catch(() => null);
        this.setJob(gameId, { phase: 'Unpacking', progress: null });
      }
      // remember which files came with the download, so backups can tell them apart from saves
      const shipped = await backup.makeManifest(content);
      await this.saveManifest(gameId, shipped);
      await inst.mergeInto(content, target); // keeps saves/configs from a previous version
      await fsp.rm(staging, { recursive: true, force: true });

      for (const f of g.filesToAdd || []) {
        const p = path.join(target, f);
        if (!fs.existsSync(p)) await fsp.writeFile(p, '');
      }
      const exe = await inst.findExecutable(target, g.exe, this.platform);
      if (!exe && this.platform !== 'win32' && (await inst.walk(target)).some((f) => /\.exe$/i.test(f.full))) {
        // the download turned out to be a Windows build: don't leave a game that can't run
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        throw new Error(`This download is a Windows build, and the project doesn't publish a ${this.platform === 'darwin' ? 'Mac' : 'Linux'} version yet.`);
      }
      if (!exe) throw new Error(this.platform === 'darwin' ? "Installed, but couldn't find the game's app. Open the folder to start it manually." : "Installed, but couldn't find the game's .exe. Open the folder to start it manually.");
      if (this.platform === 'darwin') await inst.clearQuarantine(target);
      else if (this.platform !== 'win32') await fsp.chmod(exe, 0o755).catch(() => {});
      // portable.txt must sit next to the exe, wherever that is
      for (const f of g.filesToAdd || []) {
        const p = path.join(path.dirname(exe), f);
        if (!fs.existsSync(p)) await fsp.writeFile(p, '');
      }

      const prev = this.state.installed[gameId];
      this.state.installed[gameId] = {
        tag, dir: target, exe, installedAt: Date.now(), asset: asset.name,
        launchedOnce: prev ? prev.launchedOnce : false, playTime: prev ? prev.playTime || 0 : 0, lastPlayed: prev ? prev.lastPlayed : null,
      };
      await this.save();
      this.setJob(gameId, null);
      this.emitChange();
      fsp.rm(archive, { force: true }).catch(() => {});
      return { ok: true };
    } catch (e) {
      this.setJob(gameId, null);
      if (archive) fsp.rm(archive, { force: true }).catch(() => {});
      this.emitChange();
      if (e.name === 'AbortError') return { ok: false, cancelled: true };
      return { ok: false, error: disk.friendly(e, this.installTarget(gameId, opts.root).root).message };
    }
  }

  cancel(gameId) {
    const j = this.jobs.get(gameId);
    if (j && j.abort) j.abort.abort();
  }

  /**
   * A copy the player built or installed themselves (ports with no download, such as LAS Recomp): Fulton just
   * starts it. `file` is the game's .exe, or a .bat/.cmd that starts it (for games that need a folder or options).
   */
  async linkInstall(gameId, file) {
    if (!this.game(gameId)) throw new Error('Unknown game.');
    if (!file || !fs.existsSync(file)) throw new Error("That file doesn't exist.");
    const prev = this.state.installed[gameId];
    if (prev && !prev.manual) throw new Error('Uninstall the copy Fulton installed first.');
    this.state.installed[gameId] = {
      tag: 'Your own copy', dir: path.dirname(file), exe: file, manual: true, installedAt: Date.now(),
      launchedOnce: prev ? prev.launchedOnce : false, playTime: prev ? prev.playTime || 0 : 0, lastPlayed: prev ? prev.lastPlayed : null,
    };
    await this.save();
    this.emitChange();
    return this.state.installed[gameId];
  }

  async uninstall(gameId) {
    const i = this.state.installed[gameId];
    if (!i) return;
    if (this.running.has(gameId)) throw new Error('Close the game first.');
    if (i.manual) { // the player's own copy: forget it, never delete their files
      delete this.state.installed[gameId];
      await this.save();
      this.emitChange();
      return;
    }
    await this.backupGame(gameId, 'before uninstall').catch(() => null);
    await fsp.rm(i.dir, { recursive: true, force: true });
    delete this.state.installed[gameId];
    await this.save();
    this.emitChange();
  }

  // ---------- launching ----------
  async prepareRom(g, i) {
    const spec = (g.rom && g.rom.setup) || { type: 'in-app' };
    const match = romdb.bestRomForGame(g, this.state.roms, this.state.romOverride[g.id]);
    if (!match) return { needsRom: true };
    if (!fs.existsSync(match.rom.file)) return { needsRom: true, missing: match.rom.file };
    const src = await this.romPath(match.rom);
    const exeDir = path.dirname(i.exe);
    if (spec.type === 'beside-exe') {
      const dest = path.join(exeDir, spec.fileName || path.basename(src));
      if (!fs.existsSync(dest)) await fsp.copyFile(src, dest);
    } else if (spec.type === 'file') {
      const dest = path.join(exeDir, spec.path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) await fsp.copyFile(src, dest);
    }
    if (this.hooks.copyToClipboard) this.hooks.copyToClipboard(src);
    if (spec.reveal && !i.launchedOnce && this.hooks.revealFile) this.hooks.revealFile(src);
    return { rom: match.rom, level: match.level };
  }

  async launch(gameId, { force = false } = {}) {
    const g = this.game(gameId);
    const i = this.state.installed[gameId];
    if (!i) throw new Error('Install the game first.');
    if (this.running.has(gameId)) return { ok: true, alreadyRunning: true };
    if (!fs.existsSync(i.exe)) throw new Error("The game's files are missing. Reinstall it.");
    const prep = await this.prepareRom(g, i);
    // Most games ask for the ROM themselves, so a missing ROM never blocks Play.
    // Only games that read the ROM from a fixed file path (Perfect Dark) can't start without it.
    const setupType = ((g.rom && g.rom.setup) || {}).type;
    if (prep.needsRom && setupType === 'file' && !force) return { ok: false, needsRom: true };

    const firstRun = !i.launchedOnce;
    // Mac app bundles start through "open"; -W waits until the game quits, so play time and backups still work
    const isApp = this.platform === 'darwin' && /\.app$/i.test(i.exe);
    // .bat/.cmd (a game linked by the player that needs a folder or options) run through cmd, which waits for the game
    const isScript = this.platform === 'win32' && /\.(bat|cmd)$/i.test(i.exe);
    const child = isApp
      ? spawn('open', ['-W', '-n', i.exe], { detached: true, stdio: 'ignore' })
      : isScript
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', i.exe], { cwd: path.dirname(i.exe), detached: true, stdio: 'ignore', windowsHide: !!i.manual }) // a script that came with an install (it may download Java on first run) keeps its window
        : spawn(i.exe, [], { cwd: path.dirname(i.exe), detached: true, stdio: 'ignore', windowsHide: false });
    const started = Date.now();
    this.running.set(gameId, child);
    child.on('error', () => { this.running.delete(gameId); this.emitChange(); });
    child.on('exit', async () => {
      this.running.delete(gameId);
      const cur = this.state.installed[gameId];
      if (cur) { cur.playTime = (cur.playTime || 0) + (Date.now() - started); cur.lastPlayed = Date.now(); await this.save(); }
      if (this.state.settings.autoBackup !== false) await this.backupGame(gameId, 'after playing').catch(() => null);
      this.emitChange();
      this.emit('exited', gameId);
    });
    child.unref();
    this.emit('started', gameId);
    i.launchedOnce = true;
    await this.save();
    this.emitChange();
    const noRomTip = 'If the game asks for your ROM, pick it there. It remembers it after that, so you only do this once.';
    return {
      ok: true, firstRun, noRom: !!prep.needsRom,
      tip: firstRun ? (prep.needsRom ? noRomTip : (g.rom && g.rom.firstRun) || null) : null,
      romFile: prep.rom ? prep.rom.file : null,
    };
  }

  // ---------- custom games ----------
  async addUserGame(entry) {
    const id = entry.id || entry.repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const game = {
      id, title: entry.title || entry.repo.split('/')[1], port: entry.port || entry.repo.split('/')[1],
      system: entry.system || 'n64', year: entry.year ? Number(entry.year) : null,
      developer: entry.developer || '', publisher: entry.publisher || '', kind: entry.kind || 'Community port',
      credits: [{ role: 'Made by', name: entry.repo.split('/')[0] }], repo: entry.repo,
      description: entry.description || '', filesToAdd: entry.portable ? ['portable.txt'] : [],
      rom: { titles: entry.romTitle ? [entry.romTitle] : [], headerNames: entry.romTitle ? [entry.romTitle] : [], setup: { type: entry.romSetup || 'in-app' } },
      art: { boxart: entry.boxart ? [entry.boxart] : [], icon: entry.icon || null }, custom: true,
    };
    this.state.userGames = this.state.userGames.filter((x) => x.id !== id).concat(game);
    (this.state.firstSeen || (this.state.firstSeen = {}))[id] = Date.now();
    await this.save();
    this.emitChange();
    this.refreshReleases({ ids: [id] }).catch(() => {});
    return game;
  }

  // ---------- favorites ----------
  async setFavorite(gameId, on) {
    const fav = this.state.favorites || (this.state.favorites = {});
    if (on) fav[gameId] = Date.now(); else delete fav[gameId];
    await this.save();
    this.emitChange();
    return !!on;
  }

  // ---------- community catalog ----------
  /** Find more was opened: ports first seen since the visit before this session's first one count as new. */
  async discoverVisited() {
    if (this.discoverPrev == null) this.discoverPrev = this.state.discoverVisitedAt || 0;
    this.state.discoverVisitedAt = Date.now();
    await this.save();
  }

  /** Clear every "NEW" tag in Find more at once. */
  async markDiscoverSeen() {
    this.discoverPrev = Date.now();
    this.state.discoverVisitedAt = Date.now();
    await this.save();
    this.emitChange();
  }

  /** All community-listed ports (cached for a day so browsing works offline). */
  async communityList({ force = false } = {}) {
    const cache = path.join(this.dataDir, 'community.json');
    let cached = null;
    try { cached = JSON.parse(await fsp.readFile(cache, 'utf8')); } catch { /* none yet */ }
    if (cached && cached.v !== 3) cached = null; // older caches lack Recompendium or the download/build labels
    if (!force && cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) return this.markCommunity(cached.items);
    try {
      const items = await community.fetchCommunity();
      await fsp.writeFile(cache, JSON.stringify({ v: 3, fetchedAt: Date.now(), items }));
      return this.markCommunity(items);
    } catch (e) {
      if (cached) return this.markCommunity(cached.items);
      return { ...this.markCommunity([]), offline: e.message }; // Fulton's own list still shows
    }
  }

  // ---------- which computers each Find more port has downloads for ----------
  platformKey(c) { return `${c.repo.toLowerCase()}#${(c.assetFilter || '').toLowerCase()}`; }

  /** { win, mac } once known (from the shelf's own release check, or the Find more check), else {}. */
  platformsFor(c) {
    if (c.get === 'build') return { win: false, mac: false, linux: false, platformsKnown: true };
    const hit = (this.state.platformCache || {})[this.platformKey(c)];
    if (hit) return { win: hit.win, mac: hit.mac, linux: !!hit.linux, platformsKnown: true, released: hit.released || null };
    return {};
  }

  /**
   * Look up, in the background, which Find more ports have Windows and Mac downloads (a few at a time, cached for
   * a few days). onProgress(done, total) as it goes. Calling it again while it runs just returns the running check.
   */
  checkPlatforms(items, { onProgress = () => {}, fetchImpl, concurrency = 4, wait = (ms) => new Promise((r) => setTimeout(r, ms)), busyWaitMs = 45000 } = {}) {
    if (this.platformJob) return this.platformJob.promise;
    const cache = this.state.platformCache || (this.state.platformCache = {});
    const now = Date.now();
    const keys = new Set();
    const todo = items.filter((c) => {
      const k = this.platformKey(c);
      if (c.get === 'build' || keys.has(k)) return false; // (two list entries for one download are checked once)
      keys.add(k);
      return !(cache[k] && cache[k].v === 2 && now - cache[k].at < platforms.TTL); // (v2 entries know the release date)
    });
    if (!todo.length) { this.platformSummary = { total: keys.size, failed: 0 }; return Promise.resolve({ checked: 0, failed: 0 }); }
    const job = { done: 0, total: todo.length, failed: 0 };
    this.platformJob = job;
    let i = 0, busyWaits = 0, sinceSave = 0;
    const retry = [];
    const one = async (c) => {
      for (;;) {
        try {
          const { names, released } = await platforms.latestAssetNames(c.repo, this.state.settings.githubToken, fetchImpl);
          cache[this.platformKey(c)] = { ...platforms.platformsOf(names, c.assetFilter), released: released || null, v: 2, at: Date.now() };
          return true;
        } catch (e) {
          // GitHub asked us to slow down: pause, then carry on (a few times at most)
          if (e.code === 'RATE_LIMIT' && busyWaits < 4) { busyWaits++; await wait(busyWaitMs); continue; }
          return false;
        }
      }
    };
    const worker = async (list) => {
      while (i < list.length) {
        const c = list[i++];
        if (!(await one(c))) retry.push(c);
        job.done++;
        onProgress(job.done, job.total);
        if (++sinceSave >= 25) { sinceSave = 0; this.save().catch(() => {}); }
      }
    };
    job.promise = (async () => {
      await Promise.all(Array.from({ length: concurrency }, () => worker(todo)));
      // one more go for the ones that failed (a hiccup, a slow answer)
      if (retry.length) {
        const again = retry.splice(0);
        let j = 0;
        await Promise.all(Array.from({ length: 2 }, async () => { while (j < again.length) { const c = again[j++]; if (!(await one(c))) retry.push(c); } }));
      }
      job.failed = retry.length;
      this.platformSummary = { total: keys.size, failed: retry.length };
      await this.save();
      return { checked: job.done - retry.length, failed: retry.length };
    })().finally(() => { this.platformJob = null; });
    return job.promise;
  }

  /** Remember when each port was first seen (the very first list is the baseline: nothing is "new" in it). */
  noteFirstSeen(items) {
    const seen = this.state.communityFirstSeen || (this.state.communityFirstSeen = {});
    // the very first list, or a big batch at once (a whole new list joining, like Recompendium did), is a starting
    // point, not news: only ports that trickle in afterwards count as new
    const unseen = items.filter((c) => !(c.key in seen)).length;
    const baseline = !Object.keys(seen).length || unseen > 40;
    const now = Date.now();
    let changed = false;
    for (const c of items) if (!(c.key in seen)) { seen[c.key] = baseline ? 0 : now; changed = true; }
    return changed;
  }

  markCommunity(items) {
    if (this.noteFirstSeen(items)) this.save().catch(() => {});
    const seen = this.state.communityFirstSeen || {};
    const since = this.discoverPrev != null ? this.discoverPrev : (this.state.discoverVisitedAt || 0);
    // more than 40 "new" at once is a list change, not news (and fixes a count like "138 new" from before)
    const fresh = items.filter((c) => seen[c.key] > 0 && seen[c.key] > since);
    if (fresh.length > 40) { for (const c of fresh) seen[c.key] = 0; this.save().catch(() => {}); }
    const key = (g) => `${(g.repo || '').toLowerCase()}#${(g.assetMatch || '').replace(/\\/g, '').toLowerCase()}`;
    const repos = new Map(this.games.map((g) => [key(g), g.id]));
    const plainRepos = new Map(this.games.map((g) => [(g.repo || '').toLowerCase(), g.id]));
    const matchId = (c) => repos.get(c.key) || (!c.assetFilter && plainRepos.get(c.repo.toLowerCase())) || null;
    const out = items.map((c) => {
      const id = matchId(c);
      return { ...c, ...this.platformsFor(c), isNew: seen[c.key] > 0 && seen[c.key] > since, onShelf: id && this.onShelf(id) ? id : null, catalogId: id || null };
    });
    // Fulton's own list of ports: any that the community lists don't already cover show here too, so they can be added
    const covered = new Set(out.map((c) => c.catalogId).filter(Boolean));
    for (const g of [...this.baseGames, ...this.remoteGames]) {
      if (covered.has(g.id) || !g.repo) continue;
      const credit = (g.credits || [])[0] || {};
      const c = { key: `builtin:${g.id}`, builtin: true, name: g.title, project: g.port || g.title, repo: g.repo, system: g.system, kind: g.kind || 'Native PC port', year: g.year || null, developer: g.developer || '', author: credit.name || g.repo.split('/')[0], desc: g.description || '', status: g.status, get: g.howToGet || 'download', needsFiles: g.needsFiles };
      out.push({ ...c, ...this.platformsFor(c), isNew: false, onShelf: this.onShelf(g) ? g.id : null, catalogId: g.id });
    }
    return {
      source: community.SOURCE_PAGE,
      recompendium: community.RECOMPENDIUM_PAGE,
      platformCheck: this.platformJob ? { running: true, done: this.platformJob.done, total: this.platformJob.total } : (this.platformSummary || null),
      items: out,
    };
  }

  async addCommunityGame(key) {
    const { items } = await this.communityList();
    const c = items.find((x) => x.key === key);
    if (!c) throw new Error('That game is no longer in the community catalog.');
    if (c.onShelf) return this.game(c.onShelf);
    if (c.catalogId) return this.addToShelf(c.catalogId); // one of Fulton's own entries: it knows more about the game
    const game = community.gameFromCandidate(c);
    this.state.userGames = this.state.userGames.filter((x) => x.id !== game.id).concat(game);
    (this.state.firstSeen || (this.state.firstSeen = {}))[game.id] = Date.now();
    await this.save();
    this.emitChange();
    this.refreshReleases({ ids: [game.id] }).catch(() => {});
    return game;
  }

  // ---------- save backups ----------
  manifestPath(gameId) { return path.join(this.dataDir, 'manifests', `${gameId}.json`); }

  async saveManifest(gameId, files) {
    let old = [];
    try { old = JSON.parse(await fsp.readFile(this.manifestPath(gameId), 'utf8')); } catch { /* first install */ }
    const all = [...new Set([...old, ...files])];
    await fsp.mkdir(path.dirname(this.manifestPath(gameId)), { recursive: true });
    await fsp.writeFile(this.manifestPath(gameId), JSON.stringify(all));
  }

  expandPath(p) {
    const env = { APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), HOME: os.homedir(), USERPROFILE: os.homedir() };
    return path.normalize(String(p).replace(/%([A-Z]+)%|\$\{?([A-Z]+)\}?/g, (m, a, b) => env[a || b] || m));
  }

  /** Back up a game's saves. reason: 'manual' | 'after playing' | 'before update' | 'before uninstall' | 'before restore'. */
  async backupGame(gameId, reason = 'manual') {
    const g = this.game(gameId);
    const i = this.state.installed[gameId];
    if (!i || !fs.existsSync(i.dir)) return null;
    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(this.manifestPath(gameId), 'utf8')); } catch { /* installed before backups existed */ }
    const files = await backup.userFiles(i.dir, { manifest, installedAt: i.installedAt });
    const extra = (g.saves || []).map((s) => ({ key: s.key, path: this.expandPath(s.path) }));
    if (reason !== 'manual') {
      const latest = (await backup.listBackups(this.dirs.backups, gameId))[0];
      if (latest && latest.fingerprint === backup.fingerprint(files) && !extra.length) return null; // nothing changed
    }
    const made = await backup.createBackup({ gameDir: i.dir, backupRoot: this.dirs.backups, gameId, files, reason, extra });
    if (made) await backup.prune(this.dirs.backups, gameId, 10);
    if (made) this.emit('backup', gameId, made);
    return made;
  }

  async listBackups(gameId) {
    return backup.listBackups(this.dirs.backups, gameId);
  }

  async restoreBackup(gameId, backupId) {
    const i = this.state.installed[gameId];
    if (!i) throw new Error('Install the game first, then restore its saves.');
    if (this.running.has(gameId)) throw new Error('Close the game first.');
    const b = (await this.listBackups(gameId)).find((x) => x.id === backupId);
    if (!b) throw new Error('That backup no longer exists.');
    await this.backupGame(gameId, 'before restore'); // so a restore can always be undone
    await backup.restoreBackup(b, i.dir);
    return b;
  }

  async backupAll() {
    const out = [];
    for (const id of Object.keys(this.state.installed)) {
      const b = await this.backupGame(id, 'manual').catch(() => null);
      if (b) out.push(id);
    }
    return out;
  }


  // ---------- cover art ----------
  get coverDir() { return path.join(this.dataDir, 'covers'); }

  /** Run fn with at most 4 downloads at once. */
  async limited(fn) {
    if (this.slots >= 4) await new Promise((r) => this.queue.push(r));
    this.slots++;
    try { return await fn(); } finally { this.slots--; const next = this.queue.shift(); if (next) next(); }
  }

  /** The cover list for one libretro-thumbnails console, cached on disk for 30 days. */
  thumbIndex(repo) {
    if (this.thumbIdx[repo]) return this.thumbIdx[repo];
    const file = path.join(this.coverDir, 'index', `${repo}.json`);
    const p = (async () => {
      let cached = null;
      try { cached = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* none yet */ }
      if (cached && Date.now() - cached.at < 30 * 24 * 3600 * 1000) return covers.makeIndex(cached.names);
      try {
        const names = await covers.fetchIndexNames(repo, this.hooks.fetch || fetch, this.state.settings.githubToken);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify({ at: Date.now(), names }));
        return covers.makeIndex(names);
      } catch (e) {
        if (cached) return covers.makeIndex(cached.names); // offline: an old list is fine
        this.thumbIdx[repo] = null; // try again next time
        throw e;
      }
    })();
    this.thumbIdx[repo] = p;
    return p;
  }

  /** What to look for: the console plus exact No-Intro names and plain titles. */
  coverWant(kind, ref) {
    if (kind === 'game') {
      const g = this.game(ref);
      const exact = (g.art && g.art.boxart) || [];
      return { system: g.system, exact, titles: [g.title, g.port].filter(Boolean), region: exact[0] ? covers.regionOf(exact[0]) : null };
    }
    if (kind === 'rom') {
      const r = this.state.roms.find((x) => x.id === ref);
      if (!r) throw new Error('That ROM is no longer in your library');
      if (r.arcade) {
        // arcade box art is named after the full set description; clones fall back to their parent's box
        return { system: r.system, thumbs: r.arcade.src === 'm' ? 'MAME' : 'FBNeo_-_Arcade_Games', exact: [r.arcade.desc, r.arcade.parentDesc].filter(Boolean), titles: [r.internalName], region: null };
      }
      const exact = r.datName ? [r.datName] : [];
      const titles = [r.internalName, rom.nameFromFile(r.originalName || r.file)].filter(Boolean);
      return { system: r.system, exact, titles, region: covers.regionOf(r.datName || r.originalName || '') };
    }
    return { system: ref.system, exact: [], titles: [ref.title].filter(Boolean), region: null };
  }

  coverKey(kind, ref) {
    return kind === 'title' ? `title:${ref.system}:${covers.normTitle(ref.title)}` : `${kind}:${ref}`;
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(() => {}), 800);
  }

  /** Find (or return the saved) cover for a game, a ROM or a title. Resolves to a local image path or null. */
  async cover(kind, ref, { force = false } = {}) {
    const key = this.coverKey(kind, ref);
    const all = this.state.covers || (this.state.covers = {});
    const entry = all[key];
    if (entry && entry.file && !force) {
      if (fs.existsSync(entry.file)) return entry.file;
      delete all[key];
    } else if (entry && entry.none && !force && Date.now() - entry.at < 7 * 24 * 3600 * 1000) {
      return null; // looked recently and found nothing
    }
    if (this.coverJobs.has(key)) return this.coverJobs.get(key);
    const job = this.findCover(kind, ref, key).finally(() => this.coverJobs.delete(key));
    this.coverJobs.set(key, job);
    return job;
  }

  async findCover(kind, ref, key) {
    const want = this.coverWant(kind, ref);
    const sys = { ...(this.systems[want.system] || {}), ...(want.thumbs ? { thumbs: want.thumbs } : {}) };
    const fetchImpl = this.hooks.fetch || fetch;
    const tryUrls = [];
    if (sys.thumbs) {
      let index = null;
      try { index = await this.thumbIndex(sys.thumbs); } catch { /* list unavailable: try the exact names directly */ }
      if (index) {
        const name = covers.bestMatch(index, want);
        if (name) tryUrls.push({ url: covers.boxartUrl(sys.thumbs, name), source: 'libretro', name });
      } else {
        for (const n of want.exact) tryUrls.push({ url: covers.boxartUrl(sys.thumbs, n), source: 'libretro', name: n });
      }
    }
    for (const t of tryUrls) {
      const file = await this.downloadCover(t.url, key).catch(() => null);
      if (file) return this.rememberCover(key, { file, url: t.url, source: t.source, name: t.name });
    }
    const sgKey = this.state.settings.steamGridKey;
    const title = want.titles[0] || (want.exact[0] ? covers.splitTags(want.exact[0]).base : '');
    if (sgKey && title) {
      const hit = await covers.steamGridCover(title, sgKey, fetchImpl).catch(() => null);
      if (hit) {
        const file = await this.downloadCover(hit.url, key).catch(() => null);
        if (file) return this.rememberCover(key, { file, url: hit.url, source: 'steamgriddb', name: hit.name });
      }
    }
    this.state.covers[key] = { none: true, at: Date.now() };
    this.saveSoon();
    return null;
  }

  rememberCover(key, entry) {
    this.state.covers[key] = { ...entry, at: Date.now() };
    this.saveSoon();
    return entry.file;
  }

  async downloadCover(url, key) {
    return this.limited(async () => {
      const res = await (this.hooks.fetch || fetch)(url, { headers: { 'User-Agent': 'Fulton-Launcher' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const type = covers.imageType(buf);
      if (!type) throw new Error('Not an image');
      await fsp.mkdir(this.coverDir, { recursive: true });
      const file = path.join(this.coverDir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.${type}`);
      await fsp.writeFile(file, buf);
      return file;
    });
  }

  /** Use your own picture as a game's or ROM's cover. */
  async setCustomCover(kind, id, imageFile) {
    const buf = await fsp.readFile(imageFile);
    const type = covers.imageType(buf);
    if (!type) throw new Error('That file is not a PNG, JPG, WebP or GIF image');
    const key = this.coverKey(kind, id);
    const dir = path.join(this.coverDir, 'custom');
    await fsp.mkdir(dir, { recursive: true });
    const old = (this.state.covers || {})[key];
    const file = path.join(dir, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}-${Date.now()}.${type}`);
    await fsp.writeFile(file, buf);
    if (old && old.source === 'custom' && old.file) fsp.rm(old.file, { force: true }).catch(() => {});
    this.state.covers[key] = { file, source: 'custom', at: Date.now() };
    await this.save();
    this.emitChange();
    return file;
  }

  /** Go back to the automatic cover. */
  async resetCover(kind, id) {
    const key = this.coverKey(kind, id);
    const old = (this.state.covers || {})[key];
    if (old && old.source === 'custom' && old.file) await fsp.rm(old.file, { force: true }).catch(() => {});
    delete this.state.covers[key];
    const file = await this.cover(kind, id);
    await this.save();
    this.emitChange();
    return file;
  }

  /** Look for every missing cover now (also retries ones not found before). */
  async findAllCovers({ onProgress } = {}) {
    const items = [...this.games.map((g) => ['game', g.id]), ...this.state.roms.map((r) => ['rom', r.id])];
    let found = 0, missing = 0, done = 0;
    await Promise.all(items.map(async ([kind, id]) => {
      const key = this.coverKey(kind, id);
      const e = this.state.covers[key];
      if (e && e.none) delete this.state.covers[key];
      const file = await this.cover(kind, id).catch(() => null);
      if (file) found++; else missing++;
      done++;
      if (onProgress) onProgress(done, items.length);
    }));
    await this.save();
    this.emitChange();
    return { found, missing, total: items.length };
  }

  // ---------- Metacritic ----------
  /** Fetch (and remember) the Metascore for a game that doesn't have one stored in the catalog. */
  async metascore(gameId, { force = false } = {}) {
    const g = this.game(gameId);
    if (g.metacritic && !force) return g.metacritic;
    const cache = this.state.metaCache || (this.state.metaCache = {});
    const hit = cache[gameId];
    const fresh = hit && hit.v === metacritic.VERSION && Date.now() - hit.fetchedAt < (hit.data ? 30 : 1) * 24 * 3600 * 1000;
    if (hit && fresh && !force) return hit.data || null;
    try {
      const data = await metacritic.lookup(g.title, this.hooks.fetch || fetch);
      cache[gameId] = { fetchedAt: Date.now(), data, v: metacritic.VERSION };
    } catch (e) {
      cache[gameId] = { fetchedAt: Date.now(), data: null, error: e.message, v: metacritic.VERSION };
    }
    await this.save();
    this.emitChange();
    return cache[gameId].data || null;
  }

  // ---------- Fulton updates ----------
  /** Is there a newer Fulton on GitHub? Checked at most every 12 hours unless forced. */
  async checkAppUpdate({ force = false } = {}) {
    if (!force && this.state.settings.checkUpdates === false) return null;
    const hit = this.state.appUpdate;
    if (!force && hit && Date.now() - hit.checkedAt < 12 * 3600 * 1000) return hit.data;
    const data = await update.checkForUpdate({ repo: this.links.repo, current: this.version, fetchImpl: this.hooks.fetch || fetch, token: this.state.settings.githubToken, platform: this.platform });
    this.state.appUpdate = { checkedAt: Date.now(), data: data.available ? data : null, latest: data.latest || null, skipped: data.skipped || null };
    await this.save();
    this.emitChange();
    return { ...data };
  }

  /** Thanks list for the About page: everyone credited in the catalog, with the ports they worked on. */
  credits() {
    const people = new Map();
    for (const g of this.games || []) {
      for (const c of g.credits || []) {
        if (!c || !c.name) continue;
        const key = c.name.toLowerCase();
        if (!people.has(key)) people.set(key, { name: c.name, url: c.url || null, roles: new Set(), games: new Set() });
        const p = people.get(key);
        if (c.role) p.roles.add(c.role.replace(/\s+by$/i, ''));
        p.games.add(g.port || g.title);
        if (!p.url && c.url) p.url = c.url;
        // the port's GitHub owner is usually the team itself
        if (!p.url && g.repo && /port/i.test(c.role || '')) p.url = `https://github.com/${g.repo.split('/')[0]}`;
      }
    }
    return [...people.values()]
      .map((p) => ({ name: p.name, url: p.url, roles: [...p.roles], games: [...p.games].sort() }))
      .sort((a, b) => b.games.length - a.games.length || a.name.localeCompare(b.name));
  }

  // ---------- getting the ROM the right way ----------
  /** How to dump this console's games yourself (catalog/dumping.json). */
  dumpGuide(system) {
    if (!this.dumping) {
      try { this.dumping = JSON.parse(fs.readFileSync(path.join(path.dirname(this.catalogFile), 'dumping.json'), 'utf8')); } catch { this.dumping = { guides: [], fallback: null }; }
    }
    return this.dumping.guides.find((x) => x.systems.includes(system)) || this.dumping.fallback;
  }

  /**
   * Everything the "How do I get this ROM?" panel shows: the dumping guide, the exact dumps the port accepts
   * (from the No-Intro list, so names and SHA-1s are real), and a link to buy the original.
   */
  async romHelp(gameId) {
    const g = this.game(gameId);
    const spec = g.rom || {};
    const sys = this.systems[g.system] || {};
    const out = { guide: this.dumpGuide(g.system), targets: [], more: 0, discIds: spec.discIds || null, checked: false };
    const base = (g.title || '').replace(/^The /, '');
    out.buyUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${base} ${sys.name || ''}`.trim())}`;
    if (!spec.discIds && (spec.titles || spec.sha1)) {
      const dat = await this.loadDat(g.system).catch(() => null);
      if (dat) {
        out.checked = true;
        const seen = new Set();
        const hits = [];
        for (const e of dat.bySha1.values()) {
          if (seen.has(e.name)) continue;
          const m = romdb.matchRomToGame({ system: g.system, sha1: e.sha1, datName: e.name }, g);
          if (m.level !== 'ok') continue;
          seen.add(e.name);
          hits.push({ name: e.name, sha1: e.sha1 });
        }
        // plain retail releases first: preferred region, then the fewest extra tags
        const extra = (n) => romdb.splitName(n).tags.length;
        hits.sort((a, b) => covers.rank(a.name) - covers.rank(b.name) || extra(a.name) - extra(b.name) || a.name.localeCompare(b.name));
        out.targets = hits.slice(0, 5);
        out.more = Math.max(0, hits.length - 5);
      }
    }
    return out;
  }

  async removeUserGame(id) {
    this.state.userGames = this.state.userGames.filter((x) => x.id !== id);
    await this.save();
    this.emitChange();
  }
}

module.exports = { Library };
