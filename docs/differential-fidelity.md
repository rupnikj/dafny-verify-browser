# Differential fidelity: browser verifier vs native Dafny

**Result at the current pin (Dafny v4.11.0 release): 99.5% verdict agreement
with a native build of the same commit across 1,295 comparable programs from
the official Dafny integration test suite** (96.9% agree exactly — counts and
error lines). 5 of the 6 verdict disagreements are timeout-boundary flips
attributable to the solver-version gap (Z3 4.16.0 native vs 5.0.0 WASM);
both sides enforce the same 30 s limit and disagree only on which proofs are
slow. The campaign across its runs found and fixed **three** real
option-fidelity bugs in the browser pipeline. Run date: 2026-08-16, commit
`cfe5d6a`.

## Methodology

- **Corpus**: all 1,309 single-file programs (no `include`, ≤64 KB) from
  `Source/IntegrationTests/TestFiles/LitTests/LitTest` at the pinned checkout
  (dafny0–4, git-issues, triggers, vstte2012, verification, examples,
  VerifyThis, ghost, datatypes). Lit RUN-line options are deliberately
  ignored: both sides run identical default options, so any program text is a
  valid differential input.
- **Native reference**: `DafnyDriver` built from the **same pinned commit**
  (`a04eea4`, the v4.11.0 release tag), `verify --cores:1`, local Z3 4.16.0,
  90 s wall timeout per file.
- **WASM side**: the exact published bundle (`dist/wwwroot/_framework`)
  loaded in Node with threaded Z3 5.0.0 — the same runtime the Pages demo
  serves — 180 s stall watchdog, restart-on-runtime-death.
- The only variables are therefore **platform** (native .NET vs browser-wasm)
  and **solver version** (Z3 4.16.0 vs 5.0.0).
- Harness: `prototype/test/differential/`.

## Results

| Bucket | Files | Share |
| --- | ---: | ---: |
| Exact agreement (verdict + counts + error lines) | 1,255 | 96.9% |
| Verdict agrees, details differ | 34 | 2.6% |
| Verdict disagreements | 6 | 0.5% |
| Excluded: infrastructure differences (below) | 14 | — |

**The 6 disagreements.** Five are the same shape: an obligation near the
30-second default time limit finishes on one solver version and times out on
the other (`SchorrWaite`, `SchorrWaite-stages`, `Primes`, `gcd`,
`ExtensibleArrayAuto`) — expected to converge once both tiers run the same
Z3. The sixth (`dafny0/Fuel.dfy`: a translation-stage "fuel can only
increase" rejection only on WASM) is the one unexplained divergence in the
corpus and is under investigation.

**The 34 detail differences** (identical verdicts): obligation-count and
error-witness-line wobble from different solver answers feeding Boogie's
failure-localization splitting — inherent to any solver-version gap.

## Three bugs this campaign found (all fixed)

Every verdict disagreement beyond the six above, across all runs of this
campaign, traced to the browser pipeline's *options* — none to the platform:

1. **Wrong type system** (fixed in `75c4c92`, re-tuned in `4dcd5ca`): the
   pipeline pinned type-system flags under a comment claiming they match
   `dafny verify`. The correct values are **per-version facts**: v4.11.0
   defaults to the legacy system; post-4.11 master flips it. The pipeline now
   documents that any re-pin must re-read `CommonOptionBag` and re-run this
   suite.
2. **Relaxed definite assignment** (fixed in `75c4c92`): the legacy property
   default (level 1) silently accepted 37 programs the CLI rejects; the CLI's
   `--relax-definite-assignment=false` maps to level 4.
3. **Missing 30 s verification time limit** (fixed in `cfe5d6a`):
   `--verification-time-limit` defaults to 30 s per obligation in the CLI;
   the legacy property default is unlimited. This was the entire historical
   "hang class" — the browser span forever where native reported "timed out
   after 30 seconds".

Lesson: "matches native" claims need differential evidence, not comments —
and the evidence needs re-running at every version pin.

## Measured limitations (the 14 infrastructure cases, ~1.1%)

| Failure | Files | Cause |
| --- | ---: | --- |
| Stall >180 s in the harness where native completes | 10 | Slow solving under Z3 5.0.0 on this hardware profile; several verify fine standalone. In the demo the time limit plus the Cancel button (worker recycle) bound the damage. |
| `RuntimeError: memory access/table index out of bounds` | 2 | Deep-recursion crash in the Mono interpreter. Measured: raising the Emscripten stack (64/256 MB) does **not** change it — the limit is interpreter-level, not the C stack. |
| Runtime `exit(1)` on cyclic-declaration files | 2 | Upstream v4.11.0 bug: the legacy resolver **infinite-loops natively** on the same two files (external kill after 90 s); the WASM build's stack guard turns the same loop into a fast exit. Arguably the better behavior. |

## Reproducing

```sh
cd prototype/test/differential
node collect.mjs
DAFNY_BROWSER_DOTNET=... node native-runner.mjs
./wasm-driver.sh        # resumable; restarts through hangs and runtime deaths
node compare.mjs
```

Native reference from the pinned checkout: `dotnet build
Source/DafnyDriver/DafnyDriver.csproj -c Release -p:SkipDafnyRuntimeJar=true`
with a .NET 8 SDK **first on PATH** (its `global.json` pins SDK 8; the
embedded `dotnet tool restore` fails under a newer default SDK), and an empty
placeholder at `DafnyRuntimeJava/build/libs/DafnyRuntime-4.11.0.jar`.

Two harness lessons encoded in the runners: a .NET runtime `exit()` inside
one verification kills the runtime for the whole process — the runner must
die and let the driver restart it, or every subsequent file records a
spurious instant crash; and dotnet's incremental publish can leave
`dist/_framework` stale after C# edits (`rm -rf dist obj` when in doubt).
