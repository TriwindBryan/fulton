'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Library } = require('./src/core/library');
const { Inspector } = require('./src/core/inspector');
const { makeZip } = require('./src/core/zipwrite');

// ---------- log file (%APPDATA%\Fulton\fulton.log): what started, how long it took, and anything that froze the window
let logFile = null;
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* never let logging break anything */ }
}
function startLog() {
  logFile = path.join(app.getPath('userData'), 'fulton.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // keep it small: start over once it passes 512 KB
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.writeFileSync(logFile, '');
  } catch { /* ignore */ }
  log(`---- Fulton ${app.getVersion()} starting (${process.platform} ${require('os').release()} ${process.arch}, Electron ${process.versions.electron})`);
  // if the main process is ever stuck for more than 2 seconds, write down for how long
  let last = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    if (now - last > 2500) log(`Main process was busy for ${((now - last - 500) / 1000).toFixed(1)}s`);
    last = now;
  }, 500);
  tick.unref();
}

let win;
let lib;

// ---------- the app used to be called Cartridge: carry its saved data over to the new folder on first start ----------
// Copies (never moves), so the old folder stays as a backup and an older version still works. Runs before anything reads the data.
const OLD_DATA_FOLDERS = ['Cartridge'];
const SKIP_CHROMIUM = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Session Storage', 'Network', 'blob_storage',
  'Shared Dictionary', 'SharedStorage', 'Local Storage', 'IndexedDB', 'Partitions', 'Crashpad', 'component_crx_cache', 'Dictionaries', 'Singleton', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);
function migrateOldData() {
  try {
    const next = app.getPath('userData');
    if (fs.existsSync(path.join(next, 'state.json'))) return null; // already in use
    for (const name of OLD_DATA_FOLDERS) {
      const prev = path.join(app.getPath('appData'), name);
      if (!fs.existsSync(path.join(prev, 'state.json'))) continue;
      fs.mkdirSync(next, { recursive: true });
      fs.cpSync(prev, next, { recursive: true, force: false, errorOnExist: false, filter: (src) => !SKIP_CHROMIUM.has(path.basename(src)) || path.dirname(src) !== prev });
      // pictures and other files saved inside the old folder are now in the new one: point the settings at them
      const file = path.join(next, 'state.json');
      const swap = (t) => JSON.stringify(t).slice(1, -1);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(swap(prev)).join(swap(next)));
      return prev;
    }
  } catch (e) { return { error: String(e && e.message || e) }; }
  return null;
}
let migratedFrom = null;

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: '#14161b',
    // the name people see ("Beta 0.0001"); the version number behind it keeps counting so installs and updates work
    title: `Fulton ${(require('./package.json').cartridge || {}).label || app.getVersion().replace(/\.0$/, '')}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => log('Window ready'));
  win.on('unresponsive', () => log('Window stopped responding'));
  win.on('responsive', () => log('Window responding again'));
  win.webContents.on('render-process-gone', (_e, d) => log(`Window process ended: ${d.reason}`));
}

// Many changes can arrive in a burst (a scan, release checks, covers). Send the window one update per burst, not one per change.
let pushTimer = null;
const push = () => {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!win || win.isDestroyed()) return;
    const t = Date.now();
    win.webContents.send('state', lib.snapshot());
    const ms = Date.now() - t;
    if (ms > 500) log(`Sending the library to the window took ${ms}ms (${lib.state.roms.length} ROMs)`);
  }, 120);
};

app.whenReady().then(async () => {
  migratedFrom = migrateOldData();
  startLog();
  if (migratedFrom && migratedFrom.error) log(`Could not copy the old Cartridge data: ${migratedFrom.error}`);
  else if (migratedFrom) log(`Copied your saved data from ${migratedFrom}`);
  const t0 = Date.now();
  // the ROM checker runs on its own thread; in the installed app it lives outside app.asar (see asarUnpack)
  const inspector = new Inspector(path.join(__dirname, 'src', 'core', 'inspect-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), log);
  lib = new Library({
    startEmpty: true, // a new install starts with an empty shelf; Find more adds games
    dataDir: app.getPath('userData'),
    catalogFile: path.join(__dirname, 'catalog', 'games.json'),
    hooks: {
      copyToClipboard: (t) => clipboard.writeText(t),
      revealFile: (p) => shell.showItemInFolder(p),
      // Chromium's network stack (same as a browser) so sites like Metacritic answer normally
      fetch: (url, opts) => net.fetch(url, opts),
      inspectRom: (file) => inspector.inspect(file),
      log,
    },
  });
  await lib.load();
  log(`Library loaded in ${Date.now() - t0}ms: ${lib.state.roms.length} ROMs, ${(lib.state.settings.romFolders || []).length} ROM folder(s)`);
  app.on('before-quit', () => inspector.close());
  lib.on('change', push);
  // Bring the launcher back to the front when a game closes, so a controller keeps working without a mouse.
  lib.on('exited', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  lib.on('job', (id, job) => { if (win && !win.isDestroyed()) win.webContents.send('job', id, Library.publicJob(job)); });

  const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  handle('state', () => lib.snapshot());
  handle('refresh', (force) => lib.refreshReleases({ force }));
  handle('install', (id) => lib.install(id));
  handle('cancel', (id) => lib.cancel(id));
  handle('linkExe', async (id) => {
    const g = lib.game(id);
    const win32 = process.platform === 'win32';
    const r = await dialog.showOpenDialog(win, {
      title: `Where is your copy of ${g.port}?`,
      buttonLabel: 'Use this',
      properties: ['openFile'],
      filters: win32 ? [{ name: 'Game or launch script', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }] : [],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const cur = lib.state.installed[id];
    if (cur && !cur.manual) {
      // Fulton installed its own download earlier: swap it for the player's copy in one go
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Use my copy', 'Cancel'], defaultId: 0, cancelId: 1,
        message: `Use your own copy of ${g.port}?`,
        detail: `Fulton will back up the saves in its downloaded copy (${cur.tag}), remove that download, and start your copy from now on. Nothing in your own folder is changed.`,
      });
      if (response !== 0) return null;
      await lib.uninstall(id);
    }
    return lib.linkInstall(id, r.filePaths[0]);
  });
  handle('uninstall', async (id) => {
    const g = lib.game(id);
    if ((lib.state.installed[id] || {}).manual) { await lib.uninstall(id); return true; }
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Uninstall', 'Keep it'], defaultId: 1, cancelId: 1,
      message: `Uninstall ${g.port}?`, detail: 'This deletes the game folder, including any saves and settings stored inside it. Your ROM stays in your library.',
    });
    if (response === 0) await lib.uninstall(id);
    return response === 0;
  });
  handle('launch', (id, opts) => lib.launch(id, opts));
  handle('addRoms', (paths) => lib.addRoms(paths));
  handle('pickRoms', async (mode) => {
    const res = await dialog.showOpenDialog(win, mode === 'folder'
      ? { title: 'Choose a folder of ROMs', properties: ['openDirectory'] }
      : { title: 'Choose ROM files', properties: ['openFile', 'multiSelections'], filters: [
        { name: 'ROMs and disc images', extensions: [...require('./src/core/rom').ROM_EXTENSIONS.map((e) => e.slice(1)), 'zip', '7z'] },
        { name: 'All files', extensions: ['*'] },
      ] });
    if (res.canceled || !res.filePaths.length) return null;
    return lib.addRoms(res.filePaths);
  });
  handle('removeRom', (id) => lib.removeRom(id));
  handle('addRomFolder', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose the folder where you keep your ROMs (subfolders are searched too)', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    return lib.addRomFolder(res.filePaths[0]);
  });
  handle('removeRomFolder', (dir) => lib.removeRomFolder(dir));
  handle('scanRomFolders', (full) => lib.scanRomFolders({ full }));
  handle('assignRom', (gameId, romId) => lib.assignRom(gameId, romId));
  handle('settings', (patch) => lib.updateSettings(patch));
  handle('checkAppUpdate', (force) => lib.checkAppUpdate({ force: !!force }));
  handle('credits', () => lib.credits());
  handle('romHelp', (id) => lib.romHelp(id));
  handle('romCopies', () => lib.romCopies());
  handle('checkSetup', () => lib.checkSetup());
  handle('fixSetup', (fixId) => lib.fixSetup(String(fixId)));
  handle('forgetMissing', async () => {
    const n = lib.state.roms.filter((r) => r.missing).length;
    if (!n) return 0;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Remove from list', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Remove ${n.toLocaleString()} missing ROM${n > 1 ? 's' : ''} from the list?`,
      detail: "Their files are already gone (or on a drive that isn't connected). This only tidies Fulton's list; no files are deleted. If they come back, a rescan finds them again.",
    });
    return response === 0 ? lib.forgetMissing() : null;
  });
  handle('removeRomCopies', async () => {
    const info = await lib.romCopies();
    if (!info.count) return { removed: 0, freed: 0 };
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Remove copies', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove ${info.count.toLocaleString()} ROM copies?`,
      detail: "These copies were made by older versions of Fulton, from ROMs that aren't in a watched ROM folder. Your own ROM files aren't touched. The ROMs disappear from My ROMs; add their folder again to bring them back.",
    });
    return response === 0 ? lib.removeRomCopies() : null;
  });
  handle('pickBackground', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose a background image', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (res.canceled || !res.filePaths.length) return null;
    const fs = require('fs');
    const dir = path.join(app.getPath('userData'), 'backgrounds');
    fs.mkdirSync(dir, { recursive: true });
    // keep our own copy so moving or deleting the original doesn't break the background
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
    const dest = path.join(dir, `background-${Date.now()}${path.extname(res.filePaths[0]).toLowerCase()}`);
    fs.copyFileSync(res.filePaths[0], dest);
    await lib.updateSettings({ backgroundImage: dest });
    return dest;
  });
  handle('clearBackground', async () => {
    await lib.updateSettings({ backgroundImage: '' });
    const fs = require('fs');
    const dir = path.join(app.getPath('userData'), 'backgrounds');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
    return true;
  });
  handle('pickLibraryDir', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Where should games and ROMs live?', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    await lib.updateSettings({ libraryDir: res.filePaths[0] });
    return res.filePaths[0];
  });
  handle('openFolder', (id) => {
    const i = lib.state.installed[id];
    return shell.openPath(i ? path.dirname(i.exe) : lib.dirs.root);
  });
  handle('openPath', (p) => shell.openPath(p || lib.dirs.root));
  handle('reveal', (p) => shell.showItemInFolder(p));
  handle('openLog', () => shell.openPath(logFile));
  // "Report a problem": one zip with the log and the basics (never tokens or keys), saved where you choose
  handle('reportProblem', async () => {
    const os = require('os');
    let snap = null;
    try { snap = lib.snapshot(); } catch { /* still make a report */ }
    const settings = { ...((lib.state && lib.state.settings) || {}) };
    for (const k of Object.keys(settings)) if (/token|key|secret|password/i.test(k) && settings[k]) settings[k] = '(set, hidden)';
    const games = snap ? snap.games.map((g) => `${g.id}\t${g.system}\t${g.installed ? `installed ${g.installed.tag || ''}` : 'not installed'}${g.running ? ' (running)' : ''}${g.updateAvailable ? ' (update available)' : ''}`) : [];
    const info = [
      `Fulton ${app.getVersion()} (${(require('./package.json').cartridge || {}).label || ''})`,
      `Platform: ${process.platform} ${os.release()} ${process.arch}`,
      `Electron ${process.versions.electron}, Node ${process.versions.node}`,
      `Memory: ${Math.round(os.totalmem() / 1048576)} MB total, ${Math.round(os.freemem() / 1048576)} MB free`,
      `Created: ${new Date().toISOString()}`,
      '', 'Settings (tokens and keys hidden):', JSON.stringify(settings, null, 2),
      '', `Games on the shelf: ${games.length}`, ...games,
    ].join('\n');
    let logText = '';
    try { logText = fs.readFileSync(logFile, 'utf8'); } catch { logText = '(no log yet)'; }
    const zip = makeZip([{ name: 'info.txt', data: info }, { name: 'fulton.log', data: logText }, { name: 'README.txt', data: 'Send this file to the developer. It holds your Fulton version, settings (without tokens or keys), the list of games on your shelf, and the log. It does not include your ROMs, saves or any game files.' }]);
    const res = await dialog.showSaveDialog(win, { title: 'Save problem report', defaultPath: path.join(app.getPath('downloads'), 'Fulton-problem-report.zip'), filters: [{ name: 'Zip file', extensions: ['zip'] }] });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, zip);
    shell.showItemInFolder(res.filePath);
    log(`Problem report saved: ${res.filePath}`);
    return res.filePath;
  });
  handle('log', (text) => { log(`UI: ${String(text).slice(0, 500)}`); });
  handle('openUrl', (url) => { if (/^https:\/\//.test(url)) return shell.openExternal(url); return null; });

  // ---------- save backups ----------
  handle('listBackups', (id) => lib.listBackups(id));
  handle('backupNow', (id) => lib.backupGame(id, 'manual'));
  handle('backupAll', () => lib.backupAll());
  handle('restoreBackup', async (id, backupId) => {
    const g = lib.game(id);
    const b = (await lib.listBackups(id)).find((x) => x.id === backupId);
    const when = b ? new Date(b.createdAt).toLocaleString() : '';
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Restore ${g.port} saves from ${when}?`,
      detail: 'Your current saves are backed up first, so you can undo this from the same list.',
    });
    if (response !== 0) return { cancelled: true };
    await lib.restoreBackup(id, backupId);
    return { restored: true };
  });
  handle('openBackups', (id) => {
    const dir = id ? path.join(lib.dirs.backups, id) : lib.dirs.backups;
    require('fs').mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('pickBackupDir', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Where should save backups go? (A OneDrive or Google Drive folder keeps them in the cloud too)', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    await lib.updateSettings({ backupDir: res.filePaths[0] });
    return res.filePaths[0];
  });
  lib.on('backup', (id, b) => { if (win && !win.isDestroyed()) win.webContents.send('backup', id, { id: b.id, reason: b.reason, files: b.files }); });

  // ---------- Add to Steam ----------
  const steam = require('./src/core/steam');
  const { spawn } = require('child_process');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function steamInfo() {
    const root = await steam.findSteamRoot();
    if (!root) return { found: false };
    const user = await steam.findUserDir(root);
    return { found: !!user, root, userId: user && user.id, userDir: user && user.dir, running: await steam.isSteamRunning() };
  }
  async function closeSteam(root) {
    if (process.platform === 'darwin') {
      try { spawn('osascript', ['-e', 'quit app "Steam"'], { detached: true, stdio: 'ignore' }).unref(); } catch { /* fall back to the URL */ }
    } else {
      const exe = process.platform === 'win32' ? path.join(root, 'steam.exe') : 'steam';
      try { spawn(exe, ['-shutdown'], { detached: true, stdio: 'ignore' }).unref(); } catch { /* fall back to the URL */ }
    }
    shell.openExternal('steam://exit').catch(() => {});
    for (let i = 0; i < 40; i++) { await sleep(500); if (!(await steam.isSteamRunning())) return true; }
    return false;
  }
  function startSteam(root) {
    if (process.platform === 'darwin') { try { spawn('open', ['-a', 'Steam'], { detached: true, stdio: 'ignore' }).unref(); } catch { shell.openExternal('steam://open/games').catch(() => {}); } return; }
    const exe = process.platform === 'win32' ? path.join(root, 'steam.exe') : 'steam';
    try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); } catch { shell.openExternal('steam://open/games').catch(() => {}); }
  }
  const fromDataUrl = (u) => (typeof u === 'string' && u.startsWith('data:image/png;base64,') ? Buffer.from(u.slice(22), 'base64') : null);

  handle('steamStatus', async () => { const s = await steamInfo(); return { found: s.found, running: !!s.running }; });

  /** items: [{ id, art: { portrait, wide, hero, logo } }] — one Steam restart for any number of games. */
  handle('addToSteam', async (items) => {
    const info = await steamInfo();
    if (!info.found) throw new Error(`Couldn't find Steam on this ${process.platform === 'darwin' ? 'Mac' : 'PC'}. Install Steam and sign in once, then try again.`);
    const wasRunning = info.running;
    if (wasRunning) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Close Steam and add', 'Cancel'], defaultId: 0, cancelId: 1,
        message: 'Steam needs to close for a moment',
        detail: 'Steam rewrites its shortcut list when it exits, so it has to be closed while Fulton adds games. It reopens straight after.',
      });
      if (response !== 0) return { cancelled: true };
      if (!(await closeSteam(info.root))) throw new Error("Steam didn't close. Close it from the system tray and try again.");
    }
    const added = [];
    for (const { id, art } of items) {
      const g = lib.game(id);
      const inst = lib.state.installed[id];
      if (!inst || !inst.exe) continue;
      await lib.prepareRom(g, inst).catch(() => {}); // put the ROM in place so launching from Steam just works
      const appid = await steam.addShortcut(info.userDir, {
        name: g.port === g.title ? g.title : `${g.title} (${g.port})`,
        exe: inst.exe, startDir: path.dirname(inst.exe), icon: inst.exe,
        tags: ['Fulton', (lib.systems[g.system] || {}).name || g.system],
      });
      await steam.writeArtwork(info.userDir, appid, art ? {
        portrait: fromDataUrl(art.portrait), wide: fromDataUrl(art.wide), hero: fromDataUrl(art.hero), logo: fromDataUrl(art.logo),
      } : null);
      lib.state.steam = lib.state.steam || {};
      lib.state.steam[id] = { appid, userId: info.userId, exe: inst.exe, addedAt: Date.now() };
      added.push(id);
    }
    await lib.save();
    lib.emitChange();
    if (wasRunning) startSteam(info.root);
    return { added, restarted: wasRunning };
  });

  handle('removeFromSteam', async (id) => {
    const info = await steamInfo();
    const rec = (lib.state.steam || {})[id];
    if (!info.found || !rec) { if (rec) { delete lib.state.steam[id]; await lib.save(); lib.emitChange(); } return { removed: 0 }; }
    const wasRunning = info.running;
    if (wasRunning) {
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Close Steam and remove', 'Cancel'], defaultId: 0, cancelId: 1,
        message: 'Steam needs to close for a moment', detail: 'It reopens straight after.' });
      if (response !== 0) return { cancelled: true };
      await closeSteam(info.root);
    }
    const removed = await steam.removeShortcut(info.userDir, rec.exe);
    await steam.removeArtwork(info.userDir, rec.appid);
    delete lib.state.steam[id];
    await lib.save();
    lib.emitChange();
    if (wasRunning) startSteam(info.root);
    return { removed };
  });

  handle('copy', (text) => clipboard.writeText(String(text)));
  handle('discover', (q) => require('./src/core/github').discover(q, lib.state.settings.githubToken));
  handle('addUserGame', (entry) => lib.addUserGame(entry));
  handle('communityList', (force) => lib.communityList({ force }));
  handle('discoverVisited', () => lib.discoverVisited());
  handle('markDiscoverSeen', () => lib.markDiscoverSeen());
  handle('checkPlatforms', async () => {
    const { items } = await lib.communityList();
    let last = 0;
    const send = (done, total) => { if (win && !win.isDestroyed()) win.webContents.send('platformProgress', { done, total }); };
    lib.checkPlatforms(items, { onProgress: (done, total) => { if (Date.now() - last > 700 || done === total) { last = Date.now(); send(done, total); } } })
      .then(() => send(1, 1)).catch(() => send(1, 1));
    return true;
  });
  handle('setFavorite', (id, on) => lib.setFavorite(id, !!on));
  handle('addCommunityGame', (key) => lib.addCommunityGame(key));
  handle('removeFromShelf', (id) => lib.removeFromShelf(id));
  handle('metascore', (id, force) => lib.metascore(id, { force }));
  // cover art
  const coverKinds = new Set(['game', 'rom', 'title']);
  handle('cover', (kind, ref) => { if (!coverKinds.has(kind)) throw new Error('Bad cover kind'); return lib.cover(kind, ref); });
  handle('pickCover', async (kind, id) => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose a cover image', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (res.canceled || !res.filePaths.length) return null;
    return lib.setCustomCover(kind, id, res.filePaths[0]);
  });
  handle('setCoverFile', (kind, id, file) => lib.setCustomCover(kind, id, file));
  handle('resetCover', (kind, id) => lib.resetCover(kind, id));
  handle('findAllCovers', () => lib.findAllCovers({ onProgress: (done, total) => win && win.webContents.send('coverProgress', { done, total }) }));
  handle('imageData', async (file) => {
    // only images Fulton saved itself (covers), handed to the canvas that draws Steam artwork
    const full = path.resolve(file);
    if (!full.startsWith(path.resolve(lib.coverDir) + path.sep)) throw new Error('Not a cover image');
    const buf = await require('fs').promises.readFile(full);
    const type = require('./src/core/covers').imageType(buf);
    if (!type) throw new Error('Not an image');
    return `data:image/${type === 'jpg' ? 'jpeg' : type};base64,${buf.toString('base64')}`;
  });
  handle('removeUserGame', (id) => lib.removeUserGame(id));

  // Mac: a normal app menu, so Cmd+Q, Cmd+W, copy/paste and full screen work as Mac users expect
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]));
  }
  createWindow();
  // Mac: clicking the Dock icon with no window open brings one back
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); else win.show(); });
  const tr = Date.now();
  lib.refreshReleases().then(() => log(`Checked ports for updates in ${((Date.now() - tr) / 1000).toFixed(1)}s`), (e) => log(`Checking ports for updates failed: ${e.message}`));
  setInterval(() => { lib.refreshReleases().catch(() => {}); }, 6 * 3600 * 1000);
  // Pick up any ROMs added to the saved folders since last time.
  lib.on('scan', (on) => { if (win && !win.isDestroyed()) win.webContents.send('scan', on); });
  const notice = (title, body, kind = 'ok') => { if (win && !win.isDestroyed()) win.webContents.send('notice', { title, body, kind }); };
  const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
  setTimeout(async () => {
    // updating from a version that copied every ROM: point at the originals and delete the copies (once)
    if (!lib.state.romCopiesMigrated) {
      const before = await lib.romCopies().catch(() => ({ count: 0 }));
      if (before.count) notice(before.bytes ? 'Freeing up space' : 'Updating your ROM list', before.bytes
        ? `Older versions of Fulton kept a copy of ${before.count.toLocaleString()} ROMs (${gb(before.bytes)}). Fulton now uses your ROMs where they are, and is removing the copies…`
        : `Pointing ${before.count.toLocaleString()} ROMs at your own files instead of old copies. This takes a few minutes with a big collection…`, '');
      const res = await lib.migrateRomCopies().catch((e) => {
        log(`ROM copy clean-up failed: ${e.message}`);
        if (e.code === 'ENOSPC') notice("Couldn't finish freeing up space", e.message, 'bad');
        return null;
      });
      if (res) {
        log(`ROM copy clean-up: ${res.relinked} relinked, ${res.freed} bytes freed, ${res.left.count} copies left`);
        if (res.freed) notice(`Freed ${gb(res.freed)}`, `${res.relinked.toLocaleString()} ROMs now point at your own files instead of copies.${res.left.count ? ` ${res.left.count.toLocaleString()} copies are left (Settings → ROM copies).` : ''}`);
        else if (res.left.count) notice('ROM copies', `${res.left.count.toLocaleString()} ROMs are still stored as copies (${gb(res.left.bytes)}). You can remove them in Settings → ROM copies.`, 'warn');
      }
    }
    const report = await lib.scanRomFolders().catch((e) => {
      log(`ROM scan failed: ${e.message}`);
      if (e.code === 'ENOSPC') notice("Couldn't check all your ROMs", e.message, 'bad');
      return [];
    });
    // a nearly full drive breaks installs, saves and Windows itself: say so plainly
    for (const d of await lib.diskStatus().catch(() => [])) {
      if (d.low) notice(`Your ${d.drive} is almost full`, `Only ${require('./src/core/disk').fmt(d.free)} is free. Installs and save backups may fail. Free up some space; Help → Check my setup shows what's using Fulton's space.`, 'warn');
    }
    const added = report.filter((r) => r.status === 'added');
    if (added.length && win && !win.isDestroyed()) win.webContents.send('scanReport', report);
  }, 1500);
  // Is there a newer Fulton? (quietly skipped when offline or before the first release exists)
  setTimeout(() => lib.checkAppUpdate().catch(() => null), 8000);
});

app.on('window-all-closed', () => app.quit());
