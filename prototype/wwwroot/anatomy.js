// src/anatomy.js
import { createDafny } from "./dafny-browser.js";

// src/share-codec.js
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlToBytes(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}
async function encodeShareFragment(source) {
  const bytes = new TextEncoder().encode(source);
  if (typeof CompressionStream !== "function") {
    return "raw:" + bytesToBase64Url(bytes);
  }
  const deflated = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  ).arrayBuffer());
  return "dfl:" + bytesToBase64Url(deflated);
}
async function decodeShareFragment(fragment2) {
  const split = fragment2.indexOf(":");
  const format = fragment2.slice(0, split);
  const bytes = base64UrlToBytes(fragment2.slice(split + 1));
  if (format === "raw") {
    return new TextDecoder().decode(bytes);
  }
  if (format !== "dfl" || typeof DecompressionStream !== "function") {
    throw new Error("unsupported share-link format: " + format);
  }
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  ).text();
}
function shareFragmentFrom(hash) {
  const match = hash.match(/^#code=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// src/anatomy.js
var DEFAULT_PROGRAM = [
  "method Abs(x: int) returns (y: int)",
  "  ensures y >= 0",
  "{",
  "  if x < 0 {",
  "    y := -x;",
  "  } else {",
  "    y := x;",
  "  }",
  "}"
].join("\n");
var stageSource = document.querySelector("#stage-source");
var stageBoogie = document.querySelector("#stage-boogie");
var stageSmt = document.querySelector("#stage-smt");
var stageVerdict = document.querySelector("#stage-verdict");
var analyzeButton = document.querySelector("#analyze");
var status = document.querySelector("#status");
var program = DEFAULT_PROGRAM;
var fragment = shareFragmentFrom(window.location.hash);
var ready = fragment ? decodeShareFragment(fragment).then((text) => {
  program = text;
}).catch(() => {
}) : Promise.resolve();
ready.then(() => {
  stageSource.textContent = program;
});
for (const id of ["open-full", "edit-link"]) {
  document.getElementById(id).addEventListener("click", async (event) => {
    event.preventDefault();
    const link = new URL("./", window.location.href).href + "#code=" + await encodeShareFragment(program);
    window.open(link, "_blank", "noopener");
  });
}
function capLines(text, limit) {
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  return lines.slice(0, limit).join("\n") + "\n\u2026 (" + (lines.length - limit) + " more lines \u2014 see the demo's Under the hood panel)";
}
function firstImplementation(boogieText) {
  const start = boogieText.indexOf("\nimplementation");
  if (start < 0) return boogieText;
  const end = boogieText.indexOf("\n}", start);
  return boogieText.slice(start + 1, end < 0 ? void 0 : end + 2);
}
function firstObligationVc(entries) {
  let vcExchange = null;
  let answer = null;
  let seenProblem = false;
  for (const entry of entries) {
    if (entry.kind === "problem") {
      seenProblem = true;
      continue;
    }
    if (!seenProblem && entry.input.includes("(push 1)")) vcExchange = entry;
    if (seenProblem && entry.input.trim() === "(check-sat)" && answer === null) {
      answer = entry.output.trim();
      break;
    }
  }
  if (!vcExchange) return "no verification condition recorded";
  const vc = vcExchange.input.slice(vcExchange.input.indexOf("(push 1)"));
  return capLines(vc.trim(), 46) + "\n\n(check-sat)\n;; Z3 answers: " + (answer ?? "\u2026");
}
var dafnyPromise = null;
function ensureDafny() {
  dafnyPromise ??= createDafny({
    onProgress({ stage, loadedBytes }) {
      const megabytes = (loadedBytes / (1024 * 1024)).toFixed(0);
      status.textContent = loadedBytes > 0 ? `${stage}\u2026 ${megabytes} MB` : `${stage}\u2026`;
    }
  });
  return dafnyPromise;
}
analyzeButton.addEventListener("click", async () => {
  analyzeButton.disabled = true;
  try {
    await ready;
    const dafny = await ensureDafny();
    status.textContent = "verifying\u2026";
    const result = await dafny.verify(program, { timeLimitSeconds: 0, readableNames: true });
    const boogieText = await dafny.getLastBoogie();
    const entries = await dafny.getLastSmtTranscript();
    stageBoogie.textContent = boogieText ? capLines(firstImplementation(boogieText), 60) : "no translation recorded (does the program parse?)";
    stageBoogie.parentElement.classList.remove("pending");
    stageSmt.textContent = Array.isArray(entries) && entries.length ? firstObligationVc(entries) : "no SMT exchange recorded (nothing needed proving, or verification stopped earlier)";
    stageSmt.parentElement.classList.remove("pending");
    const line = document.createElement("div");
    line.className = "verdict-line " + (result.verified ? "ok" : "bad");
    line.textContent = result.verified ? `unsat \u2192 verified: ${result.verifiedCount} obligation(s), no counterexample can exist` : `\u2717 not verified: ${result.errorCount} problem(s) \u2014 the solver found (or could not rule out) a violating execution`;
    stageVerdict.replaceChildren(line);
    const detail = document.createElement("div");
    detail.textContent = `stage: ${result.stage} \u2022 ${result.smtExchangeCount} SMT exchanges \u2022 all computed in this browser tab`;
    stageVerdict.append(detail);
    stageVerdict.parentElement.classList.remove("pending");
    status.textContent = "done \u2014 every pane above is live output";
  } catch (error) {
    status.textContent = "failed: " + String(error?.message ?? error).slice(0, 200);
  } finally {
    analyzeButton.disabled = false;
  }
});
//# sourceMappingURL=anatomy.js.map
