'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const rom = require('../src/core/rom');
const romdb = require('../src/core/romdb');
const gh = require('../src/core/github');
const inst = require('../src/core/install');
const { Library } = require('../src/core/library');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'games.json'), 'utf8'));
const G = (id) => catalog.games.find((g) => g.id === id);

function fakeN64(name, serial, size = 1024 * 1024) {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(0x80371240, 0);
  b.write(name.padEnd(20, ' '), 0x20, 'latin1');
  b.write(serial, 0x3b, 'latin1');
  for (let i = 0x1000; i < size; i += 4) b.writeUInt32BE((i * 2654435761) >>> 0, i);
  return b;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cart-test-'));

test('N64 byte orders normalise to the same z64 bytes', () => {
  const z = fakeN64('SUPER MARIO 64', 'NSME');
  const v = Buffer.from(z).swap16();
  const n = Buffer.from(z).swap32();
  assert.equal(rom.n64Order(z), 'z64');
  assert.equal(rom.n64Order(v), 'v64');
  assert.equal(rom.n64Order(n), 'n64');
  assert.ok(rom.toZ64(v).equals(z));
  assert.ok(rom.toZ64(n).equals(z));
  const h = rom.parseN64Header(z);
  assert.equal(h.internalName, 'SUPER MARIO 64');
  assert.equal(h.serial, 'NSME');
});

test('inspectRom reads a .v64 file and hashes the normalised data', async () => {
  const d = tmp();
  const z = fakeN64('ZELDA MAJORA\'S MASK', 'NZSE');
  fs.writeFileSync(path.join(d, 'mm.v64'), Buffer.from(z).swap16());
  const info = await rom.inspectRom(path.join(d, 'mm.v64'));
  assert.equal(info.format, 'v64');
  assert.equal(info.sha1, rom.sha1(z));
  assert.equal(info.serial, 'NZSE');
});

test('GameCube RVZ disc ID is read from the embedded header', () => {
  const d = tmp();
  const b = Buffer.alloc(0x200);
  b.write('RVZ\x01', 0, 'latin1');
  b.write('GZ2E01', 0x58, 'latin1');
  b.write('The Legend of Zelda Twilight Princess', 0x58 + 0x20, 'latin1');
  fs.writeFileSync(path.join(d, 'tp.rvz'), b);
  const h = rom.readDiscHeader(path.join(d, 'tp.rvz'));
  assert.equal(h.serial, 'GZ2E01');
  assert.match(h.internalName, /Twilight/);
});

const DAT = `clrmamepro (
\tname "Nintendo - Nintendo 64"
)

game (
\tname "Legend of Zelda, The - Majora's Mask (USA)"
\tregion "USA"
\tserial "NZSE"
\trom ( name "Legend of Zelda, The - Majora's Mask (USA).z64" size 33554432 crc 00000000 md5 00 sha1 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA serial "NZSE" )
)

game (
\tname "Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es)"
\tregion "Europe"
\tserial "NZSP"
\trom ( name "x.z64" size 1 crc 0 md5 0 sha1 BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB serial "NZSP" )
)

game (
\tname "Perfect Dark (USA) (Rev 1)"
\tregion "USA"
\tserial "NPDE"
\trom ( name "pd.z64" size 1 crc 0 md5 0 sha1 CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC serial "NPDE" )
)

game (
\tname "Perfect Dark (USA)"
\tregion "USA"
\tserial "NPDE"
\trom ( name "pd10.z64" size 1 crc 0 md5 0 sha1 DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD serial "NPDE" )
)
`;

test('DAT parsing indexes by sha1 and serial', () => {
  const db = romdb.parseDat(DAT);
  assert.equal(db.size, 4);
  assert.equal(db.bySha1.get('A'.repeat(40)).name, "Legend of Zelda, The - Majora's Mask (USA)");
  assert.equal(db.bySerial.get('NZSP').region, 'Europe');
});

test('ROM matching: region, required tags and header fallback', () => {
  const mmUS = { system: 'n64', datName: "Legend of Zelda, The - Majora's Mask (USA)" };
  const mmEU = { system: 'n64', datName: "Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es)" };
  assert.equal(romdb.matchRomToGame(mmUS, G('2ship')).level, 'ok');
  assert.equal(romdb.matchRomToGame(mmUS, G('zelda64recomp')).level, 'ok');
  assert.equal(romdb.matchRomToGame(mmEU, G('2ship')).level, 'warn');
  assert.equal(romdb.matchRomToGame(mmUS, G('soh')).level, null);
  assert.equal(romdb.matchRomToGame({ system: 'n64', datName: 'Perfect Dark (USA) (Rev 1)' }, G('perfectdark')).level, 'ok');
  assert.equal(romdb.matchRomToGame({ system: 'n64', datName: 'Perfect Dark (USA)' }, G('perfectdark')).level, 'warn');
  assert.equal(romdb.matchRomToGame({ system: 'n64', datName: 'Star Fox 64 (USA) (Rev 1)' }, G('starship')).level, 'warn');
  assert.equal(romdb.matchRomToGame({ system: 'n64', datName: 'Lylat Wars (Europe) (En,Fr,De)' }, G('starship')).level, 'ok');
  // unknown dump but header says Dinosaur Planet
  assert.equal(romdb.matchRomToGame({ system: 'n64', internalName: 'Dinosaur Planet' }, G('dinorecomp')).level, 'ok');
  // header-only Mario on a region-locked port is a soft warning
  assert.equal(romdb.matchRomToGame({ system: 'n64', internalName: 'SUPER MARIO 64' }, G('ghostship')).level, 'warn');
  // exact sha1 from the catalog wins
  assert.equal(romdb.matchRomToGame({ system: 'n64', sha1: '579C48E211AE952530FFC8738709F078D5DD215E' }, G('spaghettikart')).level, 'ok');
  assert.equal(romdb.matchRomToGame({ system: 'gc', serial: 'GZ2E01' }, G('dusklight')).level, 'ok');
  assert.equal(romdb.matchRomToGame({ system: 'gc', serial: 'GALE01' }, G('dusklight')).level, null);
  assert.equal(romdb.matchRomToGame({ system: 'n64', datName: 'Pokémon Stadium (USA)' }, G('pokestadiumrecomp')).level, 'ok');
});

test('Windows asset picker chooses the right download', () => {
  const A = (names) => names.map((name) => ({ name, browser_download_url: 'u/' + name, size: 1 }));
  const pick = (names, m) => (gh.pickAsset(A(names), 'win32', m) || {}).name;
  assert.equal(pick(['SoH-Dewey-Alpha-Win64.zip', 'SoH-Dewey-Alpha.appimage', 'SoH-Dewey-Alpha-Mac.zip']), 'SoH-Dewey-Alpha-Win64.zip');
  assert.equal(pick(['Starship-Barnard-Alfa-Windows.zip', 'Starship-Barnard-Alfa-Linux.zip', 'Starship-Barnard-Alfa-Switch.zip']), 'Starship-Barnard-Alfa-Windows.zip');
  assert.equal(pick(['spaghetti-windows.zip', 'spaghetti-linux.zip']), 'spaghetti-windows.zip');
  assert.equal(pick(['Nautilus-Alfa-Win64.zip', 'Nautilus-Alfa-Linux.zip', 'Nautilus-Alfa-Mac.zip', 'Nautilus-Alfa-Android.zip', 'Nautilus-Alfa-iOS.zip']), 'Nautilus-Alfa-Win64.zip');
  assert.equal(pick(['Zelda64Recompiled-v1.2.2-Linux-X64.AppImage', 'Zelda64Recompiled-v1.2.2-Windows.zip', 'Zelda64Recompiled-v1.2.2-macOS.zip', 'Zelda64Recompiled-v1.2.2-Windows.pdb.zip']), 'Zelda64Recompiled-v1.2.2-Windows.zip');
  assert.equal(pick(['pd-i686-windows.zip', 'pd-x86_64-windows.zip', 'pd-x86_64-linux.tar.gz'], G('perfectdark').assetMatch), 'pd-x86_64-windows.zip');
  assert.equal(pick(['sm64coopdx_v1.5.1_Windows_OpenGL.zip', 'sm64coopdx_v1.5.1_Linux.zip', 'sm64coopdx_v1.5.1_MacOS_Arm.zip']), 'sm64coopdx_v1.5.1_Windows_OpenGL.zip');
  assert.equal(pick(['source.tar.gz', 'game-linux.zip']), undefined);
});

test('findExecutable prefers the hinted exe and skips redistributables', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'redist'));
  fs.writeFileSync(path.join(d, 'redist', 'vc_redist.x64.exe'), Buffer.alloc(9000));
  fs.writeFileSync(path.join(d, 'soh.exe'), Buffer.alloc(100));
  fs.writeFileSync(path.join(d, 'ZAPD.exe'), Buffer.alloc(5000));
  assert.equal(path.basename(await inst.findExecutable(d, G('soh').exe, 'win32')), 'soh.exe');
  assert.equal(path.basename(await inst.findExecutable(d, null, 'win32')), 'ZAPD.exe');
});

test('end to end: add ROMs, install from a fake GitHub release, launch', { skip: process.platform === 'win32' && 'uses zip and a shell script as the fake game' }, async (t) => {
  const work = tmp();
  // A fake game: a shell script padded past 500 KB so it looks like a binary
  const pkg = path.join(work, 'pkg', 'Zelda64Recompiled');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'Zelda64Recompiled'), '#!/bin/sh\necho ran > "$(dirname "$0")/ran.txt"\nexit 0\n#' + 'x'.repeat(600 * 1024) + '\n');
  fs.chmodSync(path.join(pkg, 'Zelda64Recompiled'), 0o755);
  const zip = path.join(work, 'Zelda64Recompiled-v9-Linux.zip');
  execFileSync('zip', ['-qr', zip, 'Zelda64Recompiled'], { cwd: path.join(work, 'pkg') });

  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/releases/latest')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ tag_name: 'v9', name: 'v9', assets: [{ name: 'Zelda64Recompiled-v9-Linux.zip', size: fs.statSync(zip).size, browser_download_url: `http://127.0.0.1:${server.address().port}/dl.zip` }] }));
    }
    if (req.url === '/dl.zip') { res.setHeader('content-length', fs.statSync(zip).size); return fs.createReadStream(zip).pipe(res); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const realFetch = global.fetch;
  global.fetch = (url, opts) => realFetch(String(url).replace('https://api.github.com', `http://127.0.0.1:${server.address().port}`), opts);
  t.after(() => { global.fetch = realFetch; });

  const dataDir = path.join(work, 'data');
  // Pre-seed the No-Intro cache so no network is needed, with our fake ROM's real sha1
  const z = fakeN64("ZELDA MAJORA'S MASK", 'NZSE');
  fs.mkdirSync(path.join(dataDir, 'romdb'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'romdb', 'Nintendo - Nintendo 64.dat'), DAT.replace('A'.repeat(40), rom.sha1(z)));

  const clip = [];
  const lib = new Library({ dataDir, catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux', hooks: { copyToClipboard: (x) => clip.push(x) } });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'lib');

  // ROMs arrive byteswapped and zipped
  const romsIn = path.join(work, 'incoming');
  fs.mkdirSync(romsIn);
  fs.writeFileSync(path.join(romsIn, 'majora.v64'), Buffer.from(z).swap16());
  execFileSync('zip', ['-q', 'majora.zip', 'majora.v64'], { cwd: romsIn });
  fs.rmSync(path.join(romsIn, 'majora.v64'));
  fs.writeFileSync(path.join(romsIn, 'notes.txt'), 'hi');

  const report = await lib.addRoms([romsIn]);
  assert.equal(report.length, 1, JSON.stringify(report));
  assert.equal(report[0].status, 'added');
  assert.equal(report[0].verified, true);
  assert.ok(report[0].unlocks.includes('Zelda 64: Recompiled'));
  assert.ok(report[0].unlocks.includes('2 Ship 2 Harkinian'));
  // the ROM stays in the user's zip; nothing is copied when it's added
  assert.equal(lib.state.roms[0].file, path.join(romsIn, 'majora.zip'));
  assert.equal(lib.state.roms[0].member, 'majora.v64');
  assert.ok(!fs.existsSync(lib.dirs.roms) || !fs.readdirSync(lib.dirs.roms).length, 'no copies in the ROMs folder');
  // a converted .z64 is made only when a game asks for the file
  const stored = await lib.romPath(lib.state.roms[0]);
  assert.ok(stored.endsWith("Legend of Zelda, The - Majora's Mask (USA).z64"));
  assert.ok(fs.readFileSync(stored).equals(z), 'stored ROM is normalised to z64');
  assert.equal((await lib.addRoms([romsIn]))[0].status, 'duplicate');

  const snap = lib.snapshot().games.find((g) => g.id === 'zelda64recomp');
  assert.equal(snap.romMatch.level, 'ok');

  const res = await lib.install('zelda64recomp');
  assert.deepEqual(res, { ok: true });
  const i = lib.state.installed.zelda64recomp;
  assert.equal(i.tag, 'v9');
  assert.equal(path.basename(i.exe), 'Zelda64Recompiled');
  assert.ok(fs.existsSync(path.join(path.dirname(i.exe), 'portable.txt')), 'portable.txt next to exe');

  // a save file survives an update
  fs.writeFileSync(path.join(i.dir, 'save.bin'), 'mine');
  assert.deepEqual(await lib.install('zelda64recomp'), { ok: true });
  assert.equal(fs.readFileSync(path.join(i.dir, 'save.bin'), 'utf8'), 'mine');

  const launched = await lib.launch('zelda64recomp');
  assert.equal(launched.ok, true);
  assert.equal(launched.firstRun, true);
  assert.match(launched.tip, /Select ROM/);
  assert.deepEqual(clip, [stored]);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(path.join(path.dirname(i.exe), 'ran.txt')), 'game process ran');

  // games without a ROM refuse to launch until forced
  lib.state.installed.bm64recomp = { ...i, launchedOnce: false };
  const noRom = await lib.launch('bm64recomp');
  assert.equal(noRom.ok, true, 'games that ask for the ROM themselves start without one');
  assert.equal(noRom.noRom, true);
  assert.match(noRom.tip, /asks for your ROM/);
  // Perfect Dark reads the ROM from a fixed path, so it still needs it loaded first
  lib.state.installed.perfectdark = { ...i, launchedOnce: false };
  assert.deepEqual(await lib.launch('perfectdark'), { ok: false, needsRom: true });

  // beside-exe strategy copies the ROM next to the exe
  lib.state.installed['2ship'] = { ...i, launchedOnce: false };
  await lib.prepareRom(G('2ship'), lib.state.installed['2ship']);
  assert.ok(fs.existsSync(path.join(path.dirname(i.exe), path.basename(stored))));

  await lib.uninstall('zelda64recomp');
  assert.ok(!fs.existsSync(i.dir));
});

test('ROM folder: deep scan, zips, remembered folder, quick rescan picks up new files', { skip: process.platform === 'win32' && 'uses zip' }, async () => {
  const work = tmp();
  const dataDir = path.join(work, 'data');
  const mm = fakeN64("ZELDA MAJORA'S MASK", 'NZSE');
  const sm = fakeN64('SUPER MARIO 64', 'NSME', 512 * 1024);
  const bk = fakeN64('Banjo-Kazooie', 'NBKE', 768 * 1024);
  fs.mkdirSync(path.join(dataDir, 'romdb'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'romdb', 'Nintendo - Nintendo 64.dat'), DAT.replace('A'.repeat(40), rom.sha1(mm)));

  const lib = new Library({ dataDir, catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'lib');

  // My ROMs/N64/Zelda/deep/mm.z64 and a zipped Mario three levels down
  const top = path.join(work, 'My ROMs');
  const deep = path.join(top, 'N64', 'Zelda', 'deep', 'er');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'mm.z64'), mm);
  const marioDir = path.join(top, 'N64', 'Mario', 'stuff');
  fs.mkdirSync(marioDir, { recursive: true });
  fs.writeFileSync(path.join(marioDir, 'sm64.n64'), Buffer.from(sm).swap32());
  execFileSync('zip', ['-q', 'sm64.zip', 'sm64.n64'], { cwd: marioDir });
  fs.rmSync(path.join(marioDir, 'sm64.n64'));
  fs.writeFileSync(path.join(top, 'readme.txt'), 'not a rom');

  const first = await lib.addRomFolder(top);
  assert.deepEqual(first.filter((r) => r.status === 'added').length, 2, JSON.stringify(first));
  assert.deepEqual(lib.state.settings.romFolders, [top]);
  assert.equal(lib.state.roms.length, 2);

  // Rescan: nothing new, and the known files aren't even opened
  assert.equal((await lib.scanRomFolders()).length, 0);

  // Drop a new ROM in; the startup rescan finds just that one
  fs.writeFileSync(path.join(top, 'N64', 'banjo.v64'), Buffer.from(bk).swap16());
  const again = await lib.scanRomFolders();
  assert.equal(again.length, 1);
  assert.equal(again[0].status, 'added');
  assert.equal(lib.state.roms.length, 3);

  // The library's own ROM copies are never scanned back in, even if the library sits inside the folder
  lib.state.settings.libraryDir = path.join(top, 'Fulton');
  await lib.addRoms([path.join(deep, 'mm.z64')]); // creates a copy under My ROMs/Fulton/ROMs
  const full = await lib.scanRomFolders({ full: true });
  assert.ok(full.every((r) => !r.file.includes('Legend of Zelda')), JSON.stringify(full));
  assert.ok(full.every((r) => r.status === 'duplicate'));

  await lib.removeRomFolder(top);
  assert.deepEqual(lib.state.settings.romFolders, []);
});

test('GitHub search uses simple queries GitHub accepts (no brackets)', () => {
  for (const q of [...gh.discoverQueries('paper mario'), ...gh.discoverQueries(''), ...gh.discoverQueries('(zelda) "oot"')]) {
    assert.ok(!/[()"]/.test(q), q);
  }
  assert.deepEqual(gh.discoverQueries('paper mario'), ['paper mario recomp fork:false', 'paper mario decomp fork:false', 'paper mario port fork:false']);
});

test('community catalog: fetch, map systems, dedupe, add to shelf', async (t) => {
  const community = require('../src/core/community');
  const lists = {
    'https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/index.json': { version: 2, lists: [{ remoteLocation: 'L1' }, { remoteLocation: 'L2' }, { remoteLocation: 'BROKEN' }] },
    L1: { name: 'Nintendo', apps: [
      { name: 'Extreme-G', project: 'Extreme-G: Recompiled', repository: 'sonicdcer/ExtremeGRecomp', appIconUrl: 'https://x/icon.png', tags: ['recomp', 'n64'], filesToAdd: ['portable.txt'] },
      { name: 'Super Mario 64', repository: 'harbourmasters/ghostship', tags: ['decomp', 'n64', 'harbour masters'] },
      { name: 'Animal Crossing', repository: 'flyngmt/ACGC-PC-Port', tags: ['decomp', 'gcn'] },
    ] },
    L2: { name: 'Xbox', apps: [
      { name: 'Exit', repository: 'FluffyQuack/ReXGlue-EXIT', releaseAssetFilter: 'EXIT1', tags: ['recomp', 'x360'] },
      { name: 'Exit 2', repository: 'FluffyQuack/ReXGlue-EXIT', releaseAssetFilter: 'EXIT2', tags: ['recomp', 'x360'] },
      { name: 'Extreme-G', repository: 'sonicdcer/ExtremeGRecomp', tags: ['recomp', 'n64'] }, // duplicate
    ] },
  };
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (!lists[url]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => lists[url] };
  };
  t.after(() => { global.fetch = realFetch; });

  const items = await community.fetchCommunity();
  assert.equal(items.filter((c) => c.from !== 'cartridge').length, 5, 'broken list skipped, duplicate removed, two EXIT games kept');
  const eg = items.find((c) => c.repo === 'sonicdcer/ExtremeGRecomp');
  assert.equal(eg.system, 'n64');
  assert.equal(eg.kind, 'Static recompilation');
  assert.equal(items.find((c) => c.name === 'Animal Crossing').system, 'gc');
  assert.equal(items.find((c) => c.name === 'Super Mario 64').harbourMasters, true);

  const work = tmp();
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32' });
  await lib.load();
  lib.refreshReleases = async () => {};
  const listed = await lib.communityList();
  // Ghostship is already in the built-in catalog, so it shows as on the shelf
  assert.equal(listed.items.find((c) => c.repo === 'harbourmasters/ghostship').onShelf, 'ghostship');
  assert.equal(listed.items.find((c) => c.repo === 'sonicdcer/ExtremeGRecomp').onShelf, null);

  const g = await lib.addCommunityGame(eg.key);
  assert.equal(g.title, 'Extreme-G');
  assert.equal(g.port, 'Extreme-G: Recompiled');
  assert.equal(g.system, 'n64');
  assert.deepEqual(g.filesToAdd, ['portable.txt']);
  assert.equal(g.rom.setup.type, 'in-app');
  assert.ok(lib.snapshot().games.some((x) => x.id === g.id));
  assert.equal((await lib.communityList()).items.find((c) => c.key === eg.key).onShelf, g.id);

  // Two games from one repo keep separate downloads
  const exit2 = await lib.addCommunityGame(listed.items.find((c) => c.name === 'Exit 2').key);
  assert.equal(gh.pickAsset([{ name: 'EXIT1-win.zip' }, { name: 'EXIT2-win.zip' }], 'win32', exit2.assetMatch).name, 'EXIT2-win.zip');

  // Harbour Masters entries put the ROM next to the exe
  assert.equal(community.gameFromCandidate(items.find((c) => c.name === 'Super Mario 64')).rom.setup.type, 'beside-exe');
});

test('Recompendium: read the archive, parse its YAML, merge with the Quiver list', async (t) => {
  const zlib = require('zlib');
  const rc = require('../src/core/recompendium');
  const community = require('../src/core/community');
  // a .tar.gz built by hand, like GitHub's codeload archive (pax global header first)
  const entry = (name, text, type = '0') => {
    const data = Buffer.from(text, 'utf8');
    const h = Buffer.alloc(512);
    h.write(name.slice(-100), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    h.fill(' ', 148, 156);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  };
  const files = {
    'unricopie-main/src/data/recomps/las.yaml': `name: "The Legend of Zelda: Link's Awakening"\nconsole: switch\nstatus: playable\nrepo: peiikai/LASRecomp\nauthor: peiikai\noriginalDeveloper: Grezzo\nyear: 2019\ndesc:\n  es: "Port"\n  en: "Native PC port of the Switch remake."\nrequirements:\n  en: "Your own Switch dump."\ntags:\n  - arm64\nlinks:\n  - label: { es: "Versi\u00f3n", en: "Web build" }\n    url: https://example.com/web\n  - label:\n      es: "Fork"\n      en: "Fork (macOS)"\n    url: https://example.com/fork\n`,
    'unricopie-main/src/data/recomps/wwhd.yaml': 'name: The Legend of Zelda: The Wind Waker HD\nconsole: wiiu\nstatus: experimental\nrepo: ZeldaWWHDRecomp/ZeldaWWHDRecomp\ndesc:\n  en: "Wii U recomp."\n',
    'unricopie-main/src/data/recomps/dead.yaml': 'name: Old One\nconsole: n64\nrepo: someone/old\nabandoned: true\ndesc:\n  en: x\n',
    'unricopie-main/src/data/ports/ac.yaml': 'name: Animal Crossing\ncategory: decomp-port\nconsole: gamecube\nstatus: playable\nrepo: flyngmt/ACGC-PC-Port\noriginalDeveloper: Nintendo\ndesc:\n  en: "Native PC port, US version only."\n',
    'unricopie-main/src/data/ports/remake.yaml': 'name: Some Remake (N64)\ncategory: fan-remake\nconsole: n64\nstatus: stable\nrepo: https://github.com/fan/remake\ndesc:\n  en: r\n',
    'unricopie-main/src/data/decomps/sm64.yaml': 'name: sm64\nconsole: n64\nrepo: n64decomp/sm64\n',
    'unricopie-main/src/data/stats.json': JSON.stringify({ 'peiikai/LASRecomp': { stars: 5, version: 'beta_4' }, 'flyngmt/ACGC-PC-Port': { stars: 9, version: null } }),
    'unricopie-main/public/logo.svg': '<svg/>',
  };
  const tar = Buffer.concat([entry('pax_global_header', '52 comment=abcdef\n', 'g'), ...Object.entries(files).map(([n, x]) => entry(n, x)), Buffer.alloc(1024)]);
  const gz = zlib.gzipSync(tar);

  const y = rc.parseYaml(files['unricopie-main/src/data/recomps/las.yaml']);
  assert.equal(y.name, "The Legend of Zelda: Link's Awakening");
  assert.equal(y.year, 2019);
  assert.equal(y.desc.en, 'Native PC port of the Switch remake.');
  assert.deepEqual(y.tags, ['arm64']);
  assert.deepEqual(y.links.map((l) => [l.label.en, l.url]), [['Web build', 'https://example.com/web'], ['Fork (macOS)', 'https://example.com/fork']]);

  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === rc.ARCHIVE_URL) return { ok: true, status: 200, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length) };
    if (/index\.json$/.test(url)) return { ok: true, status: 200, json: async () => ({ lists: [{ remoteLocation: 'L1' }] }) };
    if (url === 'L1') return { ok: true, status: 200, json: async () => ({ name: 'Nintendo', apps: [{ name: 'Animal Crossing', repository: 'flyngmt/ACGC-PC-Port', tags: ['decomp', 'gcn'] }] }) };
    return { ok: false, status: 404 };
  };
  t.after(() => { global.fetch = realFetch; });

  const rec = await rc.fetchRecompendium();
  assert.deepEqual(rec.map((c) => c.repo).sort(), ['ZeldaWWHDRecomp/ZeldaWWHDRecomp', 'fan/remake', 'flyngmt/ACGC-PC-Port', 'peiikai/LASRecomp'], 'tools, decomps and abandoned entries are left out');
  const las = rec.find((c) => c.repo === 'peiikai/LASRecomp');
  assert.equal(las.system, 'switch');
  assert.equal(las.kind, 'Static recompilation');
  assert.equal(las.status, 'Playable');
  assert.equal(las.needs, 'Your own Switch dump.');
  assert.equal(las.get, 'download', 'has a release (from stats.json)');
  assert.equal(las.needsFiles, true, 'Switch ports need files from the console');
  assert.equal(rec.find((c) => c.repo === 'flyngmt/ACGC-PC-Port').get, 'build', 'no release: build it yourself');
  assert.equal(rec.find((c) => c.repo === 'fan/remake').get, 'build');
  assert.equal(rec.find((c) => c.repo === 'ZeldaWWHDRecomp/ZeldaWWHDRecomp').system, 'wiiu');
  const remake = rec.find((c) => c.repo === 'fan/remake');
  assert.equal(remake.kind, 'Reimplementation');
  assert.equal(remake.name, 'Some Remake');

  const all = await community.fetchCommunity();
  const ac = all.filter((c) => c.repo === 'flyngmt/ACGC-PC-Port');
  assert.equal(ac.length, 1, 'a port on both lists shows once');
  assert.equal(ac[0].list, 'Nintendo', 'keeping the Quiver entry');
  assert.equal(ac[0].status, 'Playable', 'with Recompendium details added');
  assert.equal(ac[0].get, 'download', 'Quiver entries have releases');
  assert.ok(all.some((c) => c.system === 'wiiu' && c.from === 'cartridge'), 'extra Wii U ports are listed');

  const g = community.gameFromCandidate(las);
  assert.equal(g.system, 'switch');
  assert.equal(g.description, 'Native PC port of the Switch remake.');
  assert.equal(g.developer, 'Grezzo');
  assert.match(g.rom.note, /Your own Switch dump/);
  assert.equal(g.needsFiles, true);
  assert.equal(g.howToGet, 'download');

  // still works when only one source answers
  global.fetch = async (url) => (url === rc.ARCHIVE_URL ? { ok: true, status: 200, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length) } : { ok: false, status: 500 });
  assert.ok((await community.fetchCommunity()).some((c) => c.repo === 'peiikai/LASRecomp'));
  global.fetch = async () => { throw new Error('fetch failed'); };
  await assert.rejects(community.fetchCommunity(), /internet connection/);
});

test('a copy you built yourself can be added, played and removed without deleting it', async () => {
  const work = tmp();
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32' });
  await lib.load();
  const id = lib.games[0].id;
  const own = path.join(work, 'MyBuild');
  fs.mkdirSync(own, { recursive: true });
  const bat = path.join(own, 'Play.bat');
  fs.writeFileSync(bat, '@echo off\r\n');
  await assert.rejects(lib.linkInstall(id, path.join(own, 'missing.exe')), /doesn't exist/);
  const i = await lib.linkInstall(id, bat);
  assert.equal(i.manual, true);
  assert.equal(i.exe, bat);
  lib.state.releases[id] = { data: { tag: 'v9.9' } };
  const snap = lib.snapshot().games.find((g) => g.id === id);
  assert.ok(snap.installed);
  assert.equal(snap.updateAvailable, false, 'no update offers for your own copy');
  await lib.uninstall(id);
  assert.ok(!lib.state.installed[id]);
  assert.ok(fs.existsSync(bat), 'your files are never deleted');
});

test('Help topics are complete and every ? button points at one', () => {
  global.window = {};
  require('../renderer/help.js');
  const topics = global.window.HELP;
  delete global.window;
  const ids = topics.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const t of topics) {
    assert.ok(t.title && t.lead && t.steps.length >= 2, t.id);
    for (const [, target] of t.actions || []) assert.ok(['shelf', 'roms', 'discover', 'settings', 'about', 'log'].includes(target), `${t.id}: ${target}`);
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const used = [...app.matchAll(/data-help-(?:tip|go)="([a-z]+)"/g)].map((m) => m[1]);
  for (const id of new Set(used)) assert.ok(ids.includes(id), `missing help topic ${id}`);
  for (const id of ['own', 'files', 'roms', 'find']) assert.ok(ids.includes(id), id);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8'), /help\.js[\s\S]*app\.js/, 'help.js loads before app.js');
});

test('catalog Metacritic data is well formed', () => {
  for (const g of catalog.games) {
    if (!g.metacritic) continue;
    const m = g.metacritic;
    assert.ok(m.score === null || (Number.isInteger(m.score) && m.score >= 0 && m.score <= 100), g.id);
    assert.ok(m.score === null ? m.reviews === 0 : m.reviews > 0, g.id);
    assert.match(m.url, /^https:\/\/www\.metacritic\.com\/game\/[a-z0-9-]+\/$/, g.id);
  }
});

test('Metacritic: slugs and page parsing', async () => {
  const mc = require('../src/core/metacritic');
  assert.equal(mc.slugify("The Legend of Zelda: Majora's Mask"), 'the-legend-of-zelda-majoras-mask');
  assert.equal(mc.slugify('Super Smash Bros.'), 'super-smash-bros');
  assert.equal(mc.slugify('Super Mario Bros. [Remastered]'), 'super-mario-bros');
  assert.equal(mc.slugify('Pokémon Stadium'), 'pokemon-stadium');
  assert.equal(mc.slugify('Sonic 3 & Knuckles'), 'sonic-3-and-knuckles');

  // Layout seen on metacritic.com: label, verdict, review count, then the number
  const visible = '<div><span>Metascore</span><span>Generally Favorable</span><span>Based on 15 Critic Reviews</span><div>88</div></div><a>Nintendo 64</a>';
  assert.deepEqual(mc.parsePage(visible), { score: 88, reviews: 15, platform: 'Nintendo 64', user: null });
  // Number first also works
  assert.equal(mc.parsePage('<p>Metascore</p><b>97</b><p>Universal Acclaim</p><p>Based on 30 Critic Reviews</p>').score, 97);
  // schema.org data wins when present
  const ld = '<script type="application/ld+json">{"@type":"VideoGame","name":"X","gamePlatform":["GameCube"],"aggregateRating":{"ratingValue":"96","reviewCount":16}}</script>';
  assert.deepEqual(mc.parsePage(ld), { score: 96, reviews: 16, platform: 'GameCube', user: null });
  // "tbd" means Metacritic has no score
  assert.equal(mc.parsePage('<span>Metascore</span><span>tbd</span><span>No score yet</span>').score, null);
  // unreadable page
  assert.equal(mc.parsePage('<html>nothing here</html>'), undefined);

  // lookup: 404 = no page, otherwise parsed result with the URL
  const fake = (status, body) => async () => ({ status, ok: status < 400, text: async () => body });
  assert.equal(await mc.lookup('Nope', fake(404, '')), null);
  const r = await mc.lookup('Diddy Kong Racing', fake(200, visible));
  assert.equal(r.url, 'https://www.metacritic.com/game/diddy-kong-racing/');
  assert.equal(r.score, 88);
});

test('Library fetches and remembers Metascores for games without one', async () => {
  const work = tmp();
  let calls = 0;
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32',
    hooks: { fetch: async (url) => { calls++; return { status: 200, ok: true, text: async () => '<span>Metascore</span><span>Universal Acclaim</span><span>Based on 30 Critic Reviews</span><b>95</b><i>Game Boy Advance</i>' }; } } });
  await lib.load();
  const before = lib.snapshot().games.find((g) => g.id === 'zelda3');
  assert.equal(before.metacritic, null);
  assert.equal(before.metaChecked, false);
  const got = await lib.metascore('zelda3');
  assert.equal(got.score, 95);
  assert.equal(got.url, 'https://www.metacritic.com/game/the-legend-of-zelda-a-link-to-the-past/');
  await lib.metascore('zelda3');
  assert.equal(calls, 1, 'cached');
  const after = lib.snapshot().games.find((g) => g.id === 'zelda3');
  assert.equal(after.metacritic.score, 95);
  // built-in scores are used as-is, no lookup
  assert.equal((await lib.metascore('soh')).score, 99);
  assert.equal(calls, 1);
});

test('Metacritic parsing ignores scripts and stray mentions', () => {
  const mc = require('../src/core/metacritic');
  const page = '<script>var x = {"label":"Metascore 12 Based on 3 Critic Reviews"};</script><nav>What is a Metascore?</nav>'
    + '<div><span>Metascore</span><span>Generally Favorable</span><span>Based on 15 Critic Reviews</span><div>88</div></div>';
  assert.equal(mc.parsePage(page).score, 88);
});

test('Metacritic user scores', () => {
  const mc = require('../src/core/metacritic');
  const page = '<div><span>Metascore</span><span>Universal Acclaim</span><span>Based on 27 Critic Reviews</span><b>95</b></div>'
    + '<div><span>User score</span><span>Universal Acclaim</span><span>Based on 2,661 User Ratings</span><b>9.2</b></div>';
  const r = mc.parsePage(page);
  assert.equal(r.score, 95);
  assert.deepEqual(r.user, { score: 9.2, ratings: 2661 });
  assert.deepEqual(mc.parseUser('User Score tbd Available after 4 ratings Based on 1 User Rating'), { score: null, ratings: 1 });
  assert.equal(mc.parsePage('<div>User score</div><div>Generally Favorable</div><div>Based on 7 User Ratings</div><div>8.9</div><div>Metascore</div><div>tbd</div>').user.score, 8.9);
  // every built-in score in the catalog has a well-formed user score
  for (const g of catalog.games) {
    const u = g.metacritic && g.metacritic.user;
    if (!u) continue;
    assert.ok(u.score === null || (u.score >= 0 && u.score <= 10), g.id);
    assert.ok(Number.isInteger(u.ratings), g.id);
  }
});

test('Steam: binary VDF round trip, shortcut add/update/remove, artwork', async () => {
  const steam = require('../src/core/steam');
  // An existing shortcuts.vdf with one game the user added themselves
  const existing = steam.writeVdf([{ key: 'shortcuts', type: steam.T.MAP, value: [
    { key: '0', type: steam.T.MAP, value: [
      { key: 'appid', type: steam.T.INT, value: -12345 },
      { key: 'AppName', type: steam.T.STR, value: 'My Other Game' },
      { key: 'Exe', type: steam.T.STR, value: '"C:\\Games\\other.exe"' },
      { key: 'LastPlayTime', type: steam.T.INT, value: 1700000000 },
      { key: 'tags', type: steam.T.MAP, value: [{ key: '0', type: steam.T.STR, value: 'Favorites' }] },
    ] },
  ] }]);
  // byte-exact round trip
  assert.ok(steam.writeVdf(steam.parseVdf(existing)).equals(existing));
  // file ends with the two closing markers Steam expects
  assert.equal(existing.subarray(-2).toString('hex'), '0808');

  // known CRC32 value
  assert.equal(steam.crc32('123456789'), 0xcbf43926);
  const id = steam.shortcutAppId('"C:\\x.exe"', 'X');
  assert.ok(id >= 0x80000000 && id <= 0xffffffff, 'top bit set, unsigned');

  const work = tmp();
  const userDir = path.join(work, 'userdata', '12345678');
  fs.mkdirSync(path.join(userDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'config', 'shortcuts.vdf'), existing);

  const exe = 'C:\\Users\\b\\Fulton\\Games\\soh\\soh.exe';
  const appid = await steam.addShortcut(userDir, { name: 'Ship of Harkinian', exe, startDir: 'C:\\Users\\b\\Fulton\\Games\\soh', icon: exe, tags: ['Fulton'] });
  let sc = await steam.readShortcuts(userDir);
  assert.equal(sc.list.value.length, 2);
  assert.deepEqual(sc.list.value.map((e) => e.key), ['0', '1']);
  const added = sc.list.value[1].value;
  const field = (list, k) => list.find((e) => e.key === k).value;
  assert.equal(field(added, 'AppName'), 'Ship of Harkinian');
  assert.equal(field(added, 'Exe'), `"${exe}"`);
  assert.equal(field(added, 'appid') >>> 0, appid);
  assert.equal(field(sc.list.value[0].value, 'AppName'), 'My Other Game', "user's own shortcut kept");
  assert.ok(fs.existsSync(path.join(userDir, 'config', 'shortcuts.vdf.cartridge-backup')));

  // adding again updates instead of duplicating
  await steam.addShortcut(userDir, { name: 'Ship of Harkinian', exe, startDir: 'x', icon: exe });
  sc = await steam.readShortcuts(userDir);
  assert.equal(sc.list.value.length, 2);
  assert.equal(await steam.hasShortcut(userDir, exe), true);

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const files = await steam.writeArtwork(userDir, appid, { portrait: png, wide: png, hero: png, logo: png });
  assert.deepEqual(files, [`${appid}p.png`, `${appid}.png`, `${appid}_hero.png`, `${appid}_logo.png`]);
  assert.ok(fs.existsSync(path.join(userDir, 'config', 'grid', `${appid}p.png`)));

  assert.equal(await steam.removeShortcut(userDir, exe), 1);
  await steam.removeArtwork(userDir, appid);
  sc = await steam.readShortcuts(userDir);
  assert.equal(sc.list.value.length, 1);
  assert.ok(!fs.existsSync(path.join(userDir, 'config', 'grid', `${appid}p.png`)));

  // a brand-new Steam account with no shortcuts.vdf yet
  const fresh = path.join(work, 'userdata', '999');
  await steam.addShortcut(fresh, { name: 'A', exe: 'C:\\a.exe', startDir: 'C:\\' });
  assert.equal((await steam.readShortcuts(fresh)).list.value.length, 1);
});

test('Save backups: only player files, skip unchanged, survive update, restore', { skip: process.platform === 'win32' && 'uses zip' }, async (t) => {
  const backup = require('../src/core/backup');
  const work = tmp();
  // release v1: exe + a default config + assets
  const pkg = path.join(work, 'pkg', 'Game');
  fs.mkdirSync(path.join(pkg, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'Game'), '#!/bin/sh\nexit 0\n#' + 'x'.repeat(600 * 1024));
  fs.chmodSync(path.join(pkg, 'Game'), 0o755);
  fs.writeFileSync(path.join(pkg, 'assets', 'level1.dat'), 'level');
  fs.writeFileSync(path.join(pkg, 'readme.txt'), 'hi');
  const zip = path.join(work, 'Game-Linux.zip');
  execFileSync('zip', ['-qr', zip, 'Game'], { cwd: path.join(work, 'pkg') });

  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/releases/latest')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ tag_name: 'v1', assets: [{ name: 'Game-Linux.zip', size: fs.statSync(zip).size, browser_download_url: `http://127.0.0.1:${server.address().port}/dl.zip` }] }));
    }
    if (req.url === '/dl.zip') return fs.createReadStream(zip).pipe(res);
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const realFetch = global.fetch;
  global.fetch = (url, opts) => realFetch(String(url).replace('https://api.github.com', `http://127.0.0.1:${server.address().port}`), opts);
  t.after(() => { global.fetch = realFetch; });

  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'lib');
  assert.deepEqual(await lib.install('bm64recomp'), { ok: true });
  const dir = lib.state.installed.bm64recomp.dir;

  // fresh install: nothing of the player's yet
  assert.equal(await lib.backupGame('bm64recomp', 'manual'), null);

  // the player saves; a copied ROM and generated asset pack must not be backed up
  fs.mkdirSync(path.join(dir, 'saves'));
  fs.writeFileSync(path.join(dir, 'saves', 'slot1.sav'), 'SAVE-ONE');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"vsync":true}');
  fs.writeFileSync(path.join(dir, 'rom.z64'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(dir, 'assets.o2r'), Buffer.alloc(1024));

  const b1 = await lib.backupGame('bm64recomp', 'after playing');
  assert.ok(b1, 'backup made');
  assert.equal(b1.files, 2);
  assert.ok(fs.existsSync(path.join(b1.dir, 'game', 'saves', 'slot1.sav')));
  assert.ok(!fs.existsSync(path.join(b1.dir, 'game', 'rom.z64')));
  assert.ok(!fs.existsSync(path.join(b1.dir, 'game', 'assets', 'level1.dat')), 'release files skipped');

  // nothing changed -> no duplicate automatic backup
  assert.equal(await lib.backupGame('bm64recomp', 'after playing'), null);

  // update: backed up first, save survives
  fs.writeFileSync(path.join(dir, 'saves', 'slot1.sav'), 'SAVE-TWO');
  assert.deepEqual(await lib.install('bm64recomp'), { ok: true });
  const list = await lib.listBackups('bm64recomp');
  assert.equal(list[0].reason, 'before update');
  assert.equal(fs.readFileSync(path.join(dir, 'saves', 'slot1.sav'), 'utf8'), 'SAVE-TWO');

  // ruin the save, restore the first backup
  fs.writeFileSync(path.join(dir, 'saves', 'slot1.sav'), 'CORRUPT');
  await lib.restoreBackup('bm64recomp', b1.id);
  assert.equal(fs.readFileSync(path.join(dir, 'saves', 'slot1.sav'), 'utf8'), 'SAVE-ONE');
  const after = await lib.listBackups('bm64recomp');
  assert.equal(after[0].reason, 'before restore', 'restore is undoable');
  assert.ok(fs.readFileSync(path.join(after[0].dir, 'game', 'saves', 'slot1.sav'), 'utf8') === 'CORRUPT');

  // uninstall keeps a final backup
  await lib.uninstall('bm64recomp');
  assert.ok(!fs.existsSync(dir));
  assert.equal((await lib.listBackups('bm64recomp'))[0].reason, 'before uninstall');

  // pruning keeps 10 automatic backups
  const root = path.join(work, 'prune');
  const gd = path.join(work, 'gd'); fs.mkdirSync(gd);
  for (let i = 0; i < 13; i++) {
    fs.writeFileSync(path.join(gd, 's.sav'), String(i));
    await backup.createBackup({ gameDir: gd, backupRoot: root, gameId: 'x', files: [{ rel: 's.sav', size: 1, mtime: i }], reason: i === 0 ? 'manual' : 'after playing' });
  }
  await backup.prune(root, 'x', 10);
  const kept = await backup.listBackups(root, 'x');
  assert.equal(kept.filter((b) => b.reason !== 'manual').length, 10);
  assert.ok(kept.some((b) => b.reason === 'manual'), 'manual backups never pruned');
});

test('PlayStation discs: .cue/.bin pairs, .chd, and telling .bin/.iso apart', async () => {
  const work = tmp();
  const roms = path.join(work, 'roms', 'PS1');
  fs.mkdirSync(roms, { recursive: true });
  // raw Mode 2 CD image: ISO 9660 descriptor in sector 16 at byte 24
  const bin = Buffer.alloc(20 * 2352);
  bin.write('\x01CD001', 16 * 2352 + 24, 'latin1');
  bin.write('PLAYSTATION', 16 * 2352 + 24 + 8, 'latin1');
  fs.writeFileSync(path.join(roms, 'Crash Bandicoot (USA) (Track 1).bin'), bin);
  fs.writeFileSync(path.join(roms, 'Crash Bandicoot (USA) (Track 2).bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(roms, 'Crash Bandicoot (USA).cue'),
    'FILE "Crash Bandicoot (USA) (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\nFILE "Crash Bandicoot (USA) (Track 2).bin" BINARY\r\n  TRACK 02 AUDIO\r\n');
  fs.writeFileSync(path.join(roms, 'Tomb Raider (USA).chd'), Buffer.alloc(2048));
  // a small Genesis .bin
  const gen = Buffer.alloc(512 * 1024); gen.write('SEGA GENESIS', 0x100, 'latin1');
  fs.writeFileSync(path.join(work, 'roms', 'Sonic.bin'), gen);
  // a GameCube .iso and a PS1 .iso
  const gc = Buffer.alloc(0x9000); gc.write('GZ2E01', 0, 'latin1'); gc.writeUInt32BE(0xc2339f3d, 0x1c);
  fs.writeFileSync(path.join(work, 'roms', 'tp.iso'), gc);
  const psIso = Buffer.alloc(0x9000); psIso.write('\x01CD001', 0x8000, 'latin1'); psIso.write('PLAYSTATION', 0x8008, 'latin1');
  fs.writeFileSync(path.join(work, 'roms', 'Spyro (USA).iso'), psIso);

  assert.equal(rom.sniffSystem(path.join(roms, 'Crash Bandicoot (USA) (Track 1).bin'), bin.length), 'ps1');
  assert.equal(rom.sniffSystem(path.join(work, 'roms', 'Sonic.bin'), gen.length), 'genesis');
  assert.equal(rom.sniffSystem(path.join(work, 'roms', 'tp.iso'), gc.length), 'gc');
  assert.equal(rom.sniffSystem(path.join(work, 'roms', 'Spyro (USA).iso'), psIso.length), 'ps1');
  assert.equal(rom.nameFromFile('Final Fantasy VIII (USA) (Disc 1) [!].cue'), 'Final Fantasy VIII');
  assert.ok(rom.ROM_EXTENSIONS.includes('.cue') && rom.ROM_EXTENSIONS.includes('.bin') && rom.ROM_EXTENSIONS.includes('.chd'));

  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'lib');
  const report = await lib.addRoms([path.join(work, 'roms')]);
  const got = report.filter((r) => r.status === 'added').map((r) => `${r.system}:${r.file}`).sort();
  assert.deepEqual(got, ['gc:tp.iso', 'genesis:Sonic.bin', 'ps1:Crash Bandicoot (USA).cue', 'ps1:Spyro (USA).iso', 'ps1:Tomb Raider (USA).chd'], JSON.stringify(report));
  assert.ok(report.find((r) => r.file === 'tp.iso').unlocks.includes('Dusklight'));
  assert.ok(!report.some((r) => /Track/.test(r.file)), 'bin tracks are covered by the cue, not listed on their own');
  const crash = lib.state.roms.find((r) => r.system === 'ps1' && r.internalName === 'Crash Bandicoot');
  assert.ok(crash.file.endsWith('.cue'), 'the .cue is what gets handed to the game');
  assert.ok(crash.size > bin.length, 'size includes the tracks');

  // a community PS1 port matches the disc by name
  const c = require('../src/core/community');
  const game = c.gameFromCandidate({ key: 'k', repo: 'alexbeavs-ps1-ports/crash', name: 'Crash Bandicoot', project: 'Crash Recomp', system: 'ps1', kind: 'Static recompilation', tags: [], filesToAdd: [] });
  const m = romdb.matchRomToGame(crash, game);
  assert.equal(m.level, 'ok');
  assert.equal(m.reason, 'Matched by file name');
});

// ---------------------------------------------------------------- every system
function makeSfo(fields) {
  const keys = Object.keys(fields);
  const keyBuf = Buffer.concat(keys.map((k) => Buffer.from(k + '\0', 'latin1')));
  const vals = keys.map((k) => Buffer.from(String(fields[k]) + '\0', 'utf8'));
  const keyStart = 20 + keys.length * 16;
  const dataStart = keyStart + keyBuf.length + ((4 - (keyBuf.length % 4)) % 4);
  const out = Buffer.alloc(dataStart + vals.reduce((n, v) => n + v.length, 0));
  out.write('\0PSF', 0, 'latin1'); out.writeUInt32LE(0x101, 4); out.writeUInt32LE(keyStart, 8); out.writeUInt32LE(dataStart, 12); out.writeUInt32LE(keys.length, 16);
  let kOff = 0, dOff = 0;
  keys.forEach((k, i) => {
    const e = 20 + i * 16;
    out.writeUInt16LE(kOff, e); out.writeUInt16LE(0x0204, e + 2); out.writeUInt32LE(vals[i].length, e + 4); out.writeUInt32LE(vals[i].length, e + 8); out.writeUInt32LE(dOff, e + 12);
    vals[i].copy(out, dataStart + dOff);
    kOff += k.length + 1; dOff += vals[i].length;
  });
  keyBuf.copy(out, keyStart);
  return out;
}

test('every system: Switch, Wii U, 3DS, PS3, Vita, Xbox, Sega discs, retro cartridges', async () => {
  const work = tmp();
  const roms = path.join(work, 'roms', 'mixed');
  const w = (rel, buf) => { const f = path.join(work, 'roms', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };

  // Nintendo Switch: name and title ID from the file name
  const nsp = Buffer.alloc(4096); nsp.write('PFS0', 0, 'latin1');
  w('mixed/Super Mario Odyssey [0100000000010000][v0].nsp', nsp);
  const xci = Buffer.alloc(4096); xci.write('HEAD', 0x100, 'latin1');
  w('mixed/The Legend of Zelda Breath of the Wild (USA).xci', xci);
  // 3DS cartridge dump with its product code
  const ds3 = Buffer.alloc(0x4200); ds3.write('NCSD', 0x100, 'latin1'); ds3.write('CTR-P-AREE', 0x4150, 'latin1');
  w('mixed/Mario Kart 7 (USA).3ds', ds3);
  // Wii U: a dumped game folder and a .wua
  w('mixed/WiiU Game/code/game.rpx', Buffer.alloc(64));
  w('mixed/WiiU Game/content/data.bin', Buffer.alloc(64));
  w('mixed/WiiU Game/meta/meta.xml', '<?xml version="1.0"?><menu><longname_en type="string">Super Mario 3D World</longname_en><product_code type="string">WUP-P-ARDE</product_code></menu>');
  w('mixed/Mario Kart 8 (USA).wua', Buffer.alloc(64));
  // PS3 and Vita folders (their EBOOT.BIN must not be mistaken for a cartridge)
  w('mixed/BLUS30001/PS3_GAME/PARAM.SFO', makeSfo({ TITLE: 'Resistance: Fall of Man', TITLE_ID: 'BCUS98174' }));
  w('mixed/BLUS30001/PS3_GAME/USRDIR/EBOOT.BIN', Buffer.concat([Buffer.from('SCE\0'), Buffer.alloc(200000)]));
  w('mixed/PCSE00082/sce_sys/param.sfo', makeSfo({ TITLE: 'Gravity Rush', TITLE_ID: 'PCSE00082' }));
  w('mixed/PCSE00082/eboot.bin', Buffer.concat([Buffer.from('SCE\0'), Buffer.alloc(100)]));
  // Xbox: extracted folders and an xiso
  w('mixed/Halo 3/default.xex', Buffer.alloc(64));
  w('mixed/Halo/default.xbe', Buffer.alloc(64));
  const xiso = Buffer.alloc(0x10100); xiso.write('MICROSOFT*XBOX*MEDIA', 0x10000, 'latin1');
  w('mixed/Jet Set Radio Future (USA).iso', xiso);
  // Sega discs: Saturn raw .cue/.bin, Sega CD .iso, Dreamcast .gdi; a 3DO .iso
  const sat = Buffer.alloc(20 * 2352); Buffer.from([0, ...Array(10).fill(0xff), 0]).copy(sat, 0); sat[15] = 1; sat.write('SEGA SEGASATURN', 16, 'latin1');
  w('mixed/Nights into Dreams (USA) (Track 1).bin', sat);
  w('mixed/Nights into Dreams (USA).cue', 'FILE "Nights into Dreams (USA) (Track 1).bin" BINARY\n  TRACK 01 MODE1/2352\n');
  const scd = Buffer.alloc(0x9000); scd.write('SEGADISCSYSTEM', 0, 'latin1');
  w('mixed/Sonic CD (USA).iso', scd);
  w('mixed/Shenmue (USA)/Shenmue (USA).gdi', '3\n1 0 4 2352 track01.bin 0\n');
  const tdo = Buffer.alloc(0x9000); Buffer.from([1, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 1]).copy(tdo, 0);
  w('mixed/Gex (USA).iso', tdo);
  // compressed .chd: the folder name decides
  w('Sega Saturn/Panzer Dragoon Saga (USA).chd', Buffer.alloc(2048));
  w('Sony - PlayStation 2/Shadow of the Colossus (USA).chd', Buffer.alloc(2048));
  // retro cartridges, some with dump headers that No-Intro leaves out
  w('mixed/Alex Kidd (USA).sms', Buffer.alloc(128 * 1024, 1));
  w('mixed/Columns (USA).gg', Buffer.alloc(32 * 1024, 2));
  const pce = Buffer.alloc(512 + 256 * 1024, 3); pce.fill(0, 0, 512);
  w('mixed/Bonk (USA).pce', pce);
  const lynx = Buffer.alloc(64 + 128 * 1024, 4); lynx.write('LYNX', 0, 'latin1'); lynx.fill(0, 4, 64); lynx.write('California Games', 0x0a, 'latin1');
  w('mixed/California Games (USA).lnx', lynx);
  w('mixed/Pitfall (USA).a26', Buffer.alloc(4096, 5));
  w('Atari 2600/River Raid (USA).bin', Buffer.alloc(4096, 6));
  const x32 = Buffer.alloc(3 * 1024 * 1024, 0); x32.write('SEGA 32X', 0x100, 'latin1'); x32.write('KNUCKLES CHAOTIX', 0x150, 'latin1');
  w('mixed/Knuckles Chaotix (USA).32x', x32);
  w('mixed/Wario Land (USA).vb', Buffer.alloc(1024 * 1024, 7));
  w('mixed/Notes.iso', Buffer.alloc(0x9000)); // an .iso we can't place stays out

  // unit checks
  assert.equal(rom.hintFromPath(path.join(work, 'Sony - PlayStation 2', 'x.chd')), 'ps2');
  assert.equal(rom.hintFromPath(path.join(work, 'Nintendo - Game Boy Color', 'x.bin')), 'gbc');
  assert.equal(rom.hintFromPath(path.join(work, 'Xbox 360', 'x.iso')), 'x360');
  assert.equal(rom.hintFromPath(path.join(work, 'Wii U', 'x.iso')), 'wiiu');
  assert.equal(rom.hintFromPath(path.join(work, 'Everything', 'x.iso')), null);
  assert.deepEqual(rom.parseSfo(makeSfo({ TITLE: 'A', TITLE_ID: 'B' })), { TITLE: 'A', TITLE_ID: 'B' });
  assert.equal(rom.dumpMarker(path.join(roms, 'BLUS30001'), fs.readdirSync(path.join(roms, 'BLUS30001'))), path.join(roms, 'BLUS30001', 'PS3_GAME', 'PARAM.SFO'));
  for (const ext of ['.nsp', '.xci', '.nsz', '.wua', '.wud', '.3ds', '.cia', '.gdi', '.cdi', '.sms', '.gg', '.pce', '.lnx', '.a26', '.32x', '.vpk', '.xex'])
    assert.ok(rom.ROM_EXTENSIONS.includes(ext), ext);
  const community = require('../src/core/community');
  assert.equal(community.systemFromTags(['xbox', 'xbox 360', 'x360']), 'x360');
  assert.equal(community.systemFromTags(['3ds', 'nintendo']), '3ds');
  assert.equal(community.systemFromTags(['nintendo switch']), 'switch');
  assert.equal(community.systemFromTags(['naomi2']), 'naomi');

  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'lib');
  const report = await lib.addRoms([path.join(work, 'roms')]);
  const by = Object.fromEntries(report.filter((r) => r.status === 'added').map((r) => [r.name, r.system]));
  const expect = {
    'Super Mario Odyssey': 'switch', 'The Legend of Zelda Breath of the Wild': 'switch', 'Mario Kart 7': '3ds',
    'Super Mario 3D World': 'wiiu', 'Mario Kart 8': 'wiiu', 'Resistance: Fall of Man': 'ps3', 'Gravity Rush': 'vita',
    'Halo 3': 'x360', Halo: 'xbox', 'Jet Set Radio Future': 'xbox', 'Nights into Dreams': 'saturn', 'Sonic CD': 'segacd',
    Shenmue: 'dreamcast', Gex: '3do', 'Panzer Dragoon Saga': 'saturn', 'Shadow of the Colossus': 'ps2',
    'California Games': 'lynx', 'KNUCKLES CHAOTIX': '32x',
  };
  for (const [name, sys] of Object.entries(expect)) assert.equal(by[name], sys, `${name} → ${sys}\n${JSON.stringify(report, null, 1)}`);
  const sys = report.filter((r) => r.status === 'added').map((r) => r.system);
  for (const s of ['sms', 'gg', 'pce', 'a2600', 'vb']) assert.ok(sys.includes(s), s);
  assert.equal(sys.filter((s) => s === 'a2600').length, 2, 'a .a26 and a small .bin in an "Atari 2600" folder');
  assert.ok(!report.some((r) => /EBOOT|eboot|default\.|data\.bin|game\.rpx/.test(r.file)), 'files inside game folders are not listed on their own');
  assert.equal(report.find((r) => r.file === 'Notes.iso').status, 'error');
  for (const s of sys) assert.ok(catalog.systems[s], `catalog lists ${s}`);

  const entry = (n) => lib.state.roms.find((r) => r.internalName === n);
  assert.equal(entry('Super Mario Odyssey').serial, '0100000000010000');
  assert.equal(entry('Mario Kart 7').serial, 'CTR-P-AREE');
  assert.equal(entry('Super Mario 3D World').serial, 'WUP-P-ARDE');
  assert.equal(entry('Resistance: Fall of Man').serial, 'BCUS98174');
  assert.ok(entry('Super Mario Odyssey').file.endsWith('.nsp'), 'big files stay where they are');
  // headers are stripped for hashing; the original keeps its header and a headerless copy is made only on demand
  const bonk = lib.state.roms.find((r) => r.system === 'pce');
  assert.equal(bonk.size, 256 * 1024);
  assert.equal(fs.statSync(bonk.file).size, 256 * 1024 + 512);
  assert.equal(fs.statSync(await lib.romPath(bonk)).size, 256 * 1024);

  // a Switch port matches the dump by name
  const game = { id: 'x', system: 'switch', title: 'Super Mario Odyssey', port: 'Odyssey PC', rom: { titles: ['Super Mario Odyssey'] } };
  assert.equal(romdb.matchRomToGame(entry('Super Mario Odyssey'), game).level, 'ok');
});

// ---------------------------------------------------------------- cover art
test('cover art: matching names to libretro-thumbnails', () => {
  const covers = require('../src/core/covers');
  const idx = covers.makeIndex([
    "Legend of Zelda, The - Majora's Mask (USA)", "Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es)",
    'Final Fantasy VII (USA)', 'Final Fantasy VIII (USA)', 'Crash Bandicoot (Japan)', 'Crash Bandicoot (USA)', 'Crash Bandicoot (USA) (Beta)',
    "Tony Hawk's Pro Skater 2 (USA)", 'Castlevania - Symphony of the Night (USA)', 'Super Mario Bros. _ Duck Hunt (USA)',
  ]);
  assert.equal(covers.bestMatch(idx, { exact: ["Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es)"] }), "Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es)");
  assert.equal(covers.bestMatch(idx, { titles: ["The Legend of Zelda: Majora's Mask"] }), "Legend of Zelda, The - Majora's Mask (USA)");
  assert.equal(covers.bestMatch(idx, { titles: ['Final Fantasy 7'] }), 'Final Fantasy VII (USA)');
  assert.equal(covers.bestMatch(idx, { titles: ['Final Fantasy VIII'] }), 'Final Fantasy VIII (USA)');
  assert.equal(covers.bestMatch(idx, { titles: ['Crash Bandicoot'] }), 'Crash Bandicoot (USA)', 'USA before Japan, never a beta');
  assert.equal(covers.bestMatch(idx, { titles: ['Crash Bandicoot'], region: 'Japan' }), 'Crash Bandicoot (Japan)', 'your ROM\'s region wins');
  assert.equal(covers.bestMatch(idx, { titles: ['Tony Hawks Pro Skater 2'] }), "Tony Hawk's Pro Skater 2 (USA)");
  assert.equal(covers.bestMatch(idx, { titles: ['Castlevania Symphony of the Night'] }), 'Castlevania - Symphony of the Night (USA)');
  assert.equal(covers.bestMatch(idx, { exact: ['Super Mario Bros. / Duck Hunt (USA)'] }), 'Super Mario Bros. _ Duck Hunt (USA)', 'characters libretro replaces');
  assert.equal(covers.bestMatch(idx, { titles: ['Final Fantasy IX'] }), null, 'never the wrong numbered game');
  assert.equal(covers.bestMatch(idx, { titles: ['Spyro'] }), null);
  assert.equal(covers.regionOf('Crash Bandicoot (Japan) (Rev 1)'), 'Japan');
  assert.equal(covers.imageType(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')), 'png');
  assert.equal(covers.imageType(Buffer.from('<html>not found</html>')), null);
});

test('cover art: library finds, saves, falls back to SteamGridDB, and takes your own picture', async () => {
  const work = tmp();
  const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64, 7)]);
  const calls = [];
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => String(body), arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const fakeFetch = async (url, opts = {}) => {
    calls.push(url);
    if (url.includes('api.github.com') && url.endsWith('/git/trees/master')) return res({ tree: [{ path: 'Named_Boxarts', type: 'tree', sha: 'abc' }] });
    if (url.includes('Sony_-_PlayStation/git/trees/abc')) return res({ tree: [{ path: 'Crash Bandicoot (USA).png' }, { path: 'Spyro the Dragon (USA).png' }] });
    if (url.includes('api.github.com')) return res({ tree: [] });
    if (url.startsWith('https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation/master/Named_Boxarts/Crash%20Bandicoot%20(USA).png')) return res(PNG);
    if (url.includes('steamgriddb.com/api/v2/search/autocomplete/Super%20Mario%20Odyssey')) {
      assert.equal(opts.headers.Authorization, 'Bearer sg-key');
      return res({ success: true, data: [{ id: 42, name: 'Super Mario Odyssey' }] });
    }
    if (url.includes('steamgriddb.com/api/v2/grids/game/42')) return res({ success: true, data: [{ url: 'https://cdn2.steamgriddb.com/grid/odyssey.png' }] });
    if (url === 'https://cdn2.steamgriddb.com/grid/odyssey.png') return res(PNG);
    return res('nope', 404);
  };
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32', hooks: { fetch: fakeFetch } });
  await lib.load();
  lib.state.roms.push(
    { id: 'r1', system: 'ps1', file: 'D:\\ROMs\\PS1\\Crash Bandicoot (USA).cue', originalName: 'Crash Bandicoot (USA).cue', internalName: 'Crash Bandicoot', byName: true },
    { id: 'r2', system: 'switch', file: 'D:\\ROMs\\Switch\\Super Mario Odyssey [0100000000010000].nsp', originalName: 'Super Mario Odyssey [0100000000010000].nsp', internalName: 'Super Mario Odyssey', byName: true },
  );

  const crash = await lib.cover('rom', 'r1');
  assert.ok(crash && fs.existsSync(crash), 'downloaded and saved');
  assert.deepEqual(fs.readFileSync(crash), PNG);
  assert.equal(lib.snapshot().roms.find((r) => r.id === 'r1').cover, crash);
  const before = calls.length;
  assert.equal(await lib.cover('rom', 'r1'), crash);
  assert.equal(calls.length, before, 'second time comes from disk, no network');
  // the console list is cached on disk too
  assert.ok(fs.existsSync(path.join(work, 'data', 'covers', 'index', 'Sony_-_PlayStation.json')));

  // Switch has no libretro covers: nothing without a SteamGridDB key, found with one
  assert.equal(await lib.cover('rom', 'r2'), null);
  assert.equal(await lib.cover('rom', 'r2'), null, 'remembered as not found');
  await lib.updateSettings({ steamGridKey: 'sg-key' });
  assert.equal(lib.snapshot().settings.steamGridKey, '••••', 'the key is never sent to the window');
  const odyssey = await lib.cover('rom', 'r2');
  assert.ok(odyssey && fs.existsSync(odyssey), 'a new key retries covers that were missing');
  assert.equal(lib.state.covers['rom:r2'].source, 'steamgriddb');

  // your own picture wins, and can be undone
  const pic = path.join(work, 'mine.png'); fs.writeFileSync(pic, PNG);
  const mine = await lib.setCustomCover('game', 'zelda64recomp', pic);
  const g = lib.snapshot().games.find((x) => x.id === 'zelda64recomp');
  assert.equal(g.cover, mine); assert.ok(g.customCover);
  await assert.rejects(lib.setCustomCover('game', 'zelda64recomp', path.join(__dirname, 'core.test.js')), /not a PNG/);
  await lib.resetCover('game', 'zelda64recomp');
  assert.ok(!fs.existsSync(mine), 'your old picture is tidied away');
  assert.ok(!lib.snapshot().games.find((x) => x.id === 'zelda64recomp').customCover);

  // titles from Find more
  assert.ok(await lib.cover('title', { system: 'ps1', title: 'Crash Bandicoot' }));
});

// ---------------------------------------------------------------- arcade sets
test('arcade: CPS1/2/3, Neo Geo and NAOMI sets are recognised by name, BIOS sets are skipped', async () => {
  const arcade = require('../src/core/arcade');
  const db = arcade.load(path.join(__dirname, '..', 'catalog', 'arcade.json'));
  const expect = { sf2: 'cps1', sf2ce: 'cps1', ffight: 'cps1', sfa3: 'cps2', mvsc: 'cps2', ddsom: 'cps2', sfiii3: 'cps3', jojoba: 'cps3', kof98: 'neogeo', mslug: 'neogeo', mvsc2: 'naomi', vf3: 'model3', mk2: 'midway' };
  for (const [set, board] of Object.entries(expect)) assert.equal(arcade.lookup(db, set).board, board, set);
  for (const b of new Set(Object.values(db.sets).map((s) => s[3]))) assert.ok(catalog.systems[b], `catalog lists board ${b}`);
  assert.equal(arcade.classify(db, 'D:\\MAME\\neogeo.zip'), 'bios');
  assert.equal(arcade.classify(db, 'Super Mario World (USA).zip'), null, 'console ROM zips are not arcade sets');
  assert.equal(arcade.titleOf('Street Fighter II - The World Warrior (910522 World)'), 'Street Fighter II - The World Warrior');

  const work = tmp();
  const dir = path.join(work, 'roms', 'FBNeo');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['sf2', 'sfa3', 'sfiii3', 'kof98', 'mslug', 'neogeo', 'sf2ce']) fs.writeFileSync(path.join(dir, `${n}.zip`), Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'));
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'lib');
  const report = await lib.addRoms([path.join(work, 'roms')]);
  const got = Object.fromEntries(report.filter((r) => r.status === 'added').map((r) => [r.file, r.system]));
  assert.deepEqual(got, { 'sf2.zip': 'cps1', 'sf2ce.zip': 'cps1', 'sfa3.zip': 'cps2', 'sfiii3.zip': 'cps3', 'kof98.zip': 'neogeo', 'mslug.zip': 'neogeo' }, JSON.stringify(report));
  const sf2 = lib.state.roms.find((r) => r.id === 'arcade-sf2');
  assert.equal(sf2.file, path.join(dir, 'sf2.zip'), 'sets stay where they are, under their own name');
  assert.equal(sf2.arcade.year, 1991);
  assert.equal(sf2.arcade.maker, 'Capcom');
  const kof = lib.state.roms.find((r) => r.id === 'arcade-kof98');
  assert.equal(kof.arcade.bios, 'neogeo'); assert.equal(kof.arcade.biosMissing, false, 'neogeo.zip is next to it');
  // clones fall back to the parent's box art
  const want = lib.coverWant('rom', 'arcade-sf2ce');
  assert.equal(want.thumbs, 'FBNeo_-_Arcade_Games');
  assert.ok(want.exact[0].startsWith("Street Fighter II' - Champion Edition"));

  // a port can name the sets it takes
  const port = { id: 'p', system: 'cps1', title: 'Street Fighter II', port: 'SF2 port', rom: { sets: ['sf2'] } };
  assert.equal(romdb.matchRomToGame(sf2, port).level, 'ok');
  assert.equal(romdb.matchRomToGame(lib.state.roms.find((r) => r.id === 'arcade-sfa3'), port).level, null);
  // and a community port tagged plain "arcade" matches by title on any board
  const generic = { id: 'q', system: 'arcade', title: 'Metal Slug', port: 'Metal Slug port', rom: { titles: ['Metal Slug'] } };
  assert.equal(romdb.matchRomToGame(lib.state.roms.find((r) => r.id === 'arcade-mslug'), generic).level, 'ok');
});

test('Fulton update check, credits and safe defaults', async () => {
  const update = require('../src/core/update');
  assert.ok(update.isNewer('1.20', '1.19'));
  assert.ok(update.isNewer('v2.0.0', '1.19'));
  assert.ok(!update.isNewer('1.19.0', '1.19'));
  assert.ok(!update.isNewer('1.9', '1.19'));
  assert.ok(!update.repoReady('YOUR-GITHUB-NAME/cartridge'));
  assert.ok(update.repoReady('triwind/cartridge'));

  const release = { tag_name: 'v9.9.0', html_url: 'https://github.com/triwind/cartridge/releases/tag/v9.9.0', body: 'notes',
    assets: [{ name: 'Fulton-1.20.exe', browser_download_url: 'https://x/exe' }, { name: 'Fulton-1.20-Setup.msi', browser_download_url: 'https://x/msi' }] };
  const fake = (rel, status = 200) => async () => ({ ok: status === 200, status, json: async () => rel });
  const r = await update.checkForUpdate({ repo: 'triwind/cartridge', current: '1.20', fetchImpl: fake(release), platform: 'win32' });
  assert.equal(r.available, true);
  assert.equal(r.version, '9.9');
  assert.equal(r.download, 'https://x/msi');
  assert.equal((await update.checkForUpdate({ repo: 'triwind/cartridge', current: '9.9', fetchImpl: fake(release) })).available, false);
  assert.equal((await update.checkForUpdate({ repo: 'triwind/cartridge', current: '1.19', fetchImpl: fake({ ...release, prerelease: true }) })).available, false);
  assert.equal((await update.checkForUpdate({ repo: 'triwind/cartridge', current: '1.19', fetchImpl: fake(null, 404) })).skipped, 'no-releases');
  let called = false;
  assert.equal((await update.checkForUpdate({ repo: 'YOUR-GITHUB-NAME/cartridge', current: '1.19', fetchImpl: async () => { called = true; } })).skipped, 'no-repo');
  assert.equal(called, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-about-'));
  const lib = new Library({ dataDir: dir, catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), hooks: { fetch: fake(release) } });
  await lib.load();
  const snap = lib.snapshot();
  assert.equal(snap.settings.showMetacritic, false, 'Metacritic is off for new installs');
  assert.equal(snap.settings.welcomeSeen, false);
  assert.equal(snap.links.kofi, 'https://ko-fi.com/triwind');
  const credits = lib.credits();
  assert.ok(credits.length > 5);
  const hm = credits.find((c) => c.name === 'Harbour Masters');
  assert.ok(hm && hm.games.length >= 2 && /github\.com\/HarbourMasters/.test(hm.url));
  assert.equal(lib.links.repo, 'TriwindBryan/fulton');
  // placeholder repo: no network call, no update
  lib.links.repo = 'YOUR-GITHUB-NAME/cartridge';
  assert.equal((await lib.checkAppUpdate({ force: true })).available, false);
  lib.links.repo = 'TriwindBryan/fulton';
  assert.equal((await lib.checkAppUpdate({ force: true })).version, '9.9');
  assert.equal(lib.snapshot().appUpdate.version, '9.9');
});

test('MSI hook closes Fulton and suppresses the restart prompt', () => {
  const { patch } = require('../build/msi-hook');
  const sample = `<?xml version="1.0"?><Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Product Id="*">
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage='A newer version is installed.'/>
    <Directory Id="TARGETDIR" Name="SourceDir"/></Product></Wix>`;
  const out = patch(sample);
  assert.match(out, /<Property Id="REBOOT" Value="ReallySuppress"\/>/);
  assert.match(out, /taskkill\.exe" \/F \/IM "Fulton\.exe"/);
  assert.match(out, /taskkill\.exe" \/F \/IM "Cartridge\.exe"/, 'upgrading from the old name closes it too');
  assert.match(out, /<InstallExecuteSequence>\s*<Custom Action="CloseFulton" Before="InstallValidate"\/>\s*<Custom Action="CloseCartridgeOld" Before="InstallValidate"\/>\s*<\/InstallExecuteSequence>/);
  assert.equal(patch(out), out, 'patching twice changes nothing');
  // an existing sequence gets the step added rather than a second sequence
  const withSeq = sample.replace('<Directory', '<InstallExecuteSequence><Custom Action="runAfterFinish" After="InstallFinalize">1</Custom></InstallExecuteSequence><Directory');
  const out2 = patch(withSeq);
  assert.equal((out2.match(/<InstallExecuteSequence>/g) || []).length, 1);
  assert.match(out2, /CloseCartridgeOld" Before="InstallValidate"\/>\s*<Custom Action="runAfterFinish"/);
});

test('ROMs are checked on a worker thread with the same results', async () => {
  const { Inspector } = require('../src/core/inspector');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-worker-'));
  // an N64 ROM in .v64 byte order (gets converted, so data comes back) and an iNES file (header stripped, alt kept)
  const z64 = Buffer.alloc(1024 * 1024); z64.writeUInt32BE(0x80371240, 0); z64.write('WORKER TEST         ', 0x20, 'latin1'); z64.write('NWTE', 0x3b, 'latin1');
  const v64 = Buffer.from(z64); for (let i = 0; i < v64.length; i += 2) { const a = v64[i]; v64[i] = v64[i + 1]; v64[i + 1] = a; }
  fs.writeFileSync(path.join(work, 'test.v64'), v64);
  const nes = Buffer.concat([Buffer.from([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(40 * 1024, 7)]);
  fs.writeFileSync(path.join(work, 'test.nes'), nes);

  const logs = [];
  const insp = new Inspector(path.join(__dirname, '..', 'src', 'core', 'inspect-worker.js'), (m) => logs.push(m));
  try {
    for (const f of ['test.v64', 'test.nes']) {
      const file = path.join(work, f);
      const a = await insp.inspect(file);
      const b = await rom.inspectRom(file);
      assert.ok(Buffer.isBuffer(a.data), `${f}: data is a Buffer again`);
      assert.equal(a.sha1, b.sha1);
      assert.ok(a.data.equals(b.data));
      assert.equal(a.system, b.system);
      if (b.alt) { assert.ok(Buffer.isBuffer(a.alt.data)); assert.equal(a.alt.sha1, b.alt.sha1); }
    }
    assert.ok(insp.worker, 'ran on the worker');
    await assert.rejects(insp.inspect(path.join(work, 'missing.nes')));
    // a worker that can't start falls back to checking in-process
    const bad = new Inspector(path.join(work, 'nope.js'), (m) => logs.push(m));
    const r = await bad.inspect(path.join(work, 'test.nes'));
    assert.equal(r.system, 'nes');
    bad.close();
  } finally { insp.close(); }
});

test('ROM help: dumping guides, exact versions and special releases', async () => {
  const dumping = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'dumping.json'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'games.json'), 'utf8'));
  const covered = new Set(dumping.guides.flatMap((g) => g.systems));
  // every console a catalog port uses has its own guide, and every link is https
  for (const g of catalog.games) assert.ok(covered.has(g.system), `no dumping guide for ${g.system}`);
  for (const g of [...dumping.guides, dumping.fallback]) {
    assert.ok(g.title && g.steps.length && g.links.length, g.id);
    for (const l of g.links) assert.match(l.url, /^https:\/\//);
  }

  // special re-releases don't count when a port names a region
  const port = { system: 'n64', rom: { titles: ["Legend of Zelda, The - Majora's Mask"], regions: ['USA'] } };
  const lvl = (name) => romdb.matchRomToGame({ system: 'n64', sha1: 'X', datName: name }, port).level;
  assert.equal(lvl("Legend of Zelda, The - Majora's Mask (USA)"), 'ok');
  assert.equal(lvl("Legend of Zelda, The - Majora's Mask (USA) (LodgeNet)"), 'warn');
  assert.equal(lvl("Legend of Zelda, The - Majora's Mask (USA) (Zelda Collection)"), 'warn');
  assert.equal(lvl("Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es)"), 'warn');
  // …but a port that accepts any version (no region) still takes them
  const any = { system: 'n64', rom: { titles: ['Legend of Zelda, The - Ocarina of Time'] } };
  assert.equal(romdb.matchRomToGame({ system: 'n64', sha1: 'X', datName: 'Legend of Zelda, The - Ocarina of Time (USA) (GameCube)' }, any).level, 'ok');

  // romHelp lists the accepted dumps from the No-Intro list, retail first
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-help-'));
  fs.mkdirSync(path.join(dir, 'romdb'));
  const sha = (c) => c.repeat(40);
  const dat = ["Legend of Zelda, The - Majora's Mask (USA) (LodgeNet)", "Legend of Zelda, The - Majora's Mask (USA)", "Legend of Zelda, The - Majora's Mask (Europe)"]
    .map((n, i) => `game (\n\tname "${n}"\n\trom ( name "${n}.z64" size 33554432 sha1 ${sha('ABC'[i])} )\n)\n`).join('');
  fs.writeFileSync(path.join(dir, 'romdb', 'Nintendo - Nintendo 64.dat'), dat);
  const lib = new Library({ dataDir: dir, catalogFile: path.join(__dirname, '..', 'catalog', 'games.json') });
  await lib.load();
  const h = await lib.romHelp('zelda64recomp');
  assert.equal(h.guide.id, 'n64');
  assert.deepEqual(h.targets.map((t) => t.name), ["Legend of Zelda, The - Majora's Mask (USA)"]);
  assert.equal(h.targets[0].sha1, sha('B'));
  assert.match(h.buyUrl, /^https:\/\/www\.ebay\.com\/sch\/i\.html\?_nkw=.*Nintendo%2064/);
  const disc = await lib.romHelp('dusklight');
  assert.deepEqual(disc.discIds, ['GZ2', 'RZD']);
  assert.equal(disc.guide.id, 'gcwii');
});

test('Metacritic: never shows a misread score', () => {
  const mc = require('../src/core/metacritic');
  // a page with no critic score, followed by another game's data further down (how Vandal Hearts once showed 144 from 1,445 reviews on "DS")
  const page = `<html><nav><a>DS</a><a>PlayStation</a></nav>
    <script>{"criticScoreSummary":{"score":null,"reviewCount":0,"url":"/game/vandal-hearts/critic-reviews/"},
    "related":[{"title":"Other game","score":144,"reviewCount":1445}]}</script>
    <div>Metascore tbd</div></html>`;
  const r = mc.sane(mc.parsePage(page));
  assert.equal(r.score, null, 'no score, not 144');
  assert.equal(r.reviews, 0);
  assert.notEqual(r.platform, 'DS', 'menu text is not the platform');
  // a normal page still reads correctly
  const good = `<script>{"criticScoreSummary":{"score":88,"reviewCount":15},"gamePlatform":"PlayStation"}</script>`;
  const g = mc.sane(mc.parsePage(good));
  assert.equal(g.score, 88); assert.equal(g.reviews, 15); assert.equal(g.platform, 'PlayStation');
  // anything out of range is rejected outright
  assert.equal(mc.sane({ score: 144, reviews: 1445, platform: 'DS' }), undefined);
  assert.equal(mc.sane({ score: 80, reviews: 3, user: { score: 79, ratings: 5 } }).user, null);
});

test('Metacritic: scores saved by an older version are looked up again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-meta-'));
  const lib = new Library({ dataDir: dir, catalogFile: path.join(__dirname, '..', 'catalog', 'games.json') });
  await lib.load();
  const g = lib.games.find((x) => !x.metacritic);
  lib.state.metaCache = { [g.id]: { fetchedAt: Date.now(), data: { score: 144, reviews: 1445, platform: 'DS' } } }; // old entry, no version
  const snap = lib.snapshot().games.find((x) => x.id === g.id);
  assert.equal(snap.metacritic, null);
  assert.equal(snap.metaChecked, false, 'the panel will check again');
});

test('Mac: picks the right download, finds the .app, and offers the right update', async () => {
  const assets = (names) => names.map((name, i) => ({ name, size: 1000 + i, browser_download_url: `https://x/${name}` }));
  // a typical Harbour Masters-style release
  const hm = assets(['SoH-Win64.zip', 'SoH-Linux.appimage', 'SoH-Mac.dmg', 'SoH-Mac.zip', 'source.tar.gz']);
  assert.equal(gh.pickAsset(hm, 'darwin', null, 'arm64').name, 'SoH-Mac.zip');
  assert.equal(gh.pickAsset(assets(['SoH-Win64.zip', 'SoH-Mac.dmg']), 'darwin', null, 'arm64').name, 'SoH-Mac.dmg');
  assert.equal(gh.pickAsset(hm, 'win32').name, 'SoH-Win64.zip', 'Windows still gets the Windows build');
  // separate chip builds: Apple Silicon gets arm64, Intel gets x86_64 and never arm64
  const split = assets(['game-macos-arm64.zip', 'game-macos-x86_64.zip', 'game-windows-x64.zip']);
  assert.equal(gh.pickAsset(split, 'darwin', null, 'arm64').name, 'game-macos-arm64.zip');
  assert.equal(gh.pickAsset(split, 'darwin', null, 'x64').name, 'game-macos-x86_64.zip');
  assert.equal(gh.pickAsset(assets(['game-macos-arm64.zip']), 'darwin', null, 'x64'), null);
  assert.equal(gh.pickAsset(assets(['g-mac-universal.dmg', 'g-mac-x86_64.dmg']), 'darwin', null, 'arm64').name, 'g-mac-universal.dmg');
  // Windows-only releases have nothing for a Mac
  assert.equal(gh.pickAsset(assets(['Zelda64Recompiled-Windows.zip', 'Zelda64Recompiled-Linux.tar.gz']), 'darwin', null, 'arm64'), null);
  // the catalog's Windows assetMatch doesn't hide the Mac build
  const rel = { tag_name: 'v1', assets: assets(['pd-x86_64-windows.zip', 'pd-macos.zip']) };
  assert.equal(gh.summariseRelease(rel, { assetMatch: 'x86_64.*win|win.*x86_64|win64' }, 'darwin').asset.name, 'pd-macos.zip');

  // finding the game inside the install folder: the .app bundle, picked by the catalog's (Windows) exe hint
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-mac-'));
  for (const app of ['soh.app', 'Updater.app']) {
    fs.mkdirSync(path.join(dir, 'Ship', app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Ship', app, 'Contents', 'MacOS', app.replace('.app', '')), Buffer.alloc(600 * 1024));
  }
  fs.mkdirSync(path.join(dir, 'Ship', 'Other.app'), { recursive: true });
  assert.equal(await inst.findExecutable(dir, 'soh\\.exe$', 'darwin'), path.join(dir, 'Ship', 'soh.app'));
  assert.equal(inst.macHint('zelda3\\.exe$'), 'zelda3');

  // Fulton's own update: a Mac gets the .dmg for its chip
  const update = require('../src/core/update');
  const release = { tag_name: 'v9.9.0', html_url: 'https://x', assets: assets(['Fulton-9.9.0-Setup.msi', 'Fulton-9.9.0-arm64.dmg', 'Fulton-9.9.0-x64.dmg']) };
  const fake = async () => ({ ok: true, status: 200, json: async () => release });
  assert.match((await update.checkForUpdate({ repo: 'a/b', current: '1.0', fetchImpl: fake, platform: 'darwin', arch: 'arm64' })).download, /arm64\.dmg$/);
  assert.match((await update.checkForUpdate({ repo: 'a/b', current: '1.0', fetchImpl: fake, platform: 'darwin', arch: 'x64' })).download, /x64\.dmg$/);
  assert.match((await update.checkForUpdate({ repo: 'a/b', current: '1.0', fetchImpl: fake, platform: 'win32' })).download, /\.msi$/);
});

test('Bundled fonts: every @font-face file exists and is licensed', () => {
  const dir = path.join(__dirname, '..', 'renderer');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const urls = [...css.matchAll(/@font-face[^}]*url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 3);
  for (const u of urls) {
    const buf = fs.readFileSync(path.join(dir, u));
    assert.ok(buf.length > 50000, u);
    assert.equal(buf.readUInt32BE(0), 0x00010000, `${u} is a TrueType font`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'fonts', 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
  // the page tags the OS before the stylesheet's Mac font order applies, and the CSP allows the fonts
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /font-src 'self'/);
  assert.ok(html.indexOf('platform.js') < html.indexOf('app.js'));
});

test('Mac and Linux never pick a download that is probably the Windows build', () => {
  const a = (names) => names.map((name) => ({ name, size: 1, browser_download_url: `https://x/${name}` }));
  // zelda3 publishes one zip with no system in its name: it's for Windows
  assert.equal(gh.pickAsset(a(['zelda3_v0.3.zip']), 'win32').name, 'zelda3_v0.3.zip');
  assert.equal(gh.pickAsset(a(['zelda3_v0.3.zip']), 'darwin', null, 'arm64'), null);
  assert.equal(gh.pickAsset(a(['zelda3_v0.3.zip']), 'linux'), null);
  // but Mac downloads without "mac" in the name still count when they're disk images
  assert.equal(gh.pickAsset(a(['Game-1.0.dmg', 'Game-1.0.zip']), 'darwin', null, 'arm64').name, 'Game-1.0.dmg');
  assert.equal(gh.pickAsset(a(['game-osx.zip', 'game.zip']), 'darwin', null, 'arm64').name, 'game-osx.zip');
});

test('ROMs are never copied, and copies from older versions are cleaned up', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-nocopy-'));
  const mine = path.join(work, 'My ROMs');
  fs.mkdirSync(mine, { recursive: true });
  const z64 = Buffer.alloc(1024 * 1024); z64.writeUInt32BE(0x80371240, 0); z64.write('NOCOPY TEST         ', 0x20, 'latin1');
  fs.writeFileSync(path.join(mine, 'game.z64'), z64);
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'Fulton');
  lib.state.settings.romFolders = [mine];

  // an older Fulton's copy of the same ROM, still in the library
  fs.mkdirSync(lib.dirs.roms, { recursive: true });
  const copy = path.join(lib.dirs.roms, 'game.z64');
  fs.writeFileSync(copy, z64);
  const sha = require('crypto').createHash('sha1').update(z64).digest('hex').toUpperCase();
  lib.state.roms.push({ id: sha, file: copy, originalName: 'game.z64', system: 'n64', sha1: sha, size: z64.length, format: 'z64' });
  assert.equal((await lib.romCopies()).count, 1);

  const res = await lib.migrateRomCopies();
  assert.equal(res.relinked, 1);
  assert.equal(res.freed, z64.length);
  assert.equal(lib.state.roms.length, 1);
  assert.equal(lib.state.roms[0].file, path.join(mine, 'game.z64'), 'points at the original now');
  assert.ok(!fs.existsSync(copy), 'the old copy is gone');
  assert.equal(await lib.romPath(lib.state.roms[0]), path.join(mine, 'game.z64'), 'a plain .z64 is used as it is');
  assert.equal(await lib.migrateRomCopies(), null, 'runs once');

  // adding more ROMs never writes anything into Fulton's folders
  fs.writeFileSync(path.join(mine, 'other.z64'), Buffer.concat([z64.subarray(0, 0x40), Buffer.alloc(z64.length - 0x40, 1)]));
  await lib.addRoms([mine]);
  assert.ok(!fs.readdirSync(lib.dirs.roms).length, 'ROMs folder stays empty');
});

test('safety: zips unpack one at a time, only real copies are deleted, missing ROMs are tracked', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-safe-'));
  const mine = path.join(work, 'My ROMs');
  fs.mkdirSync(mine, { recursive: true });
  const n64 = (tag) => { const b = Buffer.alloc(256 * 1024); b.writeUInt32BE(0x80371240, 0); b.write(tag.padEnd(20), 0x20, 'latin1'); b.write(tag, 0x100, 'latin1'); return b; };
  // three zipped ROMs (loose ROMs where there's no zip command, e.g. GitHub's Windows machines: the rest still runs)
  let hasZip = true;
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { hasZip = false; }
  const ext = hasZip ? 'zip' : 'z64';
  for (const t of ['ZIPA', 'ZIPB', 'ZIPC']) {
    const src = path.join(work, `${t}.z64`);
    fs.writeFileSync(src, n64(t));
    if (!hasZip) { fs.renameSync(src, path.join(mine, `${t}.z64`)); continue; }
    execFileSync('zip', ['-qj', path.join(mine, `${t}.zip`), src]);
    fs.rmSync(src);
  }
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'Fulton');
  lib.state.settings.romFolders = [mine];
  // count temporary folders that exist at once while the scan runs
  let most = 0;
  const realInspect = rom.inspectRom;
  lib.hooks.inspectRom = async (f) => {
    const live = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cartridge-rom-')).length;
    most = Math.max(most, live);
    return realInspect(f);
  };
  const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cartridge-rom-')).length;
  const report = await lib.addRoms([mine]);
  assert.equal(report.filter((r) => r.status === 'added').length, 3);
  assert.ok(most - before <= 1, `only one zip unpacked at a time (saw ${most - before})`);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('cartridge-rom-')).length, before, 'temporary folders cleaned up');

  // a full drive stops with a plain message instead of failing silently
  const disk = require('../src/core/disk');
  const e = disk.spaceError('C:\\Users\\x', 2e9, 1e8);
  assert.match(e.message, /drive is too full: this needs about 2\.0 GB free and there's 100 MB/);
  assert.ok((await disk.freeBytes(path.join(work, 'no', 'such', 'folder'))) > 0, 'free space found from a parent folder');

  // strict deleting: a copy goes; its neighbours and anything in a watched folder never do
  fs.mkdirSync(path.join(lib.dirs.roms, 'Disc'), { recursive: true });
  const copy = path.join(lib.dirs.roms, 'Disc', 'copy.z64');
  const neighbour = path.join(lib.dirs.roms, 'Disc', 'mine-too.z64');
  fs.writeFileSync(copy, 'x'); fs.writeFileSync(neighbour, 'y');
  assert.equal(await lib.deleteRomCopy(copy), 1);
  assert.ok(!fs.existsSync(copy) && fs.existsSync(neighbour), 'only the copy itself is deleted, not its folder');
  lib.state.settings.romFolders = [mine, path.join(lib.dirs.roms, 'Disc')];
  assert.equal(lib.isRomCopy(neighbour), false, 'a watched folder holds your own files');
  assert.equal(await lib.deleteRomCopy(neighbour), 0);
  assert.ok(fs.existsSync(neighbour));
  assert.equal(await lib.deleteRomCopy(path.join(mine, `ZIPA.${ext}`)), 0, 'never outside Fulton\'s ROMs folder');
  assert.ok(fs.existsSync(path.join(mine, `ZIPA.${ext}`)));
  lib.state.settings.romFolders = [mine];

  // a ROM that moves is found again; one that's deleted from a watched folder is forgotten; files are untouched
  const moved = path.join(mine, 'moved');
  fs.mkdirSync(moved);
  fs.renameSync(path.join(mine, `ZIPB.${ext}`), path.join(moved, `ZIPB.${ext}`));
  fs.rmSync(path.join(mine, `ZIPC.${ext}`));
  // a ROM from somewhere else (a drive that's unplugged) is kept, marked missing
  lib.state.roms.push({ id: 'usb', file: path.join(work, 'USB', 'gone.z64'), system: 'n64', size: 1 });
  const rep2 = await lib.scanRomFolders();
  const byName = (t) => lib.state.roms.find((r) => r.internalName && r.internalName.startsWith(t));
  assert.equal(rep2.filter((r) => r.status === 'relinked').length, 1, 'moved ROM relinked');
  assert.equal(byName('ZIPB').file, path.join(moved, `ZIPB.${ext}`));
  assert.ok(!byName('ZIPB').missing);
  assert.ok(!byName('ZIPC'), 'deleted ROM forgotten');
  assert.equal(lib.state.roms.find((r) => r.id === 'usb').missing, true, 'ROM elsewhere kept, marked missing');
  const snap = lib.snapshot();
  assert.ok(snap.roms.find((r) => r.id === 'usb').missing);
  assert.equal(await lib.forgetMissing(), 1);
  assert.ok(!lib.state.roms.some((r) => r.id === 'usb'));
});

test('Check my setup finds problems and fixes only Fulton\'s own leftovers', async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-setup-'));
  // the check looks in the computer's temp folder: point it at an empty one, so leftovers from real use can't change the result
  const fakeTmp = path.join(work, 'tmp'); fs.mkdirSync(fakeTmp);
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: fakeTmp, TMP: fakeTmp, TMPDIR: fakeTmp });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'Fulton');
  const mine = path.join(work, 'roms');
  fs.mkdirSync(mine);
  lib.state.settings.romFolders = [mine, path.join(work, 'unplugged')];
  const id = lib.games[0].id;
  lib.state.installed[id] = { tag: 'v1', dir: path.join(work, 'gone'), exe: path.join(work, 'gone', 'game.exe') };
  lib.state.roms.push({ id: 'lost', file: path.join(work, 'elsewhere', 'lost.z64'), system: 'n64', size: 1 });
  fs.mkdirSync(lib.dirs.downloads, { recursive: true });
  fs.writeFileSync(path.join(lib.dirs.downloads, 'big.zip'), Buffer.alloc(60e6));
  const keep = path.join(mine, 'mine.z64');
  fs.writeFileSync(keep, 'x');

  const r = await lib.checkSetup();
  const ids = r.issues.map((x) => x.id);
  assert.ok(ids.includes('downloads'), 'leftover downloads');
  assert.ok(ids.includes(`folder-${path.join(work, 'unplugged')}`), 'unreachable folder');
  assert.ok(ids.includes('missing'), 'missing ROM');
  assert.ok(ids.includes(`install-${id}`), 'missing game files');
  for (const x of r.issues) if (x.fix) assert.ok(x.fix.label && x.fix.id, x.id);

  await lib.fixSetup('clear-downloads');
  assert.equal(fs.readdirSync(lib.dirs.downloads).length, 0);
  await lib.fixSetup(`unwatch:${path.join(work, 'unplugged')}`);
  assert.deepEqual(lib.state.settings.romFolders, [mine]);
  await lib.fixSetup(`forget-install:${id}`);
  assert.ok(!lib.state.installed[id]);
  await lib.fixSetup('forget-missing');
  assert.ok(!lib.state.roms.some((x) => x.id === 'lost'));
  assert.ok(fs.existsSync(keep), 'your files are never touched');
  const again = await lib.checkSetup();
  assert.deepEqual(again.issues.filter((x) => !/^space-/.test(x.id)).map((x) => x.id), []);
});

test('favorites, new ports since your last visit, and color themes', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-fav-'));
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  const id = lib.games[0].id;
  await lib.setFavorite(id, true);
  assert.equal(lib.snapshot().games.find((g) => g.id === id).favorite, true);
  await lib.setFavorite(id, false);
  assert.equal(lib.snapshot().games.find((g) => g.id === id).favorite, false);

  const item = (k) => ({ key: `${k}#`, repo: k, name: k, project: k, system: 'n64', kind: 'Native PC port', tags: [] });
  // first list ever: the baseline, nothing is new
  await lib.discoverVisited();
  let marked = lib.markCommunity([item('a/one'), item('a/two')]);
  assert.equal(marked.items.filter((c) => c.isNew).length, 0);
  // a later session: a port that appeared since the last visit is new, and stays new for the whole session
  lib.discoverPrev = null;
  lib.state.discoverVisitedAt = Date.now() - 1000;
  await lib.discoverVisited();
  await new Promise((r) => setTimeout(r, 5));
  marked = lib.markCommunity([item('a/one'), item('a/two'), item('b/three')]);
  assert.deepEqual(marked.items.filter((c) => c.isNew).map((c) => c.repo), ['b/three']);
  await lib.discoverVisited();
  assert.deepEqual(lib.markCommunity([item('a/one'), item('a/two'), item('b/three')]).items.filter((c) => c.isNew).map((c) => c.repo), ['b/three']);

  // a whole new list arriving at once isn't 50 "new" ports
  lib.discoverPrev = null;
  lib.state.discoverVisitedAt = Date.now() - 1000;
  await lib.discoverVisited();
  await new Promise((r) => setTimeout(r, 5));
  const batch = Array.from({ length: 50 }, (_, i) => item(`batch/p${i}`));
  assert.equal(lib.markCommunity([item('a/one'), ...batch]).items.filter((c) => c.isNew).length, 0);

  // themes: every preset has every color, and custom colors sit on top of the preset they started from
  global.window = {};
  require('../renderer/themes.js');
  const { THEMES, THEME_KEYS, themeColors } = global.window;
  for (const t of THEMES) for (const [k] of THEME_KEYS) assert.match(t.colors[k], /^#[0-9a-f]{6}$/i, `${t.id}.${k}`);
  assert.equal(themeColors(undefined).accent, '#0a84ff', 'Fulton Blue by default');
  assert.equal(THEMES[0].name, 'Fulton Blue');
  const c = themeColors({ preset: 'custom', base: 'midnight', custom: { accent: '#123456' } });
  assert.equal(c.accent, '#123456');
  assert.equal(c.wall1, THEMES.find((t) => t.id === 'midnight').colors.wall1, 'the rest comes from the preset they started from');
  // custom colors saved by earlier versions (hot was the accent) still apply
  assert.equal(themeColors({ preset: 'custom', base: 'arctic', custom: { hot: '#abcdef' } }).accent, '#abcdef');
  assert.equal(themeColors({ preset: 'arctic' }).accent, THEMES.find((t) => t.id === 'arctic').colors.accent, 'saved presets keep working');
  // pale accents get dark text, deep ones white
  assert.equal(global.window.inkFor('#64d2ff'), '#10131a');
  assert.equal(global.window.inkFor('#0a84ff'), '#ffffff');
  delete global.window;
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.ok(!/rgba\(\s*226,\s*52,\s*43/.test(css.slice(css.indexOf('* { box-sizing'))), 'the reds follow the theme');
});

test('the color wash finds a cover\'s main color; the Mac icon stores small sizes as ARGB', () => {
  const { dominantColor } = require('../src/core/color');
  const px = (fn) => Buffer.from(Array.from({ length: 1024 }, (_, i) => fn(i)).flat());
  const red = dominantColor(px((i) => (i % 5 === 0 ? [200, 20, 30, 255] : [245, 245, 245, 255])));
  assert.match(red, /^#[c-f][0-9a-f]{5}$/i, 'a white cover with a red logo gives red, not gray');
  assert.equal(dominantColor(px(() => [120, 120, 120, 255])), null, 'a gray cover gives nothing (the theme shows)');
  // BGRA order is read too
  const blue = dominantColor(px(() => [200, 60, 20, 255]), { bgra: true });
  assert.ok(parseInt(blue.slice(5, 7), 16) > parseInt(blue.slice(1, 3), 16), 'blue in BGRA');

  const icns = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.icns'));
  assert.equal(icns.toString('latin1', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const tags = {};
  for (let i = 8; i < icns.length;) { const n = icns.readUInt32BE(i + 4); tags[icns.toString('latin1', i, i + 4)] = icns.subarray(i + 8, i + n); i += n; }
  assert.equal(tags.ic04.toString('latin1', 0, 4), 'ARGB', '16 px as ARGB');
  assert.equal(tags.ic05.toString('latin1', 0, 4), 'ARGB', '32 px as ARGB');
  assert.ok(!tags.icp4 && !tags.icp5, 'no PNGs at 16 and 32 px (Finder garbles them)');
  for (const t of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) assert.ok(tags[t], t);
});

test('Find more: which ports have Windows and Mac downloads', async () => {
  const pl = require('../src/core/platforms');
  const html = (repo, tag, names) => names.map((n) => `<a href="/${repo}/releases/download/${tag}/${encodeURIComponent(n)}" rel="nofollow">${n}</a>`).join('');
  assert.deepEqual(pl.assetNamesFromHtml(html('a/b', 'v1', ['Game Win64.zip', 'Game-mac.dmg']), 'a/b'), ['Game Win64.zip', 'Game-mac.dmg']);
  assert.deepEqual(pl.platformsOf(['SoH-Win64.zip', 'SoH-Mac.zip', 'SoH-Linux.AppImage']), { win: true, mac: true, linux: true });
  assert.deepEqual(pl.platformsOf(['zelda3_v0.3.zip']), { win: true, mac: false, linux: false }, 'an unlabelled zip is a Windows build');
  assert.deepEqual(pl.platformsOf(['Game-macos-arm64.dmg']), { win: false, mac: true, linux: false });
  assert.deepEqual(pl.platformsOf(['source.tar.gz']), { win: false, mac: false, linux: false });

  // a fake github.com: two repos with releases, one without, one that answers "busy"
  const releases = { 'hm/soh': ['SoH-Win64.zip', 'SoH-Mac.zip'], 'x/winonly': ['game-windows-x64.zip'] };
  const fakeFetch = async (url) => {
    let m = url.match(/github\.com\/([^/]+\/[^/]+)\/releases\/latest$/);
    if (m) {
      return releases[m[1]] ? { status: 200, ok: true, url: `https://github.com/${m[1]}/releases/tag/v1.0` } : { status: 200, ok: true, url: `https://github.com/${m[1]}/releases` };
    }
    m = url.match(/github\.com\/([^/]+\/[^/]+)\/releases\/expanded_assets\/(.+)$/);
    if (m) return { status: 200, ok: true, text: async () => html(m[1], m[2], releases[m[1]]) };
    return { status: 404, ok: false };
  };
  assert.deepEqual(await pl.latestAssetNames('hm/soh', '', fakeFetch), { tag: 'v1.0', names: ['SoH-Win64.zip', 'SoH-Mac.zip'], released: null });
  assert.deepEqual(await pl.latestAssetNames('no/releases', '', fakeFetch), { tag: null, names: [] });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-plat-'));
  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'win32' });
  await lib.load();
  const item = (repo, get = 'download') => ({ key: `${repo}#`, repo, name: repo, project: repo, system: 'n64', kind: 'Native PC port', tags: [], get });
  const items = [item('hm/soh'), item('x/winonly'), item('no/releases'), item('self/build', 'build')];
  const seen = [];
  await lib.checkPlatforms(items, { fetchImpl: fakeFetch, concurrency: 1, onProgress: (d, t) => seen.push(`${d}/${t}`) });
  assert.deepEqual(seen, ['1/3', '2/3', '3/3'], 'build-it-yourself ports are skipped');
  const marked = Object.fromEntries(lib.markCommunity(items).items.map((c) => [c.repo, [c.win, c.mac]]));
  assert.deepEqual(marked['hm/soh'], [true, true]);
  assert.deepEqual(marked['x/winonly'], [true, false]);
  assert.deepEqual(marked['no/releases'], [false, false]);
  assert.deepEqual(marked['self/build'], [false, false]);
  // cached: nothing to check the second time; a busy GitHub stops the check (the rest wait for next time)
  assert.deepEqual(await lib.checkPlatforms(items, { fetchImpl: fakeFetch }), { checked: 0, failed: 0 }, 'cached: nothing to check again');
  // GitHub says "slow down": Fulton pauses and carries on; what still fails is counted, not silently dropped
  let busyLeft = 2;
  releases['busy/repo'] = ['Game-Mac.zip'];
  const flaky = async (url) => (/busy\/repo\/releases\/latest$/.test(url) && busyLeft-- > 0 ? { status: 429, ok: false, url } : fakeFetch(url));
  const waits = [];
  const r = await lib.checkPlatforms([item('busy/repo'), item('later/one')], { fetchImpl: flaky, concurrency: 1, wait: async (ms) => { waits.push(ms); } });
  assert.equal(waits.length, 2, 'waited twice, then carried on');
  assert.deepEqual(r, { checked: 2, failed: 0 });
  assert.deepEqual(lib.markCommunity([item('busy/repo')]).items[0].mac, true);
  const broken = async () => { throw new Error('boom'); };
  const r2 = await lib.checkPlatforms([item('new/one')], { fetchImpl: broken, wait: async () => {} });
  assert.deepEqual(r2, { checked: 0, failed: 1 });
  assert.deepEqual(lib.markCommunity([item('new/one')]).platformCheck, { total: 1, failed: 1 }, 'the page can say what is still unknown');
});

// Windows doesn't make sparse files by default, so the 18 GB of fake discs would really be written: skipped there
test('Xbox 360: full disc dumps, trimmed isos and Games on Demand are recognised', { skip: process.platform === 'win32' && 'needs sparse files' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-xdisc-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // write an XDVDFS volume (magic + root folder holding the game file) at a partition offset, as a sparse file
  const xdvdfs = (file, part, gameFile, total) => {
    const fd = fs.openSync(file, 'w');
    const vd = Buffer.alloc(32);
    vd.write('MICROSOFT*XBOX*MEDIA', 0, 'latin1');
    vd.writeUInt32LE(0x40, 20); // root folder at sector 0x40
    vd.writeUInt32LE(2048, 24);
    fs.writeSync(fd, vd, 0, 32, part + 0x10000);
    const root = Buffer.alloc(2048);
    root.writeUInt8(gameFile.length, 13); root.write(gameFile, 14, 'latin1');
    fs.writeSync(fd, root, 0, 2048, part + 0x40 * 2048);
    fs.ftruncateSync(fd, total);
    fs.closeSync(fd);
  };
  const GB = 1024 * 1024 * 1024;
  xdvdfs(path.join(work, 'Halo 3 (USA).iso'), 0xfd90000, 'default.xex', 7 * GB); // XGD2: most 360 games
  xdvdfs(path.join(work, 'Forza Horizon (USA).iso'), 0x2080000, 'default.xex', 8 * GB); // XGD3
  xdvdfs(path.join(work, 'Gears of War (trimmed).iso'), 0, 'default.xex', 2 * GB); // extract-xiso output
  xdvdfs(path.join(work, 'Halo (original Xbox).iso'), 0, 'default.xbe', 1 * GB);
  for (const [name, want] of [['Halo 3 (USA).iso', 'x360'], ['Forza Horizon (USA).iso', 'x360'], ['Gears of War (trimmed).iso', 'x360'], ['Halo (original Xbox).iso', 'xbox']]) {
    const f = path.join(work, name);
    assert.equal(rom.sniffSystem(f, fs.statSync(f).size), want, name);
  }

  // Games on Demand: <TitleID>/00007000/<package> with no extension, an STFS "LIVE" file carrying the name
  const god = path.join(work, 'GOD', '4D5307E6', '00007000');
  fs.mkdirSync(god, { recursive: true });
  const pkg = Buffer.alloc(0x2000);
  pkg.write('LIVE', 0, 'latin1');
  pkg.writeUInt32BE(0x7000, 0x344);
  pkg.writeUInt32BE(0x4D5307E6, 0x360);
  const name = Buffer.from('Halo 3', 'utf16le'); name.swap16(); name.copy(pkg, 0x411);
  fs.writeFileSync(path.join(god, '2DFD4B7F9DD1A2D2D3E4'), pkg);
  fs.mkdirSync(path.join(god, '2DFD4B7F9DD1A2D2D3E4.data'));
  fs.writeFileSync(path.join(god, '2DFD4B7F9DD1A2D2D3E4.data', 'Data0000'), Buffer.alloc(4096));

  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'Fulton');
  const report = await lib.addRoms([work]);
  const added = report.filter((r) => r.status === 'added');
  assert.equal(report.filter((r) => r.status === 'error').length, 0, JSON.stringify(report.filter((r) => r.status === 'error')));
  assert.deepEqual(added.map((r) => r.system).sort(), ['x360', 'x360', 'x360', 'x360', 'xbox']);
  const godRom = lib.state.roms.find((r) => r.serial === '4D5307E6');
  assert.ok(godRom, 'Games on Demand package found');
  assert.equal(godRom.internalName, 'Halo 3');
  assert.ok(!fs.existsSync(lib.dirs.roms) || !fs.readdirSync(lib.dirs.roms).length, 'nothing copied');
});

test('3DS: compressed formats, big archives listed without unpacking, clean names', { skip: process.platform === 'win32' && 'uses zip' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-ctr-'));
  const games = path.join(work, 'Games');
  fs.mkdirSync(games);
  // a .3ds (NCSD) with its product code, an Azahar-compressed .zcci, and a .cia inside a "big" zip
  const ncsd = Buffer.alloc(0x5000); ncsd.write('NCSD', 0x100, 'latin1'); ncsd.write('CTR-P-AMKE', 0x4150, 'latin1');
  fs.writeFileSync(path.join(games, '0337 - Mario Kart 7 (USA) Decrypted.3ds'), ncsd);
  fs.writeFileSync(path.join(games, 'Super Mario 3D Land (USA).zcci'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(work, 'Animal Crossing - New Leaf (USA).cia'), Buffer.alloc(300 * 1024, 3));
  execFileSync('zip', ['-q', path.join(games, 'acnl.zip'), 'Animal Crossing - New Leaf (USA).cia'], { cwd: work });

  assert.equal(rom.systemForExtension('x.zcia'), '3ds');
  assert.equal(rom.nameFromFile('0337 - Mario Kart 7 (USA) Decrypted.3ds'), 'Mario Kart 7');
  const listed = await inst.listArchive(path.join(games, 'acnl.zip'));
  assert.deepEqual(listed.map((f) => f.name), ['Animal Crossing - New Leaf (USA).cia']);
  assert.equal(listed[0].size, 300 * 1024);

  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'Fulton');
  lib.bigArchiveBytes = 1; // treat every zip as "big", so it's only listed
  const report = await lib.addRoms([games]);
  assert.equal(report.filter((r) => r.status === 'error').length, 0, JSON.stringify(report));
  const by = (name) => lib.state.roms.find((r) => r.internalName === name);
  assert.equal(by('Mario Kart 7').serial, 'CTR-P-AMKE');
  assert.equal(by('Super Mario 3D Land').system, '3ds');
  const acnl = by('Animal Crossing - New Leaf');
  assert.equal(acnl.file, path.join(games, 'acnl.zip'));
  assert.equal(acnl.member, 'Animal Crossing - New Leaf (USA).cia');
  // unpacked only when a game needs the file
  const p = await lib.romPath(acnl);
  assert.equal(fs.statSync(p).size, 300 * 1024);
});

test('Modern consoles and Dreamcast CHDs are recognised', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-modern-'));
  const mk = (rel, data) => { const f = path.join(work, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const sfo = (entries) => { // a minimal PARAM.SFO with UTF-8 string values
    const keys = Object.keys(entries);
    let kt = Buffer.alloc(0); let dt = Buffer.alloc(0); const idx = [];
    for (const k of keys) {
      const v = Buffer.from(entries[k] + '\0');
      idx.push({ ko: kt.length, dof: dt.length, len: v.length });
      kt = Buffer.concat([kt, Buffer.from(k + '\0')]); dt = Buffer.concat([dt, v]);
    }
    const head = Buffer.alloc(20); head.write('\0PSF', 0, 'latin1'); head.writeUInt32LE(0x101, 4);
    const tableLen = 16 * keys.length;
    head.writeUInt32LE(20 + tableLen, 8); head.writeUInt32LE(20 + tableLen + kt.length, 12); head.writeUInt32LE(keys.length, 16);
    const table = Buffer.alloc(tableLen);
    idx.forEach((e, i) => { table.writeUInt16LE(e.ko, i * 16); table.writeUInt16LE(0x0204, i * 16 + 2); table.writeUInt32LE(e.len, i * 16 + 4); table.writeUInt32LE(e.len, i * 16 + 8); table.writeUInt32LE(e.dof, i * 16 + 12); });
    return Buffer.concat([head, table, kt, dt]);
  };
  // PS4: a package, and a dumped folder (sce_sys/param.sfo + eboot.bin) with a CUSA title ID
  const pkg = Buffer.alloc(0x100); pkg.write('\x7fCNT', 0, 'latin1'); pkg.write('UP9000-CUSA00900_00-BLOODBORNE000000', 0x40, 'latin1');
  mk('PS4/Bloodborne.pkg', pkg);
  mk('Games/God of War/sce_sys/param.sfo', sfo({ TITLE: 'God of War', TITLE_ID: 'CUSA07408' }));
  mk('Games/God of War/eboot.bin', Buffer.alloc(1024));
  // Vita folder stays Vita
  mk('Games/Persona 4 Golden/sce_sys/param.sfo', sfo({ TITLE: 'Persona 4 Golden', TITLE_ID: 'PCSE00120' }));
  mk('Games/Persona 4 Golden/eboot.bin', Buffer.alloc(1024));
  // PS5: sce_sys/param.json + eboot.bin
  mk('Games/Astro Bot/sce_sys/param.json', JSON.stringify({ titleId: 'PPSA01234', localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: 'Astro Bot' } } }));
  mk('Games/Astro Bot/eboot.bin', Buffer.alloc(1024));
  // Xbox One / Series: MicrosoftGame.config
  mk('Xbox One/Halo 5/MicrosoftGame.config', '<Game><ShellVisuals DefaultDisplayName="Halo 5: Guardians"/></Game>');
  mk('Xbox Series/Starfield/MicrosoftGame.config', '<Game><ShellVisuals DefaultDisplayName="Starfield"/></Game>');
  // Switch 2: same file types as Switch, told apart by the folder
  mk('Switch 2/Mario Kart World [0100000000000000].xci', Buffer.alloc(4096));
  // PS3 digital game folder (PSN): PARAM.SFO + USRDIR
  mk('PS3/NPUB30910/PARAM.SFO', sfo({ TITLE: 'Journey', TITLE_ID: 'NPUA80068' }));
  mk('PS3/NPUB30910/USRDIR/EBOOT.BIN', Buffer.alloc(1024));
  // Wii U: NUS folder (title.tmd + .app files) and a .wuhb bundle
  const tmd = Buffer.alloc(0x200); tmd.write('0005000010145D00', 0x18c, 'hex');
  mk('Wii U/Mario Kart 8 [0005000010145D00]/title.tmd', tmd);
  mk('Wii U/Mario Kart 8 [0005000010145D00]/title.tik', Buffer.alloc(0x350));
  mk('Wii U/Mario Kart 8 [0005000010145D00]/00000000.app', Buffer.alloc(4096));
  mk('Wii U/Mario Kart 8 [0005000010145D00]/00000001.app', Buffer.alloc(4096));
  mk('Wii U/Homebrew Launcher.wuhb', Buffer.alloc(4096));
  // CHDs: a GD-ROM (Dreamcast) and a DVD (PS2), each with one metadata entry
  const chd = (tag) => { const b = Buffer.alloc(256); b.write('MComprHD', 0, 'latin1'); b.writeUInt32BE(124, 8); b.writeUInt32BE(5, 12); b.writeBigUInt64BE(124n, 48); b.write(tag, 124, 'latin1'); return b; };
  mk('Discs/Shenmue (USA).chd', chd('CHGD'));
  mk('Discs/God of War II (USA).chd', chd('DVD '));
  assert.equal(rom.chdKind(path.join(work, 'Discs/Shenmue (USA).chd')), 'gd');

  const lib = new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' });
  await lib.load();
  lib.state.settings.libraryDir = path.join(work, 'Fulton');
  const report = await lib.addRoms([work]);
  assert.equal(report.filter((r) => r.status === 'error').length, 0, JSON.stringify(report.filter((r) => r.status === 'error')));
  const sys = (name) => (lib.state.roms.find((r) => r.internalName === name) || {}).system;
  assert.equal(sys('Bloodborne'), 'ps4');
  assert.equal(lib.state.roms.find((r) => r.internalName === 'Bloodborne').serial, 'CUSA00900');
  assert.equal(sys('God of War'), 'ps4');
  assert.equal(sys('Persona 4 Golden'), 'vita');
  assert.equal(sys('Astro Bot'), 'ps5');
  assert.equal(sys('Halo 5: Guardians'), 'xone');
  assert.equal(sys('Starfield'), 'xsx');
  assert.equal(sys('Mario Kart World'), 'switch2');
  assert.equal(sys('Journey'), 'ps3');
  assert.equal(sys('Mario Kart 8'), 'wiiu');
  assert.equal(lib.state.roms.find((r) => r.internalName === 'Mario Kart 8').serial, '0005000010145D00');
  assert.equal(lib.state.roms.filter((r) => r.internalName === 'Mario Kart 8').length, 1, 'one game, not one per .app file');
  assert.equal(sys('Homebrew Launcher'), 'wiiu');
  assert.equal(sys('Shenmue'), 'dreamcast');
  assert.equal(sys('God of War II'), 'ps2');
  for (const id of ['ps4', 'ps5', 'xone', 'xsx', 'switch2']) assert.ok(lib.systems[id], `${id} is in the catalog`);
});

test('a new install starts with an empty shelf; Find more adds built-in ports; removing needs an uninstall first', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-shelf-'));
  const mk = () => new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux', startEmpty: true });
  const lib = await mk().load();
  assert.equal(lib.snapshot().games.length, 0, 'nothing packed in');
  const list = lib.markCommunity([]);
  assert.equal(list.items.filter((c) => c.builtin).length, catalog.games.filter((g) => g.repo).length, 'built-in ports are listed for adding');
  const id = catalog.games.find((g) => g.repo).id;
  const item = list.items.find((c) => c.catalogId === id);
  assert.equal(item.onShelf, null);
  await lib.addCommunityGame(item.key).catch(() => {}); // (the community list needs the network; adding by id is the real path)
  await lib.addToShelf(id);
  assert.deepEqual(lib.snapshot().games.map((g) => g.id), [id]);
  assert.equal(lib.markCommunity([]).items.find((c) => c.catalogId === id).onShelf, id);
  // installed games can't be removed from the shelf
  lib.state.installed[id] = { tag: 'v1', dir: path.join(work, 'x'), exe: 'x' };
  await assert.rejects(() => lib.removeFromShelf(id), /Uninstall/);
  delete lib.state.installed[id];
  await lib.removeFromShelf(id);
  assert.equal(lib.snapshot().games.length, 0);
  // someone who already had Fulton keeps the whole shelf
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-shelf-old-'));
  fs.mkdirSync(path.join(old, 'data'));
  fs.writeFileSync(path.join(old, 'data', 'state.json'), JSON.stringify({ installed: {}, roms: [] }));
  const upgraded = await new Library({ dataDir: path.join(old, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux', startEmpty: true }).load();
  assert.equal(upgraded.snapshot().games.length, catalog.games.length);
});

test('findExecutable: a Java game with only a launch script starts from the script, never a tool inside the bundled JDK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-java-'));
  fs.mkdirSync(path.join(dir, 'libs'));
  fs.writeFileSync(path.join(dir, 'launch.bat'), '@echo off');
  fs.writeFileSync(path.join(dir, 'gpu-optional-setup.bat'), '@echo off');
  fs.writeFileSync(path.join(dir, 'updater.jar'), 'x');
  assert.equal(await inst.findExecutable(dir, undefined, 'win32'), path.join(dir, 'launch.bat'));
  fs.mkdirSync(path.join(dir, 'jdk25', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jdk25', 'bin', 'jaccessinspector.exe'), Buffer.alloc(2e5));
  assert.equal(await inst.findExecutable(dir, undefined, 'win32'), path.join(dir, 'launch.bat'), 'the JDK tool is ignored');
  fs.writeFileSync(path.join(dir, 'Game.exe'), Buffer.alloc(1000));
  assert.equal(await inst.findExecutable(dir, undefined, 'win32'), path.join(dir, 'Game.exe'), 'a real exe still wins');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Find more: release dates are read from a release page and kept with the Windows / Mac check', async () => {
  const platforms = require('../src/core/platforms');
  assert.equal(platforms.releasedFromHtml('<relative-time datetime="2026-10-17T01:16:33Z">Oct 17</relative-time>'), Date.parse('2026-10-17T01:16:33Z'));
  assert.equal(platforms.releasedFromHtml('no dates here'), null);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-rel-'));
  const lib = await new Library({ dataDir: path.join(work, 'data'), catalogFile: path.join(__dirname, '..', 'catalog', 'games.json'), platform: 'linux' }).load();
  const c = { repo: 'a/b', assetFilter: '', get: 'download' };
  lib.state.platformCache = { 'a/b#': { win: true, mac: false, linux: false, released: 1700000000000, v: 2, at: Date.now() } };
  assert.equal(lib.platformsFor(c).released, 1700000000000);
  // an entry saved before dates were kept is checked again
  lib.state.platformCache = { 'a/b#': { win: true, mac: false, linux: false, at: Date.now() } };
  let asked = 0;
  const html = '<a href="/a/b/releases/download/v1/x-win.zip">x</a><relative-time datetime="2026-09-01T00:00:00Z"></relative-time>';
  const fetchImpl = async (url) => { asked++; return url.endsWith('/releases/latest') ? { status: 200, ok: true, url: 'https://github.com/a/b/releases/tag/v1' } : { status: 200, ok: true, text: async () => html }; };
  await lib.checkPlatforms([c], { fetchImpl });
  assert.ok(asked >= 2, 'old entries are checked again');
  assert.equal(lib.platformsFor(c).released, Date.parse('2026-09-01T00:00:00Z'));
});

test('problem report zip is a valid archive', () => {
  const { makeZip, crc32 } = require('../src/core/zipwrite');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const z = makeZip([{ name: 'a.txt', data: 'hello '.repeat(40) }, { name: 'b.log', data: 'x' }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  assert.equal(z.readUInt16LE(z.length - 22 + 10), 2);
});
