# Fulton

**Your home base for recomps, decomps and remakes.**

Discover · Install · Update · Play

**Version 1.0.** Fulton was called Cartridge until Beta 0.0020, and ran as a beta until 1.0. Your saved settings and library folder carry over automatically.

**Supported:** Windows 10/11 and Mac (Apple Silicon and Intel). **Linux is not supported yet** (nobody has been able to test it). The installers are not code-signed (that costs money and Fulton is a free hobby project), so expect a one-time warning on first launch: see the notes below.

A launcher for decompiled and recompiled retro game ports. You bring the ROMs; Fulton finds the ports, downloads them from their official GitHub releases, installs them, puts your ROM where each game expects it, and launches them.

Fulton comes with no games: the shelf starts empty and you add ports from **Find more**.

Fulton is free. If you enjoy it, you can support it on [Ko-fi](https://ko-fi.com/triwind).

**How Fulton is made:** Fulton is designed, tested and maintained by me, a retro gamer of 40+ years. The code was written with the help of an AI assistant (Claude). Every feature, fix and release is decided and tested by me.

**Download:** [latest release](https://github.com/TriwindBryan/fulton/releases/latest). Get the .msi installer or the portable .exe. Windows 10/11, 64-bit. Windows may say "Windows protected your PC" because Fulton isn't code-signed yet; click **More info → Run anyway**.

**Mac (Apple Silicon and Intel):** get the .dmg for your Mac from the same page, drag Fulton to Applications, and the first time go to **System Settings → Privacy & Security → Open Anyway** (Fulton isn't registered with Apple yet). Many ports are Windows-only; those show "No Mac build yet" on a Mac.

The rest of this page is about building Fulton yourself.

## Run it

1. Install Node.js once: `winget install OpenJS.NodeJS.LTS` (or the LTS installer from nodejs.org).
2. Double-click **Start Fulton.bat**. The first start downloads Electron (about a minute).

To get a single portable `Fulton-1.52.0-Portable.exe` you can share or keep anywhere, double-click **Build Portable EXE.bat**. The file appears in `dist\`.

## Mac builds

Mac apps are built on GitHub (see LAUNCH.md): publishing a release, or **Actions → Build Fulton → Run workflow**, produces `Fulton-<version>-arm64.dmg` and `-x64.dmg`. On a Mac you can also run `npm install` then `npm run dist:mac`. The apps are ad-hoc signed (free, no Apple account). With an Apple Developer ID (about $99/year) they can be properly signed and notarized so the first-run warning goes away.

On a Mac, Fulton picks each port's Mac download (preferring Apple Silicon or universal builds on M-series Macs), unpacks .zip and .dmg files, and starts the game's .app. Data lives in `~/Library/Application Support/Fulton`.

## Make an installer (.msi)

Double-click **Build Installer (MSI).bat**. It runs the tests and builds `dist\Fulton-1.52.0-Setup.msi` (the first build downloads Electron and the WiX installer tools, so it takes a few minutes). The installer:

- asks whether to install just for you (no admin rights needed) or for everyone on the PC, and where;
- adds Fulton to the Start menu and the desktop, with the cartridge icon;
- offers to start Fulton when it finishes;
- shows up in **Settings → Apps** so it can be uninstalled like any program.

Newer versions install over older ones; just run the new .msi. If Fulton is open, the installer closes it first, so it never asks you to restart Windows. Your library, ROM list, covers, settings and backups live in `%APPDATA%\Fulton`, so reinstalling or updating keeps them, and so does uninstalling.

Windows may warn that the installer is from an unknown publisher, because it isn't code-signed. Click **More info → Run anyway**. Removing that warning needs a paid code-signing certificate.



**ROMs.** Click **+ Add ROMs** and pick the top folder where you keep your ROMs (for example `D:\ROMs`). Fulton searches every subfolder and every zip/7z inside, and remembers the folder: each time it starts, it checks the folder again and adds anything new. Files it has already checked are skipped, so this is quick. You can watch more than one folder, stop watching one, or rescan from **My ROMs**. You can also drop files or folders onto the window. Fulton:
- converts `.n64` and `.v64` byte orders to `.z64`, which is what the ports want
- checks the SHA-1 against the No-Intro database (downloaded from libretro-database and cached for 30 days) so it knows the exact title, region and revision
- falls back to the ROM header for dumps that aren't in No-Intro, such as the Dinosaur Planet prototype
- reads the disc ID from GameCube/Wii `.iso` and `.rvz` images
- leaves your ROMs where they are: it remembers each file (or its place inside a zip) and never copies your collection. Only when a game needs a different file (a .v64 converted to .z64, a header removed, a ROM unpacked from a zip) does it make one copy, for that game's ROM, in `Fulton/ROMs/Converted`

Every game has a **ROM slot**, with a **How do I get this ROM?** link. It opens a short guide for that console on dumping a game you own (with links to dumping.guide and the official homebrew/emulator guides), the exact versions the port accepts with their SHA-1 fingerprints, and a link to find the original cartridge or disc on eBay. The guides live in `catalog/dumping.json`.

The slot itself: Green means your ROM is verified for that port. Amber means Fulton found the right game but a different region or revision than the port expects; it may still work. You can drop a ROM on a slot, or pick one from your library by hand.

**Installing.** Fulton asks GitHub for the latest release, picks the Windows download, verifies GitHub's SHA-256 digest when one is published, and extracts it with Windows' built-in `tar`, which reads `.zip`, `.7z` and `.rar`. Updates unpack over the old version, so saves and settings inside the game folder are kept. Recomps get a `portable.txt`, so their saves live in the game folder too.

**Launching.** Each catalog entry says how its game takes the ROM:

| Setup | Used by | What Fulton does |
|---|---|---|
| `beside-exe` | Harbour Masters ports (Ship of Harkinian, 2 Ship, Starship, SpaghettiKart, Ghostship) | Copies the ROM next to the `.exe`. The game finds it on first launch and extracts its assets. |
| `file` | Perfect Dark | Copies the ROM to the exact path the game needs (`data/pd.ntsc-final.z64`). |
| `in-app` | N64Recomp projects, sm64coopdx, Dusklight | Puts the ROM's path on your clipboard and shows a first-run tip. Paste it into the game's file box. |

## Supported systems

Fulton recognises games for every major console, loose or inside .zip/.7z:

| Maker | Systems and file types |
|---|---|
| Nintendo | NES (.nes), Famicom Disk System (.fds), SNES (.sfc .smc), Virtual Boy (.vb), N64 (.z64 .n64 .v64), 64DD (.ndd), Game Boy (.gb), Game Boy Color (.gbc), GBA (.gba), Pokémon mini (.min), DS (.nds), 3DS (.3ds .cia .cxi, and Azahar's .zcci .zcxi .z3dsx .zcia), GameCube and Wii (.iso .rvz .gcm .ciso .gcz .wbfs), Wii U (.wua .wud .wux .rpx .wuhb, a dumped game folder, or a NUS folder with title.tmd + .app files), Switch (.nsp .xci .nsz .xcz), Switch 2 (the same file types, in a folder named Switch 2) |
| Sega | SG-1000 (.sg), Master System (.sms), Game Gear (.gg), Genesis / Mega Drive (.md .gen .bin), 32X (.32x), Sega CD, Saturn (.cue + .bin, .chd, .iso), Dreamcast (.gdi .cdi .cue + .bin, .chd: CHDs holding a GD-ROM are recognised by their contents) |
| Sony | PlayStation (.cue + .bin, .chd, .m3u, .pbp, .iso), PS2 (.iso .chd), PS3 (dumped game folder, PSN game folder with USRDIR, .iso, .pkg), PSP (.iso .cso), Vita (dumped game folder, .vpk), PS4 (.pkg, or a dumped game folder), PS5 (dumped game folder with sce_sys/param.json) |
| Microsoft | Xbox and Xbox 360 (.iso, or an extracted folder with default.xbe / default.xex; Xbox 360 Games on Demand and Xbox Live Arcade packages), Xbox One and Xbox Series X\|S (dumped game folder with MicrosoftGame.config; Series games in a folder named Xbox Series) |
| Arcade | Capcom CPS-1, CPS-2, CPS-3 and ZN; Neo Geo (MVS / AES); Sega NAOMI, Atomiswave, System 16 / 18 / 24 / 32, Model 1 / 2 / 3 and ST-V; Namco System 1 / 2 / 11 / 12 / 22; Konami GX and System 573; Taito F3; IGS PGM; Cave; Psikyo; Toaplan; Irem; Midway; and about 4,700 more games on other boards (.zip or .7z sets) |
| Others | PC Engine / TurboGrafx-16 (.pce), PC Engine CD, SuperGrafx (.sgx), Neo Geo CD, Neo Geo Pocket / Color (.ngp .ngc), WonderSwan / Color (.ws .wsc), Atari 2600 (.a26 .bin), 5200 (.a52), 7800 (.a78), Lynx (.lnx), Jaguar (.j64), 3DO, ColecoVision (.col), Intellivision (.int), Vectrex (.vec), MSX (.mx1 .mx2) |

How each kind is handled:

- **Fulton games** are checked against the No-Intro database for that console, so the exact title, region and revision are known. The file itself stays where it is. Dump headers No-Intro leaves out (NES, Famicom Disk System, PC Engine, Lynx, Atari 7800, SNES copier headers) are handled either way.
- **Discs and modern games** (PlayStation, Saturn, Dreamcast, Wii U, Switch, 3DS, Xbox and so on) are too big to copy, so they stay where they are and Fulton remembers the path. They are matched to games by name, plus the serial where the files carry one: the Switch title ID from the file name, the 3DS product code, the Wii U product code from meta.xml, the PS3/Vita/PS4 title ID from PARAM.SFO (which also tells a PS4 folder from a Vita one), the PS5 title from param.json, the Xbox One/Series name from MicrosoftGame.config, and the Xbox 360 name and title ID from Games on Demand packages.
- **Shared file types** (.bin, .iso, .cue, .chd) are used by several consoles. Fulton looks inside the file for the console's own signature (Saturn, Sega CD, Dreamcast, 3DO, PC Engine CD, PlayStation 1/2/3, PSP, GameCube, Wii, Xbox). When that can't decide (.chd files are compressed), the folder name does: anything inside a folder called "Saturn", "PS2", "Sony - PlayStation 2" and so on goes to that console.
- **Dumped game folders** (PS3, Vita, Wii U, Xbox) count as one game, not hundreds of loose files.
- A .cue and its .bin tracks count as one disc, and the .cue is what gets handed to the game.
- **Switch:** Fulton only reads the file name and title ID. It never needs or touches console keys and never changes the file.

**Arcade sets** are the .zip files MAME and FinalBurn Neo use, named after the game: `sf2.zip` (Street Fighter II, CPS-1), `sfa3.zip` (Street Fighter Alpha 3, CPS-2), `sfiii3.zip` (Street Fighter III 3rd Strike, CPS-3), `kof98.zip` (King of Fighters '98, Neo Geo), `mvsc2.zip` (Marvel vs. Capcom 2, NAOMI). Fulton knows 7,800 sets by name (from the FinalBurn Neo and MAME databases), with each game's full title, year, maker, board and parent version, and box art from the arcade cover library. Sets stay where they are under their own name, because emulators find games by that name. BIOS sets (neogeo.zip, naomi.zip, pgm.zip…) aren't listed as games, but a game's banner tells you if the BIOS its board needs is missing from its folder. A port can name the exact sets it accepts with `"rom": { "sets": ["sf2", "sf2ce"] }`. The set list is in `catalog/arcade.json`; `tools/build-arcade.js` rebuilds it from newer databases.

Most of these consoles don't have PC ports yet (there are none for Switch or Wii U so far). Your files still show in **My ROMs** and are matched automatically as soon as a port for that game is added. 

## Loading ROMs

- **+ Load ROM** (top bar) picks one or more ROM files and matches them to their games.
- **ROM Folder** (top bar) adds a whole folder; it is searched again every time Fulton starts.
- **Load ROM** on a game (in its ROM slot and in its info panel) picks a ROM file and attaches it to that game, even if the name doesn't match automatically. On a controller, **Y** does the same for the selected game.

You don't have to load a ROM in Fulton first. **Play** always starts the game; most ports ask for the ROM themselves the first time and remember it. The one exception is Perfect Dark, which reads its ROM from a fixed file, so Fulton asks you to load it there first.

Each game's banner shows **ROM FILE** (the file types it takes, for example `.z64 · .n64 · .v64` for N64, `.sfc · .smc` for SNES, `.iso · .rvz` for GameCube) and **ROM VERSION** (for example USA, or USA (Rev 1) for Perfect Dark). Hover over them for details. Games with strict rules (SpaghettiKart and Perfect Dark need .z64) say so, and Fulton converts .n64/.v64 dumps to .z64 when you load them here.

## Add to Steam

**＋ Add to Steam** (on an installed game, or **Settings → Add all installed games to Steam**) adds the game to your Steam library as a non-Steam game that launches the port directly, so the Steam overlay, Big Picture mode and Steam Input controller settings all work. Fulton also makes the library artwork from the game's box art: a tall cover, a wide banner, a big header image and a logo. Steam rewrites its shortcut list when it exits, so if Steam is open Fulton asks to close it, adds the games and reopens Steam. A copy of your previous shortcut list is kept as `shortcuts.vdf.cartridge-backup` in your Steam user folder. **Remove from Steam** takes a game back out.

## Save backups

Fulton backs up each game's saves automatically after you play, before every update, before uninstalling and before a restore, keeping the last 10 automatic backups per game (ones you make yourself are never deleted). It knows which files came with each download, so it backs up only what the game wrote: saves, settings and mods. It skips large files the game can rebuild (ROM copies, .o2r/.otr asset packs).

- **Your saves** in a game's info panel lists its backups with **Restore** buttons. Restoring first backs up what's there now, so it can be undone.
- **Back up now** makes a backup any time.
- **Settings → Save backups** sets the backup folder. Choose one inside OneDrive or Google Drive and your saves are copied to the cloud too. **Back up all games now** backs up everything at once.

Games installed before this feature existed are handled by date: files changed after the install are treated as yours.

## Cover art

Every game, every ROM in **My ROMs** and every entry in **Find more** gets box art:

1. **libretro-thumbnails** (free, no account): Fulton downloads each console's list of covers once (cached for 30 days) and matches by name. Verified ROMs use their exact No-Intro name. Everything else is matched by title, ignoring punctuation, "The" and region tags ("The Legend of Zelda: Majora's Mask" finds "Legend of Zelda, The - Majora's Mask (USA)"). Numbers must match, so Final Fantasy VII never gets the VIII cover. Your ROM's region is preferred, then USA, World, Europe and Japan, and betas and demos are skipped.
2. **SteamGridDB** (optional): for games libretro doesn't have, such as Switch titles. Add a free API key in **Settings → Cover art** (sign in at steamgriddb.com, then Preferences → API).
3. **Your own picture:** **Change cover** in a game's info panel, **Cover** on a ROM in My ROMs, or drop a PNG/JPG/WebP/GIF onto the window while a game is selected. **Automatic cover** goes back.
4. If nothing is found, the game keeps its generated 90s cover (or the project's icon).

Covers are saved in Fulton's data folder, so they load instantly and work offline. Ones that weren't found are tried again after 7 days, or straight away with **Settings → Cover art → Find missing covers**.

## Custom background

**Settings → Background → Choose image** uses any PNG, JPG, WebP or GIF as the background. Fulton keeps its own copy, so moving or deleting the original is fine. The **Darken** slider keeps text readable on bright pictures, and **Back to default** brings back the 90s sunset.

## Browsing a big collection

The Games screen has two layouts, switched with **Rows / Grid** in the bar above the games:

- **Rows** (like a console home screen): Continue playing, Recently added, Installed, Ready to install, then one row per console. The mouse wheel scrolls up and down through the rows. To move along a row, use the ‹ › arrows that appear at its ends when you point at it, Shift + wheel, a trackpad swipe, the arrow keys or a controller.
- **Grid**: every game in rows that wrap, so you can see the whole collection at once.

**The filter bar** sits above the games in two lines:

- First line, what to show: **All · Decomp · Recomp · Remake · ROMs**, each with a count, plus **↻** on the right to check every game for updates.
- Second line, left to right: **Layout** (Rows / Grid), **Sort**, **Console** and **Status** (Any, Works on this PC/Mac, Installed, ROM ready, No ROM loaded) dropdowns. A dropdown that's changed from its default turns gold, and **Reset** puts them all back.
- When the info panel is open, the games move over to make room, so nothing is hidden behind it.

- **All** (the default) shows every game together, all types mixed, so you see everything you have.
- **Decomps**, **Recomps** and **Remakes** narrow it to one kind of port. Decomps were rebuilt from the original code by hand, recomps had their machine code recompiled to run on PC, and remakes were recreated from scratch. Every cover also carries a coloured DECOMP, RECOMP or REMAKE badge.
- **My ROMs** shows only your ROM files and discs, as covers grouped by console. Select one to see its details (system, file type, size, whether it's verified) and a big button to play or get the game it unlocks.

Shortcuts: keys **1–5**, or **LB / RB** on a controller. The first four buttons are on **Find more** too.

Sort options: Best first, A to Z, Z to A, Recently added, Recently played, Most played, Release year (newest or oldest), Console and Metascore. Fulton remembers your layout and sort. The banner at the top shrinks while you scroll down so more rows fit on screen.


Click any game, or press **I** (or the View button on a controller), to slide out a panel with everything about it: a short history of the original game, the system, release year, developer and publisher; what kind of port it is and who made it; which ROM it needs and whether yours is ready; and the installed and latest versions with release notes. Press **Esc** (or **B**) to close it.

At the top of the panel are the game's Metacritic scores in big gold numbers: the critic **Metascore** (out of 100) and the **User Score** (out of 10), each with Metacritic's verdict (for example "Universal acclaim") and how many critic reviews it's based on. Click it to open the game's Metacritic page. Built-in games have their scores stored. For any other game (for example ones added from Find more), Fulton looks the score up on the game's Metacritic page the first time you open its panel and remembers it for 30 days; the box says which platform the score is for. If Metacritic has no score it shows N/A, with links to search Metacritic or try again. You can sort the Games screen by Metascore, when the scores are on. Metacritic scores are **off by default**; turn them on in **Settings**.

## Controller

Xbox controllers work straight away. PlayStation, Switch Pro, 8BitDo and generic USB/Bluetooth controllers work too: Fulton uses the standard layout when the controller reports one, otherwise a layout for the brand (PlayStation, Nintendo) or a general one, including D-pads that report as a "hat". If a controller does the wrong thing, **Settings → Controller** shows what Fulton sees live and has **Set up buttons**: press each button when asked and it's remembered for that controller. A button bar appears at the bottom when a controller is connected. Windows only shows a controller to apps after you press a button, so press any button if it isn't picked up.

| Button | Does |
|---|---|
| D-pad / left stick | Move left/right along a row and up/down between rows (hold to scroll fast) |
| A (Cross) or Start | Play or Install the selected game; answers pop-ups |
| B (Circle) | Back: closes the info panel or a pop-up, cancels a download, clears filters, returns to Games |
| X (Square) | Update the selected game, or check all games for updates |
| Y (Triangle) | Load a ROM for the selected game |
| LB / RB | Switch what's shown: All, Decomps, Recomps, Remakes, My ROMs |
| View (Back/Select) | Show or hide the game info panel |
| In the info panel | D-pad up/down moves between its buttons (gold highlight), A presses, left/right changes a dropdown, right stick scrolls, B closes the panel |
| LT / RT | Switch screen: Games, My ROMs, Find more, Settings |

The launcher ignores the controller while a game has focus, and comes back to the front when the game closes. If Steam is open and the controller moves the mouse pointer, that's Steam's desktop controller layout: change it in Steam → Settings → Controller, or close Steam. Each controller Fulton sees is written to the log with its layout, which helps when reporting a problem.

## The catalog

`catalog/games.json` lists 27 projects: 25 installable ports plus 2 source-only reimplementations shown for reference. Each entry has the original system, year, developer and publisher, who made the decomp or recomp, who built the PC port, and how the game takes its ROM.

Add your own games in three ways:
- **Find more** lists hundreds of decomp, recomp and remake ports for N64, SNES, NES, Game Boy, GBA, DS, 3DS, GameCube, Wii, Wii U, Switch, Genesis, Dreamcast, PS1, PS2, PS3, PS4, PSP, Xbox, Xbox 360, Xbox One and PC. It merges two lists, refreshed daily: the community catalog at github.com/tgeorgiadis/quiver-community-app-catalog (the one Quiver Launcher uses) and [Recompendium](https://recompendium.com) (data under CC BY-SA 4.0), plus a few newer ports Fulton adds itself. Each card shows the port's status; hover for its description and what it needs. Filter by console or type and click **+ Add**. Anything brand new can be found with the GitHub search at the bottom of the page.
- Each Find more card says what it takes: **Download**, **Build it yourself** or **Needs game files**, with a filter for each. For ports you build yourself, click **Add your copy** on the game's page and pick its .exe or a .bat that starts it.
- The **Help** tab explains every part of Fulton in a few steps per topic, and the small **?** buttons open the matching topic where you are.
- **Check my setup** (in Help) finds full drives, missing ROM folders and files, broken installs and leftovers, with one-click fixes that never delete your own files.
- **Favorites**, a **Recently played** row, **NEW** badges on Find more, release notes before each update, and **Settings → Colors** with eight themes or your own custom colors.
- **Settings → Extra catalog URL** loads a `games.json` from anywhere, such as a raw GitHub link, so you can share a list.
- Edit `catalog/games.json` directly. Useful fields:

```jsonc
{
  "id": "unique-id",
  "title": "Original game title",
  "port": "Name of the PC port",
  "system": "n64",              // any id under "systems": n64, snes, switch, wiiu, ps1, saturn, dreamcast…
  "year": 1998,
  "developer": "…", "publisher": "…",
  "kind": "Static recompilation",
  "credits": [{ "role": "Decompiled by", "name": "…" }, { "role": "PC port by", "name": "…" }],
  "repo": "owner/repo",
  "exe": "regex for the exe name",        // optional; otherwise the biggest .exe wins
  "assetMatch": "regex for the download", // optional; otherwise Windows .zip/.7z is chosen
  "filesToAdd": ["portable.txt"],
  "rom": {
    "titles": ["No-Intro title without region"],
    "regions": ["USA"], "requireTags": ["Rev 1"], "excludeTags": [],
    "headerNames": ["INTERNAL NAME"], "sha1": ["…"], "discIds": ["GZ2"],
    "note": "Shown when the ROM is missing or the wrong version",
    "setup": { "type": "beside-exe" | "file" | "in-app", "path": "data/x.z64", "reveal": true },
    "firstRun": "Tip shown the first time the game starts"
  },
  "art": { "boxart": ["No-Intro name (USA)"], "icon": "https://…png" }
}
```

Box art is found automatically (see **Cover art**); `art.boxart` gives exact No-Intro names to try first.

## Support, About and updates

- The **♥ Support** button at the top right opens [ko-fi.com/triwind](https://ko-fi.com/triwind). Supporting Fulton doesn't unlock anything.
- Click the **version badge** next to the logo for **About & credits**: the version, a thank-you list of the teams behind every port in the catalog, the data Fulton uses, and the legal notes.
- Fulton checks its GitHub releases for a newer version twice a day and shows a gold button in the header when there is one. You can turn this off in Settings.
- The links live in `package.json` under `"cartridge"`: `kofi`, `repo` (`TriwindBryan/fulton`, where releases are checked) and `itch`. To publish a release, see LAUNCH.md.

## If something goes wrong

Fulton keeps a log at `%APPDATA%\Fulton\fulton.log` (open it from **About → Open the log file**). It records each start, how long loading, ROM scanning and update checks took, ROM folders that couldn't be reached, and any time the window stopped responding. Send it along with a bug report.

## Project layout

```
build/             the app icon (icon.png, icon.ico); build/icon-src/ has the SVG source and the script that draws it
main.js            Electron main process and IPC
preload.js         the safe bridge the UI talks through
src/core/          pure Node logic (unit tested)
  rom.js           console detection for every system, byte-order conversion, hashing, headers
  romdb.js         No-Intro DAT parsing and ROM-to-game matching
  github.js        release lookup, Windows asset picking, GitHub search
  install.js       download with progress, extraction, exe detection
  covers.js        box art matching (libretro-thumbnails, SteamGridDB)
  arcade.js        arcade sets (CPS1/2/3, Neo Geo, NAOMI…) by set name
  update.js        checks GitHub for a newer Fulton
  inspector.js     checks ROM files on a worker thread (inspect-worker.js) so the window never freezes
  library.js       state, ROM library, install/update/uninstall, launch
renderer/          the interface (plain HTML/CSS/JS, no build step)
catalog/games.json the game list
test/              npm test
```

## Notes

- Fulton never downloads ROMs or game data. Dump them from games you own.
- GitHub allows 60 unauthenticated API calls an hour. Release info is cached for 6 hours. If you hit the limit, add a token in Settings.
- Credits in the catalog name the teams shown on each project's page. Check the project page for the full contributor list.
