function asError(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return new Error(value);
  }
  return new Error(fallbackMessage);
}

function resolveBaseUrl(baseUrl) {
  if (baseUrl === undefined) {
    return new URL(".", import.meta.url);
  }
  const documentBase = globalThis.document?.baseURI ?? import.meta.url;
  const resolved = new URL(baseUrl, documentBase);
  if (!resolved.pathname.endsWith("/")) {
    resolved.pathname += "/";
  }
  return resolved;
}

/**
 * Starts the browser-only Dafny verifier.
 *
 * The returned API communicates with a Web Worker that owns .NET browser-WASM,
 * Dafny, Boogie, and Z3 WASM. Source code never leaves the browser.
 *
 * @param {{
 *   baseUrl?: string | URL,
 *   workerFactory?: (workerUrl: URL) => Worker,
 *   onProgress?: (progress: {
 *     stage: string,
 *     loadedBytes: number,
 *     totalBytes: number
 *   }) => void
 * }} options
 */
export async function createDafny(options = {}) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const workerUrl = new URL("verification-worker.js", baseUrl);
  const workerFactory = options.workerFactory ??
    (url => new Worker(url, { name: "dafny-browser-verifier" }));
  const worker = workerFactory(workerUrl);

  let nextRequestId = 1;
  let ready = false;
  let terminated = false;
  let fatalError = null;
  const pending = new Map();
  let resolveStartup;
  let rejectStartup;

  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });

  function rejectPending(error) {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function fail(value, fallbackMessage) {
    const error = asError(value, fallbackMessage);
    fatalError = error;
    rejectStartup(error);
    rejectPending(error);
    worker.terminate();
  }

  worker.addEventListener("message", event => {
    const message = event.data;
    if (message?.type === "ready") {
      ready = true;
      resolveStartup();
      return;
    }
    if (message?.type === "progress") {
      try {
        options.onProgress?.(message.detail);
      } catch {
        // Progress display failures must not break verification.
      }
      return;
    }
    if (message?.type === "startup-error") {
      fail(message.error, "The Dafny verifier could not start.");
      return;
    }

    const request = pending.get(message?.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.ok) {
      request.resolve(message.result);
    } else {
      request.reject(asError(message.error, "The Dafny worker request failed."));
    }
  });

  worker.addEventListener("error", event => {
    fail(event.error ?? event.message, "The Dafny worker stopped unexpectedly.");
  });

  worker.addEventListener("messageerror", () => {
    fail(null, "The Dafny worker returned an unreadable message.");
  });

  function call(operation, source) {
    if (terminated) {
      return Promise.reject(new Error("The Dafny verifier has been terminated."));
    }
    if (fatalError) {
      return Promise.reject(fatalError);
    }
    if (!ready) {
      return Promise.reject(new Error("The Dafny verifier is not ready."));
    }

    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, operation, source });
    });
  }

  await startup;

  return Object.freeze({
    parse(source) {
      if (typeof source !== "string") {
        return Promise.reject(new TypeError("Dafny source must be a string."));
      }
      return call("parse", source);
    },

    verify(source) {
      if (typeof source !== "string") {
        return Promise.reject(new TypeError("Dafny source must be a string."));
      }
      return call("verify", source);
    },

    getLastSmtTranscript() {
      return call("transcript");
    },

    terminate() {
      if (terminated) {
        return;
      }
    terminated = true;
      const error = new Error("The Dafny verifier has been terminated.");
      rejectPending(error);
      worker.terminate();
    }
  });
}

export default createDafny;
