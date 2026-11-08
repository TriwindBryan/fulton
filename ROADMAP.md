# Fulton roadmap

Ideas that have been discussed but not built yet. Current version: 1.29.

## Emulator support (planned, not started)

Decided on October 18, 2026: not now, keep for later.

**Goal:** a Play button for every game you have, not just the ones with a PC port. A port always wins when one exists; an emulator is the fallback.

**Why it fits:** most of what's needed already exists in Fulton:
- downloading, installing and updating apps from GitHub releases
- recognising games for 80+ consoles and arcade boards
- covers, Add to Steam, controller support and save backups

The new parts would be:
- an emulator catalog: which emulator handles which console, its GitHub repo and Windows download, its exe, and the command-line options to open a game in full screen
- a launch step that hands your game file to the emulator

**Phase 1 (would be 1.14):** one well-known emulator per big system, installed the first time it's needed.

| System | Emulator |
|---|---|
| PS1 | DuckStation |
| PS2 | PCSX2 |
| GameCube / Wii | Dolphin |
| PSP | PPSSPP |
| Wii U | Cemu |
| 3DS | Azahar |
| DS | melonDS |
| Dreamcast | Flycast |
| PS3 | RPCS3 |
| Xbox | xemu |
| Xbox 360 | Xenia |
| Arcade | MAME or FinalBurn Neo |

Check each one's current download location before building. Some publish on their own website rather than GitHub releases.

**Phase 2:**
- RetroArch for the older cartridge systems (NES, SNES, Genesis, Game Boy and so on). Its cores come from RetroArch's own download server, not GitHub, so this needs extra download code.
- Choose your emulator per game or per console.
- Switch, once its emulators settle. They've been in flux since Ryujinx shut down in 2024, so check what's current first.

**Things to handle:**
- **Files from your own console:** PS1/PS2 BIOS, PS3 firmware, Switch keys. Fulton would say what's missing and where it goes, but never download them.
- **Emulator settings:** graphics and controller setup stay inside each emulator. Fulton only starts games full screen.
- **Identity:** Fulton becomes a general game frontend (like LaunchBox or Playnite) that favours ports. Keep ports first in the interface.

## Other platforms: Mac (in testing from 1.29), Steam Deck / Linux (planned)

Mac started October 18, 2026 (1.29), built on GitHub Actions. **Confirmed working on an M1 Max as of Beta 0.0015 (October 21, 2026); Fulton is now the go-forward product on Windows and Mac.** Later: Apple Developer ID ($99/year) to sign and notarize. Steam Deck / Linux next.

**What carries over unchanged:** ROM checking, covers, the catalog, the interface, backups, controller support. Electron runs on all three.

**What changes in Fulton itself:**
- Picking the right download from each GitHub release (Linux AppImage/tarball, Mac .dmg/.app zip/universal build) instead of the Windows .exe
- Unpacking and launching the native way (AppImage / `open` an .app) instead of running an .exe
- Add to Steam: same idea, different Steam folders on Linux and Mac
- Packaging: AppImage for Linux, .dmg and .icns icon for Mac, instead of the .msi, .bat files and .ico
- The catalog needs to say which ports have a Linux or Mac build; games without one are hidden or marked on that platform

**Steam Deck / Linux first, because:**
- most of these ports already publish Linux builds
- no yearly fee and no Apple notarization
- the Steam Deck is popular with retro fans, and Fulton's controller support and Add to Steam already suit it (Game Mode)

**Mac, after that:**
- Fewer ports have Mac builds (Harbour Masters ports and sm64coopdx do; check every catalog game first), so the Mac library starts smaller
- Apple blocks unsigned apps more strictly than Windows SmartScreen. Doing it properly needs the Apple Developer Program (about $99/year) and notarizing each release. Downloaded ports can hit the same blocks, so Fulton has to handle that too
- Needs testing on a real Mac, on both Apple Silicon and Intel. GitHub's free Mac build machines can make the .dmg once the code is on GitHub

**Rough size:** a couple of solid sessions of work, plus testing on each platform.

## Other ideas mentioned

- Update all, or automatic updates, for ports (and emulators later)
- Favourites and your own collections ("Zelda", "Couch co-op")
- TV mode: full screen, controller only
- GitLab releases (for example Link's Awakening DX HD)
- Mods and texture packs
- Menu sounds, screenshots and trailers
- Desktop shortcuts
- Play stats
- Self-update: download and run the new installer from inside Fulton (1.19 only tells you a new version is out)

## Launch status

- **October 18, 2026:** Fulton 1.28 released on GitHub (TriwindBryan/fulton) and announced on Ko-fi (ko-fi.com/triwind). Soft launch: friends and Ko-fi first, wider sharing (Reddit, port Discords) after the first week's feedback.
- Next: turn on GitHub Issues, collect logs from early users, fix what comes in, then the itch.io page and wider posts.

## Launch and money (decided October 18, 2026)

- Free app with donations on Ko-fi (ko-fi.com/triwind). No ads.
- Maybe later: an optional $4.99 Supporter Pack with extra themes, a supporter badge and your name in the credits. No features locked.
- Downloads: GitHub Releases (also powers the update check), plus an itch.io page with pay-what-you-want.
- To do before launch: create the GitHub repo and set `repo` in package.json, publish the first release with the .msi, make the itch.io page, add a Ko-fi cover image.


## Ideas for later (October 21, 2026)
1. Support: a "Report a problem" button (one zip with the log, Check my setup results and version), one-click Fulton updates, "Update all" for games.
2. **Linux and Steam Deck: planned next** (Find more already records which ports have Linux downloads, so a Linux filter is one line to add). Also mods and texture packs for Harbour Masters ports, and a TV / couch mode.
3. Trust and reach: Windows code signing (Microsoft Trusted Signing, about $10/month), an itch.io page.

## Next: finding updates and new releases on Find more (planned October 23, 2026; all of it goes into Beta 0.0021, build 1.54)
Scope decided: everything below, not a cut-down first version.
**Built in 1.55 (Oct 27):** Updates page + Update all, update badges and sidebar count, favorites alerts, release notes preview, New / Updated tabs, Mark all as seen, remembered filters, Update alerts on/off switch (on by default). 2 years / Older than a year / custom days, Clear all, result counter, search by game name (and "new" / "updated"), Windows / Mac and Status filters, 4–5 column grid, Background color fades.

**Built in 1.54 (Oct 27):** the date range chips (30 / 60 / 90 days, 6 months, 1 year), the Sort menu and the "Updated N days ago" tag on each card. Still to do: the Updated vs New ports views, update badges and sidebar count, "Updates for my games" with Update all, the release-notes preview, favorites alerts, mark as seen / remembered filters.
- **Date range filter:** Last 20 / 60 / 90 days (and a custom range) for ports with a new release.
- **Two views:** **New ports** (added to the lists) and **Updated** (a new release of a port already listed).
- **Update badges** on Find more cards and a "N updated since your last visit" count on the sidebar, like New.
- **Sort by:** newest release, recently added, name.
- Ideas: "Updates for my games" on the shelf with an Update all button, a "What changed" preview from the release notes, Windows / Mac / Linux download filters combined with the date range, saved filters, notifications for favorites, a "Playable / Complete" status filter, mark as seen.
- Data note: a release date needs the port's latest GitHub release, which Fulton already fetches for the Windows / Mac check (cached for a few days). New ports show up from the list's own first-seen dates. Without a GitHub token the check is limited to 60 repos per hour, so the date filter should fill in gradually.


## Next builds (proposed October 28, 2026, after 1.55)

**1.56: Supporters and trust (monetization).** Free stays free: no feature locks, perks are cosmetic or early access only.
1. **Ko-fi and GitHub buttons that do their job:** `.github/FUNDING.yml` (adds a Sponsor button on the repo), Ko-fi cover image, a "What your support pays for" line on the Support page and About.
2. **One support moment, never a nag:** after something good happens (for example the 5th game installed), show a single small card with the Ko-fi link and "Don't show again". Never during play or an install.
3. **Supporter Pack (about $4.99, optional):** extra themes, a supporter badge, name in the credits. Sold as a Ko-fi shop item that delivers an unlock code; Fulton checks the code offline (no server). Cosmetic only, so cracking it costs nothing.
4. **Supporters wall (opt-in):** names in About, read from a small JSON file in the repo.
5. **Trust:** itch.io page (pay what you want), a "Report a problem" button (one zip with log and version), and look into Windows code signing (Microsoft Trusted Signing, about $10/month; check eligibility first). Fewer SmartScreen warnings means more installs, which is where donations come from.

**1.57: Steam Deck / Linux (first version, built).** AppImage packaging, Linux game detection, Linux update check; needs a real Linux PC / Steam Deck test.

**1.58: Game drives (in progress).** Done: several install drives, pick a drive per install, default drive, free space, converted-ROM-copy folder. Next: move installed games between drives (including an external drive), several at once, to free up space; ports that pick up your ROM on their own.
- Settings: add and remove game locations; each shows free space. Installing asks where, with a default.
- **Move to another drive** on a game, and on several selected games: copies the game folder, checks it, then removes the old one. Original stays if anything fails. Cancel is safe.
- Care: update Add to Steam shortcuts and Fulton's records, keep save backups linked, no moving a running game, clear message when the drive is full, and a game on an unplugged drive shows "drive not connected" and returns when the drive does.
- Fulton moves only what it installed. It never moves or deletes your ROM files.

**1.59: Games page.** Header with your own shelf stats and playtime chart, Normal/Large/Huge cards and a list view, Continue playing row, collections. (The Find more card at the end of the list is already in 1.55.)

**1.59: Screenshots (built).** One key (F8 by default, changeable), a Screenshots page, use a screenshot as your background. Needs a real-PC test with real games (fullscreen capture).

**Later (Linux): Linux filter on Find more, running Windows-only ports through Proton/Wine.**

**Anytime:** Severed Chains launch.bat hang, first-run help for ports that need game files, pin a version per game (skip in Update all).

**Measure after each release:** GitHub downloads, Ko-fi donations and followers, issues opened.

## Standing out from Quiver (October 28, 2026)
From Quiver's own release notes: catalog, Windows/Linux/Mac/Android filters, Linux AppImage and Android builds, launch logs, 7z/RAR handling. Ideas that go beyond a catalog launcher:
1. **Playable now:** Find more shows which ports you already have the ROM for, since Fulton already matches your ROMs.
2. **A Play button for every game (emulator fallback),** already planned, with ports always first.
3. **Mods and texture packs** for ports that support them.
4. **Per-game profiles:** launch options and settings saved per game, plus save backups you can restore.
5. **Customize button and first-run tour** so the looks and features are easy to find (1.56).
