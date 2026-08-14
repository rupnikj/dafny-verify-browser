# Investigation log

## Revisions and scope

- Dafny: `f3c2fedfb2b88272af5b64f5e45d803a3bc0043a` (current checkout inspected,
  2026-07-24). Its `DafnyCore.csproj` pins Boogie `3.5.5`.
- Matching Boogie: tag `v3.5.5`, commit
  `d90c6c9ef7e0e244cef55ddd0557e28a1a1301d8`.
- Current Boogie master was also checked at
  `977902c30c6f6f5e6967987af4dbcab1c52ba5ec`; it retains the same solver seam.
- Z3 JavaScript/WASM: official `z3-solver` npm package `5.0.0`.

The prototype deliberately supports one in-memory source and verification only.
There is no compiler backend, project model, package manager, plugin loading,
language server, or server-side verification.

## Exact source map

### Dafny frontend and Boogie invocation

1. `Source/DafnyCore/AST/Grammar/ProgramParser.cs:336` exposes
   `ProgramParser.Parse(string, Uri, ErrorReporter)` and constructs an
   `InMemoryFileSystem` at line 337.
2. `Source/DafnyCore/Resolver/ProgramResolver.cs:29` performs asynchronous name
   and type resolution.
3. `Source/DafnyCore/Verifier/BoogieGenerator.cs:943` exposes
   `BoogieGenerator.Translate`, producing `(module name, Boogie.Program)` pairs.
4. `Source/DafnyCore/DafnyMain.cs:107` exposes `DafnyMain.BoogieOnce`, which
   drives Boogie's resolve/typecheck, transformations, VC generation, and
   verification. The prototype calls this direct API to avoid CLI/LSP layers.
5. The modern LSP/CLI route creates tasks in
   `Source/DafnyLanguageServer/Language/DafnyProgramVerifier.cs`; the legacy
   direct path calls `DafnyMain.BoogieOnce` from
   `Source/DafnyDriver/Legacy/SynchronousCliCompilation.cs:464`.

`BoogieGenerator.ReadPrelude` at `BoogieGenerator.cs:726-751` still expects
`DafnyPrelude.bpl` by filesystem path. The POC embeds the official file and
writes it once into .NET WASM's in-memory filesystem.

### Boogie solver boundary

The proposed new `ISmtTransport` is not necessary. Boogie already has the right
abstraction:

- `Source/Provers/SMTLib/SMTLibSolver.cs:8`: abstract transport with `Send`,
  `SendRequest`, `SendRequestsAndCloseInput`, `PingPong`, and `Close`.
- `Source/Provers/SMTLib/SMTLibProcess.cs:14`: native implementation. Its
  constructor creates `ProcessStartInfo` at line 32 and owns stdin/stdout parsing.
- `Source/ExecutionEngine/CommandLineOptions.cs:224`: public `CreateSolver`
  factory, defaulting to `SMTLibProcess`.
- Both interactive and batch prover implementations call that factory
  (`SMTLibInteractiveTheoremProver.cs:863` and
  `SMTLibBatchTheoremProver.cs:322`).

Therefore `BrowserSmtSolver.cs` subclasses the existing `SMTLibSolver`. No
Boogie source or VC-generation semantics were changed.

## Z3 transport experiment

The official low-level API exposes asynchronous
`Z3.eval_smtlib2_string(context, script)`. Sequential calls against one
`Z3_context` preserve declarations, assertions, and push/pop state. A direct
experiment returned the expected results for separate calls containing:

```smt2
(set-option :print-success false)
(declare-fun x () Int)
(assert (> x 0))
(push 1)
(check-sat)
(get-model)
(pop 1)
(get-info :name)
```

The end-to-end WASM test further confirms Boogie's real traffic. `Abs` returns
`unsat` for the negated VC; `Bad` returns `sat`, then Boogie performs its normal
model/error-path queries. The exact browser-side exchanges are available from
`dafny.getLastSmtTranscript()`. Native reference transcripts are retained in
`prototype/NativeHarness/logs`.

This means the preferred SMT-LIB strategy works. A direct-expression Z3 backend
is neither needed nor desirable.

Z3's browser build requires `SharedArrayBuffer` and threads. It also requires
`z3-built.js` to remain a standalone script because Emscripten loads additional
instances for pthread work. The prototype uses a classic verification worker,
loads that script separately, and serves:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

## Browser-WASM compatibility findings

The untrimmed browser publish succeeds. Its direct Dafny project reference is
only `DafnyCore`; that pulls `DafnyRuntime` and the Boogie 3.5.5 package graph.
The published verification-relevant assemblies are:

```text
DafnyBrowser, DafnyCore, DafnyRuntime
Boogie.Core, Boogie.ExecutionEngine, Boogie.VCExpr, Boogie.VCGeneration,
Boogie.Provers.SMTLib, Boogie.Model, Boogie.Graph,
Boogie.AbstractInterpretation, Boogie.CodeContractsExtender,
Boogie.Concurrency, Boogie.Houdini, Boogie.Provers.LeanAuto
```

Because current `DafnyCore` has broad dependencies and trimming is disabled, the
publish contains 223 managed assemblies. Measured output is about 93 MB raw:
approximately 59 MB under `_framework`, including compressed alternatives, plus
the 33 MB Z3 WASM. This is a packaging/performance problem, not a feasibility
problem. A production effort should trim or split a verifier-focused Dafny
project after establishing linker annotations.

Runtime incompatibilities actually encountered:

1. `DafnyMain` eagerly created `CustomStackSizePoolTaskScheduler`, whose
   `Thread.Start` fails on browser WASM even when the caller bypasses the
   large-stack helpers. Patch: choose `TaskScheduler.Default` on browser.
2. The Dafny runtime project built its unrelated Java runtime JAR. Patch: make
   that target skippable for this build.
3. `DafnyPrelude.bpl` was not available by ordinary path. POC fix: embedded
   resource copied to WASM MEMFS.
4. Boogie's prover plugin discovery uses `Assembly.Location`/`Assembly.LoadFrom`.
   POC fix: instantiate the already-linked SMTLib `Factory` directly.
5. Boogie's console printer reads/writes `Console.ForegroundColor`, unsupported
   in browser WASM. POC fix: silent output mode plus structured diagnostics from
   verification results.
6. `System.Diagnostics.Process` and many filesystem assemblies remain present in
   the untrimmed output, but the minimal path does not execute them. The injected
   `BrowserSmtSolver` prevents `SMTLibProcess` construction.
7. More complex generic programs caused type formatting during resolution, which
   lazily initialized `DafnyOptions.DefaultImmutableOptions`. Its CLI-oriented
   initialization touched both unsupported `Console.In` and Boogie's dynamic
   prover discovery (`Assembly.Location`/`Assembly.LoadFrom`). Patch: create the
   browser's formatting-only immutable options without parsing CLI defaults.
8. Calling `CreateUsingOldParser` before setting `TheProverFactory` printed an
   `Invalid filename` warning on browser because CLI defaults attempted the same
   dynamic prover discovery. POC fix: construct `DafnyOptions`, seed the linked
   SMTLib factory, and only then parse the empty option list.

The POC runs the managed pipeline on one Web Worker. .NET uses the default task
scheduler there; Z3 manages its own pthread workers. Complex programs may need
WASM stack-size tuning because Dafny/Boogie normally request unusually large
managed-thread stacks, but the required examples complete with the current
5 MB WASM stack.

## Tests performed

- Native reference pipeline with Z3 4.16.0:
  - `Abs`: verified, 1 verified, 0 errors.
  - `Bad`: not verified, 0 verified, 1 real postcondition diagnostic.
- Published .NET `browser-wasm` + official Z3 WASM 5.0.0 through the JS import:
  - `Abs`: verified, 1 verified, 0 errors.
  - `Bad`: not verified, 0 verified, 1 real postcondition diagnostic.
  - transcript assertions confirm options, push, check-sat, `unsat` for `Abs`,
    and `sat` for `Bad`.
  - a larger multi-method regression file reaches verification, verifies 42
    implementations, reports the four real errors left by its two TODO proof
    bodies, and records 250 SMT exchanges (no runtime diagnostic).
- Static server smoke test: HTML and the 33 MB Z3 WASM return HTTP 200 with the
  required COOP/COEP/CORP headers.
- Not observed: an interactive graphical browser run, because the available
  in-app browser provider reported no browser instance. No alternate browser
  automation was substituted.

## Smallest change set and blocker classification

| Change/blocker | Classification | Smallest treatment |
|---|---|---|
| Native Z3 process | Moderate engineering work | Implement one `SMTLibSolver` subclass and select it with existing `CreateSolver`. |
| Interactive SMT compatibility | Resolved; no architectural change | Keep one Z3 context and call `eval_smtlib2_string`; preserve Boogie's SMT-LIB exactly. |
| Dafny eager custom-stack scheduler | Easy compatibility patch | Use `TaskScheduler.Default` when `OperatingSystem.IsBrowser()`. |
| Prelude path | Easy compatibility patch | Embed unchanged prelude and materialize it in MEMFS, or add a stream-based prelude API upstream. |
| Dynamic prover factory loading | Easy compatibility patch | Register the linked SMTLib factory explicitly. |
| Console colors | Easy compatibility patch | Use structured/silent output, or guard color calls on browser. |
| Lazy formatting options use console/CLI defaults | Easy compatibility patch | On browser, construct the formatting-only options without `Console.In` or CLI prover discovery. |
| Java runtime build target | Easy build patch | Add a skip condition; Java output is irrelevant to verification. |
| Z3 pthread isolation headers | Browser deployment requirement | Serve COOP/COEP; run verification in a worker. |
| Cancellation of a running raw Z3 call | Moderate follow-up work | Wire cancellation to Z3 interruption; SMT `:timeout` already covers verifier time limits. |
| Bundle size/startup | Moderate follow-up work | Trim/link or split a smaller verifier project. |
| Large recursive verification workloads | Moderate risk, not shown fundamental | Measure and tune WASM stack or reduce recursion where required. |
| Fundamental browser limitation | None for this milestone | Browsers cannot spawn Z3, but the existing solver abstraction makes spawning unnecessary. |

## Conclusion

The hypothesis is supported. Real client-side Dafny verification does not need a
rewrite of Dafny-to-Boogie, Boogie's VC generator, or the SMT encoding. The
smallest functional change is a browser implementation of Boogie's existing
`SMTLibSolver` plus a handful of platform guards/configuration changes. The
largest remaining work is hardening—cancellation, stack stress testing, bundle
size, and broad browser testing—not a fundamental verifier limitation.
