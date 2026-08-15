// Equivalence: same synthetic session through both transports (incremental
// C API vs CLI replay), deltas must match exchange by exchange.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZ3ApiTransport } from "../src/z3-api-transport.js";
import { createZ3StTransport } from "../src/z3-st-transport.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(repoRoot, "../../z3-inline/dist"));
const require = createRequire(import.meta.url);
const createZ3 = require(join(z3StDir, "z3-st.js"));
const wasmBinary = readFileSync(join(z3StDir, "z3-st.wasm"));

const SESSION = [
  "(set-option :produce-models true)",
  "(declare-const x Int)",
  "(declare-const y Int)",
  "(assert (> x 0))",
  "(check-sat)",
  "(push)",
  "(assert (< x 0))",
  "(check-sat)",
  "(pop)",
  "(assert (= y (+ x 10)))",
  "(check-sat)",
  "(get-value (x y))",
  "(push)",
  "(assert (= x 3))",
  "(check-sat)",
  "(get-value (x y))",
  "(pop)",
  "(check-sat)",
  // error handling must be byte-identical too: this is the gap that let a
  // throwing transport pass the original equivalence test and then abort
  // ch10 after 18 of 411 obligations.
  "(assert (bogus))",
  "(check-sat)",
  "(set-option :nonexistent-thing true)",
  "(declare-const z Int)",
  "(assert (= z 5))",
  "(check-sat)",
  "(get-value (z))"
];

const z3 = await createZ3({ wasmBinary, noInitialRun: true, print(){}, printErr(){} });
const api = createZ3ApiTransport({ z3, timeoutMs: 10000 });
const replay = createZ3StTransport({ createZ3, wasmBinary, softTimeoutMs: 10000 });

// Error positions legitimately differ: the API sees each exchange as its own
// line 1, while replay counts into the accumulated script. Compare the
// semantic text, not the coordinates.
const norm = s => s.trim().split(/\s+/).join(" ")
  .replace(/line \d+ column \d+/g, "line L column C");
let mismatches = 0;
for (const [i, command] of SESSION.entries()) {
  const a = norm(await api.evaluate("s", command));
  const b = norm(await replay.evaluate("s", command));
  if (a !== b) { mismatches++; console.log(`MISMATCH ${i} ${command}\n  api:    ${JSON.stringify(a)}\n  replay: ${JSON.stringify(b)}`); }
}
api.close("s"); replay.close("s");
console.log(mismatches === 0 ? `all ${SESSION.length} exchanges identical` : `${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
