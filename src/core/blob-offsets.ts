/**
 * Where the player-ID fields sit inside the few **raw, undecoded byte blobs** in a save.
 *
 * It is a separate file so it can be verified on its own: no vendor import, no GVAS, no
 * real save needed, just byte arithmetic. `scripts/check.mjs` assembles synthetic blobs in
 * upstream's field order and asserts that each function below lands exactly on the IDs
 * planted in them.
 *
 * **A wrong offset is the worst kind of bug**: the patch lands on a neighbouring field (an
 * i64 timestamp, part of a string), the output still passes checks like "the old ID is
 * gone", and the damage is somewhere else. So this layer needs its own guard.
 *
 * The field order comes from the upstream MIT Python decoders
 * (`palworld_save_tools/rawdata/`): `group.py`, `map_model.py`,
 * `map_concrete_model_module.py`. The reading rules (little-endian; a negative fstring
 * length means UTF-16 and includes the trailing NUL) match `FReader` in
 * `../vendor/gvas.js` one for one.
 */

/** A byte cursor, enough to walk the guild and module blobs. `pos` can be rewound to try several layouts in turn. */
export class Cursor {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.length) throw new RangeError("blob ended early");
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** Skip a GUID and return its start offset: callers want the position, not the value. */
  guidAt(): number {
    const at = this.pos;
    this.skip(16);
    return at;
  }

  fstring(): void {
    const size = this.i32();
    if (size === 0) return;
    this.skip(size < 0 ? -size * 2 : size);
  }

  /**
   * Read an array's element count. `minStride` is the minimum bytes per element, used to
   * stop some other field read as a count of hundreds of millions; when a layout is wrong,
   * this is usually where it shows first.
   */
  count(minStride: number): number {
    const n = this.u32();
    if (n * minStride > this.bytes.length - this.pos) {
      throw new RangeError(`implausible array count ${n}`);
    }
    return n;
  }

  /** An array of fixed-size elements: returns each element's start offset. */
  tarrayFixed(stride: number): number[] {
    const n = this.count(stride);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.pos);
      this.skip(stride);
    }
    return out;
  }

  get atEnd(): boolean {
    return this.pos === this.bytes.length;
  }
}

export function sameAt(hay: Uint8Array, at: number, needle: Uint8Array): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let i = 0; i < needle.length; i++) if (hay[at + i] !== needle[i]) return false;
  return true;
}

export type GuildOffsets = {
  /** In each "this player holds this pal" handle, the owner in the first 16 bytes. */
  handles: number[];
  /** The `player_uid` of the guild admin (`EPalGroupType::Guild`) or of a solo guild. */
  admin: number | null;
  /** Each roster member's `player_uid`. */
  members: number[];
  /** Whoever last renamed the guild. All zeros if nobody has. */
  nameModifier: number | null;
  /** Who placed each guild map marker, one per marker. */
  markerOwners: number[];
};

/**
 * Each guild map marker (`FPalGuildMarkerData`) is 60 bytes: marker_id(16), icon_location
 * (three doubles, 24), icon_type(4), owner_player_uid(16).
 */
export const GUILD_MARKER_STRIDE = 60;
export const GUILD_MARKER_OWNER_OFFSET = 44;

/**
 * Every 16-byte "this is a player" field in a guild blob.
 *
 * Shared prefix: group_id, group_name, the handle array (each item `[uid(16), instance_id(16)]`).
 * **The first 16 bytes of a handle are the owner**: vendor's `migrate.js` layer 3 zeroes
 * it and we replace it instead, but it is the same field (vendor finds it by counting 16
 * bytes back from the pal instance id).
 *
 * After the prefix it branches by type. Player guilds and solo guilds **must read exactly
 * to the end of the blob** for the layout to count as recognised: the blob has no version
 * number, so after a format change an old layout still "reads through", just with every
 * offset shifted. That is how the host's admin and membership were once silently missed
 * after the 2026-07 game update. Landing exactly on the end is the only criterion that
 * separates "read correctly" from "happened not to overrun".
 *
 * NPC factions (`Organization`) and other types only use the handles from the prefix; the
 * rest holds no player IDs and is not read.
 */
export function guildIdentityOffsets(bytes: Uint8Array, groupType: string): GuildOffsets {
  const c = new Cursor(bytes);
  c.skip(16); // group_id
  c.fstring(); // group_name
  const handles = c.tarrayFixed(32); // individual_character_handle_ids

  const prefix = { handles, admin: null, members: [], nameModifier: null, markerOwners: [] };
  if (groupType === "EPalGroupType::Guild") return { ...prefix, ...guildBody(c) };
  if (groupType === "EPalGroupType::IndependentGuild") {
    return { ...prefix, admin: independentGuildAdmin(c) };
  }
  return prefix;
}

/**
 * Field order from `rawdata/group.py` in oMaN-Rod/palworld-save-tools as of 2026-07-10
 * (the original cheahjs repository is no longer maintained; this is the community MIT
 * decoder that kept up with 1.0), checked field by field against real 1.0 saves.
 */
function guildBody(c: Cursor): Omit<GuildOffsets, "handles"> {
  c.u8(); // org_type
  c.skip(4); // leading_bytes, meaning unknown
  c.tarrayFixed(16); // base_ids
  c.i32(); // unknown_1
  c.i32(); // base_camp_level
  c.tarrayFixed(16); // map_object_instance_ids_base_camp_points
  c.fstring(); // guild_name
  const nameModifier = c.guidAt(); // last_guild_name_modifier_player_uid
  const markerOwners = c
    .tarrayFixed(GUILD_MARKER_STRIDE)
    .map((at) => at + GUILD_MARKER_OWNER_OFFSET);

  // The tail exists in an old and a new version, again with no marker in the blob, so try
  // each and accept the one that reads exactly to the end. New first: the game rewrites
  // old saves in the new layout on load, so old-layout saves only become rarer.
  const tailAt = c.pos;
  for (const tail of [guildTail2026, guildTailLegacy]) {
    c.pos = tailAt;
    try {
      const found = tail(c);
      if (c.atEnd) return { ...found, nameModifier, markerOwners };
    } catch {
      // This version overran; try the next.
    }
  }
  throw new RangeError("guild blob matches no known layout");
}

/** After the 2026-07 update: guild chest permissions, member roles and the role permission table. */
function guildTail2026(c: Cursor): { admin: number; members: number[] } {
  c.tarrayFixed(1); // guild_chest_allowed_roles
  c.i32(); // unknown_i32
  const admin = c.guidAt(); // admin_player_uid
  const members: number[] = [];
  const memberCount = c.count(16 + 8 + 4 + 1);
  for (let i = 0; i < memberCount; i++) {
    members.push(c.guidAt()); // player_uid
    c.skip(8); // last_online_real_time
    c.fstring(); // player_name
    c.u8(); // role
  }
  const roleCount = c.count(1 + 4);
  for (let i = 0; i < roleCount; i++) {
    c.u8(); // role
    c.tarrayFixed(1); // permissions
  }
  c.skip(4); // trailing_bytes
  return { admin, members };
}

/** Before the 2026-07 update. */
function guildTailLegacy(c: Cursor): { admin: number; members: number[] } {
  const admin = c.guidAt(); // admin_player_uid
  const members: number[] = [];
  const memberCount = c.count(16 + 8 + 4);
  for (let i = 0; i < memberCount; i++) {
    members.push(c.guidAt()); // player_uid
    c.skip(8); // last_online_real_time
    c.fstring(); // player_name
  }
  c.skip(4); // trailing_bytes
  return { admin, members };
}

/**
 * Solo guild. The original cheahjs decoder reads base_ids before the base camp level; the
 * oMaN-Rod one does not, and we have no real save of this type to decide between them. So
 * try both and accept the one that reads exactly to the end.
 */
function independentGuildAdmin(c: Cursor): number {
  const startAt = c.pos;
  for (const withBaseIds of [false, true]) {
    c.pos = startAt;
    try {
      c.u8(); // org_type
      if (withBaseIds) c.tarrayFixed(16);
      c.i32(); // base_camp_level
      c.tarrayFixed(16); // map_object_instance_ids_base_camp_points
      c.fstring(); // guild_name
      const admin = c.guidAt(); // player_uid
      c.fstring(); // guild_name_2
      c.skip(8); // last_online_real_time
      c.fstring(); // player_name
      if (c.atEnd) return admin;
    } catch {
      // This version overran; try the next.
    }
  }
  throw new RangeError("independent guild blob matches no known layout");
}

/**
 * Offset of `build_player_uid` in a map object's `Model.RawData`: "who built this wall,
 * this chest".
 *
 * Summing `map_model.py`'s field order: four GUIDs (64) + two hp i32s (8) + FTransform
 * (a quaternion of 4 doubles + two vectors of 3 doubles = 80) + repair_work_id (16)
 * + owner_spawner_level_object_instance_id (16) + owner_instance_id (16) = 200.
 */
export const BUILD_PLAYER_UID_OFFSET = 200;

/** A Model blob shorter than this is a layout we have not seen; leave it alone. Better to change too little than to write in the wrong place. */
export const MODEL_MIN_BYTES = BUILD_PLAYER_UID_OFFSET + 16;

/** Each password-lock record: `[player_uid(16), try_failed_count(4), try_success_cache(4)]`. */
export const LOCK_ENTRY_STRIDE = 24;

/**
 * Offset of `owner_player_uid` in `ConcreteModel.RawData`, by `MapObjectId`.
 *
 * In `map_concrete_model.py`'s per-object-class table, **only these two classes carry a
 * player ID**:
 *
 *   - `droppedcharacter` (a character dropped on death): shared prefix instance_id(16) +
 *     model_instance_id(16) = 32, plus `stored_parameter_id`(16) = 48;
 *   - `deathpenaltychest` (death-drop chest): it comes right after the shared prefix, = 32.
 *
 * The dozens of others (chests, shelves, signs, eggs...) are either NO_OP in that decoder
 * or only have their own state fields, no owner. Similar tools patch a few more places;
 * those are not in any public decoder, and we **do not follow**: writing 16 bytes at an
 * offset that is only a guess, if wrong, breaks thousands of chests at once with no layer
 * reporting it. To follow them, first prove those offsets against real saves.
 */
// A Map rather than an object literal: `mapObjectId` comes straight from save bytes, and
// an object literal inherits Object.prototype. An object class called `constructor` would
// get the prototype's function, `?? null` would not catch it (it is not null), and it would
// then be used as an offset to write 16 bytes. `Map.get` only sees its own keys.
const CONCRETE_OWNER_OFFSETS = new Map<string, number>([
  ["droppedcharacter", 48],
  ["deathpenaltychest", 32],
]);

/** `MapObjectId` is case-insensitive (upstream's table keys are all lowercase). Returns null for classes without an owner field. */
export function concreteOwnerOffset(mapObjectId: string): number | null {
  return CONCRETE_OWNER_OFFSETS.get(mapObjectId.toLowerCase()) ?? null;
}

/**
 * Offsets of each `player_uid` in a password-lock module: "who has opened this lock" on a
 * chest / fridge / display stand.
 *
 * The PasswordLock branch of `map_concrete_model_module.py`: lock_state(byte),
 * password(fstring), player_infos(tarray).
 */
export function passwordLockOffsets(bytes: Uint8Array): number[] {
  const c = new Cursor(bytes);
  c.u8(); // lock_state
  c.fstring(); // password
  return c.tarrayFixed(LOCK_ENTRY_STRIDE);
}
