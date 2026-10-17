/**
 * Convert Palworld co-op saves to dedicated-server saves and back. **The whole thing runs
 * in the visitor's browser**; not a single byte reaches any server.
 *
 * This file is the UI-side entry point. It **does not parse saves**; it only does two
 * things: keeps the name-only work (listing worlds, spotting a new ID) on the main thread,
 * and hands everything that reads bytes to `worker.ts`. Why the heavy lifting must leave
 * the UI thread is explained in that file's header.
 *
 * # Both directions are the same code
 *
 * The ID replacement lives in `remap.ts`, and **every site only does old -> new, never
 * writes zeros**, so direction is not part of the algorithm: co-op -> dedicated passes
 * `(...0001, the server-assigned ID)`, dedicated -> co-op swaps the two.
 *
 * This must not fall back to vendor's `migrate`: three of its layers write hard-coded
 * zeros (normalising to the dedicated-server shape), which are no-ops when run in reverse
 * while its verification still passes. The full reasoning is in `remap.ts`'s header.
 *
 * # Why in the browser
 *
 * This handles other people's game saves. Processing them locally means nobody has to
 * trust a third party with their world: the page only ever serves static assets, and the
 * save files never leave the user's computer.
 *
 * # What vendor/ is, and why it is not rewritten in TS
 *
 * `../vendor/` holds the GVAS parser and migration code of zlmitchell/palworld-save-toolkit,
 * **copied verbatim, not one line changed** (the commit is in `../vendor/UPSTREAM-COMMIT`).
 * It is not translated to TS so that it can track upstream: every Palworld save-format
 * change breaks community tools all at once, and the fix then is to diff upstream's
 * changes in. Types are written once, in `types.ts`; the UI sees only those named types.
 */
import { classifyWorldFile, guid32, isRollingBackup, relOf } from "./paths";
import type { LoadResult, PalSaveRequest, PalSaveResponse, WorldDescription } from "./protocol";
import type { GuidCandidate, MigrateReport, WorldChoice } from "./types";

export { COOP_HOST_GUID } from "./constants";
export type { WorldDescription } from "./protocol";
export type {
  CoopPlayer,
  GuidCandidate,
  LoadedWorld,
  MigrateReport,
  WorldChoice,
  WorldSummary,
} from "./types";

/**
 * Recognise every world directory in a pile of files.
 *
 * It exists because **users should not have to pick the exact world directory**: Palworld
 * keeps worlds under `SaveGames/<steamid>/<hex>/`, both directory names are meant for
 * machines, and asking people to pick one of them is the step most likely to make them
 * give up. Drop the whole `SaveGames` in and this lists the worlds.
 *
 * Only names and mtimes are read, not a single byte, so it stays on the main thread.
 */
export function findWorlds(files: File[]): WorldChoice[] {
  const levels = new Map<string, File>();

  for (const f of files) {
    const rel = relOf(f);
    if (isRollingBackup(rel)) continue;
    // Shares one classifier with reading a world and spotting a new ID. The three once had
    // their own copies, and a missed update showed up as the steps seeing different sets
    // of files, with no error (see the header of `paths.ts`).
    if (classifyWorldFile(rel).kind !== "level") continue;
    levels.set(rel.split("/").slice(0, -1).join("/"), f);
  }

  const out: WorldChoice[] = [];
  for (const [dir, level] of levels) {
    // An empty dir means the world directory itself was picked, so every file belongs to it.
    const own = dir === "" ? files : files.filter((f) => relOf(f).startsWith(`${dir}/`));
    out.push({
      name: dir.split("/").pop() || (level.webkitRelativePath ? "" : "world"),
      dir,
      lastModified: level.lastModified,
      files: own,
    });
  }

  // Most recently modified first: people usually have one world they "just played", and
  // the rest are old saves.
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

/**
 * Spot the host's new GUID in a dedicated-server world: a player file under Players/ that
 * the co-op save does not have.
 *
 * Returns all candidates newest first rather than just the first one: if more than one
 * person joined after the server started there is more than one candidate, and only the
 * host knows which is theirs, so the caller has to hand the choice back.
 */
export function detectNewGuid(files: File[], known: Iterable<string>): GuidCandidate[] {
  const seen = new Set([...known].map(guid32));
  const out: GuidCandidate[] = [];
  for (const f of files) {
    const rel = relOf(f);
    if (isRollingBackup(rel)) continue;
    // Loose files count too: the most common use of this step is **dropping in just the
    // new player file**, in which case there is no Players/ level in the path at all.
    const kind = classifyWorldFile(rel);
    if (kind.kind !== "player") continue;
    const guid = kind.guid as string;
    if (!seen.has(guid)) out.push({ guid, lastModified: f.lastModified });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

/**
 * The error that requests still pending after `terminate()` receive. Callers **should
 * ignore it entirely**: it only means "this read is void, the user is already looking at a
 * different world". Rendering it as an error flashes an unintelligible red line whenever
 * the world changes.
 */
export const ABORTED = "palsave:aborted";

export function isAborted(err: unknown): boolean {
  return err instanceof Error && err.message === ABORTED;
}

/**
 * Request body: `PalSaveRequest` minus id. `Omit` does not distribute over unions (it
 * collapses to the keys all branches share, leaving only `kind`), so a conditional type on
 * a **naked type parameter** spreads it branch by branch. Writing
 * `PalSaveRequest extends unknown ? ...` directly does not work: distribution only
 * happens on type parameters.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PalSaveRequestBody = DistributiveOmit<PalSaveRequest, "id">;

export type PalSaveClient = {
  /** Read each LevelMeta for world name and in-game day. Unreadable entries are null; does not throw. */
  describe(worlds: { dir: string; files: File[] }[]): Promise<WorldDescription[]>;
  /** Read a world and summarise it. Returns `{ world: null }` when there is no Level.sav; that is not an error. */
  load(files: File[], worldName: string | null): Promise<LoadResult>;
  /** For `fresh`, see `protocol.ts`: true for the host run, false for friends chained after it. */
  migrate(oldGuid: string, newGuid: string, fresh: boolean): Promise<MigrateReport>;
  /** Pack the output of the last `migrate`. The bytes are in the worker; only a Blob comes back. */
  pack(folderName: string): Promise<Blob>;
  terminate(): void;
};

/**
 * Start a worker and wrap its messages in promises.
 *
 * **One client per world**: callers `terminate()` before creating a new one when the world
 * changes. That one rule buys three things at once: the previous world's tens of MB and
 * the wasm heap are reclaimed; an old request that arrives late cannot overwrite a newer
 * result (the old worker is gone); and the download can never mix bytes from two worlds.
 */
export function createPalSaveClient(): PalSaveClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let dead = false;

  worker.addEventListener("message", (e: MessageEvent<PalSaveResponse>) => {
    const res = e.data;
    const slot = pending.get(res.id);
    if (!slot) return;
    pending.delete(res.id);
    if (res.ok) slot.resolve(res.value);
    else slot.reject(new Error(res.message));
  });

  // When the worker itself dies (an uncaught exception in the parser, or the browser
  // killing it under memory pressure), fail the pending requests: otherwise the step 1
  // spinner keeps spinning forever with no explanation.
  worker.addEventListener("error", (e: ErrorEvent) => {
    const message = e.message || "worker crashed";
    for (const [, slot] of pending) slot.reject(new Error(message));
    pending.clear();
  });

  function send<T>(body: PalSaveRequestBody): Promise<T> {
    if (dead) return Promise.reject(new Error(ABORTED));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...body, id });
    });
  }

  return {
    describe: (worlds) => send<WorldDescription[]>({ kind: "describe", worlds }),
    load: (files, worldName) => send<LoadResult>({ kind: "load", files, worldName }),
    migrate: (oldGuid, newGuid, fresh) =>
      send<MigrateReport>({ kind: "migrate", oldGuid, newGuid, fresh }),
    pack: (folderName) => send<Blob>({ kind: "pack", folderName }),
    terminate() {
      dead = true;
      for (const [, slot] of pending) slot.reject(new Error(ABORTED));
      pending.clear();
      worker.terminate();
    },
  };
}
