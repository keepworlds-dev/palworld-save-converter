/**
 * **All the heavy work** of parsing, migrating and packing saves. This file is the only
 * place in the chain that imports vendor, and it runs in a worker, not on the UI thread.
 *
 * # Why it has to be a worker
 *
 * A mid-sized world's Level.sav is tens of MB once decompressed, and this chain runs on
 * it: Oodle decompression, a full GVAS parse, byte-by-byte scans of guild blobs, writing
 * back, parsing again to verify, crc32 and zip assembly. On the main thread, around 10 MB
 * already freezes interaction and tens of MB triggers "page unresponsive", while the
 * step 4 hint says precisely "do not close the page". On a phone the OS just kills it and
 * the user sees no explanation.
 *
 * # World bytes live here and never go back to the main thread
 *
 * After `load`, the whole world (Level.sav, every player file, Dimensional Pal Storage,
 * LocalData.sav...) stays on the worker's heap; the main thread only gets the summary and
 * player IDs. That way neither `migrate` nor `pack` moves tens of MB back and forth, and
 * there is no peak where both the main thread and the worker hold a copy.
 *
 * The price is that the worker is stateful. **A different world means a different worker**
 * (see the client in `index.ts`): terminating the old one discards its heap along with the
 * decompressed Level.sav inside emscripten. The ooz wrapper only frees the previous pointer
 * on the next call, so without a new worker the last decompression result would stay
 * pinned on the wasm heap. It also makes it impossible for "convert A, then click B" to mix
 * two worlds' bytes in one package: the old worker no longer exists.
 */
import { classifyWorldFile, guid32, isRollingBackup, relOf } from "./paths";
import type { LoadResult, PalSaveRequest, PalSaveResponse, WorldDescription } from "./protocol";
import { remapHost, remapSidecars } from "./remap";
// Fills gaps in the vendor type table; must take effect before any parse. See that file's header.
import "./type-hints";
import type { CoopPlayer, MigrateReport, WorldSummary } from "./types";
import { inspectWorld, parsePlayer } from "../vendor/migrate.js";
import { buildZip } from "../vendor/zip.js";

/** A world folder read into memory. Files other than Level.sav are all carried as is; see readWorldFolder. */
type WorldFolder = {
  worldName: string | null;
  levelBytes: Uint8Array;
  levelMetaBytes: Uint8Array | null;
  /** Keyed by 32-character uppercase hex GUID (the stem of Players/<guid>.sav). */
  playerFiles: Map<string, Uint8Array>;
  /** Files under Players/ that are not <guid>.sav, such as Dimensional Pal Storage <guid>_dps.sav. Keyed by original file name. */
  extraFiles: Map<string, Uint8Array>;
  /** Other .sav files at the world root, such as LocalData.sav. WorldOption.sav is not among them; see classifyWorldFile. */
  rootFiles: Map<string, Uint8Array>;
};

type OozDecompress = (data: Uint8Array, rawSize: number) => Uint8Array;

/**
 * The Oodle decompressor (131 KB of wasm, base64-inlined in the emscripten output) lives in
 * `public/ooz-wasm/` and is **loaded from a URL at runtime, bypassing the bundler**.
 *
 * Two reasons, the second one hard:
 *   1. it is only needed when actually reading a PlM save, and has no place in any page's
 *      initial bundle;
 *   2. the emscripten output carries a Node environment branch (the
 *      `await import("module")` part). A bundler that tries to resolve it fails on
 *      `module`, even though that code never runs in a browser; static analysis cannot
 *      know that. Working around it would mean editing vendor (which breaks upstream
 *      tracking) or configuring aliases; loading from a URL needs neither.
 *
 * The URL is built from Vite's `BASE_URL`, so the app also works when deployed under a
 * sub-path. It is made fully qualified on purpose: the Vite dev server appends `?import` to
 * root-relative dynamic imports, and a public file requested that way is refused (404).
 * `@vite-ignore` keeps Vite from warning about the non-static import.
 *
 * The promise is cached rather than the result, so concurrent callers initialise the
 * runtime only once; but **failures are not cached**. A settled rejected promise is
 * neither null nor undefined, so with `??=` a single network hiccup (or static assets
 * being replaced on deploy) would make every later conversion fail with the same stale
 * error until the user reloads, and the UI would only repeat that raw error without
 * suggesting a reload.
 */
const OOZ_URL = new URL(`${import.meta.env.BASE_URL}ooz-wasm/index.js`, self.location.origin).href;

let oozPromise: Promise<OozDecompress> | null = null;

function loadOoz(): Promise<OozDecompress> {
  if (oozPromise === null) {
    oozPromise = (
      import(/* @vite-ignore */ OOZ_URL) as Promise<{
        decompress: OozDecompress;
      }>
    )
      .then((m) => m.decompress)
      .catch((err: unknown) => {
        oozPromise = null;
        throw err;
      });
  }
  return oozPromise;
}

/**
 * Read a world directory's file list into memory. Returns null when Level.sav is missing,
 * which means the picked files contain no world at all; the caller shows a dedicated hint.
 */
async function readWorldFolder(files: File[]): Promise<WorldFolder | null> {
  // Classify first (pure string work, no disk reads), then read everything concurrently.
  // Awaiting one by one would add up the read latency of a dozen to dozens of files that do
  // not depend on each other. Peak memory is the same: all these bytes are kept anyway.
  const picked = files
    .map((f) => {
      const rel = relOf(f);
      return { f, rel, kind: classifyWorldFile(rel) };
    })
    .filter(({ rel, kind }) => !isRollingBackup(rel) && kind.kind !== "ignore");
  const blobs = await Promise.all(
    picked.map(({ f }) => f.arrayBuffer().then((b) => new Uint8Array(b))),
  );

  let worldName: string | null = null;
  let levelBytes: Uint8Array | null = null;
  let levelMetaBytes: Uint8Array | null = null;
  const playerFiles = new Map<string, Uint8Array>();
  const extraFiles = new Map<string, Uint8Array>();
  const rootFiles = new Map<string, Uint8Array>();

  // Fill the tables in pick order, not completion order: concurrency should only change
  // when bytes arrive, not which of two same-named files wins.
  for (let i = 0; i < picked.length; i++) {
    const { rel, kind } = picked[i];
    const bytes = blobs[i];
    const base = rel.split("/").pop() ?? "";

    if (kind.kind === "level") {
      levelBytes = bytes;
      const parts = rel.split("/");
      if (parts.length >= 2) worldName = parts[parts.length - 2];
    } else if (kind.kind === "levelMeta") {
      levelMetaBytes = bytes;
    } else if (kind.kind === "player") {
      playerFiles.set(kind.guid as string, bytes);
    } else if (kind.kind === "sidecar") {
      extraFiles.set(base, bytes);
    } else if (kind.kind === "root") {
      rootFiles.set(base, bytes);
    }
  }

  if (levelBytes === null) return null;
  return { worldName, levelBytes, levelMetaBytes, playerFiles, extraFiles, rootFiles };
}

/**
 * Read a world's name and in-game day.
 *
 * Both live in `LevelMeta.sav`; the whole file is those two fields, about 2 KB, and it is
 * what the in-game world picker reads too. Worth a separate read: the world directory
 * name is a hex string, and someone with several worlds picking by directory name and
 * mtime alone could pick the wrong one without noticing (and the cost of that is
 * converting a different world).
 *
 * **Any failure returns null instead of throwing**: the name only helps people recognise
 * the world. Without it the list falls back to the directory name; one broken LevelMeta
 * must not stop the whole list from opening.
 */
async function readWorldMeta(files: File[]): Promise<{ name: string | null; inGameDay: number | null }> {
  try {
    const metaFile = files.find((f) => {
      const rel = relOf(f);
      return !isRollingBackup(rel) && classifyWorldFile(rel).kind === "levelMeta";
    });
    if (!metaFile) return { name: null, inGameDay: null };

    const ooz = await loadOoz();
    const bytes = new Uint8Array(await metaFile.arrayBuffer());
    // LevelMeta is a plain GVAS save with no custom properties, so it takes parsePlayer's generic path.
    const parsed = (await parsePlayer(bytes, ooz)) as unknown as {
      player: { properties: { SaveData: { value: Record<string, { value?: unknown }> } } };
    };
    const sd = parsed.player.properties.SaveData.value;
    const name = typeof sd.WorldName?.value === "string" ? sd.WorldName.value : null;
    const rawDay = sd.InGameDay?.value;
    const inGameDay =
      typeof rawDay === "number" ? rawDay : typeof rawDay === "bigint" ? Number(rawDay) : null;
    return { name: name !== null && name !== "" ? name : null, inGameDay };
  } catch {
    return { name: null, inGameDay: null };
  }
}

/** Read the world's players, pal count, guild count, and the two anomalies the parser reports itself. */
async function summarizeWorld(levelBytes: Uint8Array): Promise<WorldSummary> {
  const ooz = await loadOoz();
  const info = await inspectWorld(levelBytes, ooz);
  const players: CoopPlayer[] = (info.players as Array<Record<string, unknown>>).map((p) => ({
    guid32: guid32(String(p.uid)),
    nickname: String(p.nickname),
    level: typeof p.level === "number" ? p.level : null,
  }));
  return {
    players,
    palCount: Number(info.palCount),
    guilds: Number(info.guilds),
    warnings: (info.warnings as string[] | undefined) ?? [],
    undecoded: Number(info.undecoded ?? 0),
  };
}

/**
 * Run the full ID replacement. The implementation is in `remap.ts`, **not vendor's
 * migrate**: the latter hard-codes zeros in three layers and only holds in the co-op ->
 * dedicated direction; the reasoning is in that file's header.
 *
 * After writing, the output is parsed again and checked item by item, and any layer that
 * did not land throws. But **the assertions only cover what it changed**, so the caller is
 * still responsible for what it did not touch (renaming Dimensional Pal Storage happens
 * here, see below).
 */
async function migrateHostSave(
  folder: WorldFolder,
  oldGuid32: string,
  newGuid32: string,
): Promise<MigrateReport> {
  const oldGuid = guid32(oldGuid32);
  const newGuid = guid32(newGuid32);
  const playerBytes = folder.playerFiles.get(oldGuid);
  if (!playerBytes) throw new Error(`missing Players/${oldGuid}.sav`);

  const ooz = await loadOoz();
  const r = await remapHost(folder.levelBytes, playerBytes, oldGuid, newGuid, ooz);

  // Dimensional Pal Storage: renaming is not enough, the ownership records **inside** the
  // file must change too (see remapSidecars).
  const side = await remapSidecars(folder.extraFiles, oldGuid, newGuid, ooz);

  // ---- Fold the results back into folder ----
  //
  // Once folded back, `folder` is the final state and `packWorld` only serialises. That
  // makes **converting another character** natural: the second migration starts from the
  // already-changed bytes, layer on layer. Without folding back, the second run would start
  // over from the original Level.sav and wipe out the first result, and the output's
  // self-check would still pass, because it only looks at this run's pair of IDs.
  folder.levelBytes = r.levelSav;
  folder.playerFiles.delete(oldGuid);
  folder.playerFiles.set(newGuid, r.playerSav);

  // Sidecar files are renamed along with it. **Case-insensitive comparison**: `playerFiles`
  // keys were uppercased on read, but `extraFiles` keeps the original on-disk names.
  // Server-assigned IDs contain hex letters; if they are lowercase on disk, a case-sensitive
  // comparison would leave the file under its old name and that player's Dimensional Pal
  // Storage would be left behind entirely.
  const renamed = new Map<string, Uint8Array>();
  for (const [name, data] of folder.extraFiles) {
    const bytes = side.files.get(name) ?? data;
    const isTheirs = name.slice(0, oldGuid.length).toUpperCase() === oldGuid;
    renamed.set(isTheirs ? newGuid + name.slice(oldGuid.length) : name, bytes);
  }
  folder.extraFiles = renamed;

  const report = [
    ...r.report,
    `[sidecars] dimensional-storage references re-pointed: ${side.changed}` +
      (side.skipped > 0 ? `, left byte-identical (writer can't round-trip): ${side.skipped}` : ""),
  ];

  return { report, oldGuid, newGuid, playerGuids: [...folder.playerFiles.keys()] };
}

/**
 * Pack into a world directory that can be dropped over the destination as a whole.
 *
 * **This only serialises; no renaming, no choosing.** `folder` is already in its final
 * state after each migration (see the fold-back part of `migrateHostSave`). These used to
 * be mixed in here, so "move another friend" could only start over: the second migration
 * started from the original bytes and wiped out the first result.
 *
 * Files the dedicated server never reads, such as LocalData.sav, are carried as well
 * (upstream does the same), so the directory can still be moved back to local co-op as is
 * and the user keeps a way back.
 */
function packWorld(folder: WorldFolder, folderName: string): Blob {
  const dir = (folderName.trim() || folder.worldName || "world").replace(/[\\/]+/g, "");
  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: `${dir}/Level.sav`, data: folder.levelBytes },
  ];
  if (folder.levelMetaBytes) {
    entries.push({ name: `${dir}/LevelMeta.sav`, data: folder.levelMetaBytes });
  }
  for (const [guid, data] of folder.playerFiles) {
    entries.push({ name: `${dir}/Players/${guid}.sav`, data });
  }
  for (const [name, data] of folder.extraFiles) {
    entries.push({ name: `${dir}/Players/${name}`, data });
  }
  for (const [name, data] of folder.rootFiles) {
    entries.push({ name: `${dir}/${name}`, data });
  }

  // buildZip returns one freshly allocated Uint8Array (byteOffset is always 0). Asserting
  // the ArrayBuffer variant only rules out SharedArrayBuffer; no copy is skipped by it.
  const zipped = buildZip(entries) as Uint8Array<ArrayBuffer>;
  return new Blob([zipped], { type: "application/zip" });
}

// ---- Message loop ----

// The tsconfig lib has only dom, not webworker (the two conflict in one program). So the
// two members actually used are declared structurally here instead of touching the global
// lib: in type terms the worker global is just these two things, and spelling it out fully
// would pull in the whole DedicatedWorkerGlobalScope.
const ctx = self as unknown as {
  postMessage(value: PalSaveResponse): void;
  addEventListener(type: "message", fn: (e: MessageEvent<PalSaveRequest>) => void): void;
};

let folder: WorldFolder | null = null;
/**
 * What `load` read in. Migrations fold their results into `folder`; a `fresh` migration
 * starts over from here. Only the Maps are copied: migrations replace byte-array
 * references and never mutate the original arrays in place, so no deep copy is needed.
 */
let pristine: WorldFolder | null = null;
/** At least one migration has run; gates `pack`. The world bytes are already folded into folder, so a flag is enough. */
let migrated = false;

function cloneFolder(f: WorldFolder): WorldFolder {
  return {
    ...f,
    playerFiles: new Map(f.playerFiles),
    extraFiles: new Map(f.extraFiles),
    rootFiles: new Map(f.rootFiles),
  };
}

async function handle(
  req: PalSaveRequest,
): Promise<LoadResult | WorldDescription[] | MigrateReport | Blob> {
  switch (req.kind) {
    case "describe": {
      // Reads only each LevelMeta (about 2 KB), never Level.sav. Sequential rather than
      // Promise.all: they share one ooz runtime, and concurrency would only hold several
      // decompression buffers on the wasm heap at once.
      const out: WorldDescription[] = [];
      for (const w of req.worlds) {
        const meta = await readWorldMeta(w.files);
        out.push({ dir: w.dir, name: meta.name, inGameDay: meta.inGameDay });
      }
      return out;
    }
    case "load": {
      // A new world clears the output too. Normally this worker is brand new (the client
      // recreates it for every world), but the protocol allows reuse, and the reuse path
      // must not become a way for "the previous world mixed into the download" to happen.
      folder = null;
      pristine = null;
      migrated = false;
      const world = await readWorldFolder(req.files);
      if (!world) return { world: null };
      const summary = await summarizeWorld(world.levelBytes);
      world.worldName = req.worldName ?? world.worldName;
      folder = world;
      pristine = cloneFolder(world);
      return {
        world: {
          worldName: world.worldName,
          summary,
          playerGuids: [...world.playerFiles.keys()],
        },
      };
    }
    case "migrate": {
      if (!folder || !pristine) throw new Error("no world loaded");
      // Migrate on a copy and swap it in only on success: if it throws midway, folder is
      // still the previous intact state, the user can change the ID and retry, and no
      // half-done output ends up in the download.
      const work = cloneFolder(req.fresh ? pristine : folder);
      const out = await migrateHostSave(work, req.oldGuid, req.newGuid);
      folder = work;
      migrated = true;
      return out;
    }
    case "pack": {
      if (!folder || !migrated) throw new Error("nothing to pack");
      return packWorld(folder, req.folderName);
    }
  }
}

ctx.addEventListener("message", (e) => {
  const req = e.data;
  void handle(req).then(
    (value) => ctx.postMessage({ id: req.id, ok: true, value }),
    (err: unknown) =>
      ctx.postMessage({
        id: req.id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
  );
});
