// Incremental solver transport for the z3-inline C API build (>= v0.2.0).
//
// Boogie's transport is interactive: many sequential exchanges against one
// solver session with accumulated declarations and push/pop state. The CLI
// build could only imitate that by replaying the whole accumulated script per
// exchange, which is quadratic in session length (measured: 405 exchanges in
// 45.7 s). Z3_eval_smtlib2_string evaluates commands against a PERSISTENT
// context and returns only that call's output, so each exchange costs what it
// actually costs and nothing is re-solved.
//
// One Emscripten instance serves the whole page; one Z3 context per solverId.
// Contexts are cheap, instances are not.
export function createZ3ApiTransport({ z3, timeoutMs = 0 }) {
  const api = {
    mkConfig: z3.cwrap("Z3_mk_config", "number", []),
    setParam: z3.cwrap("Z3_set_param_value", null, ["number", "string", "string"]),
    mkContext: z3.cwrap("Z3_mk_context", "number", ["number"]),
    delConfig: z3.cwrap("Z3_del_config", null, ["number"]),
    delContext: z3.cwrap("Z3_del_context", null, ["number"]),
    setHandler: z3.cwrap("Z3_set_error_handler", null, ["number", "number"]),
    // returnType "string" copies out of wasm memory immediately, which is
    // required: the returned Z3_string is only valid until the next call.
    evalSmtlib: z3.cwrap("Z3_eval_smtlib2_string", "string", ["number", "string"]),
    errorCode: z3.cwrap("Z3_get_error_code", "number", ["number"]),
    errorMsg: z3.cwrap("Z3_get_error_msg", "string", ["number", "number"])
  };

  const sessions = new Map();

  function open() {
    const cfg = api.mkConfig();
    if (timeoutMs > 0) {
      // Config-time timeout is the API equivalent of the CLI's -t, but it
      // applies per check-sat rather than per process run.
      api.setParam(cfg, "timeout", String(timeoutMs));
    }
    const ctx = api.mkContext(cfg);
    // A NULL handler makes eval errors set an error code and leave the context
    // usable; Z3's default handler calls exit(1), which surfaces as a thrown
    // ExitStatus and kills the instance.
    api.setHandler(ctx, 0);
    return { cfg, ctx };
  }

  function dispose(session) {
    if (!session) return;
    try { api.delContext(session.ctx); } finally { api.delConfig(session.cfg); }
  }

  return {
    name: "z3-api",

    async evaluate(solverId, smtLib) {
      let session = sessions.get(solverId);
      if (!session) {
        session = open();
        sessions.set(solverId, session);
      }

      const output = api.evalSmtlib(session.ctx, smtLib);
      const code = api.errorCode(session.ctx);
      if (code !== 0) {
        const message = api.errorMsg(session.ctx, code);
        sessions.delete(solverId);
        dispose(session);
        throw new Error(`z3 error ${code}: ${message}`);
      }
      return output ?? "";
    },

    close(solverId) {
      const session = sessions.get(solverId);
      sessions.delete(solverId);
      dispose(session);
    },

    // Test/diagnostic aid: contexts must not accumulate across verifications.
    get openSessionCount() {
      return sessions.size;
    }
  };
}
