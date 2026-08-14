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

// Parse a minified module's export surface (`export{A as B,...}` clauses and
// `export default X`) into a registration statement that runs in the same
// module scope — no eval needed.
function registrationLine(name, source) {
  const props = [];
  for (const clause of source.matchAll(/export\{([^}]*)\}/g)) {
    for (const part of clause[1].split(",")) {
      const binding = part.trim();
      if (!binding) continue;
      const renamed = binding.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      props.push(renamed ? [renamed[2], renamed[1]] : [binding, binding]);
    }
  }
  const defaultExport = source.match(/export default ([\w$]+)/);
  if (defaultExport) {
    props.push(["default", defaultExport[1]]);
  }
  if (props.length === 0) {
    throw new Error("No export clause found in " + name);
  }
  return "\n;globalThis.__inlineRegister(" + JSON.stringify(name) + ",{" +
    props.map(([key, local]) => JSON.stringify(key) + ":" + local).join(",") + "});\n";
}

// Registry variant for sandboxes where no URL of any scheme loads (blob:,
// data:, and <script src> are all blocked): each loader module registers its
// exports with globalThis.__inlineRegister, and dotnet.js resolves its
// runtime/native modules through globalThis.__inlineImport instead of
// dynamic import() — following the loader's own moduleExports design.
export function transformLoaderModuleForRegistry(name, bytes) {
  let source = patchLoaderScript(bytes).toString("utf8");
  if (name === "dotnet.js") {
    let dynamicImports = 0;
    source = source.replace(/([\w$]+)=import\(([\w$]+)\.resolvedUrl\)/g,
      (_, target, asset) => {
        dynamicImports++;
        return `${target}=globalThis.__inlineImport(${asset}.name)`;
      });
    if (dynamicImports === 0) {
      throw new Error("dotnet.js: no dynamic import sites found to patch");
    }
  }
  return Buffer.from(source + registrationLine(name, source), "utf8");
}

export async function buildFrameworkBundle(frameworkRoot, {
  includeSatellites = true,
  gzipLevel = 6,
  // "gzip" for DecompressionStream consumers; "none" returns the raw
  // container so the caller can apply its own (e.g. brotli) compression.
  compression = "gzip",
  // Optional allowlist of assembly simple names ("DafnyCore"). When given,
  // assemblies outside the list are dropped from both the bundle and the
  // boot config, so the loader never requests them.
  keepAssemblies = null,
  // Files carried outside the bundle by the caller (e.g. loader modules
  // inlined as script text) — excluded here so they don't ship twice.
  excludeNames = null,
  // Transform loader modules for the inline registry (no-URL sandboxes).
  inlineRegistry = false
} = {}) {
  const bootConfig = JSON.parse(
    await readFile(resolve(frameworkRoot, "blazor.boot.json"), "utf8"));
  const assemblyFiles = new Set(Object.keys(bootConfig.resources.assembly ?? {}));
  const keep = keepAssemblies ? new Set(keepAssemblies) : null;
  if (keep) {
    bootConfig.resources.assembly = Object.fromEntries(
      Object.entries(bootConfig.resources.assembly)
        .filter(([file]) => keep.has(file.replace(/\.(wasm|dll)$/, ""))));
  }
  if (!includeSatellites) {
    bootConfig.resources.satelliteResources = {};
  }
  const bootConfigBytes = Buffer.from(JSON.stringify(bootConfig), "utf8");

  const entries = await readdir(frameworkRoot, { recursive: true, withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile() && !entry.name.endsWith(".br") && !entry.name.endsWith(".gz"))
    .map(entry => resolve(entry.parentPath, entry.name)
      .slice(frameworkRoot.length + 1)
      .split("\\").join("/"))
    .filter(name => includeSatellites || !name.includes("/"))
    .filter(name => !keep || !assemblyFiles.has(name) ||
      keep.has(name.replace(/\.(wasm|dll)$/, "")))
    .filter(name => !excludeNames || !excludeNames.has(name))
    .sort();

  const files = [];
  const chunks = [];
  let offset = 0;
  for (const name of names) {
    let bytes = await readFile(resolve(frameworkRoot, name));
    if (loaderScriptPattern.test(name)) {
      bytes = inlineRegistry
        ? transformLoaderModuleForRegistry(name, bytes)
        : patchLoaderScript(bytes);
    } else if (name === "blazor.boot.json") {
      bytes = bootConfigBytes;
    }
    files.push({ name, offset, size: bytes.byteLength });
    chunks.push(bytes);
    offset += bytes.byteLength;
  }

  const manifestBytes = Buffer.from(JSON.stringify({ files }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(manifestBytes.byteLength, 0);
  const container = Buffer.concat([header, manifestBytes, ...chunks]);
  return {
    bundle: compression === "gzip" ? gzipSync(container, { level: gzipLevel }) : container,
    fileCount: files.length,
    rawBytes: offset,
    bootConfigBytes
  };
}
