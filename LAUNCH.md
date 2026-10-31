# Launching Fulton

Everything needed to put Fulton up for download: the steps, then text to paste into GitHub, itch.io and Ko-fi.

## Every release from 1.29 on: GitHub builds it for you

From 1.29, a workflow in `.github/workflows/release.yml` builds the Mac and Windows versions on GitHub's own machines. You don't need to build anything or attach files.

1. **Upload the new code.** On your repository page: **Add file → Upload files**, drag in everything in your Fulton folder **except** `node_modules` and `dist` (make sure the `.github` folder is included), then **Commit changes**. Existing files are replaced.
2. **Make a test build (optional, but do it for the first Mac version).** Go to the **Actions** tab → **Build Fulton** → **Run workflow** → **Run workflow**. After about 10–15 minutes, open the finished run and download **cartridge-mac** (the .dmg files) and **cartridge-windows** from **Artifacts** at the bottom. Send the Mac one to your tester with MAC-TESTING.md.
3. **Publish the release.** **Releases → Draft a new release**, tag `v1.53` (always `v` + the **build number**, shown as "build 1.52" in Settings and on About, never the beta name), title `Fulton Beta 0.0020`, paste the release text, then **Publish release**. About 10–15 minutes later the .dmg, .msi and portable .exe appear on the release by themselves. You can watch progress on the Actions tab.

If a build fails, the Actions tab shows a red ✕; click it, open the failed step, and send the last lines.

## 1. Test first

- [ ] Double-click **Build Installer (MSI).bat** and **Build Portable EXE.bat**. Both files end up in `dist\`.
- [ ] Install the .msi **while the old Fulton is still open**. It should close the old one and finish with no "restart your system" prompt.
- [ ] Start Fulton a few times. It should open in a few seconds and never turn white.
- [ ] Install one port, give it a ROM, play it, close it.
- [ ] If anything goes wrong: **About → Open the log file**, and send it over.
- [ ] Bonus: try it on a second PC that has never had Fulton or Node.js.

## 2. Put the code on GitHub

The update check looks for releases at **github.com/TriwindBryan/fulton**, so the repository must be called exactly `fulton` and be **public**.

1. On github.com, click **+ → New repository**. Name: `fulton`. Public. Don't add a README, license or .gitignore (Fulton has its own). Click **Create repository**.
2. On the empty repository page, click **uploading an existing file**.
3. Drag in everything inside your Fulton folder **except** `node_modules` and `dist` (those are big and get rebuilt). Click **Commit changes**.
   (If you'd rather not drag files, GitHub Desktop does the same with a few clicks and makes later updates easier.)
4. On the repository's main page, click the ⚙ next to **About** and set:
   - Description: `Fulton: Your home base for recomps, decomps and remakes. A launcher for decomp, recomp and remake PC ports of classic games. Bring your ROMs, it does the rest.`
   - Website: `https://ko-fi.com/triwind`
   - Topics: `decompilation` `recompilation` `n64` `retro-gaming` `game-launcher` `electron`

## 3. Make the first release

1. On the repository page: **Releases → Create a new release**.
2. **Choose a tag** → type `v1.53` → **Create new tag**. (Always `v` + the build number shown in Settings and on About, never the beta name. The update check compares this number.)
3. Title: `Fulton Beta 0.0020`
4. Paste the release text below.
5. Drag in `dist\Fulton-1.53.0-Setup.msi` and `dist\Fulton-1.53.0-Portable.exe`.
6. Click **Publish release**.

For every later version: bump the version, build, and make a new release the same way with the new tag. Everyone on an older version sees a gold "v1.xx is out" button within 12 hours.

### Release text (GitHub)

```markdown
## Fulton Beta 0.0020

Fulton is a free launcher for decompiled, recompiled and remade PC ports of classic games: Zelda 64: Recompiled, Ship of Harkinian, sm64coopdx, Perfect Dark and many more. It finds the ports, downloads them from their official releases, installs them, and starts them for you. You bring your own ROMs.

### What's new
- **Cartridge is now Fulton.** New name, new balloon-and-cartridge icon, and the tagline "Your home base for recomps, decomps and remakes". It installs over Cartridge, and your settings, favorites and library folder carry over automatically (your old data folder is left in place as a backup).
- **A new look.** A dark, Mac-style layout with a sidebar, square covers and a blue accent.
- **Themes are still here, and better.** Ten color themes, plus **Custom** with a real color picker. Your custom colors are remembered when you try other themes.
- **Background picture.** Use any picture behind the app, with **Darken** and a new **See-through** slider so it actually shows.
- **No games packed in.** A new install starts with an empty shelf. Browse **Find more** and press **+ Add** for the ports you want. Any game can be taken off with **Remove from shelf** (an installed one is uninstalled first, after asking). If you already used Cartridge, your shelf stays as it was.
- **Uninstall and Remove from shelf** sit at the bottom of the side panel, out of the way.

### Download
**Windows**
- **Fulton-1.53.0-Setup.msi**: the installer (recommended). Adds Start menu and desktop shortcuts; uninstall from Settings → Apps.
- **Fulton-1.53.0-Portable.exe**: a single file that runs without installing.

Windows 10 or 11, 64-bit.

**Mac** (from 1.29)
- **Fulton-1.53.0-arm64.dmg** for Apple Silicon Macs (M1 and newer), **Fulton-1.53.0-x64.dmg** for Intel Macs. Open it and drag Fulton to Applications.
- The first time, macOS says it can't verify the developer. Go to **System Settings → Privacy & Security** and click **Open Anyway**. Only once.
- Fewer ports have Mac builds than Windows ones; Fulton shows "No Mac build yet" for the rest.

### "Windows protected your PC"?
Fulton isn't code-signed yet (certificates cost money), so Windows SmartScreen warns about it. Click **More info → Run anyway**. The full source code is right here if you'd like to check it.

### Important
Fulton doesn't include, download or share any games, ROMs, BIOS files or keys. The ports need files from games you own.

### Support
Fulton is free and always will be. If it saves you some time, you can support it on [Ko-fi](https://ko-fi.com/triwind). Nothing is locked behind it.

Full list of changes: [CHANGELOG.md](CHANGELOG.md)
```

## 4. itch.io page

1. On itch.io: **Upload new project**.
2. Title `Fulton`, kind **Downloadable**, classification **Tools**.
3. Pricing: **$0 or donate**, suggested donation **$5**.
4. Upload the .msi and the portable .exe, and tick **Windows** on both.
5. Cover image: 630×500 (I can make one in the icon's style).
6. Genre/tags: `retro`, `launcher`, `n64`, `decompilation`, `emulation-alternative`, `tool`.
7. Paste the description below.

### itch.io description

> **Fulton**: play the classics as native PC games.
>
> Fans have spent years decompiling and recompiling classic games into real PC ports: Zelda 64: Recompiled, Ship of Harkinian, 2 Ship 2 Harkinian, Starship, sm64coopdx, Perfect Dark, Dinosaur Planet and many more. They run in widescreen, at high frame rates, with mods and enhancements. But finding, installing and setting up each one is a chore.
>
> **Fulton does it for you.**
> - Finds the ports and downloads them from their official GitHub releases
> - Installs them, keeps them updated, and launches them
> - Checks your ROMs and tells you which games they unlock, and whether a port needs a different version
> - Shows exactly which version each port needs, with step-by-step guides for dumping your own cartridges and discs
> - Recognises games for 80+ consoles and arcade boards, from NES to Switch, plus CPS1/2/3, Neo Geo and NAOMI
> - Box art for everything, a 90s-style interface, full controller support
> - Add any game to Steam (with box art) for Big Picture mode
> - Automatic save backups
>
> **You bring the ROMs.** Fulton doesn't include, download or share any games, ROMs, BIOS files or keys. Use files dumped from games you own.
>
> **Free forever.** Pay what you want if you'd like to support it. Nothing is locked.
>
> **Windows warning:** Fulton isn't code-signed yet, so Windows may say "Windows protected your PC". Click **More info → Run anyway**. Source code: github.com/TriwindBryan/fulton
>
> Made by a gamer of 40+ years who loves retro games and wants to help the scene any way I can. ❤

## 5. Ko-fi

- Add a link to your profile: **Download Fulton → https://github.com/TriwindBryan/fulton/releases/latest**
- First post:

> **Fulton Beta 0.0020 is out!** 🎮
> My free launcher for decomp and recomp PC ports of classic games is ready to download. It finds the ports, installs them, checks your ROMs and launches everything from one 90s-style shelf, controller included.
> Download: https://github.com/TriwindBryan/fulton/releases/latest
> It's free and always will be. Thanks to everyone who supports it here!

## 6. Where to share it (optional)

- Reddit: r/emulation, r/n64, r/SteamDeck (once there's a Linux version), r/retrogaming. Read each one's self-promotion rules first.
- The Discord servers of the port projects. Ask before posting, and always credit their work: Fulton only exists because of them.
