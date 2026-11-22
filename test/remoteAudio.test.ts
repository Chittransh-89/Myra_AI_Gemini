/**
 * Phase 2 targeted tests: remote audio bridge + authenticated /remote/ws audio.
 *
 * Run with: npx tsx test/remoteAudio.test.ts
 */

import express from "express";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { WebSocket } from "ws";

import { RemoteAudioBridge } from "../src/server/remote/audioBridge.js";
import { PairingManager } from "../src/server/remote/pairing.js";
import { RemoteRuntime } from "../src/server/remote/runtime.js";
import { createRemoteRouter, createRemoteWebSocketServer } from "../src/server/remote/routes.js";

const DESKTOP_TOKEN = "audio-test-desktop-token";
const PUBLIC_URL = "https://myra-pc.test-tailnet.ts.net";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WsQueue {
  next(predicate?: (message: any) => boolean, timeoutMs?: number): Promise<any>;
}

function createQueue(ws: WebSocket): WsQueue {
  const buffer: any[] = [];
  const waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on("message", (raw) => {
    let parsed: any;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      parsed = { type: "invalid" };
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    buffer.push(parsed);
  });

  return {
    next(predicate: (message: any) => boolean = () => true, timeoutMs = 3_000): Promise<any> {
      const index = buffer.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffer.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
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

function connect(url: string, headers: Record<string, string>): Promise<{ ws: WebSocket; queue: WsQueue }> {
  const ws = new WebSocket(url, { headers });
  const queue = createQueue(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, queue }));
    ws.once("error", reject);
  });
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(0);
    ws.once("close", (code) => resolve(code));
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
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

function pcmChunk(bytes = 3_200, fill = 1): string {
  return Buffer.alloc(bytes, fill).toString("base64");
}

async function run(): Promise<void> {
  // --- Bridge unit behaviour ------------------------------------------------
  {
    const bridge = new RemoteAudioBridge();
    check(Boolean(bridge.hasSession) === false, "a fresh bridge must have no session");
    check(bridge.push(pcmChunk(), 3_200).reason === "noSession", "no session must reject audio");

    const received: string[] = [];
    const detach = bridge.attach("desktop-1", { sendAudio: (data) => received.push(data) });
    check(Boolean(bridge.hasSession) === true, "attach must mark a session active");
    const chunk = pcmChunk();
    check(bridge.push(chunk, 3_200).ok === true, "attached bridge must accept audio");
    check(received.length === 1 && received[0] === chunk, "bridge must forward the exact chunk");

    detach();
    check(Boolean(bridge.hasSession) === false, "detach must clear the session");
    check(bridge.push(chunk, 3_200).reason === "noSession", "detached bridge must reject audio");

    // Replacement + fallback ordering.
    const order: string[] = [];
    bridge.attach("desktop-a", { sendAudio: () => order.push("a") });
    bridge.attach("desktop-b", { sendAudio: () => order.push("b") });
    bridge.push(chunk, 3_200);
    check(order[order.length - 1] === "b", "newest attached session must receive audio");
    bridge.detach("desktop-b");
    bridge.push(chunk, 3_200);
    check(order[order.length - 1] === "a", "detaching the newest must fall back to the previous");

    // Send failures are reported, never buffered.
    const failing = new RemoteAudioBridge();
    failing.attach("desktop-x", {
      sendAudio: () => {
        throw new Error("provider closed");
      },
    });
    check(failing.push(chunk, 3_200).reason === "sendFailed", "sink failure must be reported");

    // Token bucket: bounded rate, refills over time.
    let now = 1_000;
    const limited = new RemoteAudioBridge({
      maxBytesPerSecond: 1_000,
      burstBytes: 2_000,
      now: () => now,
    });
    limited.attach("desktop-y", { sendAudio: () => {} });
    check(limited.push(chunk, 2_000).ok === true, "burst allowance must be usable");
    check(limited.push(chunk, 1).reason === "rateLimited", "rate limit must reject excess audio");
    now += 1_000;
    check(limited.push(chunk, 1).ok === true, "the bucket must refill over time");

    bridge.dispose();
    failing.dispose();
    limited.dispose();
  }

  // --- Authenticated WebSocket integration ---------------------------------
  const runtime = new RemoteRuntime({ enabled: true, publicUrl: PUBLIC_URL });
  const pairing = new PairingManager();
  const bridge = new RemoteAudioBridge();

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
    })
  );

  const server = http.createServer(app);
  const remoteWs = createRemoteWebSocketServer({
    runtime,
    pairing,
    publicUrl: PUBLIC_URL,
    audioBridge: bridge,
  });
  server.on("upgrade", (req, socket, head) => {
    if (!remoteWs.handleUpgrade(req, socket, head)) socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/remote/ws`;

  try {
    const code = pairing.getInfo().code;
    const paired = await fetch(`${base}/remote/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Audio Phone" }),
    });
    check(paired.status === 200, "pairing must succeed");
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
    check(cookie.startsWith("myra_remote="), "pairing must set the phone cookie");

    const received: string[] = [];
    const detach = bridge.attach("desktop-live", {
      sendAudio: (data) => received.push(data),
    });

    const { ws, queue } = await connect(wsUrl, { cookie });
    const initial = await queue.next((message) => message.type === "remoteState");
    check(initial.snapshot.mic.streaming === false, "fresh phone socket must not report streaming");

    // Accepted chunk is forwarded byte-for-byte and acknowledged.
    const chunk = pcmChunk();
    ws.send(JSON.stringify({ type: "audio", data: chunk, seq: 7 }));
    const ack = await queue.next((message) => message.type === "audioAck");
    check(ack.seq === 7, "audioAck must echo the client sequence");
    check(ack.bytes === 3_200, "audioAck must report the decoded byte length");
    check(received.length === 1 && received[0] === chunk, "the bridge must receive the exact PCM chunk");

    const streaming = await queue.next(
      (message) => message.type === "remoteState" && message.snapshot.mic.streaming === true
    );
    check(streaming.snapshot.mic.streaming === true, "accepted audio must mark mic.streaming true");

    // Invalid payloads are rejected without reaching the sink.
    ws.send(JSON.stringify({ type: "audio", data: "not base64 !!" }));
    const bad = await queue.next((message) => message.type === "error" && message.code === "badAudio");
    check(bad.code === "badAudio", "invalid base64 must be rejected");

    ws.send(JSON.stringify({ type: "audio", data: Buffer.alloc(3).toString("base64") }));
    const odd = await queue.next((message) => message.type === "error" && message.code === "badAudio");
    check(odd.code === "badAudio", "odd-length PCM must be rejected");

    check(received.length === 1, "rejected payloads must never reach the sink");

    // The phone cannot submit tool responses.
    ws.send(JSON.stringify({ type: "toolResponse", functionResponses: [{ name: "openWebsite" }] }));
    const forbidden = await queue.next(
      (message) => message.type === "error" && message.code === "forbidden"
    );
    check(forbidden.code === "forbidden", "tool responses from the phone must be forbidden");

    // audioStop clears streaming immediately.
    ws.send(JSON.stringify({ type: "audioStop" }));
    await queue.next(
      (message) => message.type === "remoteState" && message.snapshot.mic.streaming === false
    );

    // With no desktop session attached, audio is rejected (Phase 3 dependency).
    detach();
    ws.send(JSON.stringify({ type: "audio", data: chunk }));
    const unavailable = await queue.next(
      (message) => message.type === "error" && message.code === "sessionUnavailable"
    );
    check(unavailable.code === "sessionUnavailable", "audio without a Gemini session must be rejected");

    await closeSocket(ws);

    // Oversized chunks are rejected and the socket is closed.
    const second = await connect(wsUrl, { cookie });
    second.ws.send(JSON.stringify({ type: "audio", data: Buffer.alloc(9_000).toString("base64") }));
    const tooLarge = await second.queue.next(
      (message) => message.type === "error" && message.code === "audioTooLarge"
    );
    check(tooLarge.code === "audioTooLarge", "oversized chunks must be rejected");
    const closeCode = await waitClose(second.ws);
    check(closeCode === 1009, "oversized chunks must close the socket with 1009");

    await sleep(50);
    const finalState = await fetch(`${base}/remote/api/state`, { headers: { cookie } });
    const finalBody: any = await finalState.json();
    check(finalBody.snapshot.mic.streaming === false, "closing the phone socket must clear streaming");

    console.log("remoteAudio: all checks passed");
  } finally {
    remoteWs.close();
    runtime.dispose();
    pairing.dispose();
    bridge.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
