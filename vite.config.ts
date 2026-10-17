import { defineConfig } from "vite";

export default defineConfig({
  // Must stay absolute (e.g. "/palworld-save-converter/" for a sub-path deploy): the worker
  // loads the Oodle decompressor from `${BASE_URL}ooz-wasm/index.js` resolved against the
  // site origin, so a relative base ("./") would point at the wrong place.
  base: "/",
  worker: {
    // The worker imports the decompressor dynamically; IIFE workers cannot code-split.
    format: "es",
  },
  build: {
    target: "es2022",
  },
});
