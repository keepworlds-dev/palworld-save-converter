/**
 * Message shapes between the main thread and the worker. Kept in its own file rather than
 * `import type`-ing from `worker.ts`: type imports are erased, but putting an edge to the
 * worker in the UI's module graph is the easiest way to drag vendor into the page bundle.
 */
import type { LoadedWorld, MigrateReport } from "./types";

/**
 * Requests are ordered: the worker only holds world bytes after `load`, and only has output
 * to pack after `migrate`. The order is kept by the client in `index.ts`, which uses a
 * **fresh** worker per world, so no generation field such as a world id is needed here.
 *
 * `findWorlds` and `detectNewGuid` only look at file names and mtimes, never bytes, so they
 * stay on the main thread and do not go through this protocol.
 */
export type PalSaveRequest =
  | { id: number; kind: "describe"; worlds: { dir: string; files: File[] }[] }
  /**
   * `worldName` is supplied by the main thread from the directory `findWorlds` recognised.
   * The worker can also derive it from the path, but for dropped files the path is patched
   * on by the main thread with defineProperty, and structured clone does not carry own
   * properties. On the worker side only the file name survives, the world name becomes
   * null, and the zip's top-level folder falls back to "world".
   */
  | { id: number; kind: "load"; files: File[]; worldName: string | null }
  /**
   * With `fresh` true, start again from the original bytes read by `load`; with `fresh`
   * false, stack on top of the previous migration's output. The host run is always fresh:
   * if the user converts, goes back to step 3 and changes the ID, the second run must start
   * from the untouched world. Otherwise the host is no longer on the old ID and the second
   * run either reports a missing player file or mistakes the new ID for someone else's.
   * Moving friends afterwards is not fresh: those stack layer on layer.
   */
  | { id: number; kind: "migrate"; oldGuid: string; newGuid: string; fresh: boolean }
  | { id: number; kind: "pack"; folderName: string };

/** `load` returns `{ world: null }` when the picked files contain no Level.sav. That is an expected outcome, not an error. */
export type LoadResult = { world: LoadedWorld | null };

/**
 * Reply to `describe`: a world's name and in-game day, read from `LevelMeta.sav` (the
 * whole file is those two fields, about 2 KB). **Null when unreadable, not an error**: the
 * list falls back to the directory name, which is harder to recognise but still usable.
 */
export type WorldDescription = { dir: string; name: string | null; inGameDay: number | null };

export type PalSaveResponse =
  | { id: number; ok: true; value: LoadResult | WorldDescription[] | MigrateReport | Blob }
  | { id: number; ok: false; message: string };
