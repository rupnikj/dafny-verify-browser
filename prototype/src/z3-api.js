// z3-solver/browser is CommonJS. Bundle just its small JavaScript API layer;
// z3-built.js and z3-built.wasm remain standalone so Emscripten can create its
// own pthread workers correctly.
export { init } from "z3-solver";
