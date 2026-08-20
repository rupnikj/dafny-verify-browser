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
const PANE_LIMIT = 2000; // the panes scroll; this only guards pathological programs

// The first implementation block of the Boogie program (ends at a
// column-zero closing brace).
function firstImplementation(boogieText) {
  const start = boogieText.indexOf("\nimplementation");
  if (start < 0) return boogieText;
  const end = boogieText.indexOf("\n}", start);
  return boogieText.slice(start + 1, end < 0 ? undefined : end + 2);
}

// One record per proof obligation. The transport transmits each
// obligation's setup and VC BEFORE announcing it, so the VC is the last
// pending exchange containing (push 1); check-sat and (on failure)
// get-model follow the announcement.
function parseObligations(entries) {
  const obligations = [];
  const pending = [];
  let current = null;
  for (const entry of entries) {
    if (entry.kind === "problem") {
      current = { name: entry.input, vc: null, answer: null, model: null };
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].input.includes("(push 1)")) { current.vc = pending[i]; break; }
      }
      obligations.push(current);
      pending.length = 0;
      continue;
    }
    if (current && entry.input.trim() === "(check-sat)" && current.answer === null) {
      current.answer = entry.output.trim();
      continue;
    }
    if (current && entry.input.trim() === "(get-model)" && current.model === null) {
      current.model = entry.output;
      continue;
    }
    pending.push(entry);
  }
  return obligations;
}

function obligationLabel(name) {
  const [kind, path] = name.split("$$");
  let tail = (path ?? name).split(".").pop();
  let suffix = "";
  const split = tail.match(/^(.*)_split(\d+)$/);
  if (split) {
    tail = split[1];
    suffix = " · part " + split[2];
  }
  const kindLabel = kind === "Impl" ? "correctness"
    : kind === "CheckWellformed" ? "well-formedness"
    : kind;
  return tail + " — " + kindLabel + suffix;
}

function obligationVcText(obligation) {
  if (!obligation?.vc) return ";; no verification condition recorded";
  const vc = obligation.vc.input.slice(obligation.vc.input.indexOf("(push 1)"));
  return capLines(vc.trim(), PANE_LIMIT) +
    "\n\n(check-sat)\n;; Z3 answers: " + (obligation.answer ?? "…");
}

let obligations = [];
let latestDiagnostics = [];

// The SMT pane and the counterexample chapter follow the picked obligation:
// each obligation is checked in its own solver session, and a model is a
// witness against that one claim.
function renderPickedObligation() {
  const picker = document.querySelector("#obligation-pick");
  const obligation = obligations[Number(picker.value)] ?? obligations[0];
  const smtShown = obligation
    ? obligationVcText(obligation)
    : ";; no SMT exchange recorded (nothing needed proving, or verification stopped earlier)";
  showCode(stageSmt, "smt", smtLanguage, smtShown);
  window.__anatomy = { ...(window.__anatomy ?? {}), smt: smtShown };

  const modelSection = document.querySelector("#model-section");
  if (obligation?.model) {
    modelSection.hidden = false;
    showCode(document.querySelector("#stage-model"), "model", smtLanguage,
      capLines(obligation.model.trim(), PANE_LIMIT));
    const states = latestDiagnostics.flatMap(diagnostic => diagnostic.counterexample ?? []);
    document.querySelector("#stage-cex").textContent = states.length > 0
      ? states.map(state =>
          `${state.name}${state.line ? " (line " + state.line + ")" : ""}:\n  ${state.assumption}`).join("\n")
      : "no source-level interpretation available for this failure";
  } else {
    modelSection.hidden = true;
  }
}
document.querySelector("#obligation-pick").addEventListener("change", renderPickedObligation);
document.querySelector("#anatomy-isolate").addEventListener("change", () => {
  const isolate = document.querySelector("#anatomy-isolate");
  if (analyzeButton.disabled) {
    isolate.checked = !isolate.checked;
    return;
  }
  analyzeButton.click();
});

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
    const result = await dafny.verify(currentProgram(), {
      timeLimitSeconds: 0,
      readableNames: true,
      counterexamples: true,
      isolateAssertions: document.querySelector("#anatomy-isolate").checked
    });
    const boogieText = await dafny.getLastBoogie();
    const entries = await dafny.getLastSmtTranscript();

    const boogieShown = boogieText
      ? capLines(firstImplementation(boogieText), PANE_LIMIT)
      : "// no translation recorded (does the program parse?)";
    showCode(stageBoogie, "boogie", boogieLanguage, boogieShown);
    stageBoogie.parentElement.classList.remove("pending");

    obligations = Array.isArray(entries) ? parseObligations(entries) : [];
    const picker = document.querySelector("#obligation-pick");
    picker.replaceChildren();
    for (const [index, obligation] of obligations.entries()) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = obligationLabel(obligation.name) +
        (obligation.answer && obligation.answer !== "unsat" ? " — fails" : "");
      option.title = obligation.name;
      picker.append(option);
    }
    document.querySelector("#obligation-row").hidden = obligations.length === 0;
    // Default to the first failing obligation (the interesting world), else
    // the first.
    const firstFailing = obligations.findIndex(o => o.answer && o.answer !== "unsat");
    picker.value = String(firstFailing >= 0 ? firstFailing : 0);
    latestDiagnostics = result.diagnostics ?? [];
    window.__anatomy = { boogie: boogieShown };
    renderPickedObligation();
    stageSmt.parentElement.classList.remove("pending");

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
