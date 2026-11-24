/**
 * Phase 1 targeted smoke test: full server wiring.
 *
 * Verifies that the new noServer upgrade dispatcher still authenticates the
 * legacy /ws path, and that the remote surface is mounted when Electron mode
 * is active. Uses the non-functional LocalProvider so no cloud session starts.
 *
 * Run with:
 *   npx tsx test/serverUpgradeSmoke.test.ts
 */

import { WebSocket } from "ws";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error("server did not start in time");
}

function connect(
  url: string,
  headers: Record<string, string> = {}
): Promise<{
  ws: WebSocket;
  next: (predicate?: (message: any) => boolean, timeoutMs?: number) => Promise<any>;
}> {
  const ws = new WebSocket(url, { headers });
  const buffer: any[] = [];
  const waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    buffer.push(parsed);
  });

  const next = (
    predicate: (message: any) => boolean = () => true,
    timeoutMs = 3_000
  ): Promise<any> => {
    const index = buffer.findIndex(predicate);
    if (index >= 0) return Promise.resolve(buffer.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error("timed out waiting for WebSocket message"));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };

  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, next }));
    ws.once("error", reject);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    try {
      ws.close();
    } catch {
      resolve();
    }
  });
}

async function run(): Promise<void> {
  const port = 39_100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;

  process.env.AI_PROVIDER = "local";
  process.env.MYRA_ELECTRON = "1";
  process.env.MYRA_WS_TOKEN = "smoke-desktop-token";
  process.env.MYRA_REMOTE = "1";
  process.env.MYRA_REMOTE_PUBLIC_URL = "https://smoke.test-tailnet.ts.net";
  process.env.NODE_ENV = "production";
  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";

  const { loadConfig } = await import("../src/server/config.js");
  const { LocalProvider } = await import("../src/server/providers/local.js");
  const { startServer } = await import("../src/server/index.js");

  const server = await startServer(new LocalProvider(), loadConfig());
  await waitForServer(`${base}/api/remote/pairing`);

  // Remote desktop endpoint is mounted and authenticated.
  const unauthorized = await fetch(`${base}/api/remote/pairing`);
  check(unauthorized.status === 401, "remote pairing endpoint must require the desktop token");

  const authorized = await fetch(`${base}/api/remote/pairing`, {
    headers: { "x-myra-desktop-token": "smoke-desktop-token" },
  });
  check(authorized.status === 200, "remote pairing endpoint must accept the desktop token");
  const pairingBody: any = await authorized.json();
  check(/^\d{6}$/.test(String(pairingBody.code)), "remote pairing endpoint must return a code");

  // Legacy /ws rejects a missing token.
  {
    const { ws, next } = await connect(`ws://127.0.0.1:${port}/ws`);
    const message = await next();
    check(
      message.type === "status" && message.state === "error",
      "unauthenticated /ws must receive an error status"
    );
    check(
      String(message.message || "").includes("Authentication failed"),
      "unauthenticated /ws must fail authentication"
    );
    await closeWs(ws);
  }

  // Legacy /ws still upgrades with a valid token (LocalProvider refuses the
  // session, which proves the connection reached handleConnection).
  {
    const { ws, next } = await connect(`ws://127.0.0.1:${port}/ws?auth=smoke-desktop-token`);
    const message = await next((frame) => frame.type === "status");
    check(message.type === "status", "authenticated /ws must receive a status frame");
    check(
      !String(message.message || "").includes("Authentication failed"),
      "authenticated /ws must not fail authentication"
    );
    await closeWs(ws);
  }

  // Phase 2 wiring: the remote socket accepts audio frames but reports
  // sessionUnavailable when no desktop Gemini session is attached. This proves
  // the audio bridge is mounted without creating a duplicate session.
  {
    const pairingInfo = await fetch(`${base}/api/remote/pairing`, {
      headers: { "x-myra-desktop-token": "smoke-desktop-token" },
    });
    const pairingBody: any = await pairingInfo.json();
    const paired = await fetch(`${base}/remote/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingBody.code, deviceName: "Smoke Phone" }),
    });
    check(paired.status === 200, "smoke phone pairing must succeed");
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
    check(cookie.startsWith("myra_remote="), "smoke phone pairing must set a cookie");

    const remote = await connect(`ws://127.0.0.1:${port}/remote/ws`, { cookie });
    await remote.next((frame) => frame.type === "remoteState");
    // Phone Remote is manual-only: arm it explicitly first.
    remote.ws.send(JSON.stringify({ type: "audioStart" }));
    await remote.next((frame) => frame.type === "remoteState" && frame.snapshot.mic.enabled === true);
    remote.ws.send(
      JSON.stringify({ type: "audio", data: Buffer.alloc(4).toString("base64") })
    );
    const audioError = await remote.next(
      (frame) => frame.type === "error" && frame.code === "sessionUnavailable"
    );
    check(
      audioError.code === "sessionUnavailable",
      "phone audio without a desktop Gemini session must be rejected"
    );
    await closeWs(remote.ws);
  }

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log("serverUpgradeSmoke: all checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
