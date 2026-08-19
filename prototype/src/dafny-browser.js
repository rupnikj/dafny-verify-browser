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
 * The worker is respawned automatically if it crashes (verification has no
 * in-pipeline cancellation, so `cancel()` is implemented the same way:
 * terminate and respawn). In-flight requests reject; the runtime re-downloads
 * from the browser cache, so a respawn costs seconds, not the first-visit
 * download. `onRestart(reason)` is called each time a respawn begins.
 *
 * @param {{
 *   baseUrl?: string | URL,
 *   workerFactory?: (workerUrl: URL) => Worker,
 *   maxRespawns?: number,
 *   onProgress?: (progress: {
 *     stage: string,
 *     loadedBytes: number,
 *     totalBytes: number
 *   }) => void,
 *   onRestart?: (reason: "cancelled" | "crashed") => void
 * }} options
 */
export async function createDafny(options = {}) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const workerUrl = new URL("verification-worker.js", baseUrl);
  const workerFactory = options.workerFactory ??
    (url => new Worker(url, { name: "dafny-browser-verifier" }));
  const maxRespawns = options.maxRespawns ?? 3;

  let worker = null;
  let nextRequestId = 1;
  let readyPromise = null;
  let terminated = false;
  let respawnsLeft = maxRespawns;
  const pending = new Map();

  function rejectPending(error) {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function startWorker() {
    const spawned = workerFactory(workerUrl);
    let resolveStartup, rejectStartup;
    const startup = new Promise((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    // A rejected startup is always surfaced through call sites; avoid
    // unhandled-rejection noise when nothing is in flight.
    startup.catch(() => {});

    spawned.addEventListener("message", event => {
      const message = event.data;
      if (message?.type === "ready") {
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
        rejectStartup(asError(message.error, "The Dafny verifier could not start."));
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

    spawned.addEventListener("error", event => {
      handleDeath(spawned, asError(event.error ?? event.message,
        "The Dafny worker stopped unexpectedly."), rejectStartup);
    });
    spawned.addEventListener("messageerror", () => {
      handleDeath(spawned, new Error("The Dafny worker returned an unreadable message."),
        rejectStartup);
    });

    worker = spawned;
    readyPromise = startup;
    return startup;
  }

  function handleDeath(deadWorker, error, rejectStartup) {
    if (worker !== deadWorker || terminated) {
      return; // already superseded by a respawn or shut down
    }
    deadWorker.terminate();
    rejectStartup(error);
    rejectPending(error);
    if (respawnsLeft > 0) {
      respawnsLeft--;
      try {
        options.onRestart?.("crashed");
      } catch {}
      startWorker();
    } else {
      worker = null;
      readyPromise = Promise.reject(error);
      readyPromise.catch(() => {});
    }
  }

  async function call(operation, source, extra) {
    if (terminated) {
      throw new Error("The Dafny verifier has been terminated.");
    }
    if (!worker) {
      throw new Error("The Dafny verifier is not available (worker respawn limit reached).");
    }
    await readyPromise;
    // Termination or a worker swap can land while awaiting readiness.
    if (terminated) {
      throw new Error("The Dafny verifier has been terminated.");
    }
    if (!worker) {
      throw new Error("The Dafny verifier is not available (worker respawn limit reached).");
    }
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, operation, source, ...extra });
    });
  }

  await startWorker();

  return Object.freeze({
    parse(source) {
      if (typeof source !== "string") {
        return Promise.reject(new TypeError("Dafny source must be a string."));
      }
      return call("parse", source);
    },

    /**
     * @param {string} source
     * @param {{ timeLimitSeconds?: number, counterexamples?: boolean }}
     *   verifyOptions — timeLimitSeconds: per-obligation limit like
     *   `dafny verify --verification-time-limit` (omit/0 for the CLI default
     *   of 30 s, -1 for no limit); counterexamples: ask the solver for a
     *   model on each failed assertion (like --extract-counterexample) and
     *   attach it to the diagnostic as a list of execution states.
     */
    verify(source, verifyOptions = {}) {
      if (typeof source !== "string") {
        return Promise.reject(new TypeError("Dafny source must be a string."));
      }
      const timeLimitSeconds = verifyOptions.timeLimitSeconds ?? 0;
      const counterexamples = verifyOptions.counterexamples === true;
      return call("verify", source, { timeLimitSeconds, counterexamples });
    },

    /**
     * Translate the program to JavaScript (like `dafny translate js
     * --include-runtime`). Resolves to { ok, hasMain, js, callToMain,
     * diagnostics, ... }; execute js + callToMain with dafny-runner.js.
     * Does not verify — run verify() first for `dafny run` semantics.
     */
    compileToJs(source) {
      if (typeof source !== "string") {
        return Promise.reject(new TypeError("Dafny source must be a string."));
      }
      return call("compile", source);
    },

    getLastSmtTranscript() {
      return call("transcript");
    },

    /** The Boogie program the last verification translated to (prelude
     *  declarations filtered out); "" before the first verify. */
    getLastBoogie() {
      return call("boogie");
    },

    /**
     * Abort the in-flight verification by recycling the worker. The rejected
     * in-flight promises carry "cancelled"; readiness is re-established
     * automatically (served from the browser cache).
     */
    cancel() {
      if (terminated || !worker) {
        return;
      }
      const cancelled = worker;
      cancelled.terminate();
      rejectPending(new Error("cancelled"));
      try {
        options.onRestart?.("cancelled");
      } catch {}
      startWorker();
    },

    /** Resolves when the (possibly respawned) worker is ready again. */
    whenReady() {
      return readyPromise ?? Promise.reject(new Error("The Dafny verifier is not available."));
    },

    terminate() {
      if (terminated) {
        return;
      }
      terminated = true;
      rejectPending(new Error("The Dafny verifier has been terminated."));
      worker?.terminate();
      worker = null;
    }
  });
}

export default createDafny;
