// Phase 1 of the inline (hostile-sandbox) tier: pack every network-served
// _framework asset into one gzipped blob and emit a test page that boots the
// .NET runtime from that blob via loadBootResource. The page's gate: a
// trivial program verifies with zero /_framework/ network requests.
//
// Bundle layout (before gzip):
//   uint32-LE manifest length | manifest JSON | concatenated file bytes
// Manifest: { files: [{ name, offset, size }] }, offsets relative to payload.
import { gzipSync } from "node:zlib";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = resolve(prototypeRoot, "dist/wwwroot/_framework");
const outRoot = resolve(prototypeRoot, "dist/wwwroot/inline-test");

const entries = await readdir(frameworkRoot, { recursive: true, withFileTypes: true });
const names = entries
  .filter(entry => entry.isFile() && !entry.name.endsWith(".br") && !entry.name.endsWith(".gz"))
  .map(entry => resolve(entry.parentPath, entry.name)
    .slice(frameworkRoot.length + 1)
    .split("\\").join("/"))
  .sort();

const files = [];
const chunks = [];
let offset = 0;
for (const name of names) {
  let bytes = await readFile(resolve(frameworkRoot, name));
  if (/^dotnet(\.native|\.runtime)?(\.[\w.]+)?\.js$/.test(name)) {
    // When imported from a blob: URL, import.meta.url is an invalid base for
    // URL resolution, which breaks the loader before loadBootResource is even
    // consulted. Let the embedding page supply a real base instead.
    const patched = bytes.toString("utf8").replaceAll(
      "import.meta.url",
      "(globalThis.__dotnetInlineBase ?? import.meta.url)"
    );
    bytes = Buffer.from(patched, "utf8");
  }
  files.push({ name, offset, size: bytes.byteLength });
  chunks.push(bytes);
  offset += bytes.byteLength;
}

const manifestBytes = Buffer.from(JSON.stringify({ files }), "utf8");
const header = Buffer.alloc(4);
header.writeUInt32LE(manifestBytes.byteLength, 0);
const bundle = gzipSync(Buffer.concat([header, manifestBytes, ...chunks]), { level: 6 });

await mkdir(outRoot, { recursive: true });
await writeFile(resolve(outRoot, "framework-bundle.bin"), bundle);
await writeFile(resolve(outRoot, "index.html"),
  await readFile(resolve(prototypeRoot, "tools/inline-test-page.html")));

console.log(`bundled ${files.length} assets: ${(offset / 1048576).toFixed(1)} MB raw, ` +
  `${(bundle.byteLength / 1048576).toFixed(1)} MB gzipped -> dist/wwwroot/inline-test/`);
