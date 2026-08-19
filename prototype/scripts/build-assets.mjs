import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(prototypeRoot, "wwwroot");
const z3Root = resolve(webRoot, "z3");
const installedZ3Root = resolve(prototypeRoot, "node_modules/z3-solver/build");

await mkdir(z3Root, { recursive: true });

await build({
  entryPoints: [resolve(prototypeRoot, "src/z3-api.js")],
  outfile: resolve(webRoot, "z3-api.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  banner: { js: "var global = globalThis;" }
});

await build({
  entryPoints: [resolve(prototypeRoot, "src/app.js")],
  outfile: resolve(webRoot, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["./dafny-browser.js"],
  sourcemap: true
});

await build({
  entryPoints: [resolve(prototypeRoot, "src/dafny-browser.js")],
  outfile: resolve(webRoot, "dafny-browser.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true
});

await copyFile(resolve(prototypeRoot, "src/app.css"), resolve(webRoot, "app.css"));

// The Dafny→JavaScript runtime's one dependency (DafnyRuntime.js line 4);
// fetched lazily by the Run feature and fed to the runner as source text.
await mkdir(resolve(webRoot, "vendor"), { recursive: true });
await copyFile(
  resolve(prototypeRoot, "node_modules/bignumber.js/dist/bignumber.js"),
  resolve(webRoot, "vendor/bignumber.js"));

await Promise.all([
  copyFile(resolve(installedZ3Root, "z3-built.js"), resolve(z3Root, "z3-built.js")),
  copyFile(resolve(installedZ3Root, "z3-built.wasm"), resolve(z3Root, "z3-built.wasm"))
]);
