// The anatomy page: one program dissected through the real pipeline —
// Dafny source -> Boogie translation -> SMT verification condition -> Z3
// verdict — computed live in the reader's browser. The program arrives via
// the #code= fragment (same codec as Share links); the verifier boots
// lazily on the Analyze click. Verification runs with readable names
// (normalization off) because this page exists to be read.
import { createDafny } from "./dafny-browser.js";
import { encodeShareFragment, decodeShareFragment, shareFragmentFrom } from "./share-codec.js";
import { dafnyLanguage, boogieLanguage, smtLanguage, createCodeView } from "./code-view.js";

const DEFAULT_PROGRAM = [
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

const stageSource = document.querySelector("#stage-source");
const stageBoogie = document.querySelector("#stage-boogie");
const stageSmt = document.querySelector("#stage-smt");
const stageVerdict = document.querySelector("#stage-verdict");
const analyzeButton = document.querySelector("#analyze");
const status = document.querySelector("#status");

let program = DEFAULT_PROGRAM;
const fragment = shareFragmentFrom(window.location.hash);
const ready = fragment
  ? decodeShareFragment(fragment).then(text => { program = text; }).catch(() => {})
  : Promise.resolve();
const views = {};
function showCode(element, key, language, text) {
  views[key]?.destroy();
  element.textContent = "";
  views[key] = createCodeView(element, language, text);
}

// The source stage is a real editor; edits mark the later stages stale and
// flip the button to Re-analyze.
let analyzedOnce = false;
function markStale() {
  if (!analyzedOnce) return;
  analyzeButton.textContent = "Re-analyze";
  for (const stage of [stageBoogie, stageSmt, stageVerdict]) {
    stage.parentElement.classList.add("stale");
  }
  status.textContent = "the program changed — the stages below show the previous version";
}
ready.then(() => {
  stageSource.textContent = "";
  views.source = createCodeView(stageSource, dafnyLanguage, program,
    { readOnly: false, onDocChanged: markStale });
});
function currentProgram() {
  return views.source ? views.source.state.doc.toString() : program;
}

// Both outbound links carry the current program.
for (const id of ["open-full", "edit-link"]) {
  document.getElementById(id).addEventListener("click", async event => {
    event.preventDefault();
    const link = new URL("./", window.location.href).href +
      "#code=" + await encodeShareFragment(currentProgram());
    window.open(link, "_blank", "noopener");
  });
}

function capLines(text, limit) {
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  return lines.slice(0, limit).join("\n") +
    "\n… (" + (lines.length - limit) + " more lines — see the demo's Under the hood panel)";
}

// The first implementation block of the Boogie program (ends at a
// column-zero closing brace).
function firstImplementation(boogieText) {
  const start = boogieText.indexOf("\nimplementation");
  if (start < 0) return boogieText;
  const end = boogieText.indexOf("\n}", start);
  return boogieText.slice(start + 1, end < 0 ? undefined : end + 2);
}

// The verification condition of the first obligation: from (push 1) in the
// big exchange through the solver's answer to its check-sat.
function firstObligationVc(entries) {
  let vcExchange = null;
  let answer = null;
  let seenProblem = false;
  for (const entry of entries) {
    if (entry.kind === "problem") { seenProblem = true; continue; }
    if (!seenProblem && entry.input.includes("(push 1)")) vcExchange = entry;
    if (seenProblem && entry.input.trim() === "(check-sat)" && answer === null) {
      answer = entry.output.trim();
      break;
    }
  }
  if (!vcExchange) return "no verification condition recorded";
  const vc = vcExchange.input.slice(vcExchange.input.indexOf("(push 1)"));
  return capLines(vc.trim(), 46) +
    "\n\n(check-sat)\n;; Z3 answers: " + (answer ?? "…");
}

let dafnyPromise = null;
function ensureDafny() {
  dafnyPromise ??= createDafny({
    onProgress({ stage, loadedBytes }) {
      const megabytes = (loadedBytes / (1024 * 1024)).toFixed(0);
      status.textContent = loadedBytes > 0 ? `${stage}… ${megabytes} MB` : `${stage}…`;
    }
  });
  return dafnyPromise;
}

analyzeButton.addEventListener("click", async () => {
  analyzeButton.disabled = true;
  try {
    await ready;
    const dafny = await ensureDafny();
    status.textContent = "verifying…";
    const result = await dafny.verify(currentProgram(), { timeLimitSeconds: 0, readableNames: true });
    const boogieText = await dafny.getLastBoogie();
    const entries = await dafny.getLastSmtTranscript();

    const boogieShown = boogieText
      ? capLines(firstImplementation(boogieText), 60)
      : "// no translation recorded (does the program parse?)";
    showCode(stageBoogie, "boogie", boogieLanguage, boogieShown);
    stageBoogie.parentElement.classList.remove("pending");

    const smtShown = Array.isArray(entries) && entries.length
      ? firstObligationVc(entries)
      : ";; no SMT exchange recorded (nothing needed proving, or verification stopped earlier)";
    showCode(stageSmt, "smt", smtLanguage, smtShown);
    stageSmt.parentElement.classList.remove("pending");
    // CodeMirror virtualizes; tooling asserts on these instead of the DOM.
    window.__anatomy = { boogie: boogieShown, smt: smtShown };

    const line = document.createElement("div");
    line.className = "verdict-line " + (result.verified ? "ok" : "bad");
    line.textContent = result.verified
      ? `unsat → verified: ${result.verifiedCount} obligation(s), no counterexample can exist`
      : `✗ not verified: ${result.errorCount} problem(s) — the solver found (or could not rule out) a violating execution`;
    stageVerdict.replaceChildren(line);
    const detail = document.createElement("div");
    detail.textContent = `stage: ${result.stage} • ${result.smtExchangeCount} SMT exchanges • ` +
      `all computed in this browser tab`;
    stageVerdict.append(detail);
    stageVerdict.parentElement.classList.remove("pending");

    analyzedOnce = true;
    analyzeButton.textContent = "Analyze";
    for (const stage of [stageBoogie, stageSmt, stageVerdict]) {
      stage.parentElement.classList.remove("stale");
    }
    status.textContent = "done";
  } catch (error) {
    status.textContent = "failed: " + String(error?.message ?? error).slice(0, 200);
  } finally {
    analyzeButton.disabled = false;
  }
});
