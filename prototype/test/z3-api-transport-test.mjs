// Unit + quadratic-regression test for the incremental C-API transport
// (z3-inline >= v0.2.0). Point Z3_ST_DIR at a v0.2.0 dist.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZ3ApiTransport } from "../src/z3-api-transport.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(repoRoot, "../../z3-inline/dist"));
const require = createRequire(import.meta.url);
const createZ3 = require(join(z3StDir, "z3-st.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : (fail++, console.log("FAIL", name, extra ?? "")); };

const z3 = await createZ3({ wasmBinary: readFileSync(join(z3StDir, "z3-st.wasm")), noInitialRun: true, print(){}, printErr(){} });
ok("capability detection", typeof z3._Z3_eval_smtlib2_string === "function");

const t = createZ3ApiTransport({ z3, timeoutMs: 10000 });

// 1. state persists across separate evaluate calls (the whole point)
ok("decl returns empty", (await t.evaluate("s1", "(declare-const x Int)")) === "");
await t.evaluate("s1", "(assert (> x 5))");
const sat = await t.evaluate("s1", "(check-sat)");
ok("sat after separate asserts", sat.includes("sat") && !sat.includes("unsat"), JSON.stringify(sat));
await t.evaluate("s1", "(assert (< x 3))");
ok("unsat once contradictory", (await t.evaluate("s1", "(check-sat)")).includes("unsat"));

// 2. push/pop
await t.evaluate("s2", "(declare-const y Int)(assert (> y 0))");
await t.evaluate("s2", "(push)");
await t.evaluate("s2", "(assert (< y 0))");
ok("push: unsat", (await t.evaluate("s2", "(check-sat)")).includes("unsat"));
await t.evaluate("s2", "(pop)");
const afterPop = await t.evaluate("s2", "(check-sat)");
ok("pop restores", afterPop.includes("sat") && !afterPop.includes("unsat"), JSON.stringify(afterPop));

// 3. sessions are independent
await t.evaluate("s3", "(declare-const z Int)(assert (= z 42))");
const val = await t.evaluate("s3", "(check-sat)(get-value (z))");
ok("independent session", val.includes("42"), JSON.stringify(val));
ok("s1 unaffected", (await t.evaluate("s1", "(check-sat)")).includes("unsat"));

// 4. error path: returned as protocol text, session SURVIVES (never throws)
const badOut = await t.evaluate("s4", "(assert (bogus))");
ok("error returned not thrown", badOut.includes("(error"), JSON.stringify(badOut));
const after = await t.evaluate("s4", "(declare-const w Int)(assert (= w 7))(check-sat)(get-value (w))");
ok("same session usable after error", after.includes("7"), JSON.stringify(after));
const badOption = await t.evaluate("s4", "(set-option :nonexistent-thing true)");
ok("unknown option is an error response", badOption.includes("(error"), JSON.stringify(badOption));
const afterOption = await t.evaluate("s4", "(check-sat)");
ok("usable after bad option", afterOption.includes("sat"), JSON.stringify(afterOption));
const pushPop = await t.evaluate("s4", "(push)(assert false)(check-sat)(pop)(check-sat)");
ok("push/pop after errors", pushPop.includes("unsat"), JSON.stringify(pushPop));

// 5. get-info / set-option pass through
ok("get-info version", /"\d+\.\d+/.test(await t.evaluate("s5", "(get-info :version)")), "");
ok("set-option quiet", (await t.evaluate("s5", "(set-option :produce-models true)")) === "");

// 6. close disposes contexts
for (const id of ["s1","s2","s3","s4","s5"]) t.close(id);
ok("no leaked sessions", t.openSessionCount === 0, t.openSessionCount);

// 7. quadratic regression: 400 exchanges, per-exchange time must not grow
const timings = [];
const t0 = Date.now();
for (let i = 0; i < 400; i++) {
  const a = Date.now();
  await t.evaluate("big", `(declare-const v${i} Int)(assert (> v${i} ${i}))(assert (< v${i} ${i+100}))(check-sat)`);
  timings.push(Date.now() - a);
}
const total = Date.now() - t0;
const median = arr => { const s = [...arr].sort((p,q)=>p-q); return s[Math.floor(s.length/2)]; };
const first = median(timings.slice(0, 100)), last = median(timings.slice(-100));
console.log(`400 exchanges: ${total}ms total, median first100=${first}ms last100=${last}ms`);
ok("400 exchanges fast", total < 5000, total + "ms");
ok("per-exchange flat", last <= first + 2, `${first} -> ${last}`);
t.close("big");

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
