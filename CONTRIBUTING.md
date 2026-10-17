# Contributing

Issues and pull requests are welcome. Before opening one, run:

```sh
npm ci
npm run check   # type-check + scripts/check.mjs
npm run build
```

## Layout

| Path | What it is | Edit? |
| --- | --- | --- |
| `src/core/` | Folder handling, the ID remapping, Steam ID derivation, the worker | Yes |
| `src/app/` | The single-page UI | Yes |
| `src/vendor/` | Save parser and writer from zlmitchell/palworld-save-toolkit | **Never** |
| `public/ooz-wasm/` | Oodle decompressor from SnosMe/ooz-wasm | **Never** |
| `scripts/check.mjs` | Static checks run in CI | Yes |

## Never edit `src/vendor/` or `public/ooz-wasm/`

These files are byte-for-byte copies of upstream, and `npm run check` fails if they differ.
There are two reasons:

1. **Following upstream.** Every time Palworld changes its save format, community save
   tools break together. The way to catch up is to diff upstream's fix in. Once our copy
   has been edited or rewritten, that diff no longer applies and every update becomes a
   reimplementation.
2. **License notices.** THIRD_PARTY.md says these are unmodified copies of upstream at a
   pinned commit. Editing them would make that untrue.

To change behaviour, change `src/core/`. Missing map types for the GVAS parser go in
`src/core/type-hints.ts`, which adds keys to the vendor table at runtime without touching
the file.

## Following upstream

```sh
git clone https://github.com/zlmitchell/palworld-save-toolkit /tmp/pst
cd /tmp/pst && git log -1 --format=%H    # the commit you are syncing to

# Compare (only these five files and the ooz-wasm folder are used here)
diff -u src/vendor/gvas.js    /tmp/pst/docs/js/gvas.js
diff -u src/vendor/sav.js     /tmp/pst/docs/js/sav.js
diff -u src/vendor/migrate.js /tmp/pst/docs/js/migrate.js
diff -u src/vendor/paldata.js /tmp/pst/docs/js/paldata.js
diff -u src/vendor/zip.js     /tmp/pst/docs/js/zip.js
diff -ru public/ooz-wasm      /tmp/pst/docs/vendor/ooz-wasm
```

Then:

1. Copy the changed files over unmodified.
2. Write the new commit hash into `src/vendor/UPSTREAM-COMMIT`.
3. Update `UPSTREAM_COMMIT` and the `VENDOR_BLOBS` hashes in `scripts/check.mjs`
   (`git hash-object <file>` prints them, and they should match the upstream tree).
4. Run `npm run check` and `npm run build`. If check reports that upstream now registers
   one of our type hints, delete that entry from `src/core/type-hints.ts`.
5. Note the new commit in THIRD_PARTY.md.

`npm run check` proves types, offsets and file integrity, but **not that parsing is still
correct**. For that, run upstream's parity test against a real co-op world and a real
dedicated-server world (fixtures are not in either repository; bring your own):

```sh
node /tmp/pst/test/parity.test.mjs <coop-world> <server-world> <old-guid> <new-guid>
```

It checks two things nothing here can: that parse -> write reproduces the original
`Level.sav` byte for byte, and that the JavaScript migration matches upstream's Python
implementation byte for byte. After a format change it is the only evidence that things
still work.

## Signs of a format change

The conversion parses its own output again and verifies every layer it touched, throwing
if anything did not land. So a format change shows up as "Conversion failed" rather than as
a silently broken save. If conversions start failing after a Palworld update, check
upstream first.

## Code style

- Comments explain **why**, not what.
- No runtime dependencies, no analytics, and no network requests except loading the app's
  own static files. Save files must never leave the browser.
