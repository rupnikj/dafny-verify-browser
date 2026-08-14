// Phase 1 of the inline (hostile-sandbox) tier: pack every network-served
// _framework asset into one gzipped blob and emit a test page that boots the
// .NET runtime from that blob via loadBootResource. The page's gate: a
// trivial program verifies with zero /_framework/ network requests.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFrameworkBundle } from "./bundle-lib.mjs";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = resolve(prototypeRoot, "dist/wwwroot/_framework");
const outRoot = resolve(prototypeRoot, "dist/wwwroot/inline-test");
// The page uses the single-threaded z3-st solver (like the artifact) so the
// gate doesn't depend on main-thread pthreads, which are unreliable on
// low-core CI runners.
const z3StDir = resolve(process.env.Z3_ST_DIR ?? resolve(prototypeRoot, "../../../z3-inline/dist"));

const { bundle, fileCount, rawBytes } = await buildFrameworkBundle(frameworkRoot);

await mkdir(outRoot, { recursive: true });
await writeFile(resolve(outRoot, "framework-bundle.bin"), bundle);
await writeFile(resolve(outRoot, "index.html"),
  await readFile(resolve(prototypeRoot, "tools/inline-test-page.html")));
await copyFile(join(z3StDir, "z3-st.js"), resolve(outRoot, "z3-st.js"));
await copyFile(join(z3StDir, "z3-st.wasm"), resolve(outRoot, "z3-st.wasm"));
await copyFile(resolve(prototypeRoot, "src/z3-st-transport.js"),
  resolve(outRoot, "z3-st-transport.js"));

console.log(`bundled ${fileCount} assets: ${(rawBytes / 1048576).toFixed(1)} MB raw, ` +
  `${(bundle.byteLength / 1048576).toFixed(1)} MB gzipped -> dist/wwwroot/inline-test/`);
