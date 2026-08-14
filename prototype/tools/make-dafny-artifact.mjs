// Phase 3 of the inline tier: assemble the whole verifier into ONE HTML file.
// Framework assets (gzip, base64) + single-threaded z3-st (gzip, base64) +
// inline glue + replay transport + minimal UI. Zero network at runtime.
//
// z3-st assets come from a z3-inline dist (Z3_ST_DIR, default ../../z3-inline/dist).
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildFrameworkBundle } from "./bundle-lib.mjs";

const SOFT_TIMEOUT_MS = 30000;
const BUDGET_BYTES = 45 * 1024 * 1024;

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = resolve(prototypeRoot, "dist/wwwroot/_framework");
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(prototypeRoot, "../../../z3-inline/dist"));
const outPath = resolve(prototypeRoot, "dist/dafny-artifact.html");

// Trim to the assemblies the runtime actually loads (measured by
// test/probe-loaded-assemblies.mjs across feature-diverse programs). A program
// exercising something outside the measured set fails with a clear
// assembly-load error rather than a wrong verdict.
const keepAssemblies = JSON.parse(
  await readFile(resolve(prototypeRoot, "test/loaded-assemblies.json"), "utf8"));

const { bundle, fileCount, rawBytes, bootConfigBytes } = await buildFrameworkBundle(frameworkRoot, {
  includeSatellites: false,
  gzipLevel: 9,
  keepAssemblies
});
const bootConfig = bootConfigBytes;
const z3Glue = await readFile(join(z3StDir, "z3-st.js"), "utf8");
const z3Wasm = await readFile(join(z3StDir, "z3-st.wasm"));
const z3Info = JSON.parse(await readFile(join(z3StDir, "build-info.json"), "utf8"));
const z3WasmGz = gzipSync(z3Wasm, { level: 9 });
const transport = (await readFile(resolve(prototypeRoot, "src/z3-st-transport.js"), "utf8"))
  .replace("export function createZ3StTransport", "function createZ3StTransport");

const template = await readFile(resolve(prototypeRoot, "tools/dafny-artifact-template.html"), "utf8");
const replacements = new Map([
  ["__Z3_VERSION__", z3Info.z3Version],
  ["__SOFT_TIMEOUT_MS__", String(SOFT_TIMEOUT_MS)],
  ["__BUILD_STAMP__", new Date().toISOString().slice(0, 10)],
  // Inline scripts must not contain a closing script tag.
  ["__Z3_GLUE__", z3Glue.replaceAll("</script", "<\\/script")],
  ["__TRANSPORT_JS__", transport],
  ["__FRAMEWORK_B64__", bundle.toString("base64")],
  ["__Z3_WASM_B64__", z3WasmGz.toString("base64")],
  ["__BOOT_CONFIG_DATA_URL__", "data:application/json;base64," + bootConfig.toString("base64")]
]);
let html = template;
for (const [placeholder, value] of replacements) {
  if (!html.includes(placeholder)) {
    throw new Error("Template placeholder missing: " + placeholder);
  }
  html = html.split(placeholder).join(value);
}

const htmlBytes = Buffer.byteLength(html, "utf8");
await writeFile(outPath, html);
console.log(`dafny-artifact.html: ${(htmlBytes / 1048576).toFixed(1)} MB ` +
  `(framework ${fileCount} files ${(rawBytes / 1048576).toFixed(1)} MB raw -> ` +
  `${(bundle.byteLength / 1048576).toFixed(1)} MB gz; ` +
  `z3-st ${(z3Wasm.byteLength / 1048576).toFixed(1)} MB -> ${(z3WasmGz.byteLength / 1048576).toFixed(1)} MB gz)`);
if (htmlBytes > BUDGET_BYTES) {
  console.error(`FAIL: exceeds ${(BUDGET_BYTES / 1048576).toFixed(0)} MB budget`);
  process.exit(1);
}
