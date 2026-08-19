// Assemble dafny-verify.html: the COMPLETE demo experience (CodeMirror
// editor, problems panel, counterexamples with in-editor ghosts, canned
// examples, the interactive tutorial) as ONE self-sufficient file — no
// network, no workers, works from file://. Sibling of dafny-artifact.html,
// which stays minimal to fit hosting limits; this build trades size for
// the full UI. Solver runs in-page (single-threaded): the page freezes
// during verification, bounded by the per-obligation time limit.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFrameworkBundle } from "./bundle-lib.mjs";
import { brotli, encodeBase85, BASE85_DECODER_JS, minify, brotliDecoderScript } from "./inline-lib.mjs";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = resolve(prototypeRoot, "dist/wwwroot/_framework");
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(prototypeRoot, "../../../z3-inline/dist"));
const outPath = resolve(prototypeRoot, "dist/dafny-verify.html");

// --- payloads (same machinery as the minimal artifact) ---
const { bundle, fileCount, rawBytes, bootConfigBytes } = await buildFrameworkBundle(frameworkRoot, {
  includeSatellites: false,
  compression: "none",
  inlineRegistry: true
});
const frameworkBr = brotli(bundle);
const z3Glue = minify(await readFile(join(z3StDir, "z3-st.js"), "utf8") +
  "\n;globalThis.createZ3 = typeof createZ3 !== 'undefined' ? createZ3 : globalThis.createZ3;");
const z3WasmBr = brotli(await readFile(join(z3StDir, "z3-st.wasm")));

// --- the full demo app, bundled against the inline shim ---
const appSource = (await readFile(resolve(prototypeRoot, "src/app.js"), "utf8"))
  .replace('from "./dafny-browser.js"', 'from "./dafny-browser-inline.js"');
const appEntry = resolve(prototypeRoot, "src/.app-inline.entry.mjs");
await writeFile(appEntry, appSource);
let appBundle;
try {
  appBundle = execFileSync(resolve(prototypeRoot, "node_modules/.bin/esbuild"), [
    appEntry, "--bundle", "--minify", "--format=esm", "--target=es2022"
  ], { maxBuffer: 1 << 28 }).toString("utf8");
} finally {
  await unlink(appEntry);
}

// --- tutorial, inlined (fetch is unavailable on file://) ---
const tutorialJson = (await readFile(resolve(prototypeRoot, "wwwroot/tutorial.json"), "utf8"))
  .replaceAll("</", "<\\/"); // JSON-legal, HTML-safe

const appCss = await readFile(resolve(prototypeRoot, "src/app.css"), "utf8");

// --- page: the real demo page, network references replaced with inline ---
let html = await readFile(resolve(prototypeRoot, "wwwroot/index.html"), "utf8");
const scrub = [
  [/\n\s*<!-- GitHub Pages cannot send COOP\/COEP headers[\s\S]*?<script src="\.\/coi-serviceworker\.js"><\/script>/, ""],
  [/<link rel="stylesheet" href="\.\/app\.css">/, "<style>\n" + appCss.replaceAll("</", "<\\/") + "\n</style>"],
  [/<title>[^<]*<\/title>/, "<title>Dafny Verify — single-file (no install, no network)</title>"]
];
for (const [pattern, replacement] of scrub) {
  if (!pattern.test(html)) throw new Error("page anchor missing: " + pattern);
  // Function form: replacement text must never be parsed for $-substitutions.
  html = html.replace(pattern, () => replacement);
}

const prelude = minify(`
globalThis.__dotnetInlineBase = "https://inline.invalid/_framework/dotnet.js";
globalThis.__dafnyBootConfigUrl = "data:application/json;base64,${bootConfigBytes.toString("base64")}";
globalThis.__inlineModules = new Map();
globalThis.__inlineWaiters = new Map();
globalThis.__inlineRegister = (name, moduleExports) => {
  globalThis.__inlineModules.set(name, moduleExports);
  const waiter = globalThis.__inlineWaiters.get(name);
  if (waiter) { globalThis.__inlineWaiters.delete(name); waiter(moduleExports); }
};
globalThis.__inlineImport = name => {
  const found = globalThis.__inlineModules.get(name);
  if (found) return Promise.resolve(found);
  return new Promise(resolveWaiter => globalThis.__inlineWaiters.set(name, resolveWaiter));
};
` + BASE85_DECODER_JS + "\nglobalThis.decodeBase85 = decodeBase85;");

const inlineBlocks = `
<base href="https://inline.invalid/_framework/">
<script>${z3Glue.replaceAll("</script", "<\\/script")}</script>
<script>${brotliDecoderScript().replaceAll("</script", "<\\/script")}</script>
<script>${prelude.replaceAll("</script", "<\\/script")}</script>
<script type="text/plain" id="fw-b64">${encodeBase85(frameworkBr)}</script>
<script type="text/plain" id="z3-b64">${encodeBase85(z3WasmBr)}</script>
<script type="application/json" id="tutorial-data">${tutorialJson}</script>
`;
html = html.replace("</head>", () => inlineBlocks + "</head>");
html = html.replace('<script type="module" src="./app.js"></script>',
  () => '<script type="module">\n' + appBundle.replaceAll("</script", "<\\/script") + "\n</script>");

const htmlBytes = Buffer.byteLength(html, "utf8");
await writeFile(outPath, html);
console.log(`dafny-verify.html: ${(htmlBytes / 1048576).toFixed(2)} MB ` +
  `(framework ${fileCount} files ${(rawBytes / 1048576).toFixed(1)} MB raw; ` +
  `app bundle ${(appBundle.length / 1024).toFixed(0)} KB; tutorial ${(tutorialJson.length / 1024).toFixed(0)} KB)`);
