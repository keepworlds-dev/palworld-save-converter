/**
 * Work out, from a Steam account, the player ID a dedicated server will assign to it.
 *
 * # This saves an entire step
 *
 * Without it the user must "start the server, join once with that account, create a
 * throwaway character, then find the new file name in Players/". For someone who has not
 * even decided to get a server yet, that step is where the flow ends.
 *
 * # Algorithm
 *
 * The server does not hand out random IDs; they are **derived from the Steam ID** using
 * Unreal Engine's string hashing:
 *
 *   1. take the SteamID64's **decimal string** as UTF-16LE bytes (17 digits -> 34 bytes);
 *   2. CityHash64 those bytes;
 *   3. fold to 32 bits as UE's `GetTypeHash(uint64)` does: `(uint32)h + 23 * (uint32)(h >> 32)`;
 *   4. write those 32 bits as 8 uppercase hex digits followed by 24 zeros; that is the
 *      name of `Players/<id>.sav`.
 *
 * Servers that skip Steam authentication (`-nosteam`) run one extra round of Bob Jenkins'
 * avalanche mix after step 3; that is the `noSteam: true` branch here.
 *
 * # Sources, and why no single one is trusted
 *
 * The most widespread claim is "the player ID is the low 32 bits of the SteamID64"; that
 * was the **old** behaviour. The upstream docs we vendor go to the other extreme and say
 * "since 1.0 it can't be derived at all". Both are out of date. CityHash is Google's MIT
 * implementation (constants and branch structure follow the public reference), the UE
 * fold is a one-line formula from the engine, and the Jenkins mix is public domain.
 *
 * `scripts/check.mjs` pins the outputs for a set of fixed inputs. **Those expected values
 * were not computed by this implementation**; they come from running a separate,
 * independent implementation on the same inputs. Testing an implementation against values
 * it produced itself proves nothing.
 *
 * # What it cannot prove
 *
 * If Palworld changes the derivation again, this will quietly produce an ID that does not
 * match, and the output will look perfectly fine, which is the very bug this tool exists
 * to fix. So the UI **must keep a way to cross-check** on this path: let the user compare
 * against the real file name in the server's Players/.
 */

const MASK64 = (1n << 64n) - 1n;

// CityHash constants, from the reference implementation. The reference also has
// `kMul = 0x9ddfea08eb382d69`, used only as `HashLen16`'s default argument; every branch up
// to 64 bytes passes mul explicitly, so it is not needed here.
const K0 = 0xc3a5c85c97cb3127n;
const K1 = 0xb492b66fbe98f273n;
const K2 = 0x9ae16a3b2f90404fn;

const mul64 = (a: bigint, b: bigint): bigint => (a * b) & MASK64;
const add64 = (a: bigint, b: bigint): bigint => (a + b) & MASK64;
const rot64 = (v: bigint, s: number): bigint =>
  s === 0 ? v : ((v >> BigInt(s)) | (v << BigInt(64 - s))) & MASK64;
const shiftMix = (v: bigint): bigint => v ^ (v >> 47n);

function fetch64(b: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]);
  return v;
}

/**
 * The top byte is joined separately, **not in the same `|`**: `b[3] << 24` pushes the
 * result into the int32 sign bit, so after `|` it is negative and `BigInt()` of it is
 * negative too.
 */
function fetch32(b: Uint8Array, at: number): bigint {
  return BigInt(b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) | (BigInt(b[at + 3]) << 24n);
}

/** 64-bit byte swap. CityHash 1.1's 33-64 byte branch uses it to stir intermediate values. */
function bswap64(v: bigint): bigint {
  let out = 0n;
  let x = v;
  for (let i = 0; i < 8; i++) {
    out = (out << 8n) | (x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** CityHash's Hash128to64. Every finalisation inside CityHash64 goes through it. */
function hashLen16(u: bigint, v: bigint, mul: bigint): bigint {
  let a = mul64(u ^ v, mul);
  a ^= a >> 47n;
  let b = mul64(v ^ a, mul);
  b ^= b >> 47n;
  return mul64(b, mul);
}

function hashLen0to16(s: Uint8Array, len: number): bigint {
  if (len >= 8) {
    const mul = add64(K2, BigInt(len * 2));
    const a = add64(fetch64(s, 0), K2);
    const b = fetch64(s, len - 8);
    const c = add64(mul64(rot64(b, 37), mul), a);
    const d = mul64(add64(rot64(a, 25), b), mul);
    return hashLen16(c, d, mul);
  }
  if (len >= 4) {
    const mul = add64(K2, BigInt(len * 2));
    const a = fetch32(s, 0);
    return hashLen16(add64(BigInt(len), (a << 3n) & MASK64), fetch32(s, len - 4), mul);
  }
  if (len > 0) {
    const a = BigInt(s[0]);
    const b = BigInt(s[len >> 1]);
    const c = BigInt(s[len - 1]);
    const y = (a + (b << 8n)) & 0xffffffffn;
    const z = (BigInt(len) + (c << 2n)) & 0xffffffffn;
    return mul64(shiftMix(mul64(y, K2) ^ mul64(z, K0)), K2);
  }
  return K2;
}

function hashLen17to32(s: Uint8Array, len: number): bigint {
  const mul = add64(K2, BigInt(len * 2));
  const a = mul64(fetch64(s, 0), K1);
  const b = fetch64(s, 8);
  const c = mul64(fetch64(s, len - 8), mul);
  const d = mul64(fetch64(s, len - 16), K2);
  return hashLen16(
    add64(add64(rot64(add64(a, b), 43), rot64(c, 30)), d),
    add64(add64(a, rot64(add64(b, K2), 18)), c),
    mul,
  );
}

/**
 * **The CityHash 1.1 version**, not 1.0.x.
 *
 * The two versions differ in the 33-64 byte branch (1.1 adds `*9`, `+1`, two `bswap64`s
 * and a 42-bit rotation), and the UTF-16 form of 17 digits is always 34 bytes, so **this
 * is the only branch that ever runs**. Writing the old version gives an ID that looks
 * perfectly plausible yet matches no server, while the output passes every self-check.
 */
function hashLen33to64(s: Uint8Array, len: number): bigint {
  const mul = add64(K2, BigInt(len * 2));
  const a0 = mul64(fetch64(s, 0), K2);
  const b0 = fetch64(s, 8);
  const c = fetch64(s, len - 24);
  const d = fetch64(s, len - 32);
  const e = mul64(fetch64(s, 16), K2);
  const f = mul64(fetch64(s, 24), 9n);
  const g = fetch64(s, len - 8);
  const h = mul64(fetch64(s, len - 16), mul);

  const u = add64(rot64(add64(a0, g), 43), mul64(add64(rot64(b0, 30), c), 9n));
  const v = add64(add64(add64(a0, g) ^ d, f), 1n);
  const w = add64(bswap64(mul64(add64(u, v), mul)), h);
  const x = add64(rot64(add64(e, f), 42), c);
  const y = mul64(add64(bswap64(mul64(add64(v, w), mul)), g), mul);
  const z = add64(add64(e, f), c);

  const a = add64(bswap64(add64(mul64(add64(x, z), mul), y)), b0);
  const b = mul64(shiftMix(add64(add64(mul64(add64(z, a), mul), d), h)), mul);
  return add64(b, x);
}

/**
 * CityHash64, **implemented only up to 64 bytes**.
 *
 * That is enough: the only input here is the UTF-16 form of 17 digits, always 34 bytes.
 * The long-input branch is another hundred-odd lines of loop; adding it would only add code
 * nobody runs and nothing here can verify, so longer input throws.
 */
export function cityHash64Short(s: Uint8Array): bigint {
  const len = s.length;
  if (len <= 16) return hashLen0to16(s, len);
  if (len <= 32) return hashLen17to32(s, len);
  if (len <= 64) return hashLen33to64(s, len);
  throw new RangeError("cityHash64Short: only inputs up to 64 bytes are implemented");
}

/** UE's `GetTypeHash(uint64)`: the low 32 bits plus 23 times the high 32 bits. */
export function ueTypeHash64(h: bigint): number {
  const lo = Number(h & 0xffffffffn);
  const hi = Number((h >> 32n) & 0xffffffffn);
  return (lo + 23 * hi) >>> 0;
}

/**
 * Bob Jenkins' 32-bit avalanche mix; the `-nosteam` branch runs it once more after folding.
 *
 * `0x9e3779b9` is the golden-ratio constant. Every step does an explicit `>>> 0`: JS shifts
 * operate on int32, and without bringing results back to unsigned, negatives propagate.
 */
export function jenkinsAvalanche(seed: number): number {
  const u = (x: number): number => x >>> 0;
  const t = u(seed);
  const r = u(u(t << 8) ^ u(0x9e3779b9 - t));
  const i = u((r >>> 13) ^ u(-(t + r)));
  const a = u((i >>> 12) ^ u(t - r - i));
  const o = u(u(a << 16) ^ u(r - a - i));
  const s = u((o >>> 5) ^ u(i - o - a));
  const c = u((s >>> 3) ^ u(a - o - s));
  const l = u(u(c << 10) ^ u(o - c - s));
  return u((l >>> 15) ^ u(s - l - c));
}

/** Spread a 32-bit hash into a Palworld player ID: 8 uppercase hex digits + 24 zeros. */
export function playerIdFromHash(h32: number): string {
  return h32.toString(16).toUpperCase().padStart(8, "0") + "0".repeat(24);
}

/** 17 digits starting with 7656. Other shapes (vanity names, profile links) must be turned into a SteamID64 first. */
export const STEAM_ID64_PATTERN = /^7656\d{13}$/;

export function isSteamId64(input: string): boolean {
  return STEAM_ID64_PATTERN.test(input.trim());
}

/**
 * Pick a SteamID64 out of whatever the user pasted. Accepts plain digits, and profile
 * links such as `https://steamcommunity.com/profiles/7656...`; **pure string matching, no
 * network**.
 *
 * Vanity links (`/id/some-name`) cannot be recognised: turning them into a SteamID64 needs
 * a Steam API call, and this page promises not to send a single request. Returns null in
 * that case, and the UI tells the user where to find the numeric ID.
 */
export function extractSteamId64(input: string): string | null {
  const m = /7656\d{13}/.exec(input);
  if (m === null) return null;
  // The match must not be directly next to more digits, or it was cut out of a longer number.
  const at = m.index;
  const before = at > 0 ? input[at - 1] : "";
  const after = at + 17 < input.length ? input[at + 17] : "";
  if (/\d/.test(before) || /\d/.test(after)) return null;
  return m[0];
}

/**
 * Recognise the Steam account a save belongs to from the world directory's path.
 *
 * Co-op worlds live under `SaveGames/<SteamID64>/<world>/`, and that directory name is the
 * Steam account that played on this PC. Co-op worlds only exist on the host's own PC, so
 * that is the host. When the user picked the whole SaveGames or that level, the path
 * contains it; when they picked only the world directory or loose files, it does not and
 * this returns null.
 *
 * Only a **whole** directory segment counts, never a substring: some other directory name
 * that happens to contain a run of digits starting with 7656 must not match.
 */
export function steamIdFromWorldDir(dir: string): string | null {
  const segments = dir.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (STEAM_ID64_PATTERN.test(segments[i])) return segments[i];
  }
  return null;
}

/**
 * SteamID64 -> dedicated-server player ID.
 *
 * @param steamId64 17-digit decimal string.
 * @param noSteam   true when the server starts with `-nosteam` (no Steam authentication).
 */
export function serverPlayerId(steamId64: string, noSteam = false): string {
  const id = steamId64.trim();
  if (!STEAM_ID64_PATTERN.test(id)) {
    throw new RangeError("expected a 17-digit SteamID64 starting with 7656");
  }
  // UTF-16LE: that is the width of UE's TCHAR, and the hash consumes these bytes, not ASCII.
  const utf16 = new Uint8Array(id.length * 2);
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    utf16[i * 2] = code & 0xff;
    utf16[i * 2 + 1] = code >> 8;
  }
  const folded = ueTypeHash64(cityHash64Short(utf16));
  return playerIdFromHash(noSteam ? jenkinsAvalanche(folded) : folded);
}
