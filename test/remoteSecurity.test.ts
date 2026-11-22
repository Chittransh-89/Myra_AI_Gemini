/**
 * Phase 1.1 security regression tests.
 *
 * Covers:
 *  1. the desktop WS token is never written to console logs,
 *  2. pairing rate limiting behind a reverse proxy (opt-in X-Forwarded-For),
 *  3. strict MYRA_REMOTE / MYRA_TRUST_PROXY parsing,
 *  4. /remote.html is not served in standalone mode,
 *  5. desktop pairing APIs are Cache-Control: no-store.
 *
 * Run with: npx tsx test/remoteSecurity.test.ts
 */

import express from "express";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig } from "../src/server/config.js";
import { PairingManager } from "../src/server/remote/pairing.js";
import { RemoteRuntime } from "../src/server/remote/runtime.js";
import { createRemoteRouter } from "../src/server/remote/routes.js";

const DESKTOP_TOKEN = "phase11-desktop-token-never-log";
const PUBLIC_URL = "https://myra-pc.test-tailnet.ts.net";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CONFIG_KEYS = [
  "AI_PROVIDER",
  "GEMINI_API_KEY",
  "HOST",
  "MYRA_DIST_DIR",
  "MYRA_ELECTRON",
  "MYRA_REMOTE",
  "MYRA_REMOTE_PUBLIC_URL",
  "MYRA_TRUST_PROXY",
  "MYRA_WEBSITE_MODE",
  "MYRA_WS_TOKEN",
  "NODE_ENV",
  "PORT",
];

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** loadConfig() without noise; captures warnings so they can be asserted on. */
function quietConfig(overrides: Record<string, string | undefined>): {
  config: ReturnType<typeof loadConfig>;
  warnings: string[];
} {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.log = () => {};
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const config = withEnv(overrides, () => loadConfig());
    return { config, warnings };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

const ELECTRON_ENV = {
  AI_PROVIDER: "local",
  MYRA_ELECTRON: "1",
  MYRA_WS_TOKEN: DESKTOP_TOKEN,
};

async function startPairingServer(options: {
  trustProxy: boolean;
  maxAttempts?: number;
}): Promise<{
  base: string;
  pairing: PairingManager;
  server: http.Server;
  runtime: RemoteRuntime;
}> {
  const runtime = new RemoteRuntime({ enabled: true, publicUrl: PUBLIC_URL });
  const pairing = new PairingManager({ maxAttempts: options.maxAttempts ?? 2 });

  const app = express();
  app.use(
    createRemoteRouter({
      runtime,
      pairing,
      desktopToken: DESKTOP_TOKEN,
      publicUrl: PUBLIC_URL,
      projectRoot: process.cwd(),
      distDir: path.join(process.cwd(), "dist"),
      isProduction: false,
      trustProxy: options.trustProxy,
    })
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, pairing, server, runtime };
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function wrongCode(pairing: PairingManager): string {
  return pairing.getInfo().code === "000000" ? "111111" : "000000";
}

async function pairAttempt(base: string, code: string, forwardedFor?: string): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  const res = await fetch(`${base}/remote/pair`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code, deviceName: "Security Phone" }),
  });
  return res.status;
}

async function run(): Promise<void> {
  // --- 1. Desktop WS token is never logged --------------------------------
  {
    const appSource = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
    const consoleCalls = appSource.match(/console\.(?:log|warn|error)\([\s\S]*?\);/g) ?? [];
    check(consoleCalls.length > 0, "App.tsx must still contain its normal console calls");
    for (const call of consoleCalls) {
      check(
        !/\bwsUrl\b|\bauthSuffix\b|\bauthToken\b/.test(call),
        `renderer console call must not reference the authenticated URL or token: ${call.slice(0, 120)}`
      );
    }
    check(
      appSource.includes("Connecting to voice-to-voice server at:") &&
        appSource.includes("/ws${authLabel}") &&
        appSource.includes("(authenticated)"),
      "renderer should log only the redacted WS path plus an auth marker"
    );

    const mainSource = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
    check(
      !/console\.(?:log|warn|error)\([^)]*WS_TOKEN/.test(mainSource),
      "main process must not log WS_TOKEN"
    );
    check(
      !/console\.(?:log|warn|error)\([^)]*MYRA_RECEIPT_KEY/.test(mainSource),
      "main process must not log the receipt key"
    );
  }

  // --- 3. Strict environment parsing --------------------------------------
  {
    check(
      quietConfig(ELECTRON_ENV).config.remoteEnabled === true,
      "unset MYRA_REMOTE must default to enabled in Electron mode"
    );

    for (const off of ["0", "false", "no", "off", " OFF "]) {
      check(
        quietConfig({ ...ELECTRON_ENV, MYRA_REMOTE: off }).config.remoteEnabled === false,
        `MYRA_REMOTE=${JSON.stringify(off)} must disable remote control`
      );
    }
    for (const on of ["1", "true", "yes", "on", " On "]) {
      check(
        quietConfig({ ...ELECTRON_ENV, MYRA_REMOTE: on }).config.remoteEnabled === true,
        `MYRA_REMOTE=${JSON.stringify(on)} must enable remote control`
      );
    }

    const invalid = quietConfig({ ...ELECTRON_ENV, MYRA_REMOTE: "ture" });
    check(
      invalid.config.remoteEnabled === false,
      "an unrecognised MYRA_REMOTE value must fail closed (remote disabled)"
    );
    check(
      invalid.warnings.some((warning) => warning.includes("MYRA_REMOTE")),
      "an invalid MYRA_REMOTE value must produce a warning naming the variable"
    );
    check(
      invalid.warnings.every((warning) => !warning.includes(DESKTOP_TOKEN)),
      "configuration warnings must never contain the WS token"
    );

    check(
      quietConfig({ MYRA_REMOTE: "1" }).config.remoteEnabled === false,
      "remote control stays Electron-only even with MYRA_REMOTE=1"
    );

    check(
      quietConfig(ELECTRON_ENV).config.trustProxy === false,
      "MYRA_TRUST_PROXY must default to false"
    );
    check(
      quietConfig({ ...ELECTRON_ENV, MYRA_TRUST_PROXY: "1" }).config.trustProxy === true,
      "MYRA_TRUST_PROXY=1 must enable proxy trust"
    );
    const invalidProxy = quietConfig({ ...ELECTRON_ENV, MYRA_TRUST_PROXY: "yes-please" });
    check(invalidProxy.config.trustProxy === false, "invalid MYRA_TRUST_PROXY must fail closed");
    check(
      invalidProxy.warnings.some((warning) => warning.includes("MYRA_TRUST_PROXY")),
      "invalid MYRA_TRUST_PROXY must warn"
    );
  }

  // --- 2. Pairing rate limiting identity ----------------------------------
  {
    // Default (no proxy trust): every loopback request shares one bucket, and
    // X-Forwarded-For cannot be used to escape it.
    const direct = await startPairingServer({ trustProxy: false });
    try {
      const code = wrongCode(direct.pairing);
      check(
        (await pairAttempt(direct.base, code, "100.64.0.10")) === 400,
        "first direct attempt must be rejected as invalidCode"
      );
      check(
        (await pairAttempt(direct.base, code, "100.64.0.10")) === 400,
        "second direct attempt must be rejected as invalidCode"
      );
      check(
        (await pairAttempt(direct.base, code, "100.64.0.99")) === 429,
        "without trustProxy a forwarded address must NOT create a fresh bucket"
      );
    } finally {
      direct.runtime.dispose();
      direct.pairing.dispose();
      await closeServer(direct.server);
    }

    // Trusted proxy: X-Forwarded-For distinguishes clients, but spoofed
    // left-most entries cannot escape the bucket the proxy observed.
    const proxied = await startPairingServer({ trustProxy: true });
    try {
      const code = wrongCode(proxied.pairing);
      check(
        (await pairAttempt(proxied.base, code, "100.64.0.10")) === 400,
        "client A first attempt must be invalidCode"
      );
      check(
        (await pairAttempt(proxied.base, code, "100.64.0.10")) === 400,
        "client A second attempt must be invalidCode"
      );
      check(
        (await pairAttempt(proxied.base, code, "100.64.0.11")) === 400,
        "client B must get its own rate-limit bucket"
      );
      check(
        (await pairAttempt(proxied.base, code, "100.64.0.10")) === 429,
        "client A must still be limited after exhausting its own bucket"
      );
      check(
        (await pairAttempt(proxied.base, code, "9.9.9.9, 100.64.0.10")) === 429,
        "a spoofed left-most entry must not escape the trusted right-most address"
      );
    } finally {
      proxied.runtime.dispose();
      proxied.pairing.dispose();
      await closeServer(proxied.server);
    }

    // Malformed forwarded headers must fall back to the peer bucket.
    const malformed = await startPairingServer({ trustProxy: true });
    try {
      const code = wrongCode(malformed.pairing);
      check(
        (await pairAttempt(malformed.base, code)) === 400,
        "no header: first attempt must be invalidCode"
      );
      check(
        (await pairAttempt(malformed.base, code)) === 400,
        "no header: second attempt must be invalidCode"
      );
      check(
        (await pairAttempt(malformed.base, code, "not-an-ip")) === 429,
        "a malformed X-Forwarded-For must fall back to the loopback peer bucket"
      );
    } finally {
      malformed.runtime.dispose();
      malformed.pairing.dispose();
      await closeServer(malformed.server);
    }
  }

  // --- 5. Desktop pairing APIs are not cacheable --------------------------
  {
    const server = await startPairingServer({ trustProxy: false });
    try {
      const info = await fetch(`${server.base}/api/remote/pairing`, {
        headers: { "x-myra-desktop-token": DESKTOP_TOKEN },
      });
      check(info.status === 200, "pairing info must be available to the desktop");
      const cacheControl = info.headers.get("cache-control") ?? "";
      check(cacheControl.includes("no-store"), "pairing info must send Cache-Control: no-store");
      check(
        (info.headers.get("pragma") ?? "").toLowerCase().includes("no-cache"),
        "pairing info must send Pragma: no-cache"
      );

      const rotated = await fetch(`${server.base}/api/remote/pairing/rotate`, {
        method: "POST",
        headers: { "x-myra-desktop-token": DESKTOP_TOKEN },
      });
      check(rotated.status === 200, "code rotation must succeed");
      check(
        (rotated.headers.get("cache-control") ?? "").includes("no-store"),
        "code rotation must send Cache-Control: no-store"
      );
    } finally {
      server.runtime.dispose();
      server.pairing.dispose();
      await closeServer(server.server);
    }
  }

  // --- 4. /remote.html is not served in standalone mode -------------------
  {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-phase11-dist-"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>spa</title>");
    fs.writeFileSync(path.join(distDir, "remote.html"), "<!doctype html><title>remote</title>");
    fs.writeFileSync(path.join(distDir, "probe.txt"), "static-ok");

    const overrides: Record<string, string | undefined> = {
      AI_PROVIDER: "local",
      HOST: "127.0.0.1",
      MYRA_DIST_DIR: distDir,
      MYRA_ELECTRON: undefined,
      MYRA_REMOTE: undefined,
      MYRA_TRUST_PROXY: undefined,
      NODE_ENV: "production",
      PORT: "0",
    };

    const saved = new Map<string, string | undefined>();
    for (const key of CONFIG_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    let server: http.Server | null = null;
    try {
      const { LocalProvider } = await import("../src/server/providers/local.js");
      const { startServer } = await import("../src/server/index.js");
      server = await startServer(new LocalProvider(), loadConfig());
      if (!server.listening) {
        await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
      }
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const probe = await fetch(`${base}/probe.txt`);
      check(probe.status === 200, "static assets must still be served in standalone mode");
      check((await probe.text()) === "static-ok", "static probe must return its content");

      const remoteHtml = await fetch(`${base}/remote.html`);
      check(remoteHtml.status === 404, "/remote.html must not be served in standalone mode");
      const remoteHtmlBody: any = await remoteHtml.json();
      check(
        remoteHtmlBody.error === "remoteDisabled",
        "/remote.html must report remoteDisabled in standalone mode"
      );

      const remote = await fetch(`${base}/remote`);
      check(remote.status === 404, "/remote must stay disabled in standalone mode");
      const pairingApi = await fetch(`${base}/api/remote/pairing`);
      check(pairingApi.status === 404, "desktop pairing API must stay disabled in standalone mode");
    } finally {
      if (server) await closeServer(server);
      for (const key of CONFIG_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }

  console.log("remoteSecurity: all checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
