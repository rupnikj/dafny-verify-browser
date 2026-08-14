import { stdin } from "node:process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { dotnet } from "../dist/wwwroot/_framework/dotnet.js";
import { init } from "z3-solver";

const args = process.argv.slice(2);
const expectVerification = args.includes("--expect-verification");
const summaryOnly = args.includes("--summary");
const sourcePath = args.find(arg => !arg.startsWith("--"));

let source;
if (sourcePath) {
  source = await readFile(sourcePath, "utf8");
} else {
  const lines = [];
  const input = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line === "// __DAFNY_EOF__") {
      input.close();
      break;
    }
    lines.push(line);
  }
  source = lines.join("\n");
}
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

try {
  const result = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(source));
  if (expectVerification && (result.stage !== "verification" || result.smtExchangeCount <= 0 ||
      result.diagnostics.some(diagnostic => diagnostic.source === "runtime"))) {
    throw new Error(`Expected the source to reach Z3-backed verification, got: ${JSON.stringify(result)}`);
  }
  if (summaryOnly) {
    console.log(JSON.stringify({
      verified: result.verified,
      verifiedCount: result.verifiedCount,
      errorCount: result.errorCount,
      stage: result.stage,
      smtExchangeCount: result.smtExchangeCount
    }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  for (const context of contexts.values()) {
    z3.Z3.del_context(context);
  }
}
