# Differential fidelity: browser verifier vs native Dafny

**Result: 100% verdict agreement with native Dafny on 1,311 comparable
programs from the official Dafny integration test suite** (97.1% agree
exactly, down to verified-obligation counts and error line numbers). The
campaign also found and fixed two real option-fidelity bugs, and produced a
measured limitations list. Run date: 2026-08-15/16, at commit `75c4c92`.

## Methodology

- **Corpus**: all 1,331 single-file programs (no `include`, ≤64 KB) from
  `Source/IntegrationTests/TestFiles/LitTests/LitTest` in the pinned Dafny
  checkout — directories dafny0–4, git-issues, triggers, vstte2012,
  verification, examples, VerifyThis, ghost, datatypes. Lit RUN-line options
  are deliberately ignored: both sides run identical default options, so any
  program text is a valid differential input.
- **Native reference**: `DafnyDriver` built from the **same pinned commit**
  (`f3c2fed`, 4.11.1) as the WASM bundle, `verify --cores:1`, local Z3
  4.16.0, 90 s timeout per file.
- **WASM side**: the exact published bundle (`dist/wwwroot/_framework`)
  loaded in Node with threaded Z3 5.0.0 — the same runtime the Pages demo
  serves — with a 180 s stall watchdog.
- The only variables are therefore **platform** (native .NET vs browser-wasm)
  and **solver version** (Z3 4.16.0 vs 5.0.0).
- Harness: `prototype/test/differential/` (collector, both runners —
  resumable JSONL — and the comparator).

## Results (after the option fixes below)

| Bucket | Files | Share |
| --- | ---: | ---: |
| Exact agreement (verdict + counts + error lines) | 1,273 | 97.1% |
| Verdict agrees, details differ | 38 | 2.9% |
| **Verdict disagreements** | **0** | **0%** |
| Excluded: infrastructure differences (below) | 20 | — |

The 38 detail differences, all with identical verdicts:

- **28** report the same errors at the same lines but a different
  verified-obligation *count*. When errors are present, Boogie splits
  obligations to localize failures, and different solver answers produce
  different split counts — the count is not a stable metric across solver
  versions.
- **9** report the same error *count* with a few error lines shifted
  (e.g. 47 errors with 4 lines differing): with many failing assertions,
  which witnesses the solver finds first varies by solver version.
- **1** involves native running out of solver resources where WASM's Z3
  5.0.0 does not.

## Two bugs this campaign found (both fixed in `75c4c92`)

The first sweep (pre-fix) showed 37 verdict disagreements — every one
traced to the browser pipeline's options, none to the platform:

1. **Wrong type system.** The pipeline pinned `TypeSystemRefresh=false`,
   `GeneralNewtypes=false`, `GeneralTraits=Legacy` under a comment claiming
   these match `dafny verify`. The actual 4.11 CLI defaults are
   `true`/`true`/`Datatype` — the browser was running Dafny 4.0-era
   resolution, changing verdicts on subset-type tests, general newtypes,
   and trait extension.
2. **Relaxed definite assignment.** The legacy parser leaves
   `DefiniteAssignmentLevel = 1`; the modern CLI's
   `--relax-definite-assignment=false` default maps to level 4. The browser
   silently accepted 37 programs that `dafny verify` rejects with
   definite-assignment errors.

Lesson recorded: "matches native" claims need differential evidence, not
comments.

## Measured limitations (the 20 infrastructure cases)

**Upstream crashes reproduced faithfully — 6 files.** The whole
`git-issue-817*` family (5 files) crashes the *refreshed resolver* with a
`NullReferenceException` in `ResolveAssignOrReturnSt`, and `git-issue-3921`
dies with an `InvalidCastException` — **native crashes identically on all
six** (it is why those lit tests pin the legacy resolver). These are
agreements in disguise: the browser faithfully reproduces upstream bugs of
the pinned commit.

**Genuine browser limitations — 14 files (~1.1% of the corpus):**

| Failure | Files | Cause |
| --- | ---: | --- |
| Hang (>180 s where native finishes in <90 s) | 9 | No cancellation is wired into the pipeline; quantifier-heavy proofs can run away. In the demo this means a stuck worker until page reload. `SnapshotableTrees.dfy` (counted here) times out natively too. |
| `RuntimeError: memory access out of bounds` / `table index is out of bounds` | 3+1 | WASM stack/memory limits under deeply recursive verification — the hardening risk the original investigation predicted. Native completes these (with verification errors). |
| Z3 WASM `exit(1)` process death | 1 | `git-issue-267.dfy` kills the solver outright; native verifies it clean. |

## Reproducing

```sh
cd prototype/test/differential
node collect.mjs                 # candidates.json from the upstream checkout
DAFNY_BROWSER_DOTNET=... node native-runner.mjs   # needs Binaries/net8.0/DafnyDriver.dll
./wasm-driver.sh                 # resumable; restarts through hangs
node compare.mjs
```

Building the native reference from the pinned checkout:
`dotnet build Source/DafnyDriver/DafnyDriver.csproj -c Release
-p:SkipDafnyRuntimeJar=true` (create an empty placeholder for
`DafnyRuntimeJava/build/libs/DafnyRuntime-4.11.1.jar` first).
