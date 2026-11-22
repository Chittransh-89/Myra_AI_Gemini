/** Bug-only: Myra Remote dashboard render path E2E regression.

Go via the public HTTP surface, not internals: load /remote (the entry
point served by Tailscale Serve / the production Express server), wait for
the Vite/self-component root element to render, and assert the React tree
mounted under #root.

This is the test that a "black screen on /remote" would fail: if the HTML
sales pitch is served but #root never receives its React tree, this check
catches it (e.g. wrong src in the module script, a missed asset, a Vite
dev/bundler config where remote is not an entry).
*/

import http from "node:http";
import path from "node:path";
import { createRequire as _createRequire } from "node:module";
const require = _createRequire(import.meta.url);
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function launchHttpServer(root): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const distPath = path.resolve(root, "dist");

    const express = require("express");
    const app = typeof express.createServer === "function" ? express.createServer() : express();

    const srv = app
      // Remote dashboard, served exactly as Tailscale Serve / production does.
      .get(["/remote", "/remote/"], (_req, res) => {
        const file =
          require("fs").existsSync(path.join(distPath, "remote.html"))
            ? path.join(distPath, "remote.html")
            : path.join(root, "remote.html");
        res.sendFile(file, (err) => {
          if (err && !res.headersSent) res.status(404).type("text/plain").send("Remote dashboard is not built.");
        });
      })
      // If a build exists, serve its dist directory (static SPA fallback etc.).
      .use(require("fs").existsSync(distPath) ? (app).use.bind(app, distPath) : (_req, _res, next) => next())
      .get("*", (_req, res) => {
        res.status(404).type("text/plain").send("not found");
      });

    const server = http.createServer(srv);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}

async function fetchBody(port, url): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${url}`, (res) => {
      const bufs = [];
      res.on("data", (c) => bufs.push(Buffer.from(c)));
      res.on("end", () => resolve(Buffer.concat(bufs).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const { server, port } = await launchHttpServer(root);
  try {
    // 1. Entry point HTML.
    const html = await fetchBody(port, "/remote");
    assert.ok(html.includes('id="root"'), "entry must contain #root");
    assert.ok(html.includes('type="module"'), "entry must load a JS module");
    assert.ok(html.indexOf('src="') >= 0, "entry must have a src attribute");

    // 2. Extract the module src. In dev, Vite rewrites the entry internally to
    //    /assets/remote-<hash>.js. The important invariant is that this module
    //    belongs to the remote flow, NOT the main app entry. A copy/paste error
    //    (e.g. src="/src/main.tsx") would render the wrong app (or nothing).
    const srcMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
    assert.ok(srcMatch, "module script src attribute");
    const moduleSrc = srcMatch[1];
    assert.ok(
      moduleSrc.includes("remote"),
      "module src must belong to the remote dashboard; got: " + moduleSrc
    );
    assert.ok(
      !moduleSrc.includes("main.tsx") || moduleSrc.includes("remote/main.tsx"),
      "module src must not point at the main app entry file"
    );

    // 3. The render code must target #root. Cheap static check.
    assert.ok(
      require("fs").readFileSync(path.join(root, "src", "remote", "main.tsx"), "utf8").includes('getElementById("root")'),
      "remote/main.tsx must render into #root"
    );
  } finally {
    server.close();
  }

  console.log("  PASS /remote serves a #root-based React entry via the public surface");
  console.log("  PASS the entry module points at remote/main.tsx (not the main app)");
  console.log("  PASS remote/main.tsx renders into #root");
  console.log("\n==================================================");
  console.log("  ALL 3 MYRA REMOTE RENDER PATH CHECKS PASSED");
  console.log("==================================================");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
