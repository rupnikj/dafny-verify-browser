// Compare native vs WASM differential results. Agreement levels:
//   exact  — same verdict class, same verified/error counts, same error lines
//   verdict — same verdict class (clean / errors / infrastructure), details differ
//   DISAGREE — verdict classes differ
// Infrastructure outcomes (timeout/hang/crash on either side) are reported
// separately: they are limitations, not verdict disagreements.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

async function loadJsonl(name, statusField) {
  const map = new Map();
  for (const line of (await readFile(join(here, name), "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.status === "start") continue;
    map.set(record.file, record);
  }
  return map;
}

const native = await loadJsonl("native-results.jsonl");
const wasm = await loadJsonl("wasm-results.jsonl");

function nativeClass(r) {
  if (r.status === "timeout") return "infra";
  if (r.verified === null) return "reject";       // parse/resolve failure
  if (r.errors === 0 && r.exitCode === 0) return "clean";
  return "errors";
}
function wasmClass(r) {
  if (r.status !== "done") return "infra";
  if (r.stage === "parse" || r.stage === "resolution" || r.stage === "translation") return "reject";
  if (r.stage === "exception") return "infra";
  if (r.verdict === true && r.errors === 0) return "clean";
  return "errors";
}

const buckets = { exact: [], verdict: [], disagree: [], infra: [] };
for (const [file, n] of native) {
  const w = wasm.get(file);
  if (!w) continue;
  const nc = nativeClass(n), wc = wasmClass(w);
  if (nc === "infra" || wc === "infra") {
    buckets.infra.push({ file, native: nc === "infra" ? (n.status ?? "?") : nc, wasm: wc === "infra" ? (w.status ?? w.stage) : wc, firstError: w.firstError ?? n.firstError });
    continue;
  }
  if (nc !== wc) {
    buckets.disagree.push({ file, native: nc, wasm: wc, nDetail: { v: n.verified, e: n.errors, oor: n.outOfResource, to: n.timeouts }, wDetail: { v: w.verified, e: w.errors, stage: w.stage }, nFirst: n.firstError, wFirst: w.firstError });
    continue;
  }
  const sameCounts = nc === "reject" ||
    (n.verified === w.verified && n.errors === w.errors &&
     JSON.stringify(n.errorLines) === JSON.stringify(w.errorLines));
  (sameCounts ? buckets.exact : buckets.verdict).push({
    file, class: nc,
    nDetail: { v: n.verified, e: n.errors, lines: n.errorLines, oor: n.outOfResource, to: n.timeouts },
    wDetail: { v: w.verified, e: w.errors, lines: w.errorLines }
  });
}

const compared = buckets.exact.length + buckets.verdict.length + buckets.disagree.length;
console.log(JSON.stringify({
  compared,
  infrastructure: buckets.infra.length,
  exactAgreement: buckets.exact.length,
  verdictAgreementDetailDiffer: buckets.verdict.length,
  disagreements: buckets.disagree.length,
  exactRate: compared ? (100 * buckets.exact.length / compared).toFixed(1) + "%" : "n/a",
  verdictRate: compared ? (100 * (buckets.exact.length + buckets.verdict.length) / compared).toFixed(1) + "%" : "n/a"
}, null, 2));
if (buckets.verdict.length) {
  console.log("\n-- verdict agrees, details differ --");
  for (const d of buckets.verdict) console.log(JSON.stringify(d));
}
if (buckets.disagree.length) {
  console.log("\n-- DISAGREEMENTS --");
  for (const d of buckets.disagree) console.log(JSON.stringify(d));
}
if (buckets.infra.length) {
  console.log("\n-- infrastructure (timeout/hang/crash) --");
  for (const d of buckets.infra) console.log(JSON.stringify(d));
}
