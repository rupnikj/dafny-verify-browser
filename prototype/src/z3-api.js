// z3-solver 4.16's browser-facing init() takes NO options — it calls the
// global emscripten factory bare, which makes the pthread build resolve its
// wasm against the page root (a 404 on any non-root deployment) and ignores
// wasmBinary. This wrapper drives the low-level init directly, binding our
// Module config around the global initZ3 that z3-built.js (loaded as a
// classic script) defines. Only the low-level Z3 API surface is exposed —
// all this project uses.
import { init as lowLevelInit } from "z3-solver/build/low-level/index.js";

export async function init(moduleConfig = {}) {
  const initZ3 = globalThis.initZ3;
  if (typeof initZ3 !== "function") {
    throw new Error("z3-built.js must be loaded (importScripts) before init().");
  }
  return lowLevelInit(() => initZ3({ ...moduleConfig }));
}
