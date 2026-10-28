/**
 * Every user-facing string in the UI. Kept in one object so another language can be added
 * later by providing a second object of the same `Strings` type and picking one at start-up.
 *
 * Messages with parameters are functions; numbers go through `num()` so they are formatted
 * for the UI language rather than printed raw.
 */

const LOCALE = "en";
const numberFormat = new Intl.NumberFormat(LOCALE);
const dateFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

export const num = (n: number): string => numberFormat.format(n);
export const dateTime = (ms: number): string => dateFormat.format(new Date(ms));

export const HOSTED_URL =
  "https://www.keepworlds.com/tools/palworld-save-converter?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter";

export const en = {
  lang: LOCALE,
  title: "Palworld Save Converter",
  lead:
    "Move a Palworld world between co-op and a dedicated server without losing the host's character, Pals, base or guild.",
  trust: "Runs entirely in your browser. Your save files are never uploaded anywhere.",

  modeTitle: "Choose a direction",
  modes: {
    toServer: {
      title: "Co-op → Dedicated server",
      desc: "Move your local world onto a server that stays up",
    },
    toCoop: {
      title: "Dedicated server → Co-op",
      desc: "Bring the world on your server back to your own PC",
    },
  },

  flow: {
    toServer: {
      step1Title: "Pick your save folder",
      step1Hint:
        "Just pick the whole SaveGames folder and we'll list the worlds inside it. Steam saves only; the tool only reads your files and never changes them.",
      pickFolder: "Choose SaveGames Folder",
      whereTitle: "Your saves are here (Windows · Steam)",
      where: [
        "Click Copy to copy the path above.",
        "Click Choose SaveGames Folder, paste into the address bar at the top of the window that opens, and press Enter.",
        "Once you're inside SaveGames, click the confirm button at the bottom right (Upload or Select Folder).",
      ],
      step2Hint:
        "Pick the character you played in the co-op world. The host's ID is a run of zeros ending in 1, which is usually the one already selected.",
      step3Title: "Confirm the host's ID on the server",
      step3Hint:
        "A dedicated server numbers each character by Steam account, and the host's character has to move to that number to be recognized. If we can read the Steam ID off your save folder, we fill it in for you — just check it.",
      convert: "Convert for a dedicated server",
      successBody: (guid: string) =>
        `The host character moved to ID ${guid}, and everything that pointed at the old one moved with it: guild membership and admin rights, pal ownership, party and palbox slots, Dimensional Pal Storage (the file is renamed and its records inside are re-pointed), the build records on your structures, chest password locks and death drops. The files were read back and checked field by field after writing.`,
      nextTitle: "Next: put it on your server",
      next: (world: string) => [
        "Stop the server.",
        `Unzip the download and put the “${world}” folder inside it into Pal/Saved/SaveGames/0/ on the server — not the save folder on the PC you play on. Leave the old world where it is — it's your backup.`,
        "Open the server's GameUserSettings.ini (under Pal/Saved/Config/WindowsServer or LinuxServer) and change the DedicatedServerName line to:",
        "Start the server and check your character, Pals and guild first. If anything's off, set DedicatedServerName back — the old world is untouched.",
      ],
    },
    toCoop: {
      step1Title: "Pick the world folder from your server",
      step1Hint:
        "Download the world folder off your server and drop the whole thing in. Keep a backup copy of your own before you start.",
      pickFolder: "Choose Server World Folder",
      whereTitle: "The server's worlds live here",
      where: [
        "It's inside the server's PalServer install folder; the innermost folder with a long letters-and-numbers name is the world.",
        "If your host offers backup downloads, you can also download a backup, extract it, and pick the SaveGames folder inside.",
        "Copy the whole world folder to this computer, then pick it with Choose Server World Folder.",
      ],
      step2Hint:
        "Pick your character on the server. A dedicated server hands everyone a different ID, so find yours by name and level.",
      step3Title: "Have a co-op world ready to land in",
      step3Hint:
        "The co-op host ID is always a run of zeros ending in 1, so there's nothing to look up. You do need somewhere to put the files:",
      prepare: [
        "In Palworld, create a new co-op world. Name and settings don't matter — the conversion moves the save itself, and world settings stay with the new world.",
        "Enter it once so the game writes a save, then quit the game.",
        "After converting, copy the downloaded files over that new world's folder.",
      ],
      convert: "Convert back to co-op",
      successBody: (guid: string) =>
        `Your character moved to the co-op host ID ${guid}, and everything that pointed at the old one moved with it: guild membership and admin rights, pal ownership, party and palbox slots, Dimensional Pal Storage (the file is renamed and its records inside are re-pointed), the build records on your structures, chest password locks and death drops. The files were read back and checked field by field after writing.`,
      nextTitle: "Next: put it back on your PC",
      next: (world: string) => [
        "Make sure you've created the co-op world from step 3 and fully quit Palworld.",
        "Open your save folder, go into the folder named after your Steam ID, find the newest world folder and copy it somewhere as a backup:",
        `Put the files from inside the “${world}” folder in the zip into it, replacing files with the same name — not the “${world}” folder itself.`,
        "Load the world in game and check your character, Pals and guild first. If anything's off, swap your backup back in.",
      ],
    },
  },

  dropHint: "Or drag the folder into this box",
  pickFiles: "Only have loose .sav files? Pick them one by one",
  uploadPromptNote:
    "Your browser will then ask whether to upload the files to this site — that's just how browsers word folder picking. The files are only read inside this page and never sent anywhere.",
  noLevelSav:
    "No world save (Level.sav) in here. Pick the SaveGames folder, or one of the world folders inside it.",
  readFailed: "Couldn't read that folder",
  loadedWorld: (name: string, players: number, pals: number) =>
    `Loaded “${name}”: ${num(players)} characters, ${num(pals)} pals.`,
  undecodedTitle: "Some entries in this world won't decode",
  undecodedBody: (n: number) =>
    `${num(n)} entries in the character list couldn't be read, and the conversion will fail at the last step because of them. This usually means Palworld changed its save format and the tool hasn't caught up.`,
  parserWarningsTitle: "The reader met structures it doesn't know",
  parserWarningsBody: (n: number) =>
    `${num(n)} structures were unfamiliar and had to be guessed at. Writing back and checking use the same guess, so a check that passes here doesn't prove the result is right. You can go ahead, but keep your original save and confirm your character, pals and guild in game before you rely on it.`,
  worldPickTitle: "Pick the world to convert",
  worldPickHint:
    "Pick by world name and in-game day. A world with no name here is one whose LevelMeta.sav we could not read — go by the folder id and the last modified time for that one.",
  worldDay: (n: number) => `In-game day ${num(n)}`,
  worldMeta: (time: string) => `Last modified ${time}`,

  step2Title: "Identify your character",
  step2Placeholder: "Once a world is loaded, its characters are listed here.",
  characterOption: (name: string, level: number) => `${name} (level ${num(level)})`,
  hostIsCoop: "co-op host",
  alreadyCoopHost:
    "That character already uses the co-op host ID, so there's nothing to convert. Pick your character on the server instead.",
  coopHostTaken:
    "This world already has a co-op host. Converting it as is would delete the current host's character and hand the host's Pals to the character you picked. To change hosts, first move the current host out with Co-op → Dedicated server, then pick that converted world here.",

  steamLabel: "Steam ID (SteamID64)",
  steamHint:
    "17 digits starting with 7656. It's the number under SaveGames in your save path, or open Steam and click your account name at the top right → Account details. A profile link works too. Computed in your browser; nothing is sent.",
  steamInvalid:
    "That needs to be a 17-digit SteamID64 starting with 7656. A custom URL (/id/name) has to be turned into the numeric ID on Steam first.",
  steamFromPath:
    "We read this Steam account off the save folder you picked — co-op worlds live on the host's own PC, so it's usually the host. If not, change it to the host's Steam ID.",
  resultLabel: "The host's ID on the server",
  resultFromSteam:
    "Worked out from the Steam ID above. Once the host joins, this is the name of their file in the server's Players folder.",
  resultFromManual: "Using the ID you entered (or that we read off the server).",
  steamAgrees: "Matches the filename on your server.",
  steamDisagreesTitle: "The computed ID doesn't match the one on your server",
  steamDisagreesBody:
    "Go with the one that actually exists on the server — that's what's filled in below. A mismatch usually means Palworld changed how the ID is derived, or this server's launch options aren't what you ticked.",
  fallbackTitle:
    "Crossplay player (Xbox / PlayStation / Mac), or want to check against the server's files?",
  fallbackHint:
    "Crossplay players' IDs can't be worked out — the host has to join the server once, create a character and leave. Then drop the server's world folder (or just the new .sav in Players) in and we'll read the ID straight off it, or type the filename below.",
  pickServerFolder: "Choose Server World Folder",
  detectedNone:
    "No new character file in what you dropped. Either the host hasn't joined this server yet, or that folder isn't the world. The Steam ID field above needs none of this.",
  detectedOne: (guid: string) => `Found the new ID: ${guid}`,
  detectedMany: (count: number, guid: string) =>
    `Found ${num(count)} unfamiliar character files and filled in the most recent one (${guid}). If several people joined fresh, pick the host's by join time.`,
  manualLabel: "Enter the ID manually (optional)",
  manualHint:
    "32 characters — the host's filename in the server's Players folder, without .sav. If filled in, it takes priority.",
  invalidGuid: "The ID should be 32 hexadecimal characters.",
  guidCollides: "That's the same ID as the selected character, so there's nothing to convert.",
  guidTakenByOther: (name: string) =>
    `That ID belongs to another character in this world (${name}). Using it would delete that person's character and save file. Enter the ID your server assigned to the host.`,
  advancedTitle: "Advanced",
  noSteamLabel: "The server runs with -nosteam",
  noSteamHint:
    "Servers started without Steam authentication work the ID out differently. Leave this off if you're not sure.",

  step4Title: "Convert and download",
  step4Hint:
    "One click starts it. The conversion runs in your browser, so bigger worlds take longer — leave the page open until it finishes.",
  converting: "Converting…",
  convertFailed: "Conversion failed",
  convertFailedBody:
    "Nothing was written and your original save is untouched. If Palworld updated recently, the save format may have changed.",
  successTitle: "Conversion complete",
  downloadZip: "Download Converted World",
  packing: "Packing…",
  friendsTitle: "Move a friend's character too?",
  friendsHint:
    "Friends on Steam keep the same ID on a dedicated server, so their files are already in the zip and need nothing. This is for Xbox, PlayStation and Mac crossplay players: the server hands them an ID of its own, which they can only get by joining once. Paste that ID here and their character moves onto it. Each one chains onto the same world.",
  friendsNone: "There's nobody else in this world.",
  friendConvert: "Move this one",
  friendDone: (name: string, guid: string) => `${name} moved to ${guid}`,
  friendTaken: "Somebody in this world already uses that ID.",
  detailsToggle: "Technical details",
  detailsNote:
    "A record of each layer that was rewritten, in English. Include it if you report a problem.",
  hostedLine: {
    before: "Also available online, from ",
    link: "KeepWorlds",
    after: ", who host Palworld dedicated servers.",
  },

  railTitle: "Progress",
  railWorldTitle: "World loaded",
  railPlayers: "Characters",
  railPals: "Pals",
  railGuilds: "Guilds",
  railHost: "Host ID",
  railEmpty: "Pick a world folder and what we read shows up here.",

  copy: "Copy",
  copied: "Copied",
  mobileTitle: "Your save is on your PC",
  mobileBody:
    "Palworld keeps saves on your Windows PC, so the conversion has to happen there. Send yourself this page's link and open it on your computer.",
  copyLink: "Copy Page Link",

  footer: {
    credits:
      "Save parsing by zlmitchell/palworld-save-toolkit and Oodle decompression by SnosMe/ooz-wasm, both GPL-3.0.",
    source: "Source code",
    maintained: "Maintained by KeepWorlds.",
  },
};

export type Strings = typeof en;
