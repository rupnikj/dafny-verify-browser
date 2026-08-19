// This is deliberately a classic Worker. Emscripten's pthread bootstrap for
// z3-built.js relies on importScripts and a standalone main script URL.
globalThis.global = globalThis;
importScripts("./z3/z3-built.js");

const contexts = new Map();

// Approximate first-visit download: ~35 MB of .NET runtime + assemblies plus
// the ~34 MB Z3 WASM. Only used to scale the progress bar; the byte counter
// shown to the user is exact.
const TOTAL_DOWNLOAD_BYTES = 70 * 1024 * 1024;
let downloadedBytes = 0;
let progressStage = "Starting…";
let lastReported = 0;

function reportProgress(stage) {
  progressStage = stage ?? progressStage;
  lastReported = downloadedBytes;
  self.postMessage({
    type: "progress",
    detail: {
      stage: progressStage,
      loadedBytes: downloadedBytes,
      totalBytes: TOTAL_DOWNLOAD_BYTES
    }
  });
}

// Streams a response while counting its (decompressed) bytes toward the
// progress total, reporting at most every 512 KB. Any failure in the counting
// wrapper falls back to an ordinary fetch — progress display must never be
// able to break loading.
async function fetchCounted(url) {
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      return response;
    }
    const counting = new TransformStream({
      transform(chunk, controller) {
        downloadedBytes += chunk.byteLength;
        if (downloadedBytes - lastReported >= 512 * 1024) {
          reportProgress();
        }
        controller.enqueue(chunk);
      }
    });
    return new Response(response.body.pipeThrough(counting), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch {
    return fetch(url);
  }
}

// Resource types that the .NET loader must receive as URLs rather than
// Response objects (scripts are loaded via import/importScripts).
const uncountedResourceTypes = new Set(["dotnetjs", "js-module-threads", "manifest", "configuration"]);

function loadBootResource(type, name, defaultUri) {
  if (uncountedResourceTypes.has(type) || name.endsWith(".js") || name.endsWith(".mjs")) {
    return undefined;
  }
  return fetchCounted(defaultUri);
}

// The threaded z3-solver build: fastest, but SharedArrayBuffer requires a
// cross-origin-isolated page (COOP+COEP).
async function startThreadedSolver() {
  const { init } = await import("./z3-api.js");
  // Download the Z3 WASM once with a counted fetch and hand the bytes to
  // Emscripten directly: the z3-solver 4.16 glue's pthread bootstrap resolves
  // the wasm against the page root (ignoring locateFile), so relying on a
  // runtime fetch 404s on any non-root deployment.
  const z3WasmUrl = new URL("./z3/z3-built.wasm", self.location.href).href;
  reportProgress("Downloading Z3 solver");
  const z3WasmBytes = new Uint8Array(await (await fetchCounted(z3WasmUrl)).arrayBuffer());

  reportProgress("Starting Z3");
  const z3MainScript = new URL("./z3/z3-built.js", self.location.href).href;
  const z3 = await init({
    wasmBinary: z3WasmBytes,
    locateFile: file => new URL(`./z3/${file}`, self.location.href).href,
    mainScriptUrlOrBlob: z3MainScript
  });
  return {
    name: "z3-threaded",
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
  };
}

// The single-threaded z3-st build (from z3-inline releases, staged under
// ./z3-st/): no SharedArrayBuffer, so it works without COOP/COEP — which is
// exactly the situation of embed.html inside a third-party iframe, where the
// embedding page would have to be cross-origin isolated itself. Same Dafny,
// same Boogie, same SMT bytes; just slower. Mirrors src/z3-api-transport.js,
// including its hard-won rule: NEVER throw on Z3 error codes — an
// (error "...") response is protocol text Boogie parses and handles, the code
// clears on the next call, and the context stays usable.
async function startSingleThreadedSolver() {
  reportProgress("Downloading Z3 solver (single-threaded)");
  const wasmUrl = new URL("./z3-st/z3-st.wasm", self.location.href).href;
  const wasmResponse = await fetchCounted(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(
      "This page is not cross-origin isolated (no SharedArrayBuffer for threaded Z3) " +
      "and the single-threaded fallback assets are missing (" + wasmUrl + " → HTTP " +
      wasmResponse.status + "). Serve COOP/COEP headers, or stage z3-st.js/z3-st.wasm under z3-st/."
    );
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
  importScripts(new URL("./z3-st/z3-st.js", self.location.href).href);
  const factory = typeof createZ3 !== "undefined" ? createZ3 : self.createZ3;
  reportProgress("Starting Z3 (single-threaded)");
  const z3 = await factory({ wasmBinary: wasmBytes, print: () => {}, printErr: () => {} });
  const api = {
    mkConfig: z3.cwrap("Z3_mk_config", "number", []),
    mkContext: z3.cwrap("Z3_mk_context", "number", ["number"]),
    delConfig: z3.cwrap("Z3_del_config", null, ["number"]),
    delContext: z3.cwrap("Z3_del_context", null, ["number"]),
    setHandler: z3.cwrap("Z3_set_error_handler", null, ["number", "number"]),
    evalSmtlib: z3.cwrap("Z3_eval_smtlib2_string", "string", ["number", "string"]),
    errorCode: z3.cwrap("Z3_get_error_code", "number", ["number"]),
    errorMsg: z3.cwrap("Z3_get_error_msg", "string", ["number", "number"])
  };
  const sessions = new Map();
  return {
    name: "z3-st-api",
    evaluate: async (solverId, smtLib) => {
      let session = sessions.get(solverId);
      if (!session) {
        const cfg = api.mkConfig();
        const ctx = api.mkContext(cfg);
        // NULL handler: eval errors set a code instead of exit(1).
        api.setHandler(ctx, 0);
        session = { cfg, ctx };
        sessions.set(solverId, session);
      }
      const output = api.evalSmtlib(session.ctx, smtLib);
      if (output) {
        return output;
      }
      const code = api.errorCode(session.ctx);
      if (code !== 0) {
        const message = (api.errorMsg(session.ctx, code) ?? "unknown").replace(/"/g, "'");
        return `(error "z3 error ${code}: ${message}")\n`;
      }
      return "";
    },
    close: solverId => {
      const session = sessions.get(solverId);
      sessions.delete(solverId);
      if (session) {
        try { api.delContext(session.ctx); } finally { api.delConfig(session.cfg); }
      }
    }
  };
}

async function start() {
  const dotnetModulePromise = import("./_framework/dotnet.js");
  const solver = crossOriginIsolated
    ? await startThreadedSolver()
    : await startSingleThreadedSolver();
  const { dotnet } = await dotnetModulePromise;

  reportProgress("Downloading Dafny + Boogie assemblies");
  const dotnetBuilder = typeof dotnet.withResourceLoader === "function"
    ? dotnet.withResourceLoader(loadBootResource)
    : dotnet;
  const runtime = await dotnetBuilder.create();
  runtime.setModuleImports("dafnyZ3", { evaluate: solver.evaluate, close: solver.close });

  reportProgress("Starting the Dafny pipeline");
  const config = runtime.getConfig();
  await runtime.runMain(config.mainAssemblyName, []);
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);

  self.addEventListener("message", async event => {
    const { id, operation, source, timeLimitSeconds, counterexamples } = event.data;
    try {
      let json;
      switch (operation) {
        case "parse":
          json = await exports.DafnyBrowser.BrowserApi.Parse(source);
          break;
        case "verify":
          json = counterexamples
            ? await exports.DafnyBrowser.BrowserApi.VerifyFull(source, timeLimitSeconds || 0, true)
            : timeLimitSeconds
              ? await exports.DafnyBrowser.BrowserApi.VerifyWithLimit(source, timeLimitSeconds)
              : await exports.DafnyBrowser.BrowserApi.Verify(source);
          break;
        case "compile":
          json = await exports.DafnyBrowser.BrowserApi.CompileToJs(source);
          break;
        case "transcript":
          json = exports.DafnyBrowser.BrowserApi.GetLastSmtTranscript();
          break;
        case "boogie":
          json = exports.DafnyBrowser.BrowserApi.GetLastBoogie();
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
