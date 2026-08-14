// Shared packing logic for the inline tier: pack _framework into one
// gzip-compressed container the boot code can unpack into a byte store.
//
// Container layout (before gzip):
//   uint32-LE manifest length | manifest JSON | concatenated file bytes
// Manifest: { files: [{ name, offset, size }] }, offsets relative to payload.
import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Blob-imported dotnet loader scripts resolve URLs against import.meta.url,
// an invalid base for blob: modules; give the embedder a settable base.
const loaderScriptPattern = /^dotnet(\.native|\.runtime)?(\.[\w.]+)?\.js$/;

export function patchLoaderScript(bytes) {
  return Buffer.from(bytes.toString("utf8").replaceAll(
    "import.meta.url",
    "(globalThis.__dotnetInlineBase ?? import.meta.url)"
  ), "utf8");
}

export async function buildFrameworkBundle(frameworkRoot, {
  includeSatellites = true,
  gzipLevel = 6
} = {}) {
  const entries = await readdir(frameworkRoot, { recursive: true, withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile() && !entry.name.endsWith(".br") && !entry.name.endsWith(".gz"))
    .map(entry => resolve(entry.parentPath, entry.name)
      .slice(frameworkRoot.length + 1)
      .split("\\").join("/"))
    .filter(name => includeSatellites || !name.includes("/"))
    .sort();

  const files = [];
  const chunks = [];
  let offset = 0;
  for (const name of names) {
    let bytes = await readFile(resolve(frameworkRoot, name));
    if (loaderScriptPattern.test(name)) {
      bytes = patchLoaderScript(bytes);
    }
    files.push({ name, offset, size: bytes.byteLength });
    chunks.push(bytes);
    offset += bytes.byteLength;
  }

  const manifestBytes = Buffer.from(JSON.stringify({ files }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(manifestBytes.byteLength, 0);
  return {
    bundle: gzipSync(Buffer.concat([header, manifestBytes, ...chunks]), { level: gzipLevel }),
    fileCount: files.length,
    rawBytes: offset
  };
}
