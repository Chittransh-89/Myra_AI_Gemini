/**
 * Myra AI — server entry point.
 *
 * Responsibilities:
 *  - Express HTTP server (health endpoint, static file serving / Vite middleware)
 *  - WebSocket server on /ws
 *  - Bridges WebSocket client messages to the active AIProvider session
 *
 * The WebSocket protocol exposed to the frontend is UNCHANGED from the original
 * server.ts. App.tsx, audioPlayer.ts and audioStreamer.ts require no modifications.
 *
 * Inbound WS messages from client:
 *   { type: "audio",        data: string }           — base64 PCM mic chunk
 *   { type: "toolResponse", functionResponses: [...] } — tool execution results
 *
 * Outbound WS messages to client:
 *   { type: "status",       state: "connecting"|"connected"|"disconnected"|"error", message? }
 *   { type: "audio",        data: string }           — base64 PCM speaker chunk
 *   { type: "interrupted" }                          — VAD interrupt
 *   { type: "turnComplete" }                         — turn done
 *   { type: "toolCall",     functionCalls: [...] }   — tool invocation request
 *   { type: "error",        message: string }        — non-fatal error
 */

import express from "express";
import path from "path";
import http from "http";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import type { AIProvider, AIProviderSession } from "./providers/index.js";
import type { ServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Myra system persona and built-in tools
// These were inline in the original server.ts — now isolated here for clarity.
// ---------------------------------------------------------------------------

const MYRA_SYSTEM_INSTRUCTION = `You are Myraa, a young, confident, witty, and charming female AI assistant. 
You are playful, energetic, engaging, smart, emotionally aware, and highly expressive.
You should be friendly, supportive, and naturally conversational, using humor, light teasing, and clever remarks when appropriate.
You must feel human-like, warm, and responsive, rather than robotic or stiff.
You MUST avoid any explicit, sexual, offensive, or inappropriate content under any circumstances.
Maintain a classy, respectful, and highly professional personality at all times.
You are communicating strictly via real-time audio (voice-to-voice). Keep your responses concise, punchy, conversational, and natural. Avoid long monologues.
You have access to browser tools. If the user asks you to open a website or do browser actions, use the openWebsite tool immediately! Always explain what you are doing in a confident and witty manner.`;

import type { ToolDeclaration } from "./providers/types.js";

const BUILT_IN_TOOLS: ToolDeclaration[] = [
  {
    name: "openWebsite",
    description:
      "Opens a specific website in the user's browser, such as Google, Wikipedia, YouTube, GitHub, or any other URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The complete, absolute URL of the website to open, e.g., 'https://www.google.com' or 'https://www.youtube.com'.",
        },
        name: {
          type: "string",
          description: "The friendly name of the website, e.g., 'Google' or 'YouTube'.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "getSystemTime",
    description: "Gets the current local date and time.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// WebSocket message helpers (keep sends typesafe and DRY)
// ---------------------------------------------------------------------------

function sendJSON(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function handleConnection(ws: WebSocket, provider: AIProvider): void {
  console.log("[server] Client connected to WebSocket. Initialising AI session...");

  let session: AIProviderSession | null = null;

  // Immediately signal that we are connecting.
  sendJSON(ws, { type: "status", state: "connecting" });

  // Open the provider session asynchronously.
  provider
    .createSession(
      {
        systemInstruction: MYRA_SYSTEM_INSTRUCTION,
        tools: BUILT_IN_TOOLS,
        voiceConfig: { voiceName: "Kore" },
      },
      {
        onAudio(base64PCMData) {
          sendJSON(ws, { type: "audio", data: base64PCMData });
        },

        onToolCall(functionCalls) {
          sendJSON(ws, { type: "toolCall", functionCalls });
        },

        onInterrupted() {
          console.log("[server] Model speech interrupted");
          sendJSON(ws, { type: "interrupted" });
        },

        onTurnComplete() {
          sendJSON(ws, { type: "turnComplete" });
        },

        onError(error) {
          console.error("[server] Provider error:", error.message);
          sendJSON(ws, { type: "error", message: "AI provider error: " + error.message });
        },

        onClose(reason) {
          console.log("[server] Provider connection closed:", reason);
          sendJSON(ws, {
            type: "status",
            state: "disconnected",
            reason: reason ?? "Provider connection closed",
          });
        },
      }
    )
    .then((s) => {
      session = s;
      console.log("[server] AI session established");
      sendJSON(ws, { type: "status", state: "connected" });
    })
    .catch((err: Error) => {
      console.error("[server] Failed to create AI session:", err.message);
      sendJSON(ws, {
        type: "status",
        state: "error",
        message: err.message || "Failed to establish AI session. Check server configuration.",
      });
      ws.close();
    });

  // Handle messages arriving from the browser.
  ws.on("message", (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage.toString());

      if (msg.type === "audio" && msg.data) {
        session?.sendAudio(msg.data);
      } else if (msg.type === "toolResponse" && msg.functionResponses) {
        session?.sendToolResponse(msg.functionResponses);
      }
    } catch (err) {
      console.error("[server] Error processing client message:", err);
    }
  });

  // Clean up when the client disconnects.
  ws.on("close", () => {
    console.log("[server] Client disconnected. Closing AI session...");
    session?.close();
    session = null;
  });
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export async function startServer(provider: AIProvider, config: ServerConfig): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Health endpoint — exposes provider name but NOT the API key.
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: config.nodeEnv,
      provider: provider.name,
    });
  });

  // Bridge each WebSocket client to the AI provider.
  wss.on("connection", (ws) => handleConnection(ws, provider));

  // Vite dev middleware or static file serving for production.
  if (config.nodeEnv !== "production") {
    console.log("[server] Starting development server with Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[server] Starting production server...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[server] Myraa AI server listening on http://0.0.0.0:${config.port}`);
    console.log(`[server] Provider: ${provider.name}`);
  });
}
