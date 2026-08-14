// Phase 1 of the inline (hostile-sandbox) tier: pack every network-served
// _framework asset into one gzipped blob and emit a test page that boots the
// .NET runtime from that blob via loadBootResource. The page's gate: a
// trivial program verifies with zero /_framework/ network requests.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFrameworkBundle } from "./bundle-lib.mjs";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = resolve(prototypeRoot, "dist/wwwroot/_framework");
const outRoot = resolve(prototypeRoot, "dist/wwwroot/inline-test");

const { bundle, fileCount, rawBytes } = await buildFrameworkBundle(frameworkRoot);

await mkdir(outRoot, { recursive: true });
await writeFile(resolve(outRoot, "framework-bundle.bin"), bundle);
await writeFile(resolve(outRoot, "index.html"),
  await readFile(resolve(prototypeRoot, "tools/inline-test-page.html")));

console.log(`bundled ${fileCount} assets: ${(rawBytes / 1048576).toFixed(1)} MB raw, ` +
  `${(bundle.byteLength / 1048576).toFixed(1)} MB gzipped -> dist/wwwroot/inline-test/`);
