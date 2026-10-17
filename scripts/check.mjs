// Static checks for the parts of the conversion chain that can be decided without a real
// save: field offsets, Steam ID derivation, vendor integrity and license files.
//
// # What it guards
//
// The guild, build-record and password-lock blobs in a save are raw bytes that
// `src/vendor/paldata.js` **deliberately does not decode**. When rewriting player IDs we do
// not decode them either; we compute the offsets of the 16-byte fields from the field order
// and patch those 16 bytes in place (the reasoning is in the header of `src/core/remap.ts`).
//
// So a wrong offset is the worst kind of bug in this chain: the patch lands on a
// neighbouring field (a timestamp, part of a string), after-the-fact checks such as "the old
// ID is gone" still pass, and the output is broken somewhere else with no layer reporting it.
//
// # Why it can guard this without real saves
//
// Because this layer is pure byte arithmetic. The script **assembles synthetic blobs** in
// the field order of the upstream MIT decoders (`palworld_save_tools/rawdata/group.py`,
// `map_model.py`, `map_concrete_model_module.py`), plants sentinel IDs at known positions,
// and asserts that the computed offsets land exactly on the sentinels. If the field order
// changes or fstring reading goes wrong, this goes red immediately.
//
// What it cannot prove: that upstream's field order matches the current Palworld version.
// That needs real saves (see the parity test described in CONTRIBUTING.md).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_PLAYER_UID_OFFSET,
  concreteOwnerOffset,
  guildIdentityOffsets,
  LOCK_ENTRY_STRIDE,
  MODEL_MIN_BYTES,
  passwordLockOffsets,
  sameAt,
} from "../src/core/blob-offsets.ts";
import { cityHash64Short, isSteamId64, serverPlayerId } from "../src/core/player-id.ts";
import { VERIFIED_TYPE_HINTS } from "../src/core/type-hints.ts";
import { PALWORLD_TYPE_HINTS } from "../src/vendor/gvas.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const problems = [];

function report(where, message) {
  problems.push(`${where}: ${message}`);
}

const sameNums = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Assembles a blob byte by byte. Mirrors FWriter in `src/vendor/gvas.js` (little-endian, fstring with trailing NUL). */
class Builder {
  constructor() {
    this.parts = [];
    this.len = 0;
  }
  get pos() {
    return this.len;
  }
  raw(bytes) {
    this.parts.push(bytes);
    this.len += bytes.length;
    return this;
  }
  u8(v) {
    return this.raw(Uint8Array.of(v));
  }
  i32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return this.raw(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.raw(b);
  }
  i64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
    return this.raw(b);
  }
  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.raw(b);
  }
  guid(bytes) {
    return this.raw(bytes);
  }
  /** ASCII: the length includes the trailing NUL. */
  fstring(s) {
    if (s === "") return this.i32(0);
    this.i32(s.length + 1);
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return this.raw(b);
  }
  /** UTF-16: negative length, also including the trailing NUL (two bytes). */
  fstringWide(s) {
    this.i32(-(s.length + 1));
    const b = new Uint8Array((s.length + 1) * 2);
    const view = new DataView(b.buffer);
    for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
    return this.raw(b);
  }
  bytes() {
    const out = new Uint8Array(this.len);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** A sentinel GUID that is easy to recognise: 16 distinct bytes. */
function sentinel(tag) {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = (tag * 16 + i) & 0xff;
  return b;
}

const FILLER = new Uint8Array(16).fill(0xcc);

/**
 * Assemble a guild blob in group.py's field order, recording the real offset of every
 * player-ID field. `wide` sends strings down the UTF-16 branch: misreading a negative
 * fstring length is the most likely offset bug.
 *
 * The player-guild layout follows group.py in oMaN-Rod/palworld-save-tools as of
 * 2026-07-10; `tail` picks the new or old tail. For solo guilds, `independentBaseIds`
 * picks whether base_ids is present.
 */
function buildGuild({
  groupType,
  handleCount,
  memberCount = 0,
  markerCount = 0,
  tail = "2026",
  independentBaseIds = false,
  wide = false,
}) {
  const b = new Builder();
  const str = wide ? (s) => b.fstringWide(s) : (s) => b.fstring(s);
  const expect = { handles: [], admin: null, members: [], nameModifier: null, markerOwners: [] };
  /** offset -> the sentinel tag planted there. */
  const planted = new Map();
  let tag = 1;
  const plant = () => {
    planted.set(b.pos, tag);
    const at = b.pos;
    b.guid(sentinel(tag++));
    return at;
  };

  b.guid(FILLER); // group_id
  str("group name");

  b.u32(handleCount);
  for (let i = 0; i < handleCount; i++) {
    expect.handles.push(plant()); // handle owner
    b.guid(FILLER); // instance_id
  }

  if (groupType === "EPalGroupType::Organization") {
    b.u8(3); // org_type
    b.raw(new Uint8Array(12)); // trailing_bytes
  } else if (groupType === "EPalGroupType::Guild") {
    b.u8(0); // org_type
    b.raw(new Uint8Array(4)); // leading_bytes
    b.u32(2).guid(FILLER).guid(FILLER); // base_ids
    b.i32(0); // unknown_1
    b.i32(7); // base_camp_level
    b.u32(1).guid(FILLER); // base camp points
    str("guild name");
    expect.nameModifier = plant(); // last_guild_name_modifier_player_uid
    b.u32(markerCount);
    for (let i = 0; i < markerCount; i++) {
      b.guid(FILLER); // marker_id
      b.f64(1).f64(2).f64(3); // icon_location
      b.i32(5); // icon_type
      expect.markerOwners.push(plant()); // owner_player_uid
    }
    if (tail === "2026") {
      b.u32(2).u8(2).u8(3); // guild_chest_allowed_roles
      b.i32(0); // unknown_i32
    }
    expect.admin = plant(); // admin_player_uid
    b.u32(memberCount);
    for (let i = 0; i < memberCount; i++) {
      expect.members.push(plant()); // player_uid
      b.i64(1700000000 + i);
      str(`member ${i}`);
      if (tail === "2026") b.u8(1); // role
    }
    if (tail === "2026") {
      b.u32(2); // role_permissions
      b.u8(2).u32(3).u8(0).u8(3).u8(4);
      b.u8(4).u32(0);
    }
    b.raw(new Uint8Array(4)); // trailing_bytes
  } else if (groupType === "EPalGroupType::IndependentGuild") {
    b.u8(0); // org_type
    if (independentBaseIds) b.u32(1).guid(FILLER);
    b.i32(7); // base_camp_level
    b.u32(1).guid(FILLER); // base camp points
    str("guild name");
    expect.admin = plant(); // player_uid
    str("guild name 2");
    b.i64(1700000000);
    str("solo player");
  }

  return { bytes: b.bytes(), expect, planted };
}

function checkGuild(name, spec) {
  const { bytes, expect, planted } = buildGuild(spec);
  let got;
  try {
    got = guildIdentityOffsets(bytes, spec.groupType);
  } catch (e) {
    report(name, `threw while computing offsets: ${e.message}`);
    return;
  }
  for (const key of ["handles", "members", "markerOwners"]) {
    if (!sameNums(got[key], expect[key])) {
      report(name, `wrong ${key} offsets: got ${got[key]}, expected ${expect[key]}`);
    }
  }
  for (const key of ["admin", "nameModifier"]) {
    if (got[key] !== expect[key]) report(name, `wrong ${key} offset: got ${got[key]}, expected ${expect[key]}`);
  }
  // Whether an offset is right comes down to whether those 16 bytes are **the** sentinel
  // we planted there.
  //
  // Compare with the real sentinel, not with `bytes` sliced at that offset: the latter is
  // always equal and guards nothing.
  const all = [
    ...got.handles,
    ...got.members,
    ...got.markerOwners,
    ...[got.admin, got.nameModifier].filter((at) => at !== null),
  ];
  for (const at of all) {
    const tag = planted.get(at);
    if (tag === undefined || !sameAt(bytes, at, sentinel(tag))) {
      report(name, `offset ${at} is not a planted sentinel`);
    }
  }
  if (all.length !== planted.size) report(name, `planted ${planted.size} IDs but recognised only ${all.length}`);
}

checkGuild("Guild / ASCII", {
  groupType: "EPalGroupType::Guild",
  handleCount: 3,
  memberCount: 2,
  markerCount: 2,
});
checkGuild("Guild / UTF-16", {
  groupType: "EPalGroupType::Guild",
  handleCount: 2,
  memberCount: 3,
  wide: true,
});
checkGuild("Guild / no handles, empty roster", {
  groupType: "EPalGroupType::Guild",
  handleCount: 0,
  memberCount: 0,
});
checkGuild("Guild / pre-2026-07 tail", {
  groupType: "EPalGroupType::Guild",
  handleCount: 2,
  memberCount: 2,
  markerCount: 1,
  tail: "legacy",
});
checkGuild("IndependentGuild", {
  groupType: "EPalGroupType::IndependentGuild",
  handleCount: 2,
});
checkGuild("IndependentGuild / with base_ids", {
  groupType: "EPalGroupType::IndependentGuild",
  handleCount: 1,
  independentBaseIds: true,
});
checkGuild("Organization", {
  groupType: "EPalGroupType::Organization",
  handleCount: 2,
});

// ---- build_player_uid in Model.RawData must land at 200 ----
{
  const b = new Builder();
  b.guid(FILLER).guid(FILLER).guid(FILLER).guid(FILLER); // four instance/group ids = 64
  b.i32(100).i32(100); // hp = 8
  for (let i = 0; i < 4; i++) b.f64(0); // rotation quaternion = 32
  for (let i = 0; i < 3; i++) b.f64(0); // translation = 24
  for (let i = 0; i < 3; i++) b.f64(1); // scale3d = 24
  b.guid(FILLER); // repair_work_id
  b.guid(FILLER); // owner_spawner_level_object_instance_id
  b.guid(FILLER); // owner_instance_id
  const at = b.pos;
  b.guid(sentinel(9)); // build_player_uid
  b.u8(0); // interact_restrict_type
  b.guid(FILLER); // stage_instance_id_belong_to.id
  b.u32(1); // valid
  b.i64(1700000000); // created_at
  const bytes = b.bytes();

  if (at !== BUILD_PLAYER_UID_OFFSET) {
    report("map_model", `build_player_uid is actually at ${at}, the constant says ${BUILD_PLAYER_UID_OFFSET}`);
  }
  if (bytes.length < MODEL_MIN_BYTES) {
    report("map_model", `synthetic blob is only ${bytes.length} bytes, shorter than MODEL_MIN_BYTES=${MODEL_MIN_BYTES}`);
  }
  if (!sameAt(bytes, BUILD_PLAYER_UID_OFFSET, sentinel(9))) {
    report("map_model", `offset ${BUILD_PLAYER_UID_OFFSET} is not the planted sentinel`);
  }
}

// ---- owner_player_uid in ConcreteModel, by object class ----
//
// Only these two classes have one (the dozens of others in `map_concrete_model.py`'s branch
// table are either NO_OP or only have their own state fields). The shared prefix is
// instance_id(16) + model_instance_id(16) = 32.
for (const [id, extraBeforeOwner, label] of [
  ["droppedcharacter", 16, "character dropped on death (stored_parameter_id comes first)"],
  ["deathpenaltychest", 0, "death-drop chest (directly after the shared prefix)"],
]) {
  const b = new Builder();
  b.guid(FILLER); // instance_id
  b.guid(FILLER); // model_instance_id
  for (let i = 0; i < extraBeforeOwner; i += 16) b.guid(FILLER);
  const at = b.pos;
  b.guid(sentinel(30));
  b.i64(1700000000); // created_at / following fields
  const bytes = b.bytes();

  const got = concreteOwnerOffset(id);
  if (got !== at) report(`concreteOwner ${id}`, `${label}: got ${got}, actually at ${at}`);
  else if (!sameAt(bytes, got, sentinel(30))) {
    report(`concreteOwner ${id}`, `offset ${got} is not the planted sentinel`);
  }
}
if (concreteOwnerOffset("itemchest") !== null) {
  report("concreteOwner itemchest", "chests have no owner field in the upstream decoder and must not get an offset");
}
if (concreteOwnerOffset("DroppedCharacter") !== 48) {
  report("concreteOwner case", "MapObjectId comparison must be case-insensitive");
}

// ---- Password locks ----
// The entry stride is a premise of every expected offset below, independent of the cases,
// so it is checked once rather than three times inside the loop.
if (LOCK_ENTRY_STRIDE !== 24) {
  report("PasswordLock", `LOCK_ENTRY_STRIDE should be 24, is ${LOCK_ENTRY_STRIDE}`);
}
for (const [name, wide, count] of [
  ["PasswordLock / ASCII", false, 3],
  ["PasswordLock / UTF-16 password", true, 2],
  ["PasswordLock / empty list", false, 0],
]) {
  const b = new Builder();
  b.u8(1); // lock_state
  // A non-ASCII password exercises the UTF-16 branch.
  if (wide) b.fstringWide("étéü"); else b.fstring("secret");
  b.u32(count);
  const expect = [];
  for (let i = 0; i < count; i++) {
    expect.push(b.pos);
    b.guid(sentinel(20 + i));
    b.i32(0); // try_failed_count
    b.u32(1); // try_success_cache
  }
  const bytes = b.bytes();
  let got;
  try {
    got = passwordLockOffsets(bytes);
  } catch (e) {
    report(name, `threw while computing offsets: ${e.message}`);
    continue;
  }
  if (!sameNums(got, expect)) {
    report(name, `wrong offsets: got ${got}, expected ${expect}`);
  }
  for (let i = 0; i < expect.length; i++) {
    if (!sameAt(bytes, expect[i], sentinel(20 + i))) report(name, `entry ${i} is not the planted sentinel`);
  }
}

// ---- Garbage input must throw, not yield a plausible-looking offset ----
for (const [name, bytes, fn] of [
  ["truncated guild blob", new Uint8Array(8), (b) => guildIdentityOffsets(b, "EPalGroupType::Guild")],
  ["array count overflow", (() => {
    const b = new Builder();
    b.guid(FILLER).fstring("g").u32(0x7fffffff);
    return b.bytes();
  })(), (b) => guildIdentityOffsets(b, "EPalGroupType::Guild")],
  // Reading exactly to the end is the only criterion for recognising a layout: extra bytes
  // mean the layout changed again and must not count as recognised.
  ["guild blob with extra trailing bytes", (() => {
    const { bytes } = buildGuild({ groupType: "EPalGroupType::Guild", handleCount: 1, memberCount: 1 });
    const out = new Uint8Array(bytes.length + 2);
    out.set(bytes);
    return out;
  })(), (b) => guildIdentityOffsets(b, "EPalGroupType::Guild")],
  ["truncated password lock", Uint8Array.of(1, 5, 0, 0, 0), passwordLockOffsets],
]) {
  let threw = false;
  try {
    fn(bytes);
  } catch {
    threw = true;
  }
  if (!threw) report(name, "did not throw: garbage input was accepted as a valid blob");
}

// ---- The entries we add to the vendor type table ----
//
// `type-hints.ts` only adds keys upstream lacks. If, after following upstream, upstream
// registers the same key: if the type agrees, delete ours (keeping it is just another copy
// to maintain); if it disagrees, find out who is right first, because ours never took
// effect. This compares against the **raw upstream table**, so it re-reads vendor source
// without our patch applied.
{
  const vendorSrc = readFileSync(join(root, "src/vendor/gvas.js"), "utf8");
  for (const [path, type] of Object.entries(VERIFIED_TYPE_HINTS)) {
    const m = new RegExp(`"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*"([^"]+)"`).exec(vendorSrc);
    if (m) {
      report(
        "type-hints",
        m[1] === type
          ? `upstream now registers ${path}; delete that entry from src/core/type-hints.ts`
          : `upstream registers ${path} as ${m[1]}, which conflicts with our ${type}`,
      );
    }
    if (PALWORLD_TYPE_HINTS[path] !== type) report("type-hints", `${path} is not ${type} after patching`);
  }
}

// ---- Steam ID -> dedicated-server player ID ----
//
// This guards `src/core/player-id.ts`, the **only place in the chain that computes an ID
// out of thin air**. Get it wrong and the output passes every self-check, and the user only
// finds out in game that their character is still missing: the very symptom this tool
// fixes, only this time caused by us.
//
// The expected values below were **not produced by our own implementation** (that would
// prove nothing); they come from running a separate, independent implementation on the same
// inputs. Both follow the public CityHash reference and agree bit for bit on these inputs.
//
// All of CityHash's length branches are covered: the 33-64 byte branch is the only one a
// SteamID ever takes (the UTF-16 form of 17 digits is always 34 bytes), and the 4-7 byte
// branch pins `fetch32`'s sign handling: if the top byte is not joined separately, `|`
// turns the result negative.
const CITY_HASH_VECTORS = [
  [0, "9AE16A3B2F90404F"], [1, "4271B80E2915C76A"], [3, "373A2B2A12E0C581"],
  [4, "CC1E778137AE6D69"], [5, "23B0F79675BD1C16"], [7, "960838FBC6D9C975"],
  [8, "7D507025ED4EECFD"], [9, "DAEBBBB958304DDE"], [15, "834F200CFA7ED95F"],
  [16, "D836480326A974D6"], [17, "5CDED6CB65C9DAC6"], [24, "A71D9FC06B55102B"],
  [31, "52A467E87C92D522"], [32, "A03300E1B2BE6DA7"], [33, "6E14215D4C7200D4"],
  [34, "E8B9FC4774FC194C"], [40, "BAB6DCDB9C93066B"], [48, "17C28EBC25E42153"],
  [63, "C9FC77DEAD95C3AA"], [64, "2A7AB541551D3235"],
];

for (const [len, expected] of CITY_HASH_VECTORS) {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 37 + 11) & 0xff;
  let got;
  try {
    got = cityHash64Short(b).toString(16).toUpperCase();
  } catch (e) {
    report(`cityHash64 len=${len}`, `threw: ${e.message}`);
    continue;
  }
  if (got !== expected) report(`cityHash64 len=${len}`, `got ${got}, expected ${expected}`);
}

{
  let threw = false;
  try {
    cityHash64Short(new Uint8Array(65));
  } catch {
    threw = true;
  }
  if (!threw) report("cityHash64 len=65", "inputs over 64 bytes must throw instead of yielding a wrong value");
}

const PLAYER_ID_VECTORS = [
  ["76561197960287930", "3E22F785000000000000000000000000", "A69CC437000000000000000000000000"],
  ["76561198000000000", "A5D406B9000000000000000000000000", "5BAA177D000000000000000000000000"],
  ["76561199123456789", "FFF69F62000000000000000000000000", "CBFBC603000000000000000000000000"],
  ["76561198123456789", "C33EC480000000000000000000000000", "A653D3B4000000000000000000000000"],
  ["76561197960265729", "E490AF0D000000000000000000000000", "33E7B318000000000000000000000000"],
  ["76561198999999999", "9C87494F000000000000000000000000", "D350CE7B000000000000000000000000"],
  ["76561197970000001", "328F1C36000000000000000000000000", "53F362FD000000000000000000000000"],
];

for (const [steamId, steam, noSteam] of PLAYER_ID_VECTORS) {
  const gotSteam = serverPlayerId(steamId, false);
  const gotNoSteam = serverPlayerId(steamId, true);
  if (gotSteam !== steam) report(`serverPlayerId ${steamId}`, `got ${gotSteam}, expected ${steam}`);
  if (gotNoSteam !== noSteam) {
    report(`serverPlayerId ${steamId} (-nosteam)`, `got ${gotNoSteam}, expected ${noSteam}`);
  }
}

for (const bad of ["", "7656119796028793", "765611979602879301", "abcdefghijklmnopq", "12345678901234567"]) {
  let threw = false;
  try {
    serverPlayerId(bad);
  } catch {
    threw = true;
  }
  if (!threw) report(`serverPlayerId ${JSON.stringify(bad)}`, "not a valid SteamID64, must throw");
  if (isSteamId64(bad)) report(`isSteamId64 ${JSON.stringify(bad)}`, "must not be accepted as valid");
}

// ---- Vendor files are the upstream files, unmodified ----
//
// The repository's license notices and CONTRIBUTING.md rely on `src/vendor/` and
// `public/ooz-wasm/` being byte-identical copies of upstream at the pinned commit. These are
// git blob hashes (`git hash-object`) of the files in zlmitchell/palworld-save-toolkit at
// that commit (docs/js/ and docs/vendor/ooz-wasm/), so they can be compared with the
// upstream tree directly. When following upstream, update them together with
// src/vendor/UPSTREAM-COMMIT.
const UPSTREAM_COMMIT = "e71370ede118311e1a2b354caadb6d527ca9bcd2";
const VENDOR_BLOBS = {
  "src/vendor/gvas.js": "731635d85b9d770170ef18f848f2a9ce1b51a4b7",
  "src/vendor/migrate.js": "4b04173b570136030634df34122e729a2459a132",
  "src/vendor/paldata.js": "2a7eccd99a3afc45fad6df2dd4fc196c004153ce",
  "src/vendor/sav.js": "27bfb5316338f61db32091b18d20f19b135de9a7",
  "src/vendor/zip.js": "f0557668a74928ff6b942252c5bfc8b0b4a01a17",
  "src/vendor/LICENSE": "f288702d2fa16d3cdf0035b15a9fcbc552cd88e7",
  "public/ooz-wasm/index.js": "d5015fe3ed236f2b53f3ea7968cc40bb159bad8e",
  "public/ooz-wasm/build/ooz.js": "46d210aac4851a8adb7a5353eb1f295beef8515a",
  "public/ooz-wasm/LICENSE": "f288702d2fa16d3cdf0035b15a9fcbc552cd88e7",
};
const gitBlobHash = (buf) =>
  createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
{
  const pinned = join(root, "src/vendor/UPSTREAM-COMMIT");
  if (!existsSync(pinned) || readFileSync(pinned, "utf8").trim() !== UPSTREAM_COMMIT) {
    report("vendor", `src/vendor/UPSTREAM-COMMIT must contain ${UPSTREAM_COMMIT}; update VENDOR_BLOBS when following upstream`);
  }
  for (const [rel, expected] of Object.entries(VENDOR_BLOBS)) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      report("vendor", `${rel} is missing`);
      continue;
    }
    const got = gitBlobHash(readFileSync(file));
    if (got !== expected) {
      report("vendor", `${rel} differs from upstream (${got} != ${expected}); vendor files must not be edited`);
    }
  }
}

// ---- GPL-3.0 license texts ----
//
// Both upstreams are GPL-3.0, and shipping them to a visitor's browser is conveying in the
// GPL sense. The repository LICENSE and the two upstream copies must all be on disk and be
// the same text. They are identical today (both upstreams use the same GPL-3.0 full text).
// If one of them ever changes to a different variant, this goes red, and that is the moment
// to re-read the license notices in THIRD_PARTY.md, not an assertion to edit away.
{
  const licenses = ["LICENSE", "src/vendor/LICENSE", "public/ooz-wasm/LICENSE"];
  const missing = licenses.filter((f) => !existsSync(join(root, f)));
  for (const f of missing) {
    report("licenses", `${f} is missing; upstream license files must not be deleted`);
  }
  if (missing.length === 0) {
    const first = readFileSync(join(root, licenses[0]));
    for (const f of licenses.slice(1)) {
      if (!readFileSync(join(root, f)).equals(first)) {
        report("licenses", `${f} is no longer the same text as LICENSE; re-check the notices in THIRD_PARTY.md`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("check failed:\n");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  "check OK: guild / build record / password lock / death-drop owner offsets match the upstream layouts; " +
    `${CITY_HASH_VECTORS.length} CityHash length vectors and ${PLAYER_ID_VECTORS.length} Steam ID vectors agree; ` +
    "vendor files match upstream; license files present and identical; garbage input throws.",
);
