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

// --- UI payload: app bundle, tutorial, bignumber, CSS — one brotli+base85
// payload (a shared compression window beats compressing them separately),
// decoded at boot by the ui-boot script below. Keeps the file inside the
// 16 MiB artifact-hosting limit that the raw texts blew past. ---
const tutorialJson = await readFile(resolve(prototypeRoot, "wwwroot/tutorial.json"), "utf8");
const bignumberSource = await readFile(
  resolve(prototypeRoot, "node_modules/bignumber.js/dist/bignumber.js"), "utf8");
const appCss = minify(await readFile(resolve(prototypeRoot, "src/app.css"), "utf8"), "css");

// --- page: the real demo page, network references replaced with inline ---
let html = await readFile(resolve(prototypeRoot, "wwwroot/index.html"), "utf8");
const scrub = [
  [/\n\s*<!-- GitHub Pages cannot send COOP\/COEP headers[\s\S]*?<script src="\.\/coi-serviceworker\.js"><\/script>/, ""],
  [/<link rel="stylesheet" href="\.\/app\.css">/, ""], // injected by ui-boot from the payload
  [/<title>[^<]*<\/title>/, "<title>Dafny Verify</title>"]
];
for (const [pattern, replacement] of scrub) {
  if (!pattern.test(html)) throw new Error("page anchor missing: " + pattern);
  // Function form: replacement text must never be parsed for $-substitutions.
  html = html.replace(pattern, () => replacement);
}
// Minify the page markup (after the comment-anchored scrubs): comments carry
// no runtime meaning, and no text node in this page leads a line, so leading
// indentation is safely collapsible.
html = html
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\n\s+</g, "\n<")
  .replace(/\n{2,}/g, "\n");

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

const uiPayload = brotli(Buffer.from(JSON.stringify({
  z3: z3Glue, // only needed at solver start, well after decode — ride compressed
  css: appCss,
  tutorial: tutorialJson,
  bignumber: bignumberSource,
  app: appBundle
})), { text: true });

// Runs in <head>, synchronously after the payloads: styles land before the
// body paints (no flash of unstyled content); the app module waits for the
// DOM. Everything it injects came through base85 (HTML-safe charset), so no
// </script>-escaping questions arise for the payload contents.
const uiBoot = minify(`
(() => {
  const decode = typeof globalThis.__brotliDecode === "function"
    ? globalThis.__brotliDecode : globalThis.__brotliDecode.default;
  const ui = JSON.parse(new TextDecoder().decode(
    new Uint8Array(decode(globalThis.decodeBase85("ui-b64")))));
  (0, eval)(ui.z3); // indirect eval: global scope, same as the script tag it replaces
  const style = document.createElement("style");
  style.textContent = ui.css;
  document.head.append(style);
  for (const [id, type, text] of [
    ["tutorial-data", "application/json", ui.tutorial],
    ["bignumber-src", "text/plain", ui.bignumber]
  ]) {
    const holder = document.createElement("script");
    holder.id = id;
    holder.type = type;
    holder.textContent = text;
    document.head.append(holder);
  }
  const bootApp = () => {
    const app = document.createElement("script");
    app.type = "module";
    app.textContent = ui.app;
    document.body.append(app);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootApp);
  } else {
    bootApp();
  }
})();
`);

const inlineBlocks = `
<base href="https://inline.invalid/_framework/">
<script>${brotliDecoderScript().replaceAll("</script", "<\\/script")}</script>
<script>${prelude.replaceAll("</script", "<\\/script")}</script>
<script type="text/plain" id="fw-b64">${encodeBase85(frameworkBr)}</script>
<script type="text/plain" id="z3-b64">${encodeBase85(z3WasmBr)}</script>
<script type="text/plain" id="ui-b64">${encodeBase85(uiPayload)}</script>
<script>${uiBoot.replaceAll("</script", "<\\/script")}</script>
`;
html = html.replace("</head>", () => inlineBlocks + "</head>");
html = html.replace('<script type="module" src="./app.js"></script>', () => "");

const htmlBytes = Buffer.byteLength(html, "utf8");
await writeFile(outPath, html);
console.log(`dafny-verify.html: ${(htmlBytes / 1048576).toFixed(2)} MiB ` +
  `(framework ${fileCount} files ${(rawBytes / 1048576).toFixed(1)} MB raw; ` +
  `ui payload ${(uiPayload.length / 1024).toFixed(0)} KB br ` +
  `from app ${(appBundle.length / 1024).toFixed(0)} KB + tutorial ${(tutorialJson.length / 1024).toFixed(0)} KB + bignumber + css)`);
// Artifact hosting accepted 17 MB in practice (measured 2026-08-19); treat
// ~16 MiB as a soft budget so growth stays visible, not as a hard gate.
