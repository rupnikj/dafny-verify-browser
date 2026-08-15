// WASM side of the differential suite: run each candidate through the
// published browser bundle (same runtime the Pages demo serves), threaded Z3,
// exactly like test/verify-corpus.mjs does. Incremental JSONL; resumable. A
// file that was started but never finished on a previous run (runtime hang or
// crash — cancellation is not wired into the pipeline) is recorded as hung
// and skipped, so the driver loop can restart this process safely.
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dotnet } from "../../dist/wwwroot/_framework/dotnet.js";
import { init } from "z3-solver";

const here = dirname(fileURLToPath(import.meta.url));
let { litRoot, files } = JSON.parse(await readFile(join(here, "candidates.json"), "utf8"));
if (process.env.DIFF_LIMIT) {
  const step = Math.max(1, Math.floor(files.length / Number(process.env.DIFF_LIMIT)));
  files = files.filter((_, i) => i % step === 0);
}
const outPath = join(here, "wasm-results.jsonl");

const finished = new Set();
const started = new Set();
try {
  for (const line of (await readFile(outPath, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    (record.status === "start" ? started : finished).add(record.file);
  }
} catch {}
for (const file of started) {
  if (!finished.has(file)) {
    await appendFile(outPath, JSON.stringify({ file, status: "hang" }) + "\n");
    finished.add(file);
    console.log("marking hung from previous run: " + file);
  }
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

let index = 0;
for (const file of files) {
  index++;
  if (finished.has(file)) continue;
  await appendFile(outPath, JSON.stringify({ file, status: "start" }) + "\n");
  const source = await readFile(join(litRoot, file), "utf8");
  const startedAt = Date.now();
  let record;
  try {
    const result = JSON.parse(await exports.DafnyBrowser.BrowserApi.Verify(source));
    const errors = (result.diagnostics ?? []).filter(d => d.severity === "error");
    record = {
      file,
      status: "done",
      seconds: (Date.now() - startedAt) / 1000,
      verified: result.verifiedCount,
      errors: result.errorCount,
      verdict: result.verified,
      stage: result.stage,
      exchanges: result.smtExchangeCount,
      errorLines: [...new Set(errors.map(d => d.line).filter(Number.isInteger))].sort((a, b) => a - b),
      firstError: errors[0]?.message?.slice(0, 200) ?? null
    };
  } catch (error) {
    record = {
      file,
      status: "crash",
      seconds: (Date.now() - startedAt) / 1000,
      firstError: String(error?.message ?? error).slice(0, 300)
    };
  }
  await appendFile(outPath, JSON.stringify(record) + "\n");
  if (index % 25 === 0) console.log(`wasm ${index}/${files.length}`);
}
console.log("wasm runner complete");
process.exit(0);
