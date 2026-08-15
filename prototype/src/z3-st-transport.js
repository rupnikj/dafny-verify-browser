// In-thread solver transport for the single-threaded z3-st build (z3-inline).
//
// z3-st is a CLI-style build with no incremental eval API, while Boogie's
// transport is interactive: many sequential exchanges against one solver
// session with accumulated declarations and push/pop state. This bridges the
// two by REPLAY: each exchange re-runs the session's entire accumulated
// script and returns only the output beyond what previous runs produced.
// Z3 is deterministic for a fixed script, so the prior output is a stable
// prefix. Replay cost is quadratic in session length — acceptable for the
// hostile-sandbox tier this exists for; the threaded tier stays the default.
//
// The Emscripten INSTANCE is reused across a session's exchanges: measured,
// instance creation dominates wall clock (~145 ms/query fresh vs ~7 ms
// reused, ~21x). callMain re-entry warns "input file was already specified"
// on stderr but proceeds correctly — Z3's SMT2 frontend builds a fresh
// context per main(), so no solver state leaks between runs (guarded by the
// transport unit test and the transcript-hash parity suite).
export function createZ3StTransport({
  createZ3,
  wasmBinary,
  softTimeoutMs = 0,
  // Recycle the instance after this many callMain re-entries — cheap
  // insurance against slow state accumulation in very long sessions.
  recycleAfter = 500
}) {
  const sessions = new Map();

  async function freshInstance(session) {
    session.stdout = [];
    session.stderr = [];
    session.z3 = await createZ3({
      wasmBinary,
      noInitialRun: true,
      print: line => session.stdout.push(line),
      printErr: line => session.stderr.push(line)
    });
    session.uses = 0;
  }

  return {
    async evaluate(solverId, smtLib) {
      let session = sessions.get(solverId);
      if (!session) {
        session = { script: "", lastOutput: "", z3: null, stdout: [], stderr: [], uses: 0 };
        sessions.set(solverId, session);
      }
      session.script += smtLib.endsWith("\n") ? smtLib : smtLib + "\n";

      if (!session.z3 || session.uses >= recycleAfter) {
        // Keep lastOutput: replay is deterministic, so a fresh instance
        // reproduces the full output and the prefix delta stays correct.
        // Resetting it would re-deliver all previous responses.
        await freshInstance(session);
      }
      session.stdout.length = 0;
      session.stderr.length = 0;
      session.z3.FS.writeFile("/session.smt2", session.script);
      const args = ["-smt2"];
      if (softTimeoutMs > 0) {
        args.push("-t:" + softTimeoutMs);
      }
      args.push("/session.smt2");
      try {
        session.z3.callMain(args);
      } catch (error) {
        // Emscripten signals exit() via throw in some configurations; output
        // captured so far is still the solver's answer.
        if (!(error && (error.name === "ExitStatus" || typeof error.status === "number"))) {
          // A real failure may leave the reused instance corrupted — force a
          // fresh one for the next exchange.
          session.z3 = null;
          throw error;
        }
      }
      session.uses++;
      const stderrLines = session.stderr.filter(line =>
        !line.includes("input file was already specified"));
      if (stderrLines.length) {
        console.warn("z3-st stderr:", stderrLines.join("\n"));
      }

      const output = session.stdout.length ? session.stdout.join("\n") + "\n" : "";
      const delta = output.startsWith(session.lastOutput)
        ? output.slice(session.lastOutput.length)
        : output; // determinism violated — return everything rather than lie
      session.lastOutput = output;
      return delta;
    },

    close(solverId) {
      // No teardown API on this build; dropping the reference frees the
      // instance via GC.
      sessions.delete(solverId);
    }
  };
}
