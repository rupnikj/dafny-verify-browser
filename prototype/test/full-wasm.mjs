import { strict as assert } from "node:assert";
import { dotnet } from "../dist/wwwroot/_framework/dotnet.js";
import { init } from "z3-solver";

const contexts = new Map();
const z3 = await init();
const runtime = await dotnet.create();

runtime.setModuleImports("dafnyZ3", {
  evaluate: async (solverId, smtLib) => {
    let context = contexts.get(solverId);
    if (!context) {
      const config = z3.Z3.mk_config();
      context = z3.Z3.mk_context_rc(config);
      z3.Z3.del_config(config);
      contexts.set(solverId, context);
    }
    return z3.Z3.eval_smtlib2_string(context, smtLib);
  },
  close: solverId => {
    const context = contexts.get(solverId);
    if (context) {
      z3.Z3.del_context(context);
      contexts.delete(solverId);
    }
  }
});

const config = runtime.getConfig();
await runtime.runMain(config.mainAssemblyName, []);
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);

const abs = `
method Abs(x: int) returns (y: int)
  ensures y >= 0
{
  if x < 0 {
    y := -x;
  } else {
    y := x;
  }
}`;

const bad = `
method Bad(x: int) returns (y: int)
  ensures y > x
{
  y := x;
}`;

const absResult = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(abs));
const absTranscript = JSON.parse(exports.DafnyBrowser.BrowserApi.GetLastSmtTranscript());
const badResult = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(bad));
const badTranscript = JSON.parse(exports.DafnyBrowser.BrowserApi.GetLastSmtTranscript());

{
  const cex = JSON.parse(await exports.DafnyBrowser.BrowserApi.VerifyFull(bad, 0, true));
  const states = cex.diagnostics?.[0]?.counterexample;
  if (!Array.isArray(states) || states.length === 0 ||
      !states.some(state => /==/.test(state.assumption))) {
    console.error("counterexample extraction failed:", JSON.stringify(cex.diagnostics));
    process.exit(1);
  }
  const plain = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(bad));
  if (plain.diagnostics?.some(diagnostic => diagnostic.counterexample)) {
    console.error("default Verify must not carry counterexamples");
    process.exit(1);
  }
}
console.log(JSON.stringify({ abs: absResult, bad: badResult }, null, 2));

assert.equal(absResult.verified, true);
assert.equal(absResult.verifiedCount, 1);
assert.equal(absResult.errorCount, 0);
assert.equal(badResult.verified, false);
assert.equal(badResult.errorCount, 1);
assert.match(badResult.diagnostics[0].message, /postcondition could not be proved/);
assert.ok(absTranscript.some(entry => entry.input.includes("(set-option :print-success false)")));
assert.ok(absTranscript.some(entry => entry.input.includes("(push 1)")));
assert.ok(absTranscript.some(entry => entry.input.includes("(check-sat)") && /unsat/.test(entry.output)));
assert.ok(badTranscript.some(entry => entry.input.includes("(check-sat)") && /sat/.test(entry.output)));
