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
// Binary payloads are embedded as base85 rather than base64: inside
// <script type="text/plain"> only the sequence "</script" (and "<!--") can
// break parsing, so a charset that simply excludes '<' is HTML-safe, and the
// 4-bytes-to-5-chars expansion (25%) beats base64's 33% — worth ~1 MB here.
const BASE85_CHARSET = (() => {
  const chars = [];
  for (let code = 33; code <= 126 && chars.length < 85; code++) {
    if ("<>&\"'\\`".includes(String.fromCharCode(code))) continue;
    chars.push(String.fromCharCode(code));
  }
  return chars.join("");
})();

function encodeBase85(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = [bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0];
    let value = ((chunk[0] * 256 + chunk[1]) * 256 + chunk[2]) * 256 + chunk[3];
    const digits = new Array(5);
    for (let d = 4; d >= 0; d--) {
      digits[d] = BASE85_CHARSET[value % 85];
      value = Math.floor(value / 85);
    }
    out.push(digits.join(""));
  }
  const padding = (4 - (bytes.length % 4)) % 4;
  let text = out.join("");
  return padding ? text.slice(0, text.length - padding) : text;
}

// The inline decoder the template embeds (kept in sync with the encoder).
const BASE85_DECODER_JS = `
function decodeBase85(elementId) {
  const CHARSET = ${JSON.stringify(BASE85_CHARSET)};
  const lookup = new Int16Array(127).fill(-1);
  for (let i = 0; i < 85; i++) lookup[CHARSET.charCodeAt(i)] = i;
  const text = document.getElementById(elementId).textContent.trim();
  const groups = Math.ceil(text.length / 5);
  const bytes = new Uint8Array(groups * 4);
  let bi = 0;
  for (let i = 0; i < text.length; i += 5) {
    let value = 0;
    for (let d = 0; d < 5; d++) {
      const ch = i + d < text.length ? lookup[text.charCodeAt(i + d)] : 84;
      value = value * 85 + ch;
    }
    bytes[bi++] = (value >>> 24) & 255;
    bytes[bi++] = (value >>> 16) & 255;
    bytes[bi++] = (value >>> 8) & 255;
    bytes[bi++] = value & 255;
  }
  const padding = (5 - (text.length % 5)) % 5;
  return bytes.subarray(0, groups * 4 - padding);
}`;

// Minify the inlined plain-text scripts (glue, decoder, transports): they
// ship uncompressed inside the HTML, so every byte is a byte of budget.
function minify(source, format = "iife") {
  return execFileSync(resolve(prototypeRoot, "node_modules/.bin/esbuild"), [
    "--minify", `--format=${format}`
  ], { input: source, maxBuffer: 1 << 26 }).toString("utf8");
}

// The global export must be assigned INSIDE the minified scope: esbuild's
// iife output wraps top-level vars, so an outside reference would see nothing.
const z3Glue = minify(await readFile(join(z3StDir, "z3-st.js"), "utf8") +
  "\n;globalThis.createZ3 = typeof createZ3 !== 'undefined' ? createZ3 : globalThis.createZ3;");
const z3Wasm = await readFile(join(z3StDir, "z3-st.wasm"));
const z3Info = JSON.parse(await readFile(join(z3StDir, "build-info.json"), "utf8"));
const z3WasmBr = brotli(z3Wasm);
const transport = minify(
  (await readFile(resolve(prototypeRoot, "src/z3-st-transport.js"), "utf8"))
    .replace("export function createZ3StTransport", "function createZ3StTransport") + "\n" +
  (await readFile(resolve(prototypeRoot, "src/z3-api-transport.js"), "utf8"))
    .replace("export function createZ3ApiTransport", "function createZ3ApiTransport") +
  "\nglobalThis.createZ3StTransport = createZ3StTransport;" +
  "\nglobalThis.createZ3ApiTransport = createZ3ApiTransport;") +
  "\nconst createZ3StTransport = globalThis.createZ3StTransport;" +
  "\nconst createZ3ApiTransport = globalThis.createZ3ApiTransport;";

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
  ["__BASE85_DECODER__", minify(BASE85_DECODER_JS + "\nglobalThis.decodeBase85 = decodeBase85;")],
  ["__FRAMEWORK_B64__", encodeBase85(frameworkBr)],
  ["__Z3_WASM_B64__", encodeBase85(z3WasmBr)],
  ["__BOOT_CONFIG_DATA_URL__", "data:application/json;base64," + bootConfigBytes.toString("base64")]
]);
let html = template;
for (const [placeholder, value] of replacements) {
  if (!html.includes(placeholder)) {
    throw new Error("Template placeholder missing: " + placeholder);
  }
  html = html.split(placeholder).join(value);
}

// Build-time safety: the embedded decoder must round-trip the encoder's
// output exactly, and the payload text must not contain parser-breaking runs.
for (const payload of [frameworkBr, z3WasmBr]) {
  const text = encodeBase85(payload);
  if (text.includes("</script") || text.includes("<!--")) {
    throw new Error("base85 payload contains an HTML-unsafe sequence");
  }
}
{
  const sample = Buffer.concat([z3WasmBr.subarray(0, 4097), Buffer.from([1, 2, 3])]);
  const encoded = encodeBase85(sample);
  const CHARSET = BASE85_CHARSET;
  const lookup = new Int16Array(127).fill(-1);
  for (let i = 0; i < 85; i++) lookup[CHARSET.charCodeAt(i)] = i;
  const groups = Math.ceil(encoded.length / 5);
  const decoded = new Uint8Array(groups * 4);
  let bi = 0;
  for (let i = 0; i < encoded.length; i += 5) {
    let value = 0;
    for (let d = 0; d < 5; d++) {
      value = value * 85 + (i + d < encoded.length ? lookup[encoded.charCodeAt(i + d)] : 84);
    }
    decoded[bi++] = (value >>> 24) & 255;
    decoded[bi++] = (value >>> 16) & 255;
    decoded[bi++] = (value >>> 8) & 255;
    decoded[bi++] = value & 255;
  }
  const padding = (5 - (encoded.length % 5)) % 5;
  const roundTripped = decoded.subarray(0, groups * 4 - padding);
  if (Buffer.compare(Buffer.from(roundTripped), sample) !== 0) {
    throw new Error("base85 round-trip failed");
  }
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
