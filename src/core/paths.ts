/**
 * The two "where is this file" decisions over a pile of picked files. The three call sites
 * (listing worlds, reading a world, spotting a new ID) once each had their own copy of the
 * same regexes. Missing an update in one copy meant one of the three steps saw a different
 * set of files than the other two, with no error at all, just results that did not line up.
 *
 * This file **must not import vendor**: both the worker and the main thread use it.
 */

/** A file's path relative to the picked root, with forward slashes. For dropped files `webkitRelativePath` is filled in by `walkEntry`. */
export function relOf(f: File): string {
  return (f.webkitRelativePath || f.name).replace(/\\/g, "/");
}

/**
 * Whether this is one of Palworld's own rolling backups. The world directory's `backup/`
 * also contains a Level.sav; treating it as a world would show the user two near-identical
 * entries, and picking the wrong one would go unnoticed.
 *
 * **Only `backup/` from the second path segment on counts**, never the first segment: both
 * drag-and-drop and the picker produce paths that start with the name of the directory the
 * user picked, and step 1 tells people to make their own backup first. Someone who does
 * exactly that, copies SaveGames into a folder called `backup` and drops it in, would have
 * every file skipped by `^backup/`, and would then be told "no Level.sav in this folder",
 * which is wrong here and points nowhere near the real cause.
 */
export function isRollingBackup(rel: string): boolean {
  return /\/backup\//i.test(rel);
}

/**
 * Normalise a GUID to 32 uppercase hex characters, i.e. the `Players/<guid>.sav` file
 * name form.
 *
 * This rule is the shared premise of sidecar renaming, target-ID collision checks and
 * new-ID candidate filtering, and it was once written separately in four places. None of
 * the copies would complain if they drifted: server-assigned IDs contain hex letters, and
 * if they are lowercase on disk, a case-sensitive comparison silently leaves that player's
 * Dimensional Pal Storage behind.
 */
export function guid32(raw: string): string {
  return raw.replace(/-/g, "").toUpperCase();
}

/** What a file is within a world directory. `ignore` is something unknown or deliberately left out, dropped entirely. */
export type WorldFileKind = "level" | "levelMeta" | "player" | "sidecar" | "root" | "ignore";

/**
 * Decide, from its relative path, what role a file plays in a world.
 *
 * **Loose files (no directory in the path) are classified by name**, and that is why this
 * function exists. A user may drop only `Level.sav` plus the few `.sav` files from
 * `Players/`: on a phone there is no `webkitdirectory` and no folder drag-and-drop, so this
 * is exactly the shape that falls out. If only the `Players/` prefix counted, those player
 * files would be swept up as miscellaneous world-root files, `playerFiles` would be empty,
 * and the error would only surface at step 4 as "missing Players/<guid>.sav", leaving the
 * user no idea what they left out.
 *
 * Order matters: fixed names first (`Level.sav` / `LevelMeta.sav`), then player files, and
 * world-root miscellany last. The other way round, a loose `LocalData.sav` would be taken
 * for a Players/ sidecar because it has no directory, and packed into `Players/`, while it
 * belongs at the world root.
 */
export function classifyWorldFile(rel: string): { kind: WorldFileKind; guid?: string } {
  const base = rel.split("/").pop() ?? "";
  if (base === "Level.sav") return { kind: "level" };
  if (base === "LevelMeta.sav") return { kind: "levelMeta" };
  // The full set of world settings a co-op world was tuned with in game. If a dedicated
  // server's world directory contains it, the server ignores PalWorldSettings.ini and uses
  // the co-op values instead, including an empty AdminPassword: server settings silently
  // stop applying and every REST call returns 401 (observed on a real server). Carried the
  // other way, it would overwrite the new co-op world's own settings. So it is left out in
  // both directions; the tool only reads the original folder, so going back to local co-op
  // is unaffected.
  if (base === "WorldOption.sav") return { kind: "ignore" };
  if (!base.endsWith(".sav")) return { kind: "ignore" };

  const inPlayersDir = /(^|\/)Players\//.test(rel);
  const loose = !rel.includes("/");
  const guid = /^([0-9A-Fa-f]{32})\.sav$/.exec(base)?.[1];

  if (guid !== undefined && (inPlayersDir || loose)) {
    return { kind: "player", guid: guid32(guid) };
  }
  // Dimensional Pal Storage `<guid>_dps.sav` and the like: under Players/, or loose with a
  // name that starts with a 32-character ID.
  if (inPlayersDir || (loose && /^[0-9A-Fa-f]{32}_/.test(base))) return { kind: "sidecar" };
  return { kind: "root" };
}
