/** Phase 1 targeted tests: remote HTTP routes + authenticated WebSocket.
 *
 * Spins up a real loopback HTTP server on an ephemeral port. Run with:
 *   npx tsx test/remoteRoutes.test.ts
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { WebSocket } from "ws";
import { createRequire as _createRequire } from "node:module";
const require = _createRequire(import.meta.url);

import { PairingManager } from "../src/server/remote/pairing.js";
import { RemoteRuntime } from "../src/server/remote/runtime.js";
import { createRemoteRouter, createRemoteWebSocketServer } from "../src/server/remote/routes.js";

const DESKTOP_TOKEN = "test-desktop-token-do-not-log";
const PUBLIC_URL = "https://myra-pc.test-tailnet.ts.net";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

interface WsQueue {
  next(predicate?, timeoutMs?);
}

/**
 * Buffers every WebSocket message from the moment the socket exists, so the
 * initial state snapshot (sent immediately on connection) is never missed.
 */
function createQueue(ws) {
  const buffer = [];
  const waiters = [];

  ws.on("message", function (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (e) {
      parsed = { type: "invalid" };
    }

    const idx = waiters.findIndex(function (waiter) { return waiter.predicate(parsed); });
    if (idx >= 0) {
      const waiter = waiters.splice(idx, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    buffer.push(parsed);
  });

  return {
    next: function (predicate?, timeoutMs?) {
      if (predicate === undefined) predicate = function () { return true; };
      if (timeoutMs === undefined) timeoutMs = 3000;

      const idx = buffer.findIndex(predicate);
      if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0]);

      return new Promise(function (resolve, reject) {
        const waiter = {
          predicate: predicate,
          resolve: resolve,
          reject: reject,
          timer: setTimeout(function () {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            reject(new Error("timed out waiting for WebSocket message"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function connectWithQueue(url, headers) {
    const ws = new WebSocket(url, headers);
    const queue = createQueue(ws);
    await new Promise<void>(function (resolve, reject) {
      ws.once("open", function () { resolve(); });
      ws.once("error", function (err) { reject(err); });
    });
    return { ws: ws, queue: queue };
  }

function closeSocket(ws) {
  return new Promise<void>(function (resolve) {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", function () { resolve(); });
    try { ws.close(); } catch (e) { resolve(); }
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function run() {
  const runtime = new RemoteRuntime({ enabled: true, publicUrl: PUBLIC_URL });
  const pairing = new PairingManager();

  const express = require("express");
  const app = typeof express.createServer === "function" ? express.createServer() : express();
  app.use(
    createRemoteRouter({
      runtime: runtime,
      pairing: pairing,
      desktopToken: DESKTOP_TOKEN,
      publicUrl: PUBLIC_URL,
      projectRoot: process.cwd(),
      distDir: path.join(process.cwd(), "dist"),
      isProduction: false,
    })
  );

  const server = http.createServer(app);
  const remoteWs = createRemoteWebSocketServer({
    runtime: runtime,
    pairing: pairing,
    publicUrl: PUBLIC_URL,
  });

  server.on("upgrade", function (req, socket, head) {
    if (!remoteWs.handleUpgrade(req, socket, head)) socket.destroy();
  });

  await new Promise<void>(function (resolve) { server.listen(0, "127.0.0.1", function () { resolve(); }); });
  const addr = server.address();
  const port = (addr && typeof addr === "object" && "port" in addr) ? addr.port : 0;
  const base = "http://127.0.0.1:" + port;
  const wsUrl = "ws://127.0.0.1:" + port + "/remote/ws";

  let phoneSocket = null;

  try {
    {
      const unauthorized = await fetch(base + "/api/remote/pairing");
      check(unauthorized.status === 401, "pairing info without desktop token must be 401");

      const wrong = await fetch(base + "/api/remote/pairing", {
        headers: { "x-myra-desktop-token": "wrong-token" },
      });
      check(wrong.status === 401, "pairing info with a wrong token must be 401");

      const ok = await fetch(base + "/api/remote/pairing", {
        headers: { "x-myra-desktop-token": DESKTOP_TOKEN },
      });
      check(ok.status === 200, "pairing info with the desktop token must be 200");
      const body = await ok.json();
      check(body.ok === true, "pairing info must report ok");
      check(/^\d{6}$/.test(String(body.code)), "pairing info must expose a 6-digit code");
      check(
        typeof body.remoteUrl === "string" && body.remoteUrl === PUBLIC_URL + "/remote",
        "pairing info must report the /remote dashboard URL"
      );
      check(body.pairedDevice === null, "fresh pairing info must not be paired");
    }

    {
      const info = pairing.getInfo();
      const wrongCode = info.code === "000000" ? "111111" : "000000";
      const rejected = await fetch(base + "/remote/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: wrongCode, deviceName: "Test Phone" }),
      });
      check(rejected.status === 400, "wrong pairing code must be 400");
      const rejectedBody = await rejected.json();
      check(rejectedBody.error === "invalidCode", "wrong pairing code must report invalidCode");
    }

    let cookie = "";
    {
      const code = pairing.getInfo().code;
      const paired = await fetch(base + "/remote/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code, deviceName: "Test Phone" }),
      });
      check(paired.status === 200, "valid pairing code must be 200");
      const body = await paired.json();
      check(body.ok === true, "pairing must report ok");
      check(body.deviceName === "Test Phone", "pairing must echo the device name");

      const setCookie = paired.headers.get("set-cookie") ?? "";
      check(setCookie.includes("myra_remote="), "pairing must set the myra_remote cookie");
      check(/HttpOnly/i.test(setCookie), "phone cookie must be HttpOnly");
      check(/SameSite=Strict/i.test(setCookie), "phone cookie must be SameSite=Strict");
      check(/Path=\/remote/i.test(setCookie), "phone cookie must be scoped to /remote");
      cookie = setCookie.split(";")[0];
      check(cookie.length > "myra_remote=".length, "phone cookie must carry a token");
    }

    {
      const unauthorized = await fetch(base + "/remote/api/state");
      check(unauthorized.status === 401, "state without cookie must be 401");

      const state = await fetch(base + "/remote/api/state", { headers: { cookie: cookie } });
      check(state.status === 200, "state with cookie must be 200");
      const body = await state.json();
      check(body.ok === true, "state must report ok");
      check(body.snapshot.mic.source === "phone", "remote mic must default to the phone");
      check(body.snapshot.mic.defaultSource === "phone", "remote mic default must be the phone");
      check(body.snapshot.mic.streaming === false, "Phase 1 must not stream audio");
      check(body.snapshot.myra.mode === "legacy", "Phase 1 must report legacy lifecycle");
      check(body.snapshot.pc.connected === true, "desktop poll must count as PC presence");
      check(body.snapshot.remote.phoneConnected === false, "no phone socket yet");
    }

    {
      const connected = await connectWithQueue(wsUrl, { headers: { cookie: cookie } });
      phoneSocket = connected.ws;
      const queue = connected.queue;

      const initial = await queue.next(function (message) { return message.type === "remoteState"; });
      check(initial.type === "remoteState", "socket must send an initial state snapshot");
      check(initial.snapshot.remote.phoneConnected === true, "socket must mark the phone connected");

      phoneSocket.send(JSON.stringify({ type: "requestState" }));
      const requested = await queue.next(function (message) { return message.type === "remoteState"; });
      check(requested.type === "remoteState", "requestState must return a snapshot");

      phoneSocket.send(JSON.stringify({ type: "ping", ts: 123 }));
      const pong = await queue.next(function (message) { return message.type === "pong"; });
      check(pong.type === "pong", "ping must be answered");
      check(pong.ts === 123, "pong must echo the timestamp");

      phoneSocket.send(JSON.stringify({ type: "control", action: "on" }));
      const control = await queue.next(
        function (message) { return message.type === "error" && message.code === "notImplemented"; }
      );
      check(control.type === "error" && control.code === "notImplemented", "control is Phase 3");

      // Manual-only Phone Remote: audio is refused until it is explicitly armed.
      phoneSocket.send(
        JSON.stringify({ type: "audio", data: Buffer.alloc(4).toString("base64") })
      );
      const notEnabled = await queue.next(
        function (message) { return message.type === "error" && message.code === "micNotEnabled"; }
      );
      check(
        notEnabled.type === "error" && notEnabled.code === "micNotEnabled",
        "audio before Phone Remote ON must be rejected"
      );

      phoneSocket.send(JSON.stringify({ type: "audioStart" }));
      const armed = await queue.next(
        function (message) { return message.type === "remoteState" && message.snapshot.mic.enabled === true; }
      );
      check(armed.snapshot.mic.enabled === true, "audioStart must arm Phone Remote");

      phoneSocket.send(
        JSON.stringify({ type: "audio", data: Buffer.alloc(4).toString("base64") })
      );
      const audio = await queue.next(
        function (message) { return message.type === "error" && message.code === "sessionUnavailable"; }
      );
      check(
        audio.type === "error" && audio.code === "sessionUnavailable",
        "audio without a wired session must be rejected"
      );

      phoneSocket.send("not json");
      const bad = await queue.next(
        function (message) { return message.type === "error" && message.code === "badMessage"; }
      );
      check(bad.type === "error" && bad.code === "badMessage", "invalid JSON must be rejected");

      const live = await fetch(base + "/remote/api/state", { headers: { cookie: cookie } });
      const liveBody = await live.json();
      check(
        liveBody.snapshot.remote.phoneConnected === true,
        "state must report the live phone connection"
      );
      check(
        liveBody.snapshot.remote.deviceName === "Test Phone",
        "state must report the paired device name"
      );

      await closeSocket(phoneSocket);
      phoneSocket = null;
      await sleep(100);
      const after = await fetch(base + "/remote/api/state", { headers: { cookie: cookie } });
      const afterBody = await after.json();
      check(
        afterBody.snapshot.remote.phoneConnected === false,
        "closing the socket must clear phone presence"
      );
    }

    {
      const noCookie = await new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl);
        ws.once("open", function () {
          ws.close();
          resolve("opened");
        });
        ws.once("error", function () { resolve("rejected"); });
      });
      check(noCookie === "rejected", "WebSocket without a cookie must be rejected");

      const badOrigin = await new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl, {
          headers: { cookie: cookie, Origin: "https://evil.example" },
        });
        ws.once("open", function () {
          ws.close();
          resolve("opened");
        });
        ws.once("error", function () { resolve("rejected"); });
      });
      check(badOrigin === "rejected", "WebSocket from a foreign origin must be rejected");
    }

    {
      const unpaired = await fetch(base + "/remote/unpair", {
        method: "POST",
        headers: { cookie: cookie },
      });
      check(unpaired.status === 200, "unpair must succeed");

      const revoked = await fetch(base + "/remote/api/state", { headers: { cookie: cookie } });
      check(revoked.status === 401, "unpaired token must be rejected");
    }

    console.log("remoteRoutes: all checks passed");
  } finally {
    if (phoneSocket) await closeSocket(phoneSocket);
    remoteWs.close();
    runtime.dispose();
    pairing.dispose();      await new Promise<void>(function (resolve) { server.close(function () { resolve(); }); });
  }
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
