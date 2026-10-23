import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const allowedFiles = new Map([
  ["/", "tests/prototypes/foundation-benchmark/index.html"],
  ["/index.html", "tests/prototypes/foundation-benchmark/index.html"],
  ["/main.js", "tests/prototypes/foundation-benchmark/main.js"],
  ["/fixtures/benchmarks/scenes.mjs", "tests/fixtures/benchmarks/scenes.mjs"],
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

createServer(async (request, response) => {
  const relativePath = allowedFiles.get(new URL(request.url, "http://localhost").pathname);
  if (!relativePath) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  try {
    const body = await readFile(resolve(repoRoot, relativePath));
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(relativePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(500);
    response.end("Unable to read benchmark file");
  }
}).listen(4173, "127.0.0.1", () => {
  process.stdout.write("Foundation benchmark: http://127.0.0.1:4173/\n");
});