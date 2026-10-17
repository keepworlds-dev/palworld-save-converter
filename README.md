**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [繁體中文](README.zh-Hant.md) | [简体中文](README.zh-CN.md)

# Palworld Save Converter

Convert a Palworld co-op world into a dedicated-server save, or a dedicated-server world back into a co-op save, entirely in your browser. Your save files never leave your computer.

**Use it online:** https://www.keepworlds.com/tools/palworld-save-converter?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter

## Why you need it

In a co-op world the host's character is stored under a fixed placeholder ID. A dedicated server gives every player an ID derived from their Steam account, so when you copy a co-op world onto a server, the host shows up as a brand-new character. Everything they owned still points at the old ID. This tool moves all of it to the right ID.

## What it does

- **Co-op → dedicated server:** re-maps the host from the co-op placeholder ID to the ID the dedicated server will assign. The ID is worked out from the host's Steam ID (read from the save folder path when possible), so you don't need to join the server first.
- **Dedicated server → co-op:** the reverse, for moving a server world back to someone's PC.
- Moves everything that points at the character: guild membership and admin rights, Pal ownership, party and Palbox slots, Dimensional Pal Storage, build records on structures, chest password locks and death drops.
- Crossplay friends (Xbox, PlayStation, Mac) can be moved too, once they have joined the server and you know the ID it gave them.
- Reads the written files back and checks every field it changed before offering the download.
- Works with Palworld 1.0 saves (Oodle-compressed `PlM`) and older zlib saves (`PlZ`). Steam saves only.
- Leaves the original folder untouched and gives you a zip.

## How to use

1. **Back up your saves.** The tool only reads them, but a copy costs nothing.
2. **Find your world folder.**
   - Co-op world on Windows (Steam): `%LOCALAPPDATA%\Pal\Saved\SaveGames\`. Inside is a folder named after your Steam ID, and inside that one folder per world with a long hex name. You can pick the whole `SaveGames` folder and the tool lists the worlds for you.
   - Dedicated server: `Pal/Saved/SaveGames/0/<world id>/` inside the server's install folder (for example `steamapps/common/PalServer/`). Copy that world folder to your computer first.
3. **Open the tool, choose the direction and pick the folder.**
4. **Pick the character** to convert. In a co-op world the host is usually preselected.
5. **Confirm the target ID.** For co-op → server, check the Steam ID the tool filled in, or enter the server's ID for the host by hand.
6. **Convert and download** the zip.
7. **Put it in place.**
   - On a server: stop it, put the world folder from the zip into `Pal/Saved/SaveGames/0/`, set `DedicatedServerName` in `Pal/Saved/Config/WindowsServer/GameUserSettings.ini` (or `LinuxServer/`) to that folder's name, and start the server.
   - Back to co-op: create a new co-op world in game, enter it once, quit, then copy the files from the zip over that world's folder.

Check your character, Pals and guild in game before you rely on the converted world. Your old world stays where it was.

## Run it locally

Requires Node.js 22.18 or later.

```sh
npm install
npm run dev
```

`npm run build` writes a static site to `dist/` that you can serve from anywhere. `npm run check` runs the type-check and the static checks in `scripts/check.mjs`.

## Credits

The save parser and writer come unmodified from [zlmitchell/palworld-save-toolkit](https://github.com/zlmitchell/palworld-save-toolkit), and Oodle decompression from [SnosMe/ooz-wasm](https://github.com/SnosMe/ooz-wasm) (based on [powzix/ooz](https://github.com/powzix/ooz)), both under GPL-3.0. Field layouts follow [palworld-save-tools](https://github.com/cheahjs/palworld-save-tools) (MIT). See [THIRD_PARTY.md](THIRD_PARTY.md).

## License

[GPL-3.0](LICENSE).

Maintained by [KeepWorlds](https://www.keepworlds.com/?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter), Palworld dedicated server hosting. Not affiliated with Pocketpair.
