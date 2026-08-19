// Real-browser gates for both tiers. Requires a built dist (npm run build).
// Runs the demo page (threaded tier, worker + COI), the inline-boot page
// (Phase 1: zero-network .NET boot), and — when the single-file artifact has
// been built — the artifact page (single-threaded tier).
//
// Usage: node test/browser/gates.mjs  (spawns server.mjs on a scratch port)
import { spawn } from "node:child_process";
import { copyFile, access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 4199);
const base = `http://localhost:${port}`;
const BOOT_TIMEOUT = 240000;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Regenerate the Phase 1 page and stage the artifact copy if one was built.
const { execFileSync } = await import("node:child_process");
execFileSync(process.execPath, [resolve(prototypeRoot, "tools/make-inline-bundle.mjs")], { stdio: "inherit" });
const artifactSource = resolve(prototypeRoot, "dist/dafny-artifact.html");
const artifactStaged = resolve(prototypeRoot, "dist/wwwroot/dafny-artifact.html");
const withArtifact = await exists(artifactSource);
if (withArtifact) {
  await copyFile(artifactSource, artifactStaged);
} else {
  console.log("note: dist/dafny-artifact.html not built — skipping the artifact gate");
}
const singleFileSource = resolve(prototypeRoot, "dist/dafny-verify.html");
const withSingleFile = await exists(singleFileSource);
if (withSingleFile) {
  await copyFile(singleFileSource, resolve(prototypeRoot, "dist/wwwroot/dafny-verify.html"));
} else {
  console.log("note: dist/dafny-verify.html not built — skipping the single-file gate");
}

const server = spawn(process.execPath, [resolve(prototypeRoot, "server.mjs")], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore"
});
for (let attempt = 0; ; attempt++) {
  try {
    await fetch(base + "/index.html", { method: "HEAD" });
    break;
  } catch {
    if (attempt > 50) throw new Error("server.mjs did not come up on port " + port);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
}

const browser = await chromium.launch();
const results = [];

// retries: the threaded tier's worker boot (pthread spawn under CPU
// contention) occasionally strands one run — observed on CI runners and
// locally, never twice in a row. A retried pass is logged; failing both
// attempts fails the gate, so real regressions still surface.
async function gate(name, run, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await run(page);
      results.push({ name, ok: true });
      console.log("PASS " + name + (attempt > 0 ? ` (attempt ${attempt + 1})` : ""));
      return;
    } catch (error) {
      const detail = (error?.message ?? String(error)) +
        (errors.length ? " | page errors: " + errors.slice(0, 5).join(" | ") : "");
      if (attempt < retries) {
        console.log("RETRY " + name + " — " + detail.split("\n")[0]);
        continue;
      }
      results.push({ name, ok: false });
      console.log("FAIL " + name + " — " + detail);
      // Surface the failure as a GitHub annotation (readable via the API even
      // when job logs are not). Annotations are single-line.
      console.log("::error::browser gate failed: " + name + " — " +
        detail.replaceAll("\n", " ⏎ ").slice(0, 800));
      return;
    } finally {
      await page.close();
    }
  }
}

// Threaded tier: the real demo page through the worker, verifying and failing.
await gate("demo: threaded tier verifies Abs and rejects Bad", async page => {
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#runtime-label")?.textContent === "Verifier ready",
    undefined, { timeout: BOOT_TIMEOUT });
  await page.click("#verify");
  await page.waitForSelector(".result-summary.is-success", { timeout: BOOT_TIMEOUT });
  await page.selectOption("#example", "bad");
  await page.click("#verify");
  await page.waitForSelector(".result-summary.is-error", { timeout: BOOT_TIMEOUT });
  await page.waitForSelector(".cex-constraint", { timeout: 30000 });
  const constraints = await page.locator(".cex-constraint").allTextContents();
  if (!constraints.some(text => /==/.test(text))) {
    throw new Error("counterexample constraints missing: " + constraints.join(", "));
  }
  const ghosts = await page.locator(".cm-cex-ghost").count();
  if (ghosts === 0) {
    throw new Error("no in-editor counterexample ghosts rendered");
  }
  // Tutorial tab: chapters load and the first runnable block produces a
  // verdict matching the upstream tutorial's expectation.
  await page.click("#tutorial-toggle");
  await page.waitForSelector(".tutorial-run", { timeout: 30000 });
  const chapters = await page.locator("#tutorial-chapter option").count();
  if (chapters !== 7) {
    throw new Error("expected 7 tutorial chapters, got " + chapters);
  }
  await page.locator(".tutorial-run").first().click();
  await page.waitForFunction(() => {
    const badge = document.querySelector(".tutorial-badge");
    return badge && badge.textContent.length > 0 && !badge.textContent.includes("verifying");
  }, undefined, { timeout: 120000 });
  const verdict = await page.locator(".tutorial-badge").first().textContent();
  if (verdict.includes("differs") || verdict.includes("error")) {
    throw new Error("tutorial first block verdict unexpected: " + verdict);
  }
  // With tutorial mode on, verifying from the editor must still show the
  // problems panel alongside (the regression this layout replaced).
  await page.selectOption("#example", "bad");
  await page.click("#verify");
  await page.waitForSelector(".result-summary.is-error", { timeout: BOOT_TIMEOUT });
  const problemsVisible = await page.locator("#problems-view:not([hidden])").count();
  const tutorialVisible = await page.locator("#tutorial-pane:not([hidden])").count();
  if (problemsVisible !== 1 || tutorialVisible !== 1) {
    throw new Error("tutorial mode layout broken: problems=" + problemsVisible + " tutorial=" + tutorialVisible);
  }
  await page.click("#tutorial-toggle");
  // Run: verify → compile to JS → execute Main in a throwaway worker.
  await page.selectOption("#example", "fastfib");
  await page.click("#run");
  await page.waitForSelector(".result-summary.is-success", { timeout: BOOT_TIMEOUT });
  const runText = await page.locator("#run-output").textContent();
  if (!runText.includes("Fib(40) = 102334155")) {
    throw new Error("run output missing Fib(40): " + runText.slice(-400));
  }
  // The JS tab shows the compiled program (runtime stripped, specs erased) in
  // a CodeMirror; it virtualizes long documents, so assert on the data hook
  // plus one rendered highlight.
  const jsState = await page.evaluate(() => ({
    hasMain: window.__compiledJs?.includes("static Main"),
    runtimeStripped: !window.__compiledJs?.includes("HaltException = class")
  }));
  if (!jsState.hasMain || !jsState.runtimeStripped) {
    throw new Error("JS tab wrong: " + JSON.stringify(jsState));
  }
  await page.click("#js-tab");
  await page.waitForSelector("#js-view .cm-editor", { timeout: 10000 });
  // "Copy runnable script" must produce text that actually runs when pasted
  // into a console: eval it in the page and capture console.log output.
  await page.click("#js-copy-runnable");
  await page.waitForFunction(() => typeof window.__runnableJs === "string", undefined, { timeout: 10000 });
  const consoleRun = await page.evaluate(() => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      (0, eval)(window.__runnableJs);
    } catch (error) {
      lines.push("THREW: " + error.message);
    } finally {
      console.log = original;
    }
    return lines;
  });
  if (!consoleRun.some(line => line.includes("Fib(40) = 102334155"))) {
    throw new Error("runnable script console output wrong: " + consoleRun.slice(0, 5).join(" | "));
  }
  // SMT tab: the transcript of the last verification, rendered as SMT-LIB.
  await page.click("#smt-tab");
  await page.waitForSelector("#smt-view .cm-editor", { timeout: 30000 });
  const smtText = await page.evaluate(() => window.__smtText ?? "");
  if (!smtText.includes("(check-sat)") || !smtText.includes("proof obligation")) {
    throw new Error("SMT transcript missing expected content (len " + smtText.length + ")");
  }
  // Share: the permalink reopens the exact program in a fresh page load.
  await page.click("#share");
  await page.waitForFunction(() => typeof window.__shareUrl === "string", undefined, { timeout: 10000 });
  const shareUrl = await page.evaluate(() => window.__shareUrl);
  if (!shareUrl.includes("#code=dfl:")) {
    throw new Error("share URL malformed: " + shareUrl.slice(0, 120));
  }
  await page.goto(shareUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#runtime-label")?.textContent === "Verifier ready",
    undefined, { timeout: BOOT_TIMEOUT });
  const restored = await page.locator("#editor .cm-content").textContent();
  if (!restored.includes("FastFib")) {
    throw new Error("shared program not restored from the URL fragment");
  }
  // Live mode: an edit re-verifies automatically — no Verify click.
  await page.click("#live-toggle");
  await page.click("#editor .cm-content");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nmethod Broken() ensures false {}");
  await page.waitForSelector(".result-summary.is-error", { timeout: BOOT_TIMEOUT });
  console.log("  run/JS/copy, SMT transcript, share permalink, live mode: all verified");
}, { retries: 1 });

// Inline tier Phase 1: .NET boots from the in-page store with zero
// /_framework/ requests (the page computes its own verdict in the title).
await gate("inline-boot: zero-network .NET boot verifies", async page => {
  await page.goto(base + "/inline-test/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.title.startsWith("PASS") || document.title.startsWith("FAIL"),
    undefined, { timeout: BOOT_TIMEOUT });
  const title = await page.title();
  if (!title.startsWith("PASS")) {
    throw new Error(await page.locator("#log").textContent());
  }
});

// Single-threaded tier: the assembled artifact, hosted the way the hostile
// sandbox hosts it — inside a srcdoc iframe (base URI about:srcdoc) under a
// CSP that blocks script URLs of every scheme (blob:, data:, http) and all
// network fetches except data:. A localhost page without these restrictions
// would pass builds that fail in the real sandbox.
if (withArtifact) {
  const artifactHtml = await readFile(artifactSource, "utf8");
  const wrapper = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src data:; worker-src 'none'; object-src 'none'">
<title>artifact sandbox wrapper</title></head>
<body style="margin:0">
<iframe id="host" style="width:100vw;height:100vh;border:0" srcdoc="${
    artifactHtml.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>
</body></html>`;
  await writeFile(resolve(prototypeRoot, "dist/wwwroot/artifact-sandbox-wrapper.html"), wrapper);

  await gate("artifact: srcdoc+CSP sandbox verdicts (abs/bad/max)", async page => {
    const requests = [];
    page.on("request", request => {
      const url = request.url();
      if (!url.startsWith("data:") && !url.includes("artifact-sandbox-wrapper.html")) {
        requests.push(url);
      }
    });
    await page.goto(base + "/artifact-sandbox-wrapper.html", { waitUntil: "domcontentloaded" });
    const host = await page.waitForSelector("#host");
    const frame = await host.contentFrame();
    await frame.waitForFunction(
      () => document.querySelector("#status")?.textContent.startsWith("ready") ||
            document.querySelector("#status")?.classList.contains("err"),
      undefined, { timeout: BOOT_TIMEOUT });
    const bootStatus = await frame.locator("#status").textContent();
    if (!bootStatus.startsWith("ready")) throw new Error(bootStatus);
    const transportName = await frame.evaluate(() => globalThis.__dafnyTransportName);
    console.log("  transport: " + transportName);

    for (const [example, expectClass] of [["abs", "ok"], ["bad", "bad"], ["max", "ok"]]) {
      await frame.selectOption("#example", example);
      await frame.click("#verify");
      await frame.waitForFunction(
        () => document.querySelector("#verdict").textContent.length > 0,
        undefined, { timeout: BOOT_TIMEOUT });
      const cls = await frame.locator("#verdict").getAttribute("class");
      const verdictText = await frame.locator("#verdict").textContent();
      if (cls !== expectClass) {
        throw new Error(example + ": expected " + expectClass + ", got " + cls +
          " (" + verdictText + ")");
      }
      const timing = verdictText.match(/(\d+) SMT exchanges, ([\d.]+)s/);
      if (timing) {
        const totalMs = Number(timing[2]) * 1000;
        console.log(`  ${example}: ${timing[1]} exchanges, ${Math.round(totalMs)} ms, ` +
          `${(totalMs / Number(timing[1])).toFixed(1)} ms/exchange`);
      }
    }
    if (requests.length) {
      throw new Error("unexpected network requests: " + requests.slice(0, 5).join(", "));
    }
    // Context-leak check: after three verifications every session must be
    // closed (the replay transport has no counter; undefined passes).
    const openSessions = await frame.evaluate(
      () => globalThis.__dafnyTransport?.openSessionCount);
    if (openSessions !== undefined && openSessions !== 0) {
      throw new Error("leaked solver sessions after verifications: " + openSessions);
    }
  });
}

// Full-UI single file: boots without any network fetch, full demo flow.
if (withSingleFile) {
  await gate("single-file: full demo UI boots and verifies (dafny-verify.html)", async page => {
    const requests = [];
    page.on("request", request => {
      const url = request.url();
      // blob: is the runner worker's own script — in-memory, not network.
      if (!url.startsWith("data:") && !url.startsWith("blob:") && !url.includes("dafny-verify.html")) requests.push(url);
    });
    await page.goto(base + "/dafny-verify.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#runtime-label")?.textContent === "Verifier ready",
      undefined, { timeout: BOOT_TIMEOUT });
    await page.selectOption("#example", "bad");
    await page.click("#verify");
    await page.waitForSelector(".result-summary.is-error", { timeout: BOOT_TIMEOUT });
    await page.waitForSelector(".cex-constraint", { timeout: 30000 });
    await page.click("#tutorial-toggle");
    await page.waitForSelector(".tutorial-code", { timeout: 30000 });
    await page.click("#tutorial-toggle");
    // Run works from the inline payloads too (bignumber-src is embedded).
    await page.selectOption("#example", "fastfib");
    await page.click("#run");
    await page.waitForSelector(".result-summary.is-success", { timeout: BOOT_TIMEOUT });
    const runText = await page.locator("#run-output").textContent();
    if (!runText.includes("Fib(40) = 102334155")) {
      throw new Error("single-file run output missing Fib(40): " + runText.slice(-400));
    }
    if (requests.length) {
      throw new Error("unexpected network requests: " + requests.slice(0, 5).join(", "));
    }
  });
}

await browser.close();
server.kill();
const failed = results.filter(result => !result.ok);
console.log(failed.length === 0
  ? "\nBROWSER GATES: PASS (" + results.length + ")"
  : "\nBROWSER GATES: FAIL (" + failed.length + "/" + results.length + ")");
process.exit(failed.length === 0 ? 0 : 1);
