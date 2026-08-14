// This is deliberately a classic Worker. Emscripten's pthread bootstrap for
// z3-built.js relies on importScripts and a standalone main script URL.
globalThis.global = globalThis;
importScripts("./z3/z3-built.js");

const contexts = new Map();

async function start() {
  if (!crossOriginIsolated) {
    throw new Error(
      "Z3 WASM needs SharedArrayBuffer. Serve this page with COOP: same-origin and COEP: require-corp."
    );
  }

  const [{ init }, { dotnet }] = await Promise.all([
    import("./z3-api.js"),
    import("./_framework/dotnet.js")
  ]);

  const z3MainScript = new URL("./z3/z3-built.js", self.location.href).href;
  const z3 = await init({
    locateFile: file => new URL(`./z3/${file}`, self.location.href).href,
    mainScriptUrlOrBlob: z3MainScript
  });

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

  self.addEventListener("message", async event => {
    const { id, operation, source } = event.data;
    try {
      let json;
      switch (operation) {
        case "parse":
          json = await exports.DafnyBrowser.BrowserApi.Parse(source);
          break;
        case "verify":
          json = await exports.DafnyBrowser.BrowserApi.Verify(source);
          break;
        case "transcript":
          json = exports.DafnyBrowser.BrowserApi.GetLastSmtTranscript();
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
      self.postMessage({ id, ok: true, result: JSON.parse(json) });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error?.stack ?? String(error) });
    }
  });

  self.postMessage({ type: "ready" });
}

start().catch(error => {
  self.postMessage({ type: "startup-error", error: error?.stack ?? String(error) });
});
