// Native side of the differential suite: run each candidate through the
// DafnyDriver built from the SAME pinned commit as the WASM bundle, with the
// same effective options (verify, one core). Incremental JSONL output;
// resumable (already-recorded files are skipped).
import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(here, "../..");
let { litRoot, files } = JSON.parse(await readFile(join(here, "candidates.json"), "utf8"));
if (process.env.DIFF_LIMIT) {
  const step = Math.max(1, Math.floor(files.length / Number(process.env.DIFF_LIMIT)));
  files = files.filter((_, i) => i % step === 0);
}
const outPath = join(here, "native-results.jsonl");
const dotnet = process.env.DAFNY_BROWSER_DOTNET ?? "dotnet";
const driver = resolve(prototypeRoot, "../upstream-dafny/Binaries/net8.0/DafnyDriver.dll");
const TIMEOUT_MS = 90000;

const done = new Set();
try {
  for (const line of (await readFile(outPath, "utf8")).split("\n")) {
    if (line.trim()) done.add(JSON.parse(line).file);
  }
} catch {}

function parseOutput(stdout) {
  const finished = stdout.match(
    /finished with (\d+) verified, (\d+) errors?(?:, (\d+) inconclusives?)?(?:, (\d+) time outs?)?(?:, (\d+) out of resource)?/);
  const errorLines = [...stdout.matchAll(/\((\d+),\d+\): Error/g)].map(m => Number(m[1]));
  return {
    verified: finished ? Number(finished[1]) : null,
    errors: finished ? Number(finished[2]) : null,
    inconclusive: finished ? Number(finished[3] ?? 0) : null,
    timeouts: finished ? Number(finished[4] ?? 0) : null,
    outOfResource: finished ? Number(finished[5] ?? 0) : null,
    errorLines: [...new Set(errorLines)].sort((a, b) => a - b),
    firstError: (stdout.match(/\(\d+,\d+\): Error[^\n]*/) ?? [null])[0]
  };
}

function runOne(path) {
  return new Promise(resolveRun => {
    const child = spawn(dotnet, [driver, "verify", "--cores:1", "--allow-warnings", path]);
    let stdout = "", timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stdout += chunk; });
    child.on("close", exitCode => {
      clearTimeout(killer);
      resolveRun({ exitCode, timedOut, stdout });
    });
  });
}

let index = 0;
for (const file of files) {
  index++;
  if (done.has(file)) continue;
  const started = Date.now();
  const { exitCode, timedOut, stdout } = await runOne(join(litRoot, file));
  const record = {
    file,
    exitCode,
    status: timedOut ? "timeout" : "done",
    seconds: (Date.now() - started) / 1000,
    ...parseOutput(stdout)
  };
  await appendFile(outPath, JSON.stringify(record) + "\n");
  if (index % 25 === 0) console.log(`native ${index}/${files.length}`);
}
console.log("native runner complete");
