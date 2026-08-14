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

async function gate(name, run) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await run(page);
    results.push({ name, ok: true });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, ok: false });
    const detail = (error?.message ?? String(error)) +
      (errors.length ? " | page errors: " + errors.slice(0, 5).join(" | ") : "");
    console.log("FAIL " + name + " — " + detail);
    // Surface the failure as a GitHub annotation (readable via the API even
    // when job logs are not). Annotations are single-line.
    console.log("::error::browser gate failed: " + name + " — " +
      detail.replaceAll("\n", " ⏎ ").slice(0, 800));
  } finally {
    await page.close();
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
});

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

    for (const [example, expectClass] of [["abs", "ok"], ["bad", "bad"], ["max", "ok"]]) {
      await frame.selectOption("#example", example);
      await frame.click("#verify");
      await frame.waitForFunction(
        () => document.querySelector("#verdict").textContent.length > 0,
        undefined, { timeout: BOOT_TIMEOUT });
      const cls = await frame.locator("#verdict").getAttribute("class");
      if (cls !== expectClass) {
        throw new Error(example + ": expected " + expectClass + ", got " + cls +
          " (" + await frame.locator("#verdict").textContent() + ")");
      }
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
