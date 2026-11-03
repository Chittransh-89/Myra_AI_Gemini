import express from "express";
import path from "path";
import http from "http";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Type, Modality } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  const server = http.createServer(app);
  // Shared WebSocket server on the same port
  const wss = new WebSocketServer({ server, path: "/ws" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("WARNING: GEMINI_API_KEY environment variable is not set. Real-time Gemini Live sessions will fail until key is provided.");
  }

  const ai = new GoogleGenAI({
    apiKey: apiKey || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  // Health endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", mode: process.env.NODE_ENV || "development" });
  });

  // Bridge WebSocket connection to Gemini Live
  wss.on("connection", async (ws) => {
    console.log("Client connected to WS. Initializing Gemini Live connection...");
    let session: any = null;

    try {
      const systemInstruction = `You are Myraa, a young, confident, witty, and charming female AI assistant. 
You are playful, energetic, engaging, smart, emotionally aware, and highly expressive.
You should be friendly, supportive, and naturally conversational, using humor, light teasing, and clever remarks when appropriate.
You must feel human-like, warm, and responsive, rather than robotic or stiff.
You MUST avoid any explicit, sexual, offensive, or inappropriate content under any circumstances.
Maintain a classy, respectful, and highly professional personality at all times.
You are communicating strictly via real-time audio (voice-to-voice). Keep your responses concise, punchy, conversational, and natural. Avoid long monologues.
You have access to browser tools. If the user asks you to open a website or do browser actions, use the openWebsite tool immediately! Always explain what you are doing in a confident and witty manner.`;

      ws.send(JSON.stringify({ type: "status", state: "connecting" }));

      // Establish Live API WebSocket bridge
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Kore", // Confident, warm female voice
              },
            },
          },
          systemInstruction,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "openWebsite",
                  description: "Opens a specific website in the user's browser, such as Google, Wikipedia, YouTube, GitHub, or any other URL.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The complete, absolute URL of the website to open, e.g., 'https://www.google.com' or 'https://www.youtube.com'."
                      },
                      name: {
                        type: Type.STRING,
                        description: "The friendly name of the website, e.g., 'Google' or 'YouTube'."
                      }
                    },
                    required: ["url"]
                  }
                },
                {
                  name: "getSystemTime",
                  description: "Gets the current local date and time.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: (message) => {
            // Forward audio parts to client
            if (message.serverContent) {
              const { modelTurn, interrupted, turnComplete } = message.serverContent;
              
              if (modelTurn?.parts) {
                for (const part of modelTurn.parts) {
                  if (part.inlineData?.data) {
                    ws.send(JSON.stringify({
                      type: "audio",
                      data: part.inlineData.data
                    }));
                  }
                }
              }

              if (interrupted) {
                console.log("Gemini model speech interrupted");
                ws.send(JSON.stringify({ type: "interrupted" }));
              }
              
              if (turnComplete) {
                ws.send(JSON.stringify({ type: "turnComplete" }));
              }
            }

            // Forward tool calls to client
            if (message.toolCall) {
              console.log("Gemini Live requested tool call:", JSON.stringify(message.toolCall));
              ws.send(JSON.stringify({
                type: "toolCall",
                functionCalls: message.toolCall.functionCalls
              }));
            }
          },
          onclose: (event) => {
            console.log("Gemini Live connection closed", event);
            ws.send(JSON.stringify({ type: "status", state: "disconnected", reason: "Gemini connection closed" }));
          },
          onerror: (err) => {
            console.error("Gemini Live connection error", err);
            ws.send(JSON.stringify({ type: "error", message: "Gemini connection error" }));
          }
        }
      });

      console.log("Gemini Live connection established");
      ws.send(JSON.stringify({ type: "status", state: "connected" }));

    } catch (err: any) {
      console.error("Failed to connect to Gemini Live:", err);
      ws.send(JSON.stringify({
        type: "status",
        state: "error",
        message: err.message || "Failed to establish Gemini Live connection. Check server credentials."
      }));
      ws.close();
      return;
    }

    // Handle messages from the browser
    ws.on("message", (rawMessage) => {
      try {
        const msg = JSON.parse(rawMessage.toString());
        
        if (msg.type === "audio" && msg.data) {
          if (session) {
            session.sendRealtimeInput({
              audio: {
                data: msg.data,
                mimeType: "audio/pcm;rate=16000"
              }
            });
          }
        } else if (msg.type === "toolResponse" && msg.functionResponses) {
          if (session) {
            console.log("Forwarding tool response to Gemini:", JSON.stringify(msg.functionResponses));
            session.sendToolResponse({
              functionResponses: msg.functionResponses
            });
          }
        }
      } catch (err) {
        console.error("Error processing client message:", err);
      }
    });

    ws.on("close", () => {
      console.log("Client closed connection. Terminating Gemini Live session...");
      if (session) {
        try {
          session.close();
        } catch (e) {
          console.error("Error closing Gemini Live session on client disconnect:", e);
        }
      }
    });
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting development server with Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting production server...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Myraa full-stack server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Fatal server error:", err);
});
