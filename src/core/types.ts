/**
 * Types that cross the main-thread / worker boundary. **Does not import vendor**: the UI
 * referencing this file must not pull the GVAS parser into the page bundle.
 *
 * The types inferred from vendor are loose and drift with upstream changes, so every
 * exit from the worker narrows to the shapes declared here; the UI only ever sees these.
 */

/** A candidate world: one world directory `findWorlds` recognised in a pile of files. Only names and mtimes are read, never bytes. */
export type WorldChoice = {
  /** World directory name. Palworld uses a hex string, so it identifies nothing to a human; the next two fields do the real work. */
  name: string;
  /** Directory path relative to the picked root; empty string means the user picked the world directory itself. */
  dir: string;
  /** Last-modified time of Level.sav: "the one I just played" can only be recognised by this. */
  lastModified: number;
  files: File[];
};

export type CoopPlayer = {
  /** 32 uppercase hex characters, matching the file name of Players/<guid>.sav. */
  guid32: string;
  nickname: string;
  level: number | null;
};

export type WorldSummary = {
  players: CoopPlayer[];
  palCount: number;
  guilds: number;
  /**
   * Messages the parser leaves when it meets structures it does not know. **These must be
   * shown to the user**: gvas guesses a type for an unknown struct and keeps going, and
   * writing back and verifying use the same guess. After a format change it can therefore
   * hand back a save that "passed verification" yet was damaged.
   */
  warnings: string[];
  /**
   * Number of entries in the character map that failed to decode. The migration aborts
   * hard on these, so this is a failure we can announce at step 1 instead of letting it
   * blow up at step 4.
   */
  undecoded: number;
};

/** Everything the main thread needs after a world is read. The bytes stay in the worker. */
export type LoadedWorld = {
  worldName: string | null;
  summary: WorldSummary;
  /** GUIDs (32 uppercase hex) of every player file under Players/, used as the "known" set when spotting a new ID. */
  playerGuids: string[];
};

export type GuidCandidate = { guid: string; lastModified: number };

export type MigrateReport = {
  /** Per-layer report; the last line is VERIFICATION PASSED. Shown verbatim, never translated. */
  report: string[];
  oldGuid: string;
  newGuid: string;
  /**
   * Which player files the world holds after this run. **Every migration returns it**: when
   * moving the next character, "does the target ID collide with someone" must be judged
   * against the latest roster; the stale roster from load time would let a real collision
   * through.
   */
  playerGuids: string[];
};
