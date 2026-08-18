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

  reportProgress("Downloading Dafny + Boogie assemblies");
  const dotnetBuilder = typeof dotnet.withResourceLoader === "function"
    ? dotnet.withResourceLoader(loadBootResource)
    : dotnet;
  const runtime = await dotnetBuilder.create();
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
