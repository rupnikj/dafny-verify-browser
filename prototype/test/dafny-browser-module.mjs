import assert from "node:assert/strict";
import { createDafny } from "../src/dafny-browser.js";

class FakeWorker {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.terminated = false;
    queueMicrotask(() => this.emit("message", { data: { type: "ready" } }));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  postMessage(message) {
    if (message.source === "pending") {
      return;
    }
    const result = message.operation === "transcript"
      ? [{ request: "(check-sat)", response: "unsat" }]
      : { operation: message.operation, source: message.source };
    queueMicrotask(() => this.emit("message", {
      data: { id: message.id, ok: true, result }
    }));
  }

  terminate() {
    this.terminated = true;
  }
}

let worker;
const dafny = await createDafny({
  baseUrl: "https://example.test/assets/dafny",
  workerFactory: url => {
    worker = new FakeWorker(url);
    return worker;
  }
});

assert.equal(
  worker.url.href,
  "https://example.test/assets/dafny/verification-worker.js"
);
assert.deepEqual(
  await dafny.parse("method M() {}"),
  { operation: "parse", source: "method M() {}" }
);
assert.deepEqual(
  await dafny.verify("method M() {}"),
  { operation: "verify", source: "method M() {}" }
);
assert.deepEqual(
  await dafny.getLastSmtTranscript(),
  [{ request: "(check-sat)", response: "unsat" }]
);
await assert.rejects(dafny.verify(null), /must be a string/);

const pending = dafny.verify("pending");
dafny.terminate();
await assert.rejects(pending, /terminated/);
assert.equal(worker.terminated, true);
await assert.rejects(dafny.parse("method N() {}"), /terminated/);

console.log("dafny-browser.js module API: ok");
