// Phase 3 of the inline tier: assemble the whole verifier into ONE HTML file.
// The FULL untrimmed assembly set ships (no reachability guesses); the size
// budget is met with brotli (payloads are base64'd, so compressed bytes count
// 1.33x) plus a small inline JS brotli decoder.
//
// z3-st assets come from a z3-inline dist (Z3_ST_DIR, default ../../z3-inline/dist).
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { buildFrameworkBundle } from "./bundle-lib.mjs";

const SOFT_TIMEOUT_MS = 30000;
const BUDGET_BYTES = 16 * 1024 * 1024; // claude.ai artifact publish limit

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = resolve(prototypeRoot, "dist/wwwroot/_framework");
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(prototypeRoot, "../../../z3-inline/dist"));
const outPath = resolve(prototypeRoot, "dist/dafny-artifact.html");

const brotli = bytes => brotliCompressSync(bytes, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
    [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength
  }
});

// Sandbox finding: in srcdoc-rendered artifacts no URL of any scheme loads
// (blob:, data:, and <script src> are all blocked), but INJECTED inline
// scripts — classic and module — execute. So the loader modules travel
// inside the brotli bundle (transformed for the inline registry) and the
// boot code injects them as inline <script type="module"> elements.
const { bundle, fileCount, rawBytes, bootConfigBytes } = await buildFrameworkBundle(frameworkRoot, {
  includeSatellites: false,
  compression: "none",
  inlineRegistry: true
});
const frameworkBr = brotli(bundle);
const z3Glue = await readFile(join(z3StDir, "z3-st.js"), "utf8");
const z3Wasm = await readFile(join(z3StDir, "z3-st.wasm"));
const z3Info = JSON.parse(await readFile(join(z3StDir, "build-info.json"), "utf8"));
const z3WasmBr = brotli(z3Wasm);
const transport = (await readFile(resolve(prototypeRoot, "src/z3-st-transport.js"), "utf8"))
  .replace("export function createZ3StTransport", "function createZ3StTransport") + "\n" +
  (await readFile(resolve(prototypeRoot, "src/z3-api-transport.js"), "utf8"))
    .replace("export function createZ3ApiTransport", "function createZ3ApiTransport");

// Bundle the pure-JS brotli decoder (dev dependency) into a self-contained IIFE.
const decoder = execFileSync(resolve(prototypeRoot, "node_modules/.bin/esbuild"), [
  "--bundle", "--minify", "--format=iife", "--global-name=__brotliDecode",
  resolve(prototypeRoot, "node_modules/brotli/decompress.js")
], { maxBuffer: 1 << 26 }).toString("utf8");

const template = await readFile(resolve(prototypeRoot, "tools/dafny-artifact-template.html"), "utf8");
const replacements = new Map([
  ["__Z3_VERSION__", z3Info.z3Version],
  ["__SOFT_TIMEOUT_MS__", String(SOFT_TIMEOUT_MS)],
  ["__BUILD_STAMP__", new Date().toISOString().slice(0, 10)],
  // Inline scripts must not contain a closing script tag.
  ["__Z3_GLUE__", z3Glue.replaceAll("</script", "<\\/script")],
  ["__BROTLI_DECODER__", decoder.replaceAll("</script", "<\\/script")],
  ["__TRANSPORT_JS__", transport],
  ["__FRAMEWORK_B64__", frameworkBr.toString("base64")],
  ["__Z3_WASM_B64__", z3WasmBr.toString("base64")],
  ["__BOOT_CONFIG_DATA_URL__", "data:application/json;base64," + bootConfigBytes.toString("base64")]
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
console.log(`dafny-artifact.html: ${(htmlBytes / 1048576).toFixed(2)} MB ` +
  `(framework ${fileCount} files ${(rawBytes / 1048576).toFixed(1)} MB raw -> ` +
  `${(frameworkBr.byteLength / 1048576).toFixed(2)} MB br; ` +
  `z3-st ${(z3Wasm.byteLength / 1048576).toFixed(1)} MB -> ${(z3WasmBr.byteLength / 1048576).toFixed(2)} MB br)`);
if (htmlBytes > BUDGET_BYTES) {
  // ::error:: makes the size visible as a GitHub annotation (fetchable via
  // the API even when job logs are not).
  console.error(`::error::dafny-artifact.html is ${htmlBytes} bytes, ` +
    `${htmlBytes - BUDGET_BYTES} over the ${(BUDGET_BYTES / 1048576).toFixed(0)} MB budget`);
  process.exit(1);
}
