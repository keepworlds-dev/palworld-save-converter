# Third-party code and licenses

This project is distributed under the GNU General Public License version 3 (see
[LICENSE](LICENSE)). It includes, unmodified, code from the projects below. Their original
license files are kept next to the code.

## Included verbatim

### zlmitchell/palworld-save-toolkit

- Repository: https://github.com/zlmitchell/palworld-save-toolkit
- Pinned commit: `e71370ede118311e1a2b354caadb6d527ca9bcd2` (also recorded in
  [`src/vendor/UPSTREAM-COMMIT`](src/vendor/UPSTREAM-COMMIT))
- Files: `src/vendor/gvas.js`, `sav.js`, `migrate.js`, `paldata.js`, `zip.js`, copied from
  `docs/js/` at that commit without any change
- License: GPL-3.0 ([`src/vendor/LICENSE`](src/vendor/LICENSE)). The upstream README
  states "Licensed GPL-3.0" without saying "or later", so we treat it as GPL-3.0-only.

`scripts/check.mjs` verifies on every CI run that these files are byte-identical to the
upstream tree at the pinned commit (by git blob hash).

According to their own headers and the upstream README, these files are ports of, or based
on, the following MIT-licensed projects:

- [cheahjs/palworld-save-tools](https://github.com/cheahjs/palworld-save-tools) (GVAS
  reader/writer, `.sav` container codec, custom property parsers)
- [quadrantbs/palworld-hostfix-toolkit](https://github.com/quadrantbs/palworld-hostfix-toolkit)
  (the four-layer host fix procedure, Palworld 1.0 parsers and `PlM` handling)

Their MIT notices are reproduced at the end of this file.

### SnosMe/ooz-wasm

- Repository: https://github.com/SnosMe/ooz-wasm (WebAssembly build of
  [powzix/ooz](https://github.com/powzix/ooz), an open-source Oodle Kraken decompressor)
- Files: `public/ooz-wasm/index.js` and `public/ooz-wasm/build/ooz.js`, as vendored by
  palworld-save-toolkit at the commit above (`docs/vendor/ooz-wasm/`). They are
  byte-identical to the `ooz-wasm@2.0.0` package on npm.
- License: GPL-3.0-or-later (`"license"` in its `package.json`; the C++ sources carry
  powzix's "version 3 of the License, or (at your option) any later version" notice).
  License text: [`public/ooz-wasm/LICENSE`](public/ooz-wasm/LICENSE).
- Corresponding source: `build/ooz.js` is an Emscripten build with the WebAssembly module
  embedded as base64 (`-s SINGLE_FILE=1`). Its complete source, the C++ decompressor in
  `lib/` plus `CMakeLists.txt` with every compiler and linker flag, is in the
  SnosMe/ooz-wasm repository; the 2.0.0 release was published from its `v2.0` commit,
  [`ebed82851988add824e092dc4db320c8fa39aaca`](https://github.com/SnosMe/ooz-wasm/tree/ebed82851988add824e092dc4db320c8fa39aaca).
  To rebuild it, install the Emscripten SDK and run:

  ```sh
  emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release
  cmake --build build
  ```

## Referenced, not copied

The field layouts used by [`src/core/blob-offsets.ts`](src/core/blob-offsets.ts) (guild,
map object and password lock blobs) and the extra map types in
[`src/core/type-hints.ts`](src/core/type-hints.ts) follow the Python decoders in
[cheahjs/palworld-save-tools](https://github.com/cheahjs/palworld-save-tools) and its
1.0-era fork [oMaN-Rod/palworld-save-tools](https://github.com/oMaN-Rod/palworld-save-tools)
(both MIT): `rawdata/group.py`, `map_model.py`, `map_concrete_model.py`,
`map_concrete_model_module.py` and `paltypes.py`. Only the field order was used; no code
was copied.

## CityHash

[`src/core/player-id.ts`](src/core/player-id.ts) contains an independent TypeScript
implementation of CityHash64 (version 1.1, inputs up to 64 bytes) written from Google's
public reference implementation (MIT). It uses the reference constants and branch
structure; no code was copied. The Bob Jenkins avalanche mix in the same file is public
domain.

## MIT notices

palworld-save-tools:

```text
MIT License

Copyright (c) 2024 Jun Siang Cheah
```

palworld-hostfix-toolkit:

```text
MIT License

Copyright (c) 2026
```

Both are followed by the standard MIT permission notice:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Palworld is a trademark of Pocketpair, Inc. This project is not affiliated with or
endorsed by Pocketpair.
