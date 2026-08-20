// createDafny for the single-file build (dafny-verify.html): same API surface
// as dafny-browser.js, but instead of a worker + threaded Z3 it boots the
// .NET runtime and single-threaded Z3 from inline payloads, in-page — no
// network, no workers, works from file://. Verification therefore runs on
// the page thread: the UI freezes until the verdict, and cancel() cannot
// interrupt a running proof (the per-obligation time limit still bounds it).
import { createZ3StTransport } from "./z3-st-transport.js";
import { createZ3ApiTransport } from "./z3-api-transport.js";

export async function createDafny(options = {}) {
  const progress = (stage) => {
    try {
      options.onProgress?.({ stage, loadedBytes: 0, totalBytes: 1 });
    } catch {}
  };

  progress("Decoding payloads");
  await new Promise(resolve => setTimeout(resolve, 30)); // let the label paint
  const frameworkBr = globalThis.decodeBase85("fw-b64");
  const z3Br = globalThis.decodeBase85("z3-b64");

  progress("Decompressing");
  await new Promise(resolve => setTimeout(resolve, 30));
  const decode = typeof globalThis.__brotliDecode === "function"
    ? globalThis.__brotliDecode : globalThis.__brotliDecode.default;
  const inflated = new Uint8Array(decode(frameworkBr));
  const wasmBinary = new Uint8Array(decode(z3Br));

  const view = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  const manifestLength = view.getUint32(0, true);
  const manifest = JSON.parse(new TextDecoder().decode(inflated.subarray(4, 4 + manifestLength)));
  const payloadBase = 4 + manifestLength;
  const store = new Map();
  for (const file of manifest.files) {
    store.set(file.name, inflated.subarray(payloadBase + file.offset, payloadBase + file.offset + file.size));
  }

  progress("Booting .NET runtime");
  await new Promise(resolve => setTimeout(resolve, 30));
  // Loader modules were transformed at build time to register their exports;
  // inject them as inline scripts (works on file:// and under strict CSPs).
  for (const file of manifest.files) {
    if (/^dotnet(\.native|\.runtime)?(\.[\w.]+)?\.js$/.test(file.name)) {
      const element = document.createElement("script");
      element.type = "module";
      element.textContent = new TextDecoder().decode(store.get(file.name));
      document.head.append(element);
    }
  }

  const lookup = (name, defaultUri) => {
    const direct = store.get(name);
    if (direct) return { key: name, bytes: direct };
    const segments = String(defaultUri ?? "").split("?")[0].split("/").filter(Boolean);
    for (let take = 2; take <= 3 && take <= segments.length; take++) {
      const key = segments.slice(-take).join("/");
      const bytes = store.get(key);
      if (bytes) return { key, bytes };
    }
    return null;
  };
  const loadBootResource = (type, name, defaultUri) => {
    if (type.startsWith("js-module") || type === "dotnetjs" || name.endsWith(".js") || name.endsWith(".mjs")) {
      return defaultUri || name;
    }
    const found = lookup(name, defaultUri);
    if (!found) return undefined;
    return Promise.resolve(new Response(found.bytes, {
      headers: {
        "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        "content-length": String(found.bytes.byteLength)
      }
    }));
  };

  const { dotnet } = await globalThis.__inlineImport("dotnet.js");
  const runtime = await dotnet
    .withConfigSrc(globalThis.__dafnyBootConfigUrl)
    .withResourceLoader(loadBootResource)
    .create();

  progress("Starting solver");
  const z3Instance = await globalThis.createZ3({
    wasmBinary, noInitialRun: true, print() {}, printErr() {}
  });
  const useApi = typeof z3Instance._Z3_eval_smtlib2_string === "function";
  const transport = useApi
    ? createZ3ApiTransport({ z3: z3Instance, timeoutMs: 30000 })
    : createZ3StTransport({ createZ3: globalThis.createZ3, wasmBinary, softTimeoutMs: 30000 });
  runtime.setModuleImports("dafnyZ3", transport);

  progress("Starting the Dafny pipeline");
  const config = runtime.getConfig();
  await runtime.runMain(config.mainAssemblyName, []);
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
  const api = exports.DafnyBrowser.BrowserApi;

  const note = document.querySelector("#runtime-note");
  if (note) {
    note.hidden = false;
    note.textContent = "single-file build — verification runs on the page thread and freezes the UI until done";
  }

  return Object.freeze({
    async parse(source) {
      return JSON.parse(await api.Parse(source));
    },
    async verify(source, verifyOptions = {}) {
      const limit = verifyOptions.timeLimitSeconds ?? 0;
      const wantCounterexamples = verifyOptions.counterexamples === true;
      const readableNames = verifyOptions.readableNames === true;
      const isolateAssertions = verifyOptions.isolateAssertions === true;
      const json = wantCounterexamples || readableNames || isolateAssertions
        ? await api.VerifyFull(source, limit, wantCounterexamples, readableNames, isolateAssertions)
        : limit
          ? await api.VerifyWithLimit(source, limit)
          : await api.Verify(source);
      return JSON.parse(json);
    },
    async compileToJs(source) {
      return JSON.parse(await api.CompileToJs(source));
    },
    async getLastSmtTranscript() {
      return JSON.parse(api.GetLastSmtTranscript());
    },
    async getLastBoogie() {
      return JSON.parse(api.GetLastBoogie());
    },
    cancel() {
      // Single-threaded: a running proof cannot be interrupted; the
      // per-obligation time limit is the bound.
    },
    whenReady() { return Promise.resolve(); },
    terminate() {}
  });
}

export default createDafny;
