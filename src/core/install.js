// Download, extract and locate the game executable. Pure Node.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');

/** Stream a URL to disk, reporting progress (0..1). Verifies a GitHub sha256 digest when given. */
async function download(url, dest, { onProgress, signal, digest, token } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Fulton-Launcher', Accept: 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'follow', signal,
  });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let last = 0;
  const hash = crypto.createHash('sha256');
  const counter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (onProgress && (now - last > 120 || got === total)) { last = now; onProgress(total ? got / total : 0, got, total); }
      cb(null, chunk);
    },
  });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
  if (digest && digest.startsWith('sha256:')) {
    const actual = hash.digest('hex');
    if (actual !== digest.slice(7).toLowerCase()) {
      await fsp.rm(dest, { force: true });
      throw new Error('The download was corrupted (checksum mismatch). Try again.');
    }
  }
  return dest;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    p.stderr && p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${err.slice(-400)}`))));
  });
}

/**
 * Extract an archive. Windows 10+ ships bsdtar as tar.exe, which reads zip, 7z and rar.
 * On other systems use tar/unzip from PATH.
 */
async function extract(archive, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const lower = archive.toLowerCase();
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
      await run(fs.existsSync(tar) ? tar : 'tar', ['-xf', archive, '-C', destDir]);
      return;
    } catch (e) {
      if (!lower.endsWith('.zip')) throw e;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]);
      return;
    }
  }
  if (process.platform === 'darwin') {
    if (lower.endsWith('.dmg')) return extractDmg(archive, destDir);
    // ditto keeps .app bundles intact (symlinks, permissions, code signatures)
    if (lower.endsWith('.zip')) { await run('ditto', ['-x', '-k', archive, destDir]); return; }
  }
  if (lower.endsWith('.zip')) {
    try { await run('unzip', ['-o', '-q', archive, '-d', destDir]); return; } catch { /* fall through to bsdtar */ }
  }
  await run('tar', ['-xf', archive, '-C', destDir]);
}

/** Mac disk image: mount it quietly, copy what's inside (usually Game.app), unmount. */
async function extractDmg(dmg, destDir) {
  const mount = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'cartridge-dmg-'));
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
  try {
    for (const e of await fsp.readdir(mount, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue; // skip the "Applications" shortcut and hidden files
      await run('ditto', [path.join(mount, e.name), path.join(destDir, e.name)]);
    }
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet']).catch(() => run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => {}));
    fsp.rm(mount, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Mac downloads are often a zip with a disk image inside (Ship of Harkinian: SoH-Mac.zip → SoH.dmg → soh.app),
 * or a zipped app. When no .app is visible after unpacking, open those too, so the game ends up ready to play.
 */
async function expandNested(dir) {
  if (process.platform !== 'darwin') return false;
  let changed = false;
  for (let round = 0; round < 2; round++) {
    const items = await walk(dir, 0, [], { apps: true });
    if (items.some((f) => f.app)) return changed;
    const inner = items.filter((f) => !f.app && /\.(dmg|zip)$/i.test(f.full));
    if (!inner.length) return changed;
    for (const f of inner) {
      const into = path.dirname(f.full);
      if (/\.dmg$/i.test(f.full)) await extractDmg(f.full, into);
      else await run('ditto', ['-x', '-k', f.full, into]);
      await fsp.rm(f.full, { force: true });
      changed = true;
    }
  }
  return changed;
}

/** Mac: the downloaded game isn't marked as "from the internet" by us, but clear the flag anyway so it opens without a prompt. */
async function clearQuarantine(dir) {
  if (process.platform !== 'darwin') return;
  await run('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => {});
}

/** The files inside a zip/7z without unpacking it (for big archives). Returns [{ name, size }]. */
async function listArchive(archive) {
  const out = await new Promise((resolve, reject) => {
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const tryCmd = (cmd, args, next) => {
      const p = spawn(cmd, args, { windowsHide: true });
      let txt = '';
      p.stdout.on('data', (d) => { txt += d; });
      p.on('error', () => (next ? next() : reject(new Error('no archive lister'))));
      p.on('close', (code) => (code === 0 ? resolve({ cmd, txt }) : next ? next() : reject(new Error(`${cmd} exited ${code}`))));
    };
    // bsdtar (Windows 10+, macOS) lists zip and 7z; unzip covers Linux zips
    tryCmd(fs.existsSync(tar) || process.platform !== 'win32' ? tar : 'tar', ['-tvf', archive],
      () => tryCmd('unzip', ['-Z', '-l', archive]));
  });
  const files = [];
  for (const line of out.txt.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('d')) continue;
    if (out.cmd === 'unzip') {
      // -rw-r--r--  3.0 unx  12345 bx  12345 defN 24-Oct-19 21:00 folder/name.3ds
      const m = line.match(/^[-l][rwx-]{9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      if (m) files.push({ name: m[2], size: Number(m[1]) });
    } else {
      // -rw-r--r--  0 0      0   12345 Oct 19 21:00 folder/name.3ds
      const m = line.match(/^[-l][rwx-]{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      if (m) files.push({ name: m[2], size: Number(m[1]) });
    }
  }
  return files;
}

/** If an archive extracted into a single wrapper folder, return that folder instead. */
async function unwrap(dir) {
  let cur = dir;
  for (let i = 0; i < 3; i++) {
    const entries = (await fsp.readdir(cur, { withFileTypes: true })).filter((e) => !e.name.startsWith('__MACOSX'));
    if (entries.length === 1 && entries[0].isDirectory()) cur = path.join(cur, entries[0].name);
    else break;
  }
  return cur;
}

/** Copy everything from src into dest, overwriting files but keeping files that only exist in dest (saves, configs). */
async function mergeInto(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(src, dest, { recursive: true, force: true });
}

async function walk(dir, depth = 0, out = [], opts = {}) {
  if (depth > 4) return out;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && opts.apps && /\.app$/i.test(e.name)) { out.push({ full, depth, size: 0, app: true }); continue; }
    if (e.isDirectory()) await walk(full, depth + 1, out, opts);
    else out.push({ full, depth, size: (await fsp.stat(full)).size });
  }
  return out;
}


/** Every file and link under a folder, at any depth, as Map(relative path -> size). Empty folders are included as "dir/". */
async function treeStats(dir, base = dir, out = new Map()) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (e.isSymbolicLink()) out.set(rel, -1);
    else if (e.isDirectory()) { const n = out.size; await treeStats(full, base, out); if (out.size === n) out.set(rel + '/', 0); }
    else out.set(rel, (await fsp.stat(full)).size);
  }
  return out;
}

/**
 * Copy a whole folder (any depth), keeping file permissions (the executable bit matters on Mac and Linux) and links.
 * Big files are streamed so progress moves smoothly. onBytes(n) is called as bytes are written; `signal` cancels.
 */
async function copyTree(src, dest, { onBytes = () => {}, signal } = {}) {
  const check = () => { if (signal && signal.aborted) throw new Error('cancelled'); };
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    check();
    const from = path.join(src, e.name), to = path.join(dest, e.name);
    if (e.isSymbolicLink()) { await fsp.symlink(await fsp.readlink(from), to); continue; }
    if (e.isDirectory()) { await copyTree(from, to, { onBytes, signal }); continue; }
    const st = await fsp.stat(from);
    if (st.size < 32 * 1024 * 1024) { await fsp.copyFile(from, to); onBytes(st.size); }
    else {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(from), ws = fs.createWriteStream(to);
        rs.on('data', (c) => { onBytes(c.length); if (signal && signal.aborted) { rs.destroy(new Error('cancelled')); } });
        rs.on('error', (er) => { ws.destroy(); reject(er); });
        ws.on('error', reject); ws.on('finish', resolve);
        rs.pipe(ws);
      });
    }
    await fsp.chmod(to, st.mode & 0o7777).catch(() => {});
  }
}

const NOT_THE_GAME = /(unins|setup|vc_?redist|vcredist|crashpad|crash_?handler|dxsetup|dxwebsetup|updater|uninstall|7z(a|r)?\.exe$|dotnet)/i;

/** Mac: turn the catalog's Windows exe hint ("soh\\.exe$") into one for app bundles ("soh"). */
const macHint = (hint) => (hint ? String(hint).replace(/\\\.exe\$?/gi, '').replace(/\.exe\$?/gi, '').replace(/\$$/, '') : hint);

/** Find the game executable inside an install folder. exeHint is an optional regex string. On a Mac this is the .app bundle. */
async function findExecutable(dir, exeHint, platform = process.platform) {
  if (platform === 'darwin') {
    const found = await walk(dir, 0, [], { apps: true });
    let apps = found.filter((f) => f.app && !NOT_THE_GAME.test(path.basename(f.full)));
    const hint = macHint(exeHint);
    if (hint && apps.length > 1) {
      let re = null; try { re = new RegExp(hint, 'i'); } catch { /* bad hint */ }
      const hinted = re ? apps.filter((f) => re.test(path.basename(f.full, '.app'))) : [];
      if (hinted.length) apps = hinted;
    }
    apps.sort((a, b) => a.depth - b.depth);
    if (apps.length) return apps[0].full;
    // no app bundle: a plain command-line build
    const bins = found.filter((f) => !f.app && !path.extname(f.full) && f.size > 500 * 1024 && !NOT_THE_GAME.test(path.basename(f.full)));
    bins.sort((a, b) => a.depth - b.depth || b.size - a.size);
    return bins.length ? bins[0].full : null;
  }
  const files = await walk(dir);
  const isExe = platform === 'win32'
    ? (f) => /\.exe$/i.test(f.full)
    // Linux: an AppImage, a plain binary (Zelda64Recomp), or one with an arch suffix (game.x86_64)
    : (f) => /\.(appimage|x86_64|x64|bin)$/i.test(f.full) || (!path.extname(f.full) && f.size > 500 * 1024);
  // tools inside a bundled Java (jdk25\\bin\\jaccessinspector.exe...) are never the game
  const inJava = (f) => /(^|[\\/])(jdk|jre|java|openjdk)[^\\/]*[\\/]/i.test(path.relative(dir, f.full));
  let cands = files.filter(isExe).filter((f) => !NOT_THE_GAME.test(path.basename(f.full)) && !inJava(f));
  if (!cands.length && platform === 'win32') {
    // no .exe: some games (Java ones like Severed Chains) start from a launch script at the top of the folder
    const scripts = files.filter((f) => f.depth <= 1 && /\.(bat|cmd)$/i.test(f.full) && !NOT_THE_GAME.test(path.basename(f.full)) && !/(optional|install|config|uninst)/i.test(path.basename(f.full)));
    const rank = (f) => (/^(launch|start|run|play)/i.test(path.basename(f.full)) ? 0 : 1);
    scripts.sort((a, b) => rank(a) - rank(b) || a.depth - b.depth);
    return scripts.length ? scripts[0].full : null;
  }
  if (!cands.length && platform === 'linux') {
    // no binary: Java and script-based games start from a .sh at the top of the folder
    const scripts = files.filter((f) => f.depth <= 1 && /\.sh$/i.test(f.full) && !NOT_THE_GAME.test(path.basename(f.full)) && !/(optional|install|config|uninst|setup)/i.test(path.basename(f.full)));
    const rank = (f) => (/^(launch|start|run|play)/i.test(path.basename(f.full)) ? 0 : 1);
    scripts.sort((a, b) => rank(a) - rank(b) || a.depth - b.depth);
    return scripts.length ? scripts[0].full : null;
  }
  if (exeHint) {
    const re = new RegExp(exeHint, 'i');
    const hinted = cands.filter((f) => re.test(path.relative(dir, f.full).replace(/\\/g, '/')) || re.test(path.basename(f.full)));
    if (hinted.length) cands = hinted;
  }
  cands.sort((a, b) => a.depth - b.depth || b.size - a.size);
  return cands.length ? cands[0].full : null;
}

module.exports = { treeStats, copyTree, listArchive, download, extract, unwrap, mergeInto, findExecutable, walk, clearQuarantine, macHint, expandNested };
