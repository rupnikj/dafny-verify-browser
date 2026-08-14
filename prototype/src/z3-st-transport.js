// In-thread solver transport for the single-threaded z3-st build (z3-inline).
//
// z3-st is a CLI-style build: one instance serves exactly one callMain (re-entry
// keeps stale argv state), and there is no incremental eval API. Boogie's
// transport is interactive: many sequential exchanges against one solver
// session with accumulated declarations and push/pop state. This bridges the
// two by REPLAY: each exchange re-runs the session's entire accumulated script
// in a fresh instance and returns only the output beyond what previous runs
// produced. Z3 is deterministic for a fixed script, so the prior output is a
// stable prefix. Cost is quadratic in session length — acceptable for the
// hostile-sandbox tier this exists for; the threaded tier stays the default.
export function createZ3StTransport({ createZ3, wasmBinary, softTimeoutMs = 0 }) {
  const sessions = new Map();

  return {
    async evaluate(solverId, smtLib) {
      const session = sessions.get(solverId) ?? { script: "", lastOutput: "" };
      session.script += smtLib.endsWith("\n") ? smtLib : smtLib + "\n";

      const stdout = [];
      const stderr = [];
      const z3 = await createZ3({
        wasmBinary,
        noInitialRun: true,
        print: line => stdout.push(line),
        printErr: line => stderr.push(line)
      });
      z3.FS.writeFile("/session.smt2", session.script);
      const args = ["-smt2"];
      if (softTimeoutMs > 0) {
        args.push("-t:" + softTimeoutMs);
      }
      args.push("/session.smt2");
      try {
        z3.callMain(args);
      } catch (error) {
        // Emscripten signals exit() via throw in some configurations; output
        // captured so far is still the solver's answer.
        if (!(error && (error.name === "ExitStatus" || typeof error.status === "number"))) {
          throw error;
        }
      }
      if (stderr.length) {
        console.warn("z3-st stderr:", stderr.join("\n"));
      }

      const output = stdout.length ? stdout.join("\n") + "\n" : "";
      const delta = output.startsWith(session.lastOutput)
        ? output.slice(session.lastOutput.length)
        : output; // determinism violated — return everything rather than lie
      session.lastOutput = output;
      sessions.set(solverId, session);
      return delta;
    },

    close(solverId) {
      sessions.delete(solverId);
    }
  };
}
