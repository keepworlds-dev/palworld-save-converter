/**
 * Move every reference to one player in a world from the old ID to the new ID. **Pure
 * replacement, direction-agnostic.**
 *
 * # Why not vendor's migrate
 *
 * `../vendor/migrate.js` does not do pure replacement. Three of its four layers write
 * hard-coded zeros: the pal keys in the character map, the handle in front of each pal
 * instance in guild blobs, and container slots' `player_uid`. That is "normalise the save
 * to the dedicated-server shape", which only holds in the co-op -> dedicated direction.
 *
 * Run the other way (dedicated -> co-op), those three places **are already zero** at the
 * source, none of the three layers matches anything, and its verification only asserts
 * "the old ID is gone and the new ID appears exactly once". Zero is not the old ID, so the
 * condition already holds and VERIFICATION PASSED is guaranteed. The output has "the host's
 * key fixed, but pal ownership, guild handles and container slots still in the dedicated
 * shape", and no layer reports it.
 *
 * Here instead: **every site only does old -> new and never writes zeros**. Direction
 * therefore stays out of the algorithm, both directions are the same code, and the reverse
 * is no longer an unfounded special case.
 *
 * # Why patch the raw bytes instead of decoding to objects and writing back
 *
 * The `RawData` of guilds and map objects is **deliberately not decoded** in
 * `../vendor/paldata.js` (that list has only two entries, with a comment saying "verified
 * to round-trip byte-identically"). Adding decoders for them would stake the
 * parse -> reserialise round trip on an encoder we wrote ourselves, and one mistake there
 * is a broken save that looks normal.
 *
 * So this does exactly one thing: **compute the offsets of those 16-byte fields from the
 * structure and change those 16 bytes in place**; every other byte is left alone and
 * written back as is by vendor's writer. The offsets are not guesses; they follow the
 * field order of the upstream MIT Python decoders (`palworld_save_tools/rawdata/group.py`,
 * `map_model.py`, `map_concrete_model_module.py`).
 *
 * **Comparing at a known offset and then writing is the only safe way to do this.** It
 * cannot be done the other way round, "search the whole blob for the old ID's 16 bytes and
 * replace": in the co-op direction the old ID is `...0001`, fifteen zero bytes and a 1, and
 * that pattern is everywhere in binary data (any int64 with value 1 next to zeros makes
 * it). The offset is what makes it safe; comparing the value only decides whether this
 * site belongs to the host.
 */
import {
  BUILD_PLAYER_UID_OFFSET,
  concreteOwnerOffset,
  type GuildOffsets,
  guildIdentityOffsets,
  MODEL_MIN_BYTES,
  passwordLockOffsets,
  sameAt,
} from "./blob-offsets";
import { guid32 } from "./paths";
// Fills gaps in the vendor type table. The worker already imports it; importing again here
// covers callers that do not go through the worker (scripts).
import "./type-hints";
import { UUID } from "../vendor/gvas.js";
import { formatGuid, parseLevel, parsePlayer } from "../vendor/migrate.js";
import { LEVEL_CUSTOM_PROPERTIES } from "../vendor/paldata.js";
import { compressSav } from "../vendor/sav.js";

/**
 * How many sites each layer changed. **Report only**: a count of 0 is itself the most
 * useful piece of information when troubleshooting, but it is not part of the caller's
 * output; the worker only takes `report` / `levelSav` / `playerSav`.
 */
type RemapCounts = {
  throwawayRemoved: number;
  hostCharacterKey: number;
  palOwnerKeys: number;
  ownerRefs: number;
  oldOwnerRefs: number;
  nickNameModifierRefs: number;
  palContainerSlots: number;
  guildHandles: number;
  guildAdmins: number;
  guildMembers: number;
  guildNameModifiers: number;
  guildMarkers: number;
  mapObjectBuilders: number;
  mapObjectLocks: number;
  deathDropOwners: number;
  undecodedEntries: number;
  blobFailures: number;
};

/** The layers `forEachIdentityBlob` counts; a subset of `RemapCounts`. */
type BlobCounts = Pick<
  RemapCounts,
  | "guildHandles"
  | "guildAdmins"
  | "guildMembers"
  | "guildNameModifiers"
  | "guildMarkers"
  | "mapObjectBuilders"
  | "mapObjectLocks"
  | "deathDropOwners"
>;

export type RemapOutput = {
  levelSav: Uint8Array;
  playerSav: Uint8Array;
  /** Per-layer report, in English. Same nature as a log; shown verbatim, not translated. */
  report: string[];
  oldGuid: string;
  newGuid: string;
};

type OozDecompress = (data: Uint8Array, rawSize: number) => Uint8Array;

/** Vendor reads GUID fields as UUID instances and accepts formatted strings on write; both sides follow migrate.js's usage. */
type GuidField = { value: unknown };

/**
 * Vendor is .js, so the `GvasFile` inferred for `parseLevel` / `parsePlayer` has no shape
 * for the property tree. These narrow it to the branches this file actually touches, cast
 * through `unknown` because the two genuinely do not overlap: the inferred result is a
 * class, and what is needed here is its runtime property bag.
 */
type ParsedPlayer = {
  player: {
    properties: { SaveData: { value: Record<string, GuidField> } };
    write: (cp: unknown) => Uint8Array;
  };
  /** Decompressed GVAS bytes. The Dimensional Pal Storage round-trip self-check uses it as the baseline; see remapSidecar. */
  gvas: Uint8Array;
  saveType: number;
};

/** Sidecar files (Dimensional Pal Storage) go through the same generic GVAS parse, but the root property is not necessarily SaveData. */
type ParsedSidecar = {
  player: { properties: Record<string, unknown>; write: (cp: unknown) => Uint8Array };
  gvas: Uint8Array;
  saveType: number;
};

type ParsedLevel = {
  level: {
    properties: { worldSaveData: { value: Record<string, { value?: unknown }> } };
    write: (cp: unknown) => Uint8Array;
  };
  saveType: number;
};

type CharEntry = {
  key: { PlayerUId: GuidField; InstanceId: GuidField };
  value: { RawData: { value: unknown } };
};

const guidOf = (f: GuidField | undefined | null): string | null =>
  f === undefined || f === null ? null : String(f.value);

/** A character-map entry's decoded SaveParameter; null when it could not be decoded (`RawData` fell back to raw bytes). */
function saveParamOf(entry: CharEntry): Record<string, GuidField | undefined> | null {
  const raw = entry.value.RawData.value as { object?: { SaveParameter?: { value?: unknown } } };
  if (!raw || typeof raw !== "object" || !("object" in raw)) return null;
  return (raw.object?.SaveParameter?.value ?? null) as Record<string, GuidField> | null;
}

/**
 * The bytes of a `RawData` may be a Uint8Array or a plain array, depending on whether it
 * was decoded.
 *
 * The Uint8Array branch is **returned as is, not copied**: vendor's `arrayValue` returns
 * `byteList(n).slice()` for ByteProperty (gvas.js), so that buffer is owned exclusively by
 * this tree, and patching it in place before writing back is fully equivalent to "copy,
 * patch, swap in". Copying is not cheap: `MapObjectSaveData` has tens to hundreds of
 * thousands of entries, and patch plus verify each walk it once, which would be two rounds
 * of tens of MB of short-lived allocations.
 */
function asBytes(values: unknown): Uint8Array | null {
  if (values instanceof Uint8Array) return values;
  if (Array.isArray(values)) return Uint8Array.from(values as number[]);
  return null;
}

type MutableRaw = { values: unknown };

/**
 * Re-point IDs referring to the host in Dimensional Pal Storage (`Players/<guid>_dps.sav`)
 * to the new ID.
 *
 * # Why renaming the file is not enough
 *
 * Upstream docs list it as "carried over as is, only the host's copy renamed", and we once
 * did exactly that. But the file **itself** stores ownership records: after the rename the
 * container inside still points at the old ID, while the success panel says Dimensional
 * Pal Storage was moved too. No layer reports it.
 *
 * # How it keeps itself safe
 *
 * `palworld-save-tools` has no decoder for `_dps`, so we have **no** existing backing for
 * "parse -> reserialise reproduces it byte for byte". Instead of trusting, prove it on the
 * spot:
 *
 *   1. parse, write back once **without any change**, and compare byte for byte with the
 *      decompressed original GVAS;
 *   2. mismatch -> our writer cannot reproduce this file, so **return it untouched, not one
 *      byte changed**;
 *   3. match -> the round trip is lossless, and only then is it meaningful to change those
 *      GUID fields.
 *
 * The comparison is on the decompressed GVAS, not the compressed container: compression
 * is not guaranteed to be bit-reproducible, and comparing that would never match.
 *
 * # What is changed
 *
 * Walk the decoded property tree recursively and replace **GUID objects whose value equals
 * the old ID** with the new ID. Only GUID objects count, not strings: changing a
 * StrProperty that happens to contain the ID would alter a variable-length field.
 * Undecoded `RawData` stays raw bytes and is written back as is.
 */
async function remapSidecar(
  bytes: Uint8Array,
  oldF: string,
  newF: string,
  ooz: OozDecompress,
): Promise<{ bytes: Uint8Array; changed: number; roundTripped: boolean }> {
  let parsed: ParsedSidecar;
  try {
    parsed = (await parsePlayer(bytes, ooz)) as unknown as ParsedSidecar;
  } catch {
    return { bytes, changed: 0, roundTripped: false };
  }

  const rewritten = parsed.player.write({});
  if (rewritten.length !== parsed.gvas.length || !sameAt(parsed.gvas, 0, rewritten)) {
    return { bytes, changed: 0, roundTripped: false };
  }

  let changed = 0;
  const seen = new Set<object>();
  /**
   * Recognise GUID objects **by type; never call `String()` on arbitrary objects**.
   *
   * That is both the rule above ("only GUID objects, not strings") and the only way this
   * runs at all: undecoded `RawData` is a Uint8Array, and `String(a 4 MB Uint8Array)`
   * expands it into a comma-separated list millions of characters long, just to compare it
   * with a 36-character ID and throw it away. Such blocks add up to roughly the file size in
   * Dimensional Pal Storage, so expanding each one costs O(file size) time and several times
   * that in transient string garbage; that kind of spike is exactly what gets the worker
   * killed on phones.
   */
  const isOldGuid = (v: unknown): boolean => v instanceof UUID && v.toString() === oldF;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (ArrayBuffer.isView(node)) return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item: unknown = node[i];
        if (isOldGuid(item)) {
          node[i] = newF;
          changed++;
        } else {
          walk(item);
        }
      }
      return;
    }

    const bag = node as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      const child: unknown = bag[key];
      if (isOldGuid(child)) {
        bag[key] = newF;
        changed++;
      } else {
        walk(child);
      }
    }
  };
  walk(parsed.player.properties);

  if (changed === 0) return { bytes, changed: 0, roundTripped: true };
  const out = await compressSav(parsed.player.write({}), parsed.saveType);
  return { bytes: out, changed, roundTripped: true };
}

/**
 * Re-bind every sidecar file belonging to the host. Keys are original file names; renaming
 * happens in the worker's migrate step, this only handles contents.
 */
export async function remapSidecars(
  extraFiles: Map<string, Uint8Array>,
  oldGuid32: string,
  newGuid32: string,
  ooz: OozDecompress,
): Promise<{ files: Map<string, Uint8Array>; changed: number; skipped: number }> {
  const oldF = formatGuid(oldGuid32) as string;
  const newF = formatGuid(newGuid32) as string;
  const upperOld = guid32(oldGuid32);

  const files = new Map<string, Uint8Array>();
  let changed = 0;
  let skipped = 0;
  for (const [name, data] of extraFiles) {
    // Only touch the host's own files. **Case-insensitive comparison**, for the same reason
    // as the rename in the worker.
    if (name.slice(0, upperOld.length).toUpperCase() !== upperOld) continue;
    const r = await remapSidecar(data, oldF, newF, ooz);
    if (!r.roundTripped) {
      skipped++;
      continue;
    }
    if (r.changed > 0) {
      files.set(name, r.bytes);
      changed += r.changed;
    }
  }
  return { files, changed, skipped };
}

/**
 * Walk every raw byte blob in a Level.sav that "stores player IDs at known offsets".
 *
 * **An unrecognised guild layout throws; an unrecognised map object is only counted.** A
 * guild holds the host's admin and membership; miss it and after joining, the palbox and
 * base no longer belong to them, while the output's self-check still passes. That is how
 * things broke silently once the 2026-07 update changed the guild layout. Missing the map
 * object sites (password-lock open records) only means typing a password again.
 */
function forEachIdentityBlob(
  wsd: Record<string, { value?: unknown }>,
  visit: (bytes: Uint8Array, offsets: number[]) => number,
  onFailure: () => void,
): BlobCounts {
  // Field names match the corresponding entries in `RemapCounts`, so the call site is one
  // Object.assign rather than lines of renaming. Two sets of names would have to be kept
  // in sync, and getting one line wrong only shows as one category stuck at 0 in the report.
  const out: BlobCounts = {
    guildHandles: 0,
    guildAdmins: 0,
    guildMembers: 0,
    guildNameModifiers: 0,
    guildMarkers: 0,
    mapObjectBuilders: 0,
    mapObjectLocks: 0,
    deathDropOwners: 0,
  };

  // ---- Guilds ----
  const groups = (wsd.GroupSaveDataMap?.value ?? []) as Array<{
    value: { GroupType: { value: { value: string } }; RawData: { value: MutableRaw } };
  }>;
  for (const grp of groups) {
    const raw = grp.value.RawData.value;
    if (!raw || !("values" in raw)) continue;
    const bytes = asBytes(raw.values);
    if (bytes === null) continue;
    const groupType = grp.value.GroupType.value.value;
    let at: GuildOffsets;
    try {
      at = guildIdentityOffsets(bytes, groupType);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`unrecognised ${groupType} layout (${bytes.length} bytes): ${why}`);
    }
    out.guildHandles += visit(bytes, at.handles);
    out.guildAdmins += visit(bytes, at.admin === null ? [] : [at.admin]);
    out.guildMembers += visit(bytes, at.members);
    out.guildNameModifiers += visit(bytes, at.nameModifier === null ? [] : [at.nameModifier]);
    out.guildMarkers += visit(bytes, at.markerOwners);
    raw.values = bytes;
  }

  // ---- Map objects: builders, and password locks on chests / fridges / display stands ----
  const mapObjects = (wsd.MapObjectSaveData?.value as { values?: unknown[] } | undefined)?.values ?? [];
  for (const mo of mapObjects as Array<Record<string, { value?: Record<string, unknown> }>>) {
    try {
      const modelRaw = (mo.Model?.value?.RawData as { value?: MutableRaw } | undefined)?.value;
      if (modelRaw && "values" in modelRaw) {
        const bytes = asBytes(modelRaw.values);
        if (bytes !== null && bytes.length >= MODEL_MIN_BYTES) {
          out.mapObjectBuilders += visit(bytes, [BUILD_PLAYER_UID_OFFSET]);
          modelRaw.values = bytes;
        }
      }

      // Characters dropped on death and death-drop chests: `ConcreteModel.RawData` carries
      // `owner_player_uid`. The offset depends on `MapObjectId`, and only these two classes
      // have one (see concreteOwnerOffset).
      const mapObjectId = (mo.MapObjectId as { value?: unknown } | undefined)?.value;
      const ownerAt = typeof mapObjectId === "string" ? concreteOwnerOffset(mapObjectId) : null;
      if (ownerAt !== null) {
        const concreteRaw = (mo.ConcreteModel?.value?.RawData as { value?: MutableRaw } | undefined)
          ?.value;
        if (concreteRaw && "values" in concreteRaw) {
          const bytes = asBytes(concreteRaw.values);
          if (bytes !== null && bytes.length >= ownerAt + 16) {
            out.deathDropOwners += visit(bytes, [ownerAt]);
            concreteRaw.values = bytes;
          }
        }
      }

      const modules = ((mo.ConcreteModel?.value?.ModuleMap as { value?: unknown } | undefined)?.value ??
        []) as Array<{ key: string; value: { RawData: { value: MutableRaw } } }>;
      for (const mod of modules) {
        if (!mod.key.endsWith("PasswordLock")) continue;
        const raw = mod.value.RawData.value;
        if (!raw || !("values" in raw)) continue;
        const bytes = asBytes(raw.values);
        if (bytes === null || bytes.length === 0) continue;
        out.mapObjectLocks += visit(bytes, passwordLockOffsets(bytes));
        raw.values = bytes;
      }
    } catch {
      onFailure();
    }
  }

  return out;
}

/**
 * Run one full ID replacement.
 *
 * The two GUID arguments decide the direction; the algorithm itself knows nothing about
 * direction: co-op -> dedicated passes `(...0001, the server-assigned ID)`, dedicated ->
 * co-op swaps the two.
 */
export async function remapHost(
  levelBytes: Uint8Array,
  oldPlayerBytes: Uint8Array,
  oldGuid32: string,
  newGuid32: string,
  ooz: OozDecompress,
): Promise<RemapOutput> {
  const report: string[] = [];
  const oldF = formatGuid(oldGuid32) as string;
  const newF = formatGuid(newGuid32) as string;
  if (oldF === newF) throw new Error("old and new IDs are identical");
  const oldB = (UUID.fromString(oldF) as { rawBytes: Uint8Array }).rawBytes;
  const newB = (UUID.fromString(newF) as { rawBytes: Uint8Array }).rawBytes;

  const counts: RemapCounts = {
    throwawayRemoved: 0,
    hostCharacterKey: 0,
    palOwnerKeys: 0,
    ownerRefs: 0,
    oldOwnerRefs: 0,
    nickNameModifierRefs: 0,
    palContainerSlots: 0,
    guildHandles: 0,
    guildAdmins: 0,
    guildMembers: 0,
    guildNameModifiers: 0,
    guildMarkers: 0,
    mapObjectBuilders: 0,
    mapObjectLocks: 0,
    deathDropOwners: 0,
    undecodedEntries: 0,
    blobFailures: 0,
  };

  // ---- Player file ----
  const parsedPlayer = (await parsePlayer(oldPlayerBytes, ooz)) as unknown as ParsedPlayer;
  const sd = parsedPlayer.player.properties.SaveData.value;
  if (guidOf(sd.PlayerUId) !== oldF) {
    throw new Error(`player file PlayerUId is ${String(sd.PlayerUId.value)}, expected ${oldF}`);
  }
  const individual = sd.IndividualId as unknown as {
    value: { PlayerUId: GuidField; InstanceId: GuidField };
  };
  sd.PlayerUId.value = newF;
  individual.value.PlayerUId.value = newF;
  const hostInstance = guidOf(individual.value.InstanceId);
  const playerSav = await compressSav(parsedPlayer.player.write({}), parsedPlayer.saveType);
  report.push(`[player] file re-keyed (host instance ${String(hostInstance)})`);

  // ---- World ----
  const parsedLevel = (await parseLevel(levelBytes, ooz)) as unknown as ParsedLevel;
  const wsd = parsedLevel.level.properties.worldSaveData.value;
  const charMapProp = wsd.CharacterSaveParameterMap as { value: CharEntry[] };

  // ---- A throwaway character already sits on the target ID (the host joined the server before): drop it entirely ----
  const before = charMapProp.value.length;
  charMapProp.value = charMapProp.value.filter((e) => guidOf(e.key.PlayerUId) !== newF);
  counts.throwawayRemoved = before - charMapProp.value.length;
  if (counts.throwawayRemoved > 0) {
    report.push(`[cleanup] throwaway entries on the target ID removed: ${counts.throwawayRemoved}`);
  }

  // ---- Character map: keys, and every ownership reference in SaveParameter ----
  for (const e of charMapProp.value) {
    if (guidOf(e.key.InstanceId) === hostInstance) {
      e.key.PlayerUId.value = newF;
      counts.hostCharacterKey++;
    } else if (guidOf(e.key.PlayerUId) === oldF) {
      // Pals are keyed by owner in the character map. **Change to the new ID, do not
      // zero**: zeroing is the "dedicated-server shape" and only holds in one direction,
      // while both directions share this code.
      e.key.PlayerUId.value = newF;
      counts.palOwnerKeys++;
    }

    const sp = saveParamOf(e);
    if (sp === null) {
      counts.undecodedEntries++;
      continue;
    }
    if (sp.OwnerPlayerUId && guidOf(sp.OwnerPlayerUId) === oldF) {
      sp.OwnerPlayerUId.value = newF;
      counts.ownerRefs++;
    }
    // Whoever last renamed the pal. Vendor does not touch this; leaving the old ID means a
    // reference to a player who does not exist on the server.
    if (sp.LastNickNameModifierPlayerUid && guidOf(sp.LastNickNameModifierPlayerUid) === oldF) {
      sp.LastNickNameModifierPlayerUid.value = newF;
      counts.nickNameModifierRefs++;
    }
    const old = sp.OldOwnerPlayerUIds as unknown as
      | { value?: { values?: unknown[] } }
      | undefined;
    const vals = old?.value?.values;
    if (Array.isArray(vals)) {
      for (let i = 0; i < vals.length; i++) {
        if (String(vals[i]) === oldF) {
          vals[i] = newF;
          counts.oldOwnerRefs++;
        }
      }
    }
  }
  report.push(
    `[characters] host key: ${counts.hostCharacterKey}, pal owner keys: ${counts.palOwnerKeys}, ` +
      `owners: ${counts.ownerRefs}, old owners: ${counts.oldOwnerRefs}, ` +
      `nickname modifiers: ${counts.nickNameModifierRefs}, undecoded: ${counts.undecodedEntries}`,
  );
  if (counts.hostCharacterKey !== 1) {
    throw new Error(`expected exactly 1 host character entry, got ${counts.hostCharacterKey}`);
  }
  if (counts.undecodedEntries > 0) {
    throw new Error("some character entries failed to decode; aborting");
  }

  // ---- Slots in party / palbox / base containers ----
  const containers = (wsd.CharacterContainerSaveData?.value ?? []) as Array<{
    value: { Slots?: { value?: { values?: Array<{ RawData?: { value?: unknown } }> } } };
  }>;
  for (const c of containers) {
    for (const s of c.value.Slots?.value?.values ?? []) {
      const rd = s.RawData?.value as { player_uid?: unknown } | undefined;
      if (rd && typeof rd === "object" && "player_uid" in rd && String(rd.player_uid) === oldF) {
        rd.player_uid = newF;
        counts.palContainerSlots++;
      }
    }
  }
  report.push(`[containers] slots re-pointed: ${counts.palContainerSlots}`);

  // ---- The raw-byte sites: guilds and map objects ----
  const patch = (bytes: Uint8Array, offsets: number[]): number => {
    let n = 0;
    for (const at of offsets) {
      if (sameAt(bytes, at, oldB)) {
        bytes.set(newB, at);
        n++;
      }
    }
    return n;
  };
  Object.assign(counts, forEachIdentityBlob(wsd, patch, () => counts.blobFailures++));
  report.push(
    `[guilds] handles: ${counts.guildHandles}, admins: ${counts.guildAdmins}, ` +
      `roster entries: ${counts.guildMembers}, name modifiers: ${counts.guildNameModifiers}, ` +
      `map markers: ${counts.guildMarkers}`,
  );
  report.push(
    `[structures] builder records: ${counts.mapObjectBuilders}, ` +
      `password-lock records: ${counts.mapObjectLocks}, ` +
      `death-drop owners: ${counts.deathDropOwners}, unreadable blobs: ${counts.blobFailures}`,
  );

  const levelSav = await compressSav(
    parsedLevel.level.write(LEVEL_CUSTOM_PROPERTIES),
    parsedLevel.saveType,
  );

  await verify(levelSav, playerSav, oldF, newF, oldB, hostInstance, ooz, report);

  return { levelSav, playerSav, report, oldGuid: oldGuid32, newGuid: newGuid32 };
}

/**
 * Parse the freshly written bytes again and assert, item by item, that the old ID is
 * really gone.
 *
 * **The assertions must change along with the algorithm.** Vendor's version asserts "the
 * new ID appears exactly once in the character map", an invariant of the normalising
 * algorithm. Under pure replacement the host and every one of their pals are keyed to the
 * new ID, so that assertion would fire on correct output. Here instead: the old ID no
 * longer appears in any category of field we touched, and the host's record really is on
 * the new ID.
 */
async function verify(
  levelSav: Uint8Array,
  playerSav: Uint8Array,
  oldF: string,
  newF: string,
  oldB: Uint8Array,
  hostInstance: string | null,
  ooz: OozDecompress,
  report: string[],
): Promise<void> {
  const { level } = (await parseLevel(levelSav, ooz)) as unknown as ParsedLevel;
  const wsd = level.properties.worldSaveData.value;

  let hostSeen = 0;
  for (const e of (wsd.CharacterSaveParameterMap as { value: CharEntry[] }).value) {
    if (guidOf(e.key.PlayerUId) === oldF) {
      throw new Error("verification failed: old ID still keyed in the character map");
    }
    if (guidOf(e.key.InstanceId) === hostInstance) {
      if (guidOf(e.key.PlayerUId) !== newF) {
        throw new Error("verification failed: host character not keyed to the new ID");
      }
      hostSeen++;
    }
    const sp = saveParamOf(e);
    if (sp === null) continue;
    for (const field of ["OwnerPlayerUId", "LastNickNameModifierPlayerUid"] as const) {
      if (sp[field] && guidOf(sp[field]) === oldF) {
        throw new Error(`verification failed: old ID remains in ${field}`);
      }
    }
    const vals = (sp.OldOwnerPlayerUIds as unknown as { value?: { values?: unknown[] } } | undefined)
      ?.value?.values;
    if (Array.isArray(vals) && vals.some((v) => String(v) === oldF)) {
      throw new Error("verification failed: old ID remains in OldOwnerPlayerUIds");
    }
  }
  if (hostSeen !== 1) {
    throw new Error(`verification failed: expected 1 host entry after writing, found ${hostSeen}`);
  }

  const containers = (wsd.CharacterContainerSaveData?.value ?? []) as Array<{
    value: { Slots?: { value?: { values?: Array<{ RawData?: { value?: unknown } }> } } };
  }>;
  for (const c of containers) {
    for (const s of c.value.Slots?.value?.values ?? []) {
      const rd = s.RawData?.value as { player_uid?: unknown } | undefined;
      if (rd && typeof rd === "object" && "player_uid" in rd && String(rd.player_uid) === oldF) {
        throw new Error("verification failed: old ID remains in a container slot");
      }
    }
  }

  // For the raw-byte sites, **only check the offsets we touched**; never search the whole
  // blob for the old ID. In the co-op direction the old ID is `...0001`, and that byte
  // pattern already appears in unrelated data, so a whole-blob search would always
  // false-positive.
  let leftovers = 0;
  forEachIdentityBlob(
    wsd,
    (bytes, offsets) => {
      for (const at of offsets) if (sameAt(bytes, at, oldB)) leftovers++;
      return 0;
    },
    () => {},
  );
  if (leftovers > 0) {
    throw new Error(`verification failed: old ID remains in ${leftovers} guild/structure records`);
  }

  const { player } = (await parsePlayer(playerSav, ooz)) as unknown as ParsedPlayer;
  if (guidOf(player.properties.SaveData.value.PlayerUId) !== newF) {
    throw new Error("verification failed: player file not on the new ID");
  }

  report.push("VERIFICATION PASSED");
}
