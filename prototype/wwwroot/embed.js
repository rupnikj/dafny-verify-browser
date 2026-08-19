// src/embed.js
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
async function encodeShareFragment(source2) {
  const bytes = new TextEncoder().encode(source2);
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

// src/embed.js
var source = document.querySelector("#source");
var verifyButton = document.querySelector("#verify");
var verdict = document.querySelector("#verdict");
var status = document.querySelector("#status");
var problems = document.querySelector("#problems");
var openFull = document.querySelector("#open-full");
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
var fragment = shareFragmentFrom(window.location.hash);
if (fragment) {
  decodeShareFragment(fragment).then((text) => {
    source.value = text;
  }).catch(() => {
    source.value = DEFAULT_PROGRAM;
  });
} else {
  source.value = DEFAULT_PROGRAM;
}
openFull.addEventListener("click", async (event) => {
  event.preventDefault();
  const link = new URL("./", window.location.href).href + "#code=" + await encodeShareFragment(source.value);
  window.open(link, "_blank", "noopener");
});
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
verifyButton.addEventListener("click", async () => {
  verifyButton.disabled = true;
  verdict.textContent = "";
  verdict.className = "";
  problems.replaceChildren();
  try {
    const dafny = await ensureDafny();
    status.textContent = "verifying\u2026";
    const result = await dafny.verify(source.value, { timeLimitSeconds: 0 });
    verdict.textContent = result.verified ? `\u2713 verified (${result.verifiedCount})` : `\u2717 ${result.errorCount} problem${result.errorCount === 1 ? "" : "s"}`;
    verdict.className = result.verified ? "ok" : "bad";
    status.textContent = `${result.stage} \u2022 ${result.smtExchangeCount} SMT exchanges`;
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") continue;
      const item = document.createElement("li");
      item.className = diagnostic.severity;
      const position = diagnostic.line != null ? `${diagnostic.line}:${(diagnostic.column ?? 0) + 1} ` : "";
      item.textContent = position + diagnostic.message;
      problems.append(item);
    }
  } catch (error) {
    verdict.textContent = "\u2717 verifier error";
    verdict.className = "bad";
    status.textContent = String(error?.message ?? error).slice(0, 200);
  } finally {
    verifyButton.disabled = false;
  }
});
//# sourceMappingURL=embed.js.map
