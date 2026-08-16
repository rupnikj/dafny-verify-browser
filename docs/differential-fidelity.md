# Differential fidelity: browser verifier vs native Dafny

**Result at the fully aligned stack (Dafny v4.11.0 release, Z3 4.16.0 on
BOTH sides): 99.5% verdict agreement with a native build of the same commit
across 1,298 comparable programs from the official Dafny integration test
suite** (96.6% agree exactly — counts and error lines). The campaign across
its runs found and fixed **three** real option-fidelity bugs in the browser
pipeline. Run date: 2026-08-16, commit `93094df`.

A negative result worth recording: aligning the WASM solver from Z3 5.0.0
down to 4.16.0 (matching native) did **not** change the agreement rate. The
five timeout-boundary disagreements persist under matched solver versions,
which demonstrates they are **wall-clock-vs-platform-speed effects**, not
version effects: a 30-second limit covers different amounts of solving on
different hardware, exactly as it would between two machines running native
Dafny. Version alignment's real value is configuration correctness (Boogie's
SMT encoding is now tuned for the solver actually shipped) and authenticity
(the browser runs the same solver version Dafny 4.11 distributes).

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
| Exact agreement (verdict + counts + error lines) | 1,254 | 96.6% |
| Verdict agrees, details differ | 38 | 2.9% |
| Verdict disagreements | 6 | 0.5% |
| Excluded: infrastructure differences (below) | 11 | — |

**The 6 disagreements.** Five are the same shape: an obligation near the
30-second default time limit finishes on one platform and times out on the
other (`SchorrWaite`, `UnionFind`, `Primes`, `gcd`, `ExtensibleArrayAuto`)
— measured to persist under matched solver versions, hence inherent to any
wall-clock limit across differing hardware speeds. The sixth
(`dafny0/Fuel.dfy`: a deterministic translation-stage "fuel can only
increase within a given scope" rejection only on WASM; native is
deterministic across repeated runs) is the one genuine open divergence in
the corpus — it involves `{:fuel}` attribute scope tracking in the direct
in-process API path.

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
| Stall >180 s in the harness where native completes | 6 | Slow solving under Z3 5.0.0 on this hardware profile; several verify fine standalone. In the demo the time limit plus the Cancel button (worker recycle) bound the damage. |
| `RuntimeError: memory access/table index out of bounds` | 2 | Deep-recursion crash in the Mono interpreter. Measured: raising the Emscripten stack (64/256 MB) does **not** change it — the limit is interpreter-level, not the C stack. |
| Z3 WASM process death (`exit(1)`) | 1 | `git-issue-267.dfy` kills the solver; native verifies it clean. The demo recovers via worker auto-respawn. |
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
