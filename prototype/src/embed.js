// The embeddable widget: a compact verify-this-program page meant to live in
// an iframe on blogs and course pages (see the demo's Embed button for the
// snippet). The program arrives in the #code= URL fragment; the verifier
// boots lazily on the first Verify click so embeds cost nothing to page
// visitors who don't use them.
//
// Inside a third-party iframe the page is NOT cross-origin isolated (that
// would require COOP/COEP on the embedding page itself), so the verification
// worker falls back to the single-threaded z3-st solver, which needs no
// SharedArrayBuffer. Same Dafny, same Boogie, same SMT bytes — just slower.
import { createDafny } from "./dafny-browser.js";
import { encodeShareFragment, decodeShareFragment, shareFragmentFrom } from "./share-codec.js";

const source = document.querySelector("#source");
const verifyButton = document.querySelector("#verify");
const verdict = document.querySelector("#verdict");
const status = document.querySelector("#status");
const problems = document.querySelector("#problems");
const openFull = document.querySelector("#open-full");

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

const fragment = shareFragmentFrom(window.location.hash);
if (fragment) {
  decodeShareFragment(fragment)
    .then(text => { source.value = text; })
    .catch(() => { source.value = DEFAULT_PROGRAM; });
} else {
  source.value = DEFAULT_PROGRAM;
}

openFull.addEventListener("click", async event => {
  event.preventDefault();
  const link = new URL("./", window.location.href).href +
    "#code=" + await encodeShareFragment(source.value);
  window.open(link, "_blank", "noopener");
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

// Enabled only once this module is wired up — the static button would
// otherwise swallow clicks that arrive before the script loads.
verifyButton.disabled = false;

verifyButton.addEventListener("click", async () => {
  verifyButton.disabled = true;
  verdict.textContent = "";
  verdict.className = "";
  problems.replaceChildren();
  try {
    const dafny = await ensureDafny();
    status.textContent = "verifying…";
    const result = await dafny.verify(source.value, { timeLimitSeconds: 0 });
    verdict.textContent = result.verified
      ? `✓ verified (${result.verifiedCount})`
      : `✗ ${result.errorCount} problem${result.errorCount === 1 ? "" : "s"}`;
    verdict.className = result.verified ? "ok" : "bad";
    status.textContent = `${result.stage} • ${result.smtExchangeCount} SMT exchanges`;
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") continue;
      const item = document.createElement("li");
      item.className = diagnostic.severity;
      const position = diagnostic.line != null ? `${diagnostic.line}:${(diagnostic.column ?? 0) + 1} ` : "";
      item.textContent = position + diagnostic.message;
      problems.append(item);
    }
  } catch (error) {
    verdict.textContent = "✗ verifier error";
    verdict.className = "bad";
    status.textContent = String(error?.message ?? error).slice(0, 200);
  } finally {
    verifyButton.disabled = false;
  }
});
