// Spot-check harness: run named corpus files through the current dist and
// print compact results. Usage: node test/spot-check.mjs <file...> (paths
// relative to the LitTest root).
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dotnet } from "../dist/wwwroot/_framework/dotnet.js";
import { init } from "z3-solver";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const litRoot = resolve(prototypeRoot,
  "../upstream-dafny/Source/IntegrationTests/TestFiles/LitTests/LitTest");

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

for (const file of process.argv.slice(2)) {
  const source = await readFile(join(litRoot, file), "utf8");
  const started = Date.now();
  try {
    const result = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(source));
    const firstError = (result.diagnostics ?? []).find(d => d.severity === "error");
    console.log(`${file}: verified=${result.verified} v=${result.verifiedCount} ` +
      `e=${result.errorCount} stage=${result.stage} ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (firstError ? ` | ${firstError.message.split("\n")[0].slice(0, 110)}` : ""));
  } catch (error) {
    console.log(`${file}: CRASH ${String(error?.message ?? error).slice(0, 110)}`);
  }
}
process.exit(0);
