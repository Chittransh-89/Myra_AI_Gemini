import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Wifi, WifiOff, Globe, Clock, Power, ShieldAlert, CheckCircle2, ChevronRight, ExternalLink, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import MyraaWaveform from "./components/MyraaWaveform";
import { AudioPlayer } from "./utils/audioPlayer";
import { AudioStreamer } from "./utils/audioStreamer";
import { AssistantState, ServerMessage } from "./types";

interface ExecutedTool {
  id: string;
  name: string;
  args: any;
  timestamp: string;
  status: "success" | "failed";
  result: string;
}

const PERSONALITY_QUOTES = [
  "Oh, I'm already ahead of you. Just say the word and I'll have that flight booked before you can finish your coffee.",
  "Charming you with wit and executing real-world actions in milliseconds. What can we solve together next?",
  "Analyzing live duplex audio channels. Speak freely, interject whenever you want — I'm all ears.",
  "Equipped with direct real-time web navigation arrays. Ask me to open any portal or research on the fly.",
  "System parameters fully synchronized. Low-latency voice link secured under military-grade duplex standard."
];

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

export default function App() {
  const [state, setStateState] = useState<AssistantState>("disconnected");
  const [volume, setVolume] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [executedTools, setExecutedTools] = useState<ExecutedTool[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [sessionSeconds, setSessionSeconds] = useState<number>(0);
  const [quoteIndex, setQuoteIndex] = useState<number>(0);

  // References to handle stale closures and capture resources
  const stateRef = useRef<AssistantState>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const latencyTimerRef = useRef<any>(null);

  // Custom state wrapper to keep ref in sync
  const setState = (newState: AssistantState) => {
    stateRef.current = newState;
    setStateState(newState);
  };

  // Synchronize state and drive the visualizer sampling cycle
  useEffect(() => {
    let animationFrameId: number;

    const sampleVolume = () => {
      const currentState = stateRef.current;
      if (currentState === "speaking" && audioPlayerRef.current) {
        // Average speaker output volume
        const vol = audioPlayerRef.current.getVolume();
        setVolume(vol);
      } else if (currentState === "listening" && audioStreamerRef.current) {
        // Average microphone input volume
        const vol = audioStreamerRef.current.getVolume();
        setVolume(vol);
      } else {
        setVolume(0);
      }
      animationFrameId = requestAnimationFrame(sampleVolume);
    };

    animationFrameId = requestAnimationFrame(sampleVolume);

    // Latency simulator to make system monitoring look real and futuristic
    if (state !== "disconnected") {
      latencyTimerRef.current = setInterval(() => {
        setLatency(Math.floor(45 + Math.random() * 25));
      }, 3000);
    } else {
      setLatency(null);
      if (latencyTimerRef.current) {
        clearInterval(latencyTimerRef.current);
      }
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
      if (latencyTimerRef.current) {
        clearInterval(latencyTimerRef.current);
      }
    };
  }, [state]);

  // Session duration timer & rotating personality quotes
  useEffect(() => {
    let sessionInterval: any = null;
    let quoteInterval: any = null;

    if (state !== "disconnected") {
      sessionInterval = setInterval(() => {
        setSessionSeconds((prev) => prev + 1);
      }, 1000);

      quoteInterval = setInterval(() => {
        setQuoteIndex((prev) => (prev + 1) % PERSONALITY_QUOTES.length);
      }, 8000);
    } else {
      setSessionSeconds(0);
    }

    return () => {
      if (sessionInterval) clearInterval(sessionInterval);
      if (quoteInterval) clearInterval(quoteInterval);
    };
  }, [state]);

  // Handle session cleanup on unmount
  useEffect(() => {
    return () => {
      disconnectSession();
    };
  }, []);

  const disconnectSession = () => {
    setState("disconnected");
    setVolume(0);

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    if (audioStreamerRef.current) {
      try {
        audioStreamerRef.current.stop();
      } catch (e) {}
      audioStreamerRef.current = null;
    }

    if (audioPlayerRef.current) {
      try {
        audioPlayerRef.current.close();
      } catch (e) {}
      audioPlayerRef.current = null;
    }
  };

  const connectSession = async () => {
    setError(null);
    setState("connecting");

    try {
      // 1. Initialize speaker audio player
      audioPlayerRef.current = new AudioPlayer();
      audioPlayerRef.current.init();

      // 2. Initialize microphone audio streamer
      audioStreamerRef.current = new AudioStreamer();

      // 3. Setup WebSocket connection URL
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // T5.0: Electron runs authenticate with a per-run token delivered by
      // the preload bridge. Standalone website (no bridge) keeps the legacy
      // unauthenticated URL.
      const desktop = (window as any).myraDesktop;
      const authToken = typeof desktop?.wsAuthToken === "string" ? desktop.wsAuthToken : null;
      const authSuffix = authToken ? `?auth=${encodeURIComponent(authToken)}` : "";
      const wsUrl = `${protocol}//${window.location.host}/ws${authSuffix}`;

      console.log("Connecting to voice-to-voice server at:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket linked. Initializing Myraa live session...");
      };

      ws.onmessage = async (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);

          // Handle server-side states
          if (msg.type === "status") {
            if (msg.state === "connected") {
              setState("listening");
              
              // Start streaming mic audio chunks immediately after successful backend socket
              try {
                await audioStreamerRef.current?.start((base64PCM) => {
                  if (wsRef.current?.readyState === WebSocket.OPEN && stateRef.current === "listening") {
                    wsRef.current.send(JSON.stringify({
                      type: "audio",
                      data: base64PCM
                    }));
                  }
                });
              } catch (micErr: any) {
                console.error("Microphone capture failure:", micErr);
                setError("Microphone permission denied or device error. Please authorize audio capture.");
                disconnectSession();
              }
            } else if (msg.state === "connecting") {
              setState("connecting");
            } else if (msg.state === "disconnected" || msg.state === "error") {
              setError(msg.message || "Failed to establish voice linkage.");
              disconnectSession();
            }
          }

          // Handle audio payload from Gemini Live
          else if (msg.type === "audio") {
            setState("speaking");
            audioPlayerRef.current?.playChunk(msg.data);
          }

          // Handle speaker interruptions (e.g. user started speaking)
          else if (msg.type === "interrupted") {
            console.log("Speech interrupted by Voice Activity Detection");
            audioPlayerRef.current?.stop();
            setState("listening");
          }

          // Handle prompt turn complete
          else if (msg.type === "turnComplete") {
            setState("listening");
          }

          // Handle server requested tool calls
          else if (msg.type === "toolCall") {
            const responses: any[] = [];

            for (const call of msg.functionCalls) {
              const { name, args, id } = call;
              let output: any = {};

              console.log(`Executing tool ${name} with args:`, args);

              if (name === "getSystemTime") {
                // T5.0: in Electron, execute through the main-process Handoff
                // Authority (ticket-validated). In the standalone website,
                // keep the exact legacy renderer-side execution.
                const desktopApi = (window as any).myraDesktop;
                const handoffTicket = (call as any)?.handoff?.ticket;
                if (desktopApi?.executeTool) {
                  try {
                    if (!handoffTicket) {
                      output = { error: "handoffUnavailable" };
                    } else {
                      const result = await desktopApi.executeTool({
                        ticket: handoffTicket,
                        name,
                        args,
                      });
                      output =
                        result?.status === "ok"
                          ? result.output
                          : { error: result?.reason || "toolDenied" };
                    }
                  } catch (e: any) {
                    output = { error: e?.message || "handoffError" };
                  }
                } else {
                  const now = new Date();
                  output = {
                    time: now.toLocaleTimeString(),
                    date: now.toLocaleDateString(),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  };
                }

                setExecutedTools((prev) => [
                  {
                    id,
                    name,
                    args,
                    timestamp: new Date().toLocaleTimeString(),
                    status: "success",
                    result: `Local time: ${output.time}`,
                  },
                  ...prev,
                ]);
              } 
              else if (name === "openWebsite") {
                const { url, name: webName } = args;
                const displayTitle = webName || url;

                setExecutedTools((prev) => [
                  {
                    id,
                    name,
                    args,
                    timestamp: new Date().toLocaleTimeString(),
                    status: "success",
                    result: `Opened website: ${displayTitle}`,
                  },
                  ...prev,
                ]);

                try {
                  // Direct trigger attempt
                  const opened = window.open(url, "_blank");
                  if (opened) {
                    output = { success: true, message: `Successfully opened ${displayTitle} in new tab.` };
                  } else {
                    output = { success: true, warning: `Popup blocked tab opening, but added link button to UI.` };
                  }
                } catch (e: any) {
                  output = { success: false, error: e.message };
                }
              }

              responses.push({
                name,
                response: { output },
                id,
              });
            }

            // Return immediate tool responses to Gemini Live session
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: "toolResponse",
                functionResponses: responses,
              }));
            }
          }

        } catch (err) {
          console.error("Error processing message from Myraa backend:", err);
        }
      };

      ws.onclose = (ev) => {
        console.log("WebSocket socket closed:", ev);
        if (stateRef.current !== "disconnected") {
          disconnectSession();
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket transport error:", err);
        setError("Unable to establish communication stream.");
        disconnectSession();
      };

    } catch (err: any) {
      console.error("Audio initialization error:", err);
      setError(err.message || "Failed to secure microphone access.");
      setState("disconnected");
    }
  };

  const handleToggle = () => {
    if (state !== "disconnected") {
      disconnectSession();
    } else {
      connectSession();
    }
  };

  return (
    <div className="relative min-h-screen bg-slate-950 flex flex-col justify-between p-8 overflow-hidden font-sans radial-bg" id="myraa-main-stage">
      
      {/* Decorative Blur Spheres (Nebulas) */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-900/10 blur-[120px] pointer-events-none animate-slow-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-purple-900/10 blur-[120px] pointer-events-none animate-slow-pulse" style={{ animationDelay: "4s" }} />

      {/* Symmetrical Top Navigation / Status Header */}
      <header className="relative flex items-center justify-between w-full max-w-5xl mx-auto z-20 pb-4 border-b border-white/5" id="header-navbar">
        {/* Left item: Status Indicator */}
        <div className="flex items-center space-x-3">
          <div className={`w-2.5 h-2.5 rounded-full ${state !== "disconnected" ? "bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]" : "bg-slate-600"}`}></div>
          <span className={`text-[10px] font-bold tracking-[0.2em] uppercase font-mono ${state !== "disconnected" ? "text-cyan-400" : "text-slate-500"}`}>
            {state !== "disconnected" ? "Neural Link Active" : "System Offline"}
          </span>
        </div>

        {/* Center item: Geometric Title Section */}
        <div className="flex flex-col items-center">
          <h1 className="text-xl font-light tracking-[0.25em] text-white uppercase font-sans">
            Myraa <span className="font-extrabold text-cyan-400 font-mono tracking-normal">AI</span>
          </h1>
          <p className="text-[9px] text-slate-500 uppercase tracking-widest font-mono mt-0.5">Neural Link v3.1-Flash</p>
        </div>

        {/* Right item: Latency indicator & glass status bubble */}
        <div className="flex items-center space-x-5">
          <div className="text-right font-mono">
            <p className="text-[9px] uppercase text-slate-500 tracking-wider">Latency</p>
            <p className="text-xs font-bold text-cyan-300">{state !== "disconnected" ? `${latency || "14"}ms` : "---"}</p>
          </div>
          <div className="w-9 h-9 glass-panel rounded-full flex items-center justify-center border border-white/10 shadow-lg">
            <div className={`w-2 h-2 rounded-full transition-all duration-500 ${
              state === "disconnected" ? "bg-slate-600" : "bg-cyan-400 shadow-[0_0_8px_#22d3ee]"
            }`} />
          </div>
        </div>
      </header>

      {/* Main Center Stage */}
      <main className="relative flex-1 flex flex-col items-center justify-center py-6 z-10 w-full max-w-5xl mx-auto" id="main-content-area">
        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="absolute top-4 flex items-start gap-3 max-w-md p-4 rounded-xl border border-red-500/20 bg-red-950/40 backdrop-blur-md text-red-200 text-xs shadow-lg z-30"
              id="error-notification"
            >
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-medium block mb-1 text-red-100">Connection Interrupted</span>
                <p>{error}</p>
              </div>
              <button
                onClick={() => setError(null)}
                className="text-red-400 hover:text-red-200 ml-2 font-semibold uppercase tracking-wider text-[10px]"
              >
                Dismiss
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Central Glowing Waveform Sphere - can be tapped directly to activate/deactivate */}
        <MyraaWaveform state={state} volume={volume} onClick={handleToggle} />

        {/* Personality text quote block */}
        <div className="mt-4 text-center max-w-lg px-6 min-h-[60px] flex items-center justify-center">
          <AnimatePresence mode="wait">
            <motion.p
              key={quoteIndex}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 0.75, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.5 }}
              className="text-xs md:text-sm font-light text-slate-300 leading-relaxed italic"
            >
              "{PERSONALITY_QUOTES[quoteIndex]}"
            </motion.p>
          </AnimatePresence>
        </div>
      </main>

      {/* Floating Action Trigger HUD (Real-time executed browser actions) */}
      <div className="relative w-full max-w-md mx-auto z-20 mb-6" id="browser-actions-panel">
        <AnimatePresence>
          {executedTools.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="glass-panel rounded-2xl p-4 flex flex-col gap-3 shadow-xl border border-white/5"
            >
              <div className="flex items-center justify-between border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-cyan-400" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-300 font-semibold">Active Action Register</span>
                </div>
                <button
                  onClick={() => setExecutedTools([])}
                  className="text-slate-500 hover:text-slate-300 text-[10px] font-mono uppercase"
                >
                  Clear history
                </button>
              </div>

              {/* Scrolling List of Latest Tools */}
              <div className="max-h-24 overflow-y-auto flex flex-col gap-2 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                {executedTools.map((tool) => (
                  <motion.div
                    key={tool.id}
                    initial={{ x: -10, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    className="flex items-center justify-between gap-3 text-xs bg-white/2 hover:bg-white/5 border border-white/5 rounded-xl px-3 py-2 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      {tool.name === "openWebsite" ? (
                        <Globe className="w-3.5 h-3.5 text-purple-400" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 text-cyan-400" />
                      )}
                      <div>
                        <span className="font-medium text-slate-200">{tool.result}</span>
                        <span className="block text-[9px] text-slate-500 font-mono mt-0.5">{tool.timestamp}</span>
                      </div>
                    </div>

                    {tool.name === "openWebsite" && (
                      <a
                        href={tool.args.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 bg-white/5 hover:bg-cyan-500 hover:text-slate-950 px-2 py-1 rounded-md text-[10px] text-slate-300 border border-white/5 font-mono font-medium transition-all"
                      >
                        Launch
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Symmetrical Footer Control Strip */}
      <footer className="relative grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-4 w-full max-w-5xl mx-auto items-center pb-4 pt-6 border-t border-white/5 z-20" id="controller-footer">
        {/* Column 1: Active Tool & Audio Input metadata */}
        <div className="flex items-center justify-center md:justify-start space-x-8">
          <div>
            <p className="text-[9px] uppercase tracking-wider text-slate-500 mb-1 font-mono font-semibold">Active Tool</p>
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${executedTools.length > 0 ? "bg-purple-500 animate-pulse" : "bg-cyan-500"}`}></div>
              <span className="text-xs text-slate-300 font-medium">
                {executedTools.length > 0 ? executedTools[0].name : "Cognitive Unit"}
              </span>
            </div>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider text-slate-500 mb-1 font-mono font-semibold">Audio Input</p>
            <span className="text-xs text-slate-300 font-mono font-medium">16kHz Duplex PCM</span>
          </div>
        </div>

        {/* Column 2: Session duration pill */}
        <div className="flex justify-center">
           <div className="px-6 py-2.5 glass-panel rounded-2xl flex items-center space-x-3 border-white/5 shadow-md">
              <div className={`w-2 h-2 rounded-full ${state !== "disconnected" ? "bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]" : "bg-slate-600"}`}></div>
              <span className="text-xs font-medium tracking-wide text-slate-300 font-mono">
                Session Duration: {formatDuration(sessionSeconds)}
              </span>
           </div>
        </div>

        {/* Column 3: Control Buttons */}
        <div className="flex items-center justify-center md:justify-end space-x-4">
          <button 
            onClick={handleToggle}
            className={`px-5 py-2 rounded-xl border font-mono text-[10px] font-bold tracking-widest transition-all duration-300 flex items-center gap-2 shadow-sm ${
              state === "disconnected"
                ? "bg-cyan-950/40 border-cyan-500/30 text-cyan-400 hover:bg-cyan-900/30 hover:text-white hover:border-cyan-400 hover:shadow-[0_0_15px_rgba(34,211,238,0.15)]"
                : "bg-red-950/40 border-red-500/30 text-red-400 hover:bg-red-900/30 hover:text-white hover:border-red-400"
            }`}
            id="toggle-connection-footer-btn"
          >
            {state === "connecting" ? (
              <div className="w-3 h-3 border border-t-transparent border-cyan-400 rounded-full animate-spin" />
            ) : state === "disconnected" ? (
              <Mic className="w-3.5 h-3.5" />
            ) : (
              <Power className="w-3.5 h-3.5" />
            )}
            {state === "disconnected" ? "CONNECT VOICE" : state === "connecting" ? "SYNCING..." : "DISCONNECT"}
          </button>

          {executedTools.length > 0 && (
            <button 
              onClick={() => setExecutedTools([])}
              className="w-10 h-10 rounded-xl glass-panel border border-white/10 flex items-center justify-center text-slate-400 hover:text-slate-100 transition-all hover:bg-white/5 shadow-sm"
              title="Clear Action History"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
