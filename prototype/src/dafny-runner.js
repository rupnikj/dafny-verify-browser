// Executes a compiled Dafny→JavaScript program (the output of CompileToJs).
// Native `dafny run` pipes the same text into node's stdin; here the JS
// engine is a throwaway Worker, so a runaway program dies by terminate()
// instead of Ctrl-C. Where Workers are unavailable the program runs on the
// page thread (no timeout is enforceable there — the page blocks until the
// program ends).
//
// The generated code expects two node ambients, both shimmed: a `require`
// that resolves exactly bignumber.js (DafnyRuntime.js line 4) and `process`
// (the call-to-main glue reads process.argv; print statements and the
// [Program halted] handler write process.stdout).

const WORKER_SOURCE = `self.onmessage = event => {
  const { bignumber, program, callToMain } = event.data;
  const post = message => self.postMessage(message);
  const processShim = {
    stdout: { write: text => post({ type: "output", text: String(text) }), setEncoding: () => {} },
    argv: ["node", "main.dfy"],
    exitCode: 0
  };
  self.process = processShim;
  try {
    (0, eval)(bignumber); // UMD: no module/define in a worker, so it lands on self.BigNumber
    const requireShim = name => {
      if (name === "bignumber.js") return self.BigNumber;
      if (name === "process") return processShim;
      throw new Error("module not available in the browser runner: " + name);
    };
    new Function("require", "process", program + "\\n" + (callToMain || ""))(requireShim, processShim);
    post({ type: "done", ok: processShim.exitCode === 0, exitCode: processShim.exitCode });
  } catch (error) {
    post({ type: "done", ok: false, error: String((error && error.stack) || error) });
  }
};`;

function runInline({ program, callToMain, bignumberSource, onOutput }) {
  const processShim = {
    stdout: { write: text => onOutput?.(String(text)), setEncoding: () => {} },
    argv: ["node", "main.dfy"],
    exitCode: 0
  };
  try {
    if (!globalThis.BigNumber) {
      (0, eval)(bignumberSource);
    }
    const requireShim = name => {
      if (name === "bignumber.js") return globalThis.BigNumber;
      if (name === "process") return processShim;
      throw new Error("module not available in the browser runner: " + name);
    };
    new Function("require", "process", program + "\n" + (callToMain || ""))(requireShim, processShim);
    return { ok: processShim.exitCode === 0, exitCode: processShim.exitCode };
  } catch (error) {
    return { ok: false, error: String(error?.stack || error) };
  }
}

/**
 * @param {{
 *   program: string, callToMain: string | null, bignumberSource: string,
 *   timeoutMs?: number, onOutput?: (text: string) => void
 * }} job — timeoutMs 0 disables the watchdog.
 * @returns {{ done: Promise<{ok: boolean, exitCode?: number, error?: string,
 *   timedOut?: boolean, cancelled?: boolean, inline?: boolean}>, cancel: () => void }}
 */
export function runCompiled({ program, callToMain, bignumberSource, timeoutMs = 30000, onOutput }) {
  let worker = null;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    try {
      worker = new Worker(url, { name: "dafny-run" });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // No Worker construction here (e.g. a sandbox with worker-src 'none'):
    // run synchronously on this thread.
    const result = runInline({ program, callToMain, bignumberSource, onOutput });
    return { done: Promise.resolve({ ...result, inline: true }), cancel: () => {} };
  }

  let settle;
  const done = new Promise(resolve => {
    let settled = false;
    settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => settle({ ok: false, timedOut: true }), timeoutMs)
      : null;
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === "output") {
        onOutput?.(message.text);
      } else if (message.type === "done") {
        settle({ ok: message.ok, exitCode: message.exitCode, error: message.error });
      }
    };
    worker.onerror = event => settle({ ok: false, error: event.message || "The runner worker failed." });
    worker.postMessage({ bignumber: bignumberSource, program, callToMain });
  });
  return { done, cancel: () => settle({ ok: false, cancelled: true }) };
}
