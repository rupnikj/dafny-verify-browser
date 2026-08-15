// Collect single-file candidates from the official Dafny integration test
// suite for differential native-vs-WASM verification. A file qualifies if it
// has no include directive (the browser pipeline is deliberately one
// in-memory file) and is not absurdly large. RUN-line options are ignored on
// purpose: both sides run with identical default options, so any
// feature-diverse program text is a valid differential input regardless of
// what the lit harness would have done with it.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const litRoot = resolve(prototypeRoot,
  "../upstream-dafny/Source/IntegrationTests/TestFiles/LitTests/LitTest");
const MAX_BYTES = 64 * 1024;
const DIRS = [
  "dafny0", "dafny1", "dafny2", "dafny3", "dafny4",
  "git-issues", "triggers", "vstte2012", "verification", "examples",
  "VerifyThis", "ghost", "datatypes"
];

const candidates = [];
let skippedInclude = 0, skippedSize = 0;
for (const dir of DIRS) {
  let entries;
  try {
    entries = await readdir(join(litRoot, dir), { recursive: true, withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".dfy")) continue;
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    if (info.size > MAX_BYTES) { skippedSize++; continue; }
    const text = await readFile(path, "utf8");
    if (/^\s*include\s/m.test(text)) { skippedInclude++; continue; }
    candidates.push(relative(litRoot, path));
  }
}
candidates.sort();
await writeFile(new URL("./candidates.json", import.meta.url),
  JSON.stringify({ litRoot, files: candidates }, null, 1));
console.log(`candidates: ${candidates.length} (skipped ${skippedInclude} with includes, ${skippedSize} oversized)`);
