import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./dist/wwwroot/", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".dat", "application/octet-stream"],
  [".dll", "application/octet-stream"],
  [".pdb", "application/octet-stream"],
  [".br", "application/octet-stream"],
  [".gz", "application/gzip"]
]);

createServer(async (request, response) => {
  // DAFNY_DEV_NO_COI simulates a host that cannot send COOP/COEP (a
  // third-party iframe embed, a plain static host): the worker must fall
  // back to the single-threaded solver. Used by the embed browser gate.
  if (!process.env.DAFNY_DEV_NO_COI) {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const requested = relative === "" ? "index.html" : relative;
  const path = join(root, requested);
  if (!path.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error("Not a file");
    }
    response.setHeader("Content-Type", contentTypes.get(extname(path)) ?? "application/octet-stream");
    response.setHeader("Content-Length", info.size);
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Dafny browser prototype: http://127.0.0.1:${port}`);
});
