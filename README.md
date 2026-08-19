# dafny-verify-browser

[![Build and deploy to Pages](https://github.com/rupnikj/dafny-verify-browser/actions/workflows/deploy.yml/badge.svg)](https://github.com/rupnikj/dafny-verify-browser/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`dafny verify` — and now `dafny run` — entirely in the browser: the real
Dafny 4.11.0 frontend and Boogie 3.5.5 compiled to .NET WebAssembly, driving
the official Z3 WebAssembly build. No verifier service, no native Z3, and
the source you type never leaves the page.

**Live demo:** <https://rupnikj.github.io/dafny-verify-browser/> — includes
an interactive **Tutorial** tab: the classic Dafny guide (formerly on
rise4fun) with 150+ runnable examples verified in-browser, plus
counterexample traces on failing programs — and a **Run** button that
verifies, compiles to JavaScript, and executes `Main` right on the page.
Also aboard: **Share** links that carry the program in the URL fragment
(never sent to a server — it verifies live in the recipient's browser),
a **Live** mode that re-verifies as you type, a **JS** tab showing what
the verified program compiles to, an **SMT** tab with the actual
SMT-LIB conversation between Boogie and Z3 (with a purpose-built SMT-LIB
syntax mode), and light/dark **themes** following the system preference,
overridable in settings.

The first load downloads the whole verifier (~95 MB raw — a .NET runtime, 223
managed assemblies, and a 33 MB Z3), so give it a moment; subsequent visits
are served from the browser cache.

## Why this is interesting

Dafny verification normally requires a native toolchain: the .NET-based Dafny
frontend translates to Boogie, Boogie generates verification conditions, and a
native Z3 *process* discharges them over stdin/stdout. The finding documented
in [`docs/investigation.md`](docs/investigation.md) is that the process
boundary is the **only** genuinely native dependency — and Boogie already
abstracts it behind a replaceable seam. Nothing in Dafny-to-Boogie
translation, VC generation, or the SMT encoding needed to change.

## How it works

```
┌─────────────────────────── Web Worker ────────────────────────────┐
│                                                                   │
│  .NET browser-wasm                          Z3 4.16.0 WASM         │
│  ┌─────────────────────────────┐            ┌────────────────┐    │
│  │ Dafny parse → resolve →     │  SMT-LIB   │ eval_smtlib2_  │    │
│  │ Boogie translate → VC gen   │ ─────────► │ string on one  │    │
│  │                             │ ◄───────── │ Z3 context     │    │
│  │ BrowserSmtSolver            │  s-exprs   │ (pthreads)     │    │
│  └─────────────────────────────┘            └────────────────┘    │
│                    bridged by ~20 lines of JS                     │
└───────────────────────────────────────────────────────────────────┘
```

Three pieces:

1. **Dafny + Boogie on .NET browser-wasm, unmodified.**
   [`prototype/DafnyBrowser.csproj`](prototype/DafnyBrowser.csproj) references
   upstream `DafnyCore` directly. [`prototype/Program.cs`](prototype/Program.cs)
   exposes `Parse` / `Verify` / `CompileToJs` / `GetLastSmtTranscript` via `[JSExport]` and
   drives Dafny's internal pipeline (`ProgramParser.Parse` →
   `ProgramResolver.Resolve` → `BoogieGenerator.Translate` →
   `DafnyMain.BoogieOnce`), skipping the CLI and language-server layers.

2. **The official Z3 WASM build** from the `z3-solver` npm package. Its
   `eval_smtlib2_string` API preserves declarations and push/pop state across
   calls on a single context, so batch string evaluation stands in for an
   interactive stdin/stdout session.

3. **[`BrowserSmtSolver.cs`](prototype/BrowserSmtSolver.cs) — the entire
   bridge.** It subclasses Boogie's existing abstract `SMTLibSolver` (the same
   interface the native process transport implements) and is injected through
   the public `options.CreateSolver` factory. Boogie still produces every byte
   of SMT-LIB itself, which is why results match native Dafny exactly — the
   test harness even hashes the SMT transcript per file to detect drift.

Upstream changes amount to a **77-line patch**
([`patches/dafny-browser-compat.patch`](patches/dafny-browser-compat.patch)):
use the default task scheduler on browser (WASM cannot create
custom-stack threads), avoid `Console.In` and dynamic prover-assembly loading
when building default options, make the Java runtime JAR build skippable, and
fall back to assembly metadata for the version stamp (WebCIL assemblies have
no `Location` for `FileVersionInfo`).
Everything else — embedding `DafnyPrelude.bpl` as a resource, instantiating
the SMTLib factory directly, silent structured output — lives in this repo's
wrapper project.

At runtime, a classic Web Worker hosts both WASM runtimes (classic because
Z3's Emscripten pthread bootstrap needs `importScripts`). Z3 uses threads, so
the page must be cross-origin isolated — see the GitHub Pages note below.

## Running programs, not just verifying them

The **Run** button gives full `dafny run` semantics: verify first, then
translate to JavaScript with Dafny's own official JS backend (already aboard
— it lives in `DafnyCore.dll`), then execute. Native `dafny run` pipes the
generated program into a `node` process; here the browser *is* the JS
engine, so the "execution backend" collapses into feeding the same text to a
throwaway Web Worker. A runaway program dies by `terminate()` (bounded by
the time-limit selector) instead of Ctrl-C, and the page stays responsive.

The generated code needs exactly two node ambients, both shimmed in the
runner ([`src/dafny-runner.js`](prototype/src/dafny-runner.js)): a `require`
that resolves [bignumber.js](https://github.com/MikeMcl/bignumber.js) — the
single dependency of Dafny's JS runtime, giving exact arbitrary-precision
`int`/`real` semantics at runtime just as in native Dafny — and a `process`
whose `stdout.write` streams into the Run tab. `expect` failures surface as
the same `[Program halted] ...` output as the CLI. Programs using `{:extern}`
or reading stdin/files are out of scope, as on any online runner.

Compilation happens in-process via `CompileToJs`
([`Program.cs`](prototype/Program.cs)), mirroring the CLI driver's
string-building path; the JS runtime rides as an embedded resource (upstream
keeps it in `DafnyPipeline.dll`, which also carries every other target's
runtime — shipping one file instead keeps the payload lean).

## Understanding the stack: Under the hood + the anatomy page

The demo's **Under the hood** panel (revealed by the muted "internals"
affordance) shows every stage of the pipeline for the last verification:
the compiled **JS**, the **Boogie** translation (prelude filtered, opening
at your method, following your cursor via `/input.dfy(line,col)`
breadcrumbs), the **SMT** transcript sliced per proof obligation with a
picker that cross-links to the editor, and the **raw result**. A
"readable names" toggle re-verifies with Boogie's name normalization off,
so the queries show `|x#0|` and `|y#0@1|` instead of `$generated@@N`
(exploration mode — the byte-faithful default stays identical to the
native CLI). Recurring encoding symbols (`$Heap`, `ControlFlow`, `T@U`…)
explain themselves on hover.

[**anatomy.html**](https://rupnikj.github.io/dafny-verify-browser/anatomy.html)
is the guided version: one program dissected live through
Dafny → Boogie → SMT → verdict, with prose between the stages — every pane
is real output computed in the reader's browser, not an illustration. The
demo's "How it works" link carries your current program along.

## Embedding a verifiable snippet in a blog or course page

The demo's **Embed** button copies an iframe snippet like:

```html
<iframe src="https://rupnikj.github.io/dafny-verify-browser/embed.html#code=dfl:..."
  style="width: 100%; height: 420px; border: 1px solid #30363d; border-radius: 8px"
  loading="lazy" title="Dafny Verify"></iframe>
```

`embed.html` is a compact widget: the program arrives in the URL fragment
(same codec as Share links — it never touches a server), readers can edit
it, and the verifier boots lazily on the first Verify click, so embeds cost
visitors nothing until used. An "Edit in Dafny Verify ↗" link carries the
current text to the full demo.

A third-party iframe can never be cross-origin isolated (that would require
COOP/COEP on the *embedding* page), so no `SharedArrayBuffer` and no
threaded Z3. The verification worker therefore falls back to the
single-threaded [z3-inline](https://github.com/rupnikj/z3-inline) build —
same Dafny, same Boogie, same SMT bytes, just slower — staged at `z3-st/`
by an optional deploy step that never blocks the threaded tier. The
fallback also makes the whole demo work on hosts that cannot send
COOP/COEP headers at all.

## Embedding the verifier in your own page

The published site doubles as a distribution. It exposes a standalone,
dependency-free ES module:

```js
import { createDafny } from "./dafny-browser.js";

const dafny = await createDafny(); // or createDafny({ baseUrl: "/static/dafny/" })
// Optional: createDafny({ onProgress: ({ stage, loadedBytes, totalBytes }) => ... })
// reports download progress during the first-visit fetch of the runtime.
//
// verify(source, { timeLimitSeconds, counterexamples }) — per-obligation time
// limit (like --verification-time-limit; 0 = CLI default 30 s, -1 = none) and
// counterexample extraction (like --extract-counterexample): failing
// diagnostics gain a `counterexample` list of execution states, each with a
// source position and a Dafny assumption constraining the variables there —
// the demo renders these as a trace with in-editor value annotations.

const result = await dafny.verify(`
method Abs(x: int) returns (y: int)
  ensures y >= 0
{
  if x < 0 { y := -x; } else { y := x; }
}
`);
// result: { verified, verifiedCount, errorCount, diagnostics, stage, smtExchangeCount }

const transcript = await dafny.getLastSmtTranscript(); // raw SMT-LIB exchanges
dafny.terminate();
```

To self-host, copy the deployed site (or a local `prototype/dist/wwwroot`):
`dafny-browser.js`, `verification-worker.js`, `z3-api.js`, the `z3/`
directory, and the complete `_framework/` directory, keeping their relative
paths. Your origin must be cross-origin isolated (send COOP/COEP headers, or
use the coi-serviceworker trick below).

## Hosting on GitHub Pages: the COOP/COEP trick

Z3's WASM build needs `SharedArrayBuffer`, which browsers only enable on
cross-origin-isolated pages — normally requiring these response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

GitHub Pages cannot send custom headers. The demo therefore ships
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker): a small
service worker that injects the headers on every response and reloads the page
once on first visit. On hosts that already send the headers (like the local
dev server here) it does nothing.

## The inline tier: single-file verifiers

Alongside the hosted demo, two fully self-contained HTML files can be built
(both zero-network, no install, work from `file://`):

- **`dafny-verify.html`** (`tools/make-dafny-verify-html.mjs`, ~16 MB) —
  the **complete demo experience** in one file: CodeMirror editor,
  diagnostics with counterexample traces and in-editor value annotations,
  all canned examples, the interactive tutorial, and the Run feature
  (compile to JS + execute, bignumber.js inlined). Verification runs on
  the page thread (the UI freezes until the verdict; the per-obligation
  time limit bounds it).
- **`dafny-artifact.html`** (`tools/make-dafny-artifact.mjs`, ~15.8 MB) — a
  minimal textarea UI, kept small enough for hosting environments with
  strict page-size limits and hardened for the harshest sandboxes.

Both are built and uploaded by the [inline-tier
workflow](.github/workflows/inline-tier.yml) as the `dafny-single-file`
artifact. Under the hood, `tools/make-dafny-artifact.mjs` assembles
every assembly, the .NET runtime, and a single-threaded Z3,
brotli-compressed and base85-inlined. It runs with **zero network requests, no workers, no
`SharedArrayBuffer`, and no COOP/COEP headers**, which means it works in
hostile sandboxes (restrictive-CSP iframes such as claude.ai artifacts) and
anywhere else a lone HTML file can be opened. The hosted threaded tier stays
the default and fastest mode; the inline tier trades speed for portability —
verification runs on the page thread (the UI freezes until the verdict) and
the solver is the single-threaded [z3-inline](https://github.com/rupnikj/z3-inline)
build. Both transports reproduce the threaded tier's verdicts and
byte-identical SMT-LIB inputs (`test/inline-parity.mjs`,
`npm run test:transport`):

- **`src/z3-api-transport.js`** (default with z3-inline ≥ v0.2.0): drives
  `Z3_eval_smtlib2_string` against one persistent context per session, so
  each exchange costs only what it solves — measured linear, ~flat
  ms/exchange over 400-exchange sessions (79–190x over replay, growing with
  session length). Note the timeout semantics: the config-time `timeout`
  applies per check, not per run.
- **`src/z3-st-transport.js`** (fallback for pre-v0.2.0 assets): replays the
  session's accumulated script through the CLI per exchange — quadratic, but
  with instance reuse still fine at moderate scale.

The transport is chosen at boot by capability detection
(`_Z3_eval_smtlib2_string` on the instance) and reported in the boot
timings line.

Three .NET-WASM loader findings this build encodes, for anyone attempting the
same (`tools/bundle-lib.mjs`, `tools/dafny-artifact-template.html`):

1. `dotnet.js` and the *fingerprinted* `dotnet.runtime.*.js` /
   `dotnet.native.*.js` resolve URLs against `import.meta.url`, which is an
   invalid base when imported from `blob:` URLs — they need a patch to prefer
   a settable global base.
2. The boot config must be handed over explicitly (`withConfigSrc` with a
   `data:` URL); the loader cannot resolve `./blazor.boot.json` from a blob
   base.
3. The `withResourceLoader` hook only honors a `Promise` or a URL-string
   return; a bare `Response` object is silently ignored and the loader falls
   back to the network.
4. The hardest sandboxes (srcdoc-rendered iframes) load **no script URL of
   any scheme** — `import(blobUrl)`, `import("data:...")`, and
   `<script src>` are all blocked, and `document.baseURI` is `about:srcdoc`,
   an invalid URL base. What still works: script text literally present in
   the document and *injected* inline scripts (classic and module). The
   build therefore transforms the loader modules to register their exports
   in a global registry, rewrites `dotnet.js`'s dynamic `import()` sites to
   consult it, injects the modules as inline `<script type="module">`
   elements at boot, and uses a synthetic unresolvable base
   (`https://inline.invalid/`) for all URL math.

To build it: `Z3_ST_DIR=/path/to/z3-inline/dist node tools/make-dafny-artifact.mjs`
(z3-st assets come from a [z3-inline release](https://github.com/rupnikj/z3-inline/releases)).
The [inline-tier workflow](.github/workflows/inline-tier.yml) rebuilds it on
every push — pinned z3-st release verified by SHA-256, a 16 MB size budget,
and real-browser gates — and uploads the file as a build artifact. It is
deliberately separate from the deploy workflow so the hosted tier never
depends on it.

## Building and testing locally

Prerequisites: .NET 8 SDK with the `wasm-tools` workload, Node.js 22+. If the
`dotnet` on your PATH is a different SDK version, set `DAFNY_BROWSER_DOTNET`
to a .NET 8 SDK's `dotnet` binary before building.

```sh
# One-time: fetch pinned Dafny sources and apply the compat patch
git clone https://github.com/dafny-lang/dafny.git upstream-dafny
git -C upstream-dafny checkout a04eea4dab324219e438f94ccc5ff0abcad11d86
git -C upstream-dafny apply ../patches/dafny-browser-compat.patch

cd prototype
npm ci
npm run build        # bundle JS assets, publish .NET browser-wasm → dist/
npm run test:wasm    # end-to-end: Dafny+Boogie WASM against Z3 WASM
npm start            # serve dist/wwwroot with COOP/COEP at http://localhost:4173
```

The GitHub Actions workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml))
does exactly this on every push to `main`, gates on the integration test, and
deploys `dist/wwwroot` to Pages — build outputs and the upstream Dafny
checkout are never committed.

### Test suites

| Command | What it checks |
| --- | --- |
| `npm run test:wasm` | Two-program smoke test: `Abs` verifies, `Bad` fails with the right diagnostic |
| `npm run test:module` | The standalone ES module surface |
| `npm run test:browser` | Real Chromium (Playwright): the demo through its worker + COI path, the inline zero-network boot, and the single-file artifact inside a srcdoc iframe under a sandbox-faithful CSP (no blob:/data:/external scripts, no network) |
| `node test/inline-parity.mjs` | Threaded z3 vs single-threaded z3-st: identical verdicts and SMT input hashes |

Two generic harnesses are included for testing at scale:
`test/verify-stdin.mjs` verifies a single `.dfy` file, and
`test/verify-corpus.mjs <dir>` runs a whole directory of programs expected to
fail next to a `solutions/` subdirectory expected to verify, hashing each
file's SMT transcript so encoding drift shows up as a diff.

**Fidelity:** measured differentially against a native `DafnyDriver` built
from the same pinned commit (matched Z3 4.16.0 on both sides), over 1,298
comparable single-file programs from the official Dafny integration test
suite: **99.5% verdict agreement, 96.6% exact** (identical counts and error
lines), with ~0.8% infrastructure limitations. Full methodology, the three
option-fidelity bugs the campaign found and fixed, and the limitations list:
[`docs/differential-fidelity.md`](docs/differential-fidelity.md).

## Repository layout

```
prototype/            The wrapper project: C# entry points, JS runtime, demo page
  Program.cs          [JSExport] browser API driving Dafny's internal pipeline
  BrowserSmtSolver.cs Boogie SMTLibSolver transport backed by Z3 WASM
  src/                dafny-browser.js module, worker API, demo app (CodeMirror)
  wwwroot/            Demo page, verification worker, coi-serviceworker
  test/               Node-based integration tests + generic corpus harness
  NativeHarness/      Native reference pipeline (transcripts in logs/)
patches/              77-line browser-compat patch against pinned Dafny
docs/investigation.md Full write-up: source map, blockers, findings
```

## Status and limitations

This is a proof of concept. Known hardening work, none of it fundamental:
the bundle is untrimmed (~95 MB raw; a production build should trim or split
a verifier-focused project), verification cancellation is not wired to Z3
interruption, and deeply recursive proofs may need WASM stack tuning.

## Credits

- The original port was produced with OpenAI Codex; the investigation log in
  [`docs/investigation.md`](docs/investigation.md) is its working record.
  The demo, the differential fidelity campaign, counterexamples, the
  tutorial revival, `dafny run`, and the single-file builds were built with
  [Claude Code](https://claude.com/claude-code).
- [Dafny](https://github.com/dafny-lang/dafny),
  [Boogie](https://github.com/boogie-org/boogie), and
  [Z3](https://github.com/Z3Prover/z3) do all the actual verification work.
- Demo editor: [CodeMirror](https://codemirror.net). Pages isolation:
  [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker).

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license texts.

## License

[MIT](LICENSE)
