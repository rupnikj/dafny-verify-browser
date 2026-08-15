// Unit test for the z3-st replay transport's instance reuse: a synthetic
// multi-exchange session (declare, assert, check, push, assert, check, pop,
// check, get-value) must produce the exact same delta sequence whether the
// instance is created fresh per exchange (recycleAfter: 0), reused for the
// whole session (recycleAfter: 500), or recycled mid-session
// (recycleAfter: 2). Any solver-state bleed across callMain re-entry would
// change the deltas.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZ3StTransport } from "../src/z3-st-transport.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(repoRoot, "../../z3-inline/dist"));
const require = createRequire(import.meta.url);
const createZ3 = require(join(z3StDir, "z3-st.js"));
const wasmBinary = readFileSync(join(z3StDir, "z3-st.wasm"));

const exchanges = [
  "(set-option :print-success false)\n(declare-const x Int)\n(assert (> x 5))",
  "(check-sat)",
  "(push 1)\n(assert (< x 3))\n(check-sat)",
  "(pop 1)\n(check-sat)",
  "(get-value (x))",
  "(push 1)\n(declare-const y Int)\n(assert (= y (* x 2)))\n(check-sat)",
  "(pop 1)\n(check-sat)"
];

async function runSession(recycleAfter) {
  const transport = createZ3StTransport({ createZ3, wasmBinary, recycleAfter });
  const deltas = [];
  for (const exchange of exchanges) {
    deltas.push(await transport.evaluate(1, exchange));
  }
  transport.close(1);
  return deltas;
}

const started = performance.now();
const fresh = await runSession(0);      // old behaviour: fresh instance per exchange
const freshMs = performance.now() - started;
const reusedStart = performance.now();
const reused = await runSession(500);   // new behaviour: one instance per session
const reusedMs = performance.now() - reusedStart;
const recycled = await runSession(2);   // recycle mid-session

assert.deepEqual(reused, fresh, "reused-instance deltas must match fresh-instance deltas");
assert.deepEqual(recycled, fresh, "mid-session recycle must not change deltas");

// Sanity on content: the check-sat sequence is sat, unsat, sat, sat, sat.
const answers = fresh.join("").split("\n").filter(line => line === "sat" || line === "unsat");
assert.deepEqual(answers, ["sat", "unsat", "sat", "sat", "sat"], "verdict sequence");
assert.match(fresh[4], /\(x /, "get-value returns a binding for x");

console.log(`z3-st transport: ${exchanges.length} exchanges — ` +
  `fresh ${freshMs.toFixed(0)} ms, reused ${reusedMs.toFixed(0)} ms ` +
  `(${(freshMs / reusedMs).toFixed(1)}x); recycle path consistent`);
console.log("z3-st transport reuse: ok");
process.exit(0);
