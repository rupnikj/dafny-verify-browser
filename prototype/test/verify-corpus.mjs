import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { dotnet } from "../dist/wwwroot/_framework/dotnet.js";
import { init } from "z3-solver";

// Usage: node test/verify-corpus.mjs <corpus-dir>
// The corpus directory holds .dfy files expected to FAIL verification, plus a
// solutions/ subdirectory of .dfy files expected to verify.
const corpusDir = process.argv[2];
if (!corpusDir) {
  throw new Error("Usage: node test/verify-corpus.mjs <corpus-dir>");
}
const corpusRoot = resolve(corpusDir);
const solutionsRoot = resolve(corpusRoot, "solutions");

async function dafnyFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".dfy"))
    .map(entry => resolve(directory, entry.name))
    .sort();
}

const allCases = [
  ...(await dafnyFiles(corpusRoot)).map(path => ({
    path,
    kind: "challenge",
    expectedVerified: false
  })),
  ...(await dafnyFiles(solutionsRoot)).map(path => ({
    path,
    kind: "solution",
    expectedVerified: true
  }))
];
const caseFilter = process.env.DAFNY_CORPUS_FILTER
  ? new RegExp(process.env.DAFNY_CORPUS_FILTER)
  : null;
const filteredCases = caseFilter
  ? allCases.filter(testCase => caseFilter.test(relative(corpusRoot, testCase.path)))
  : allCases;
const repeatCount = Math.max(1, Number(process.env.DAFNY_CORPUS_REPEAT ?? 1));
const cases = Array.from({ length: repeatCount }, () => filteredCases).flat();

if (cases.length === 0) {
  throw new Error("No Dafny files found under " + corpusRoot);
}

const contexts = new Map();
const z3 = await init();
const runtime = await dotnet.create();

runtime.setModuleImports("dafnyZ3", {
  evaluate: async (solverId, smtLib) => {
    let context = contexts.get(solverId);
    if (!context) {
      const config = z3.Z3.mk_config();
      context = z3.Z3.mk_context_rc(config);
      z3.Z3.del_config(config);
      contexts.set(solverId, context);
    }
    return z3.Z3.eval_smtlib2_string(context, smtLib);
  },
  close: solverId => {
    const context = contexts.get(solverId);
    if (context) {
      z3.Z3.del_context(context);
      contexts.delete(solverId);
    }
  }
});

const config = runtime.getConfig();
await runtime.runMain(config.mainAssemblyName, []);
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
const parse = exports.DafnyBrowser.BrowserApi.Parse;
const verify = exports.DafnyBrowser.BrowserApi.Verify;
const getLastSmtTranscript = exports.DafnyBrowser.BrowserApi.GetLastSmtTranscript;

const results = [];
console.log("browser-WASM corpus regression");
console.log("corpus: " + relative(process.cwd(), corpusRoot));
console.log("cases: " + cases.length + "\n");

try {
  for (const testCase of cases) {
    const source = await readFile(testCase.path, "utf8");
    if (process.env.DAFNY_CORPUS_PREPARSE === "1") {
      await parse(source);
    }
    const started = performance.now();
    let result;
    try {
      result = JSON.parse(await verify(source));
    } catch (error) {
      result = {
        verified: false,
        verifiedCount: 0,
        errorCount: 1,
        stage: "harness-exception",
        smtExchangeCount: 0,
        diagnostics: [{
          severity: "error",
          source: "runtime",
          message: error?.stack ?? String(error)
        }]
      };
    }
    const elapsedSeconds = (performance.now() - started) / 1000;
    const transcript = JSON.parse(getLastSmtTranscript());
    const smtInputHash = createHash("sha256")
      .update(transcript.map(entry => entry.input).join("\u0000"))
      .digest("hex")
      .slice(0, 12);
    const runtimeDiagnostic = result.diagnostics?.find(diagnostic =>
      diagnostic.source === "runtime");
    const reachedVerifier = result.stage === "verification" && !runtimeDiagnostic;
    const matched = result.verified === testCase.expectedVerified &&
      reachedVerifier &&
      (testCase.expectedVerified ? result.errorCount === 0 : result.errorCount > 0);
    const errors = (result.diagnostics ?? []).filter(diagnostic =>
      diagnostic.severity === "error");
    const firstError = errors[0];

    results.push({
      file: relative(corpusRoot, testCase.path),
      kind: testCase.kind,
      expectedVerified: testCase.expectedVerified,
      matched,
      elapsedSeconds,
      smtInputHash,
      openZ3Contexts: contexts.size,
      result
    });

    const verdict = matched ? "PASS" : "FAIL";
    const location = firstError?.line
      ? " @" + firstError.line + ":" + (firstError.column ?? 1)
      : "";
    const detail = firstError
      ? " — " + firstError.message.split("\n", 1)[0]
      : "";
    console.log(
      verdict.padEnd(5) + " " +
      testCase.kind.padEnd(9) + " " +
      basename(testCase.path).padEnd(32) + " " +
      String(result.verified).padEnd(5) + " " +
      String(result.verifiedCount).padStart(3) + " verified  " +
      String(result.errorCount).padStart(3) + " errors  " +
      String(result.smtExchangeCount).padStart(4) + " SMT  " +
      smtInputHash + "  " +
      elapsedSeconds.toFixed(2).padStart(6) + "s" +
      location + detail
    );
  }
} finally {
  for (const context of contexts.values()) {
    z3.Z3.del_context(context);
  }
}

const mismatches = results.filter(result => !result.matched);
const challengeResults = results.filter(result => result.kind === "challenge");
const solutionResults = results.filter(result => result.kind === "solution");
const totalSeconds = results.reduce((sum, result) => sum + result.elapsedSeconds, 0);

console.log("\nsummary");
console.log(JSON.stringify({
  cases: results.length,
  challenges: {
    cases: challengeResults.length,
    expectedFailures: challengeResults.filter(result => result.matched).length,
    mismatches: challengeResults.filter(result => !result.matched).length
  },
  solutions: {
    cases: solutionResults.length,
    verified: solutionResults.filter(result => result.matched).length,
    mismatches: solutionResults.filter(result => !result.matched).length
  },
  totalSeconds: Number(totalSeconds.toFixed(2)),
  mismatches: mismatches.map(result => ({
    file: result.file,
    expectedVerified: result.expectedVerified,
    actualVerified: result.result.verified,
    stage: result.result.stage,
    errorCount: result.result.errorCount,
    errors: result.result.diagnostics?.filter(diagnostic =>
      diagnostic.severity === "error") ?? []
  }))
}, null, 2));

if (mismatches.length > 0) {
  process.exitCode = 1;
}
