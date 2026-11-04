import { useState, useEffect, useRef } from "react";
import {
  Mic,
  Power,
  ShieldAlert,
  CheckCircle2,
  Trash2,
  FolderTree,
  FileCode,
  Folder,
  Check,
  AlertCircle,
  Clock,
  Globe,
} from "lucide-react";
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

interface ProjectBuilderState {
  activeProject?: {
    name: string;
    root: string;
    active: boolean;
  };
  activePlan?: {
    planId: string;
    projectName: string;
    root: string;
    dirs: number;
    files: number;
    paths: string[];
    tree?: string;
    overwrites: string[];
    requiresOverwriteConfirmation?: boolean;
    status: "proposed" | "applied" | "failed";
  };
  lastApplied?: {
    root: string;
    createdDirs: string[];
    createdFiles: string[];
    overwrittenFiles: string[];
    summary: string;
  };
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

/**
 * Human-readable one-liner for the action register. Myra speaks the real
 * result through the model; this is only the UI mirror of it.
 */
function describeToolResult(name: string, args: any, output: any, failed: boolean): string {
  if (failed) return `${name} failed: ${output?.error ?? "unknown error"}`;
  if (output?.accepted) return `${name}: running in desktop`;
  if (output?.ok === false) return `${name}: ${output?.error ?? "failed"}`;

  switch (name) {
    case "getSystemTime":
      return `Local time: ${output?.time ?? "?"}`;
    case "openWebsite":
      return `Opened ${output?.title || output?.url || args?.name || args?.url || "website"}`;
    case "projectControl": {
      const action = String(args?.action ?? "");
      if (action === "detect") {
        return output?.ok
          ? `VS Code Project: ${output.name} (${output.vscodeRunning ? "active" : "last opened"})`
          : "VS Code: No active project detected";
      }
      if (action === "reference") {
        return `Reference scanned: ${output?.dirs ?? 0} folders, ${output?.files ?? 0} files`;
      }
      if (action === "plan") {
        return output?.summary || `Plan: ${output?.files ?? 0} files, ${output?.dirs ?? 0} folders proposed`;
      }
      if (action === "apply") {
        return output?.summary || `Created ${output?.counts?.createdFiles ?? 0} files, ${output?.counts?.createdDirs ?? 0} folders`;
      }
      if (action === "edit") {
        return output?.ok ? `Updated file: ${args?.path ?? "file"}` : `Edit failed: ${output?.error}`;
      }
      return `Project: ${action}`;
    }
    case "browserControl": {
      const action = String(args?.action ?? "");
      if (action === "search") return `YouTube "${args?.query ?? ""}" → ${output?.count ?? 0} results`;
      if (action === "listVideos") return `${output?.count ?? 0} videos on page`;
      if (action === "clickVideo") return `Playing: ${output?.title ?? args?.query ?? "video"}`;
      if (action === "playPause") return `Playback ${output?.state ?? "toggled"}`;
      if (action === "scroll") return `Scrolled ${output?.direction ?? "down"} → y=${output?.scrollY ?? 0}`;
      if (action === "open") return `Opened ${output?.title || output?.url || "page"}`;
      return `Browser: ${action || "action"}`;
    }
    case "whatsappControl": {
      const action = String(args?.action ?? "");
      if (action === "status") return `WhatsApp: ${output?.ready ? "ready" : "not linked"}`;
      if (action === "prepare") return `WhatsApp: drafted for ${args?.phone ?? "contact"}`;
      if (action === "send") return output?.sent ? `WhatsApp: sent to ${args?.phone ?? "contact"}` : `WhatsApp send failed`;
      return `WhatsApp: ${action}`;
    }
    case "phoneControl": {
      const action = String(args?.action ?? "");
      if (action === "status") return `Phone Link: ${output?.installed ? "ready" : "not found"}`;
      if (action === "open") return `Opened Phone Link`;
      return `Phone Link: ${action}`;
    }
    default:
      return `${name} done`;
  }
}

export default function App() {
  const [state, setStateState] = useState<AssistantState>("disconnected");
  const [volume, setVolume] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [executedTools, setExecutedTools] = useState<ExecutedTool[]>([]);
  const [projectState, setProjectState] = useState<ProjectBuilderState>({});
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

  const updateProjectBuilderState = (output: any, args: any) => {
    if (!output || typeof output !== "object") return;
    const action = String(args?.action ?? "");

    if (action === "detect" || output.projectName || output.root) {
      if (output.root || output.name || output.projectName) {
        setProjectState((prev) => ({
          ...prev,
          activeProject: {
            name: output.projectName || output.name || prev?.activeProject?.name || "Active Workspace",
            root: output.root || prev?.activeProject?.root || "",
            active: output.active ?? output.vscodeRunning ?? prev?.activeProject?.active ?? true,
          },
        }));
      }
    }

    if ((action === "plan" || output.planId) && output.paths) {
      setProjectState((prev) => ({
        ...prev,
        activePlan: {
          planId: output.planId,
          projectName: output.projectName || prev?.activeProject?.name || "",
          root: output.root || prev?.activeProject?.root || "",
          dirs: output.dirs || 0,
          files: output.files || 0,
          paths: output.paths || [],
          tree: output.tree || "",
          overwrites: output.overwrites || [],
          requiresOverwriteConfirmation: output.requiresOverwriteConfirmation || false,
          status: "proposed",
        },
      }));
    }

    if (action === "apply" || output.createdFiles || output.createdDirs) {
      setProjectState((prev) => ({
        ...prev,
        activePlan: prev?.activePlan ? { ...prev.activePlan, status: "applied" } : undefined,
        lastApplied: {
          root: output.root || prev?.activeProject?.root || "",
          createdDirs: output.createdDirs || [],
          createdFiles: output.createdFiles || [],
          overwrittenFiles: output.overwrittenFiles || [],
          summary: output.summary || output.detail || "Project files created successfully.",
        },
      }));
    }

    if (action === "edit" && output.ok) {
      setProjectState((prev) => ({
        ...prev,
        lastApplied: {
          root: output.root || prev?.activeProject?.root || "",
          createdDirs: [],
          createdFiles: [],
          overwrittenFiles: [args?.path || "modified file"],
          summary: `Updated ${args?.path || "file"} with requested code.`,
        },
      }));
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
            const desktopApi = (window as any).myraDesktop;
            const responses: any[] = [];

            for (const call of msg.functionCalls) {
              const { name, args, id } = call;
              const handoffField = (call as any)?.handoff;
              let output: any = {};
              let failed = false;

              console.log(`Executing tool ${name} with args:`, args);

              if (desktopApi?.executeTool) {
                // T5.0/Phase C: EVERY desktop tool executes in the main process
                // through the Handoff Authority. The renderer only TRIGGERS the
                // call — it never authors the result the model sees, and it has
                // no filesystem, shell or browser access of its own.
                const ticket = typeof handoffField?.ticket === "string" ? handoffField.ticket : null;
                if (!ticket) {
                  failed = true;
                  output = { error: handoffField?.error || "handoffUnavailable" };
                } else {
                  try {
                    const result = await desktopApi.executeTool({ ticket, name, args });
                    if (result?.status === "ok") {
                      output = result.output;
                      if (name === "projectControl") {
                        updateProjectBuilderState(output, args);
                      }
                    } else if (result?.status === "accepted") {
                      // Async main-process executor: the real result reaches
                      // Gemini via the signed completion channel, not via us.
                      output = { accepted: true };
                    } else {
                      failed = true;
                      output = { error: result?.reason || "toolDenied" };
                    }
                  } catch (e: any) {
                    failed = true;
                    output = { error: e?.message || "handoffError" };
                  }
                }
              } else if (name === "getSystemTime") {
                // Legacy standalone-website mode (no desktop bridge exists).
                const now = new Date();
                output = {
                  time: now.toLocaleTimeString(),
                  date: now.toLocaleDateString(),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                };
              } else if (name === "openWebsite") {
                // Browser-only mode has no main process, so it is the only place
                // a renderer-side open is legitimate: still web-scheme only.
                const target = typeof args?.url === "string" ? args.url : "";
                try {
                  if (!/^https?:\/\//i.test(target)) throw new Error("unsupportedUrl");
                  const opened = window.open(target, "_blank", "noopener,noreferrer");
                  output = opened ? { ok: true, url: target } : { ok: false, error: "popupBlocked" };
                } catch (e: any) {
                  output = { ok: false, error: e?.message || "openFailed" };
                }
              } else {
                failed = true;
                output = { error: "unsupportedInBrowserMode" };
              }

              setExecutedTools((prev) => [
                {
                  id,
                  name,
                  args,
                  timestamp: new Date().toLocaleTimeString(),
                  status: failed ? "failed" : "success",
                  result: describeToolResult(name, args, output, failed),
                },
                ...prev,
              ]);

              responses.push({
                name,
                response: { output },
                id,
              });
            }

            // Return immediate tool responses to Gemini Live session.
            // In Electron mode the server deliberately DROPS renderer-authored
            // results for main-executed tools — main sends the signed completion.
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: "toolResponse",
                functionResponses: responses,
              }));
            }
          }

          // Handle authenticated completions from main process
          else if ((msg as any).type === "toolCompletion") {
            const { callId, name, status, output } = msg as any;
            const isFailed = status !== "success";
            let matchedArgs: any = null;

            setExecutedTools((prev) =>
              prev.map((item) => {
                if (item.id === callId || (item.name === name && item.result.includes("running in desktop"))) {
                  matchedArgs = item.args;
                  return {
                    ...item,
                    status: isFailed ? "failed" : "success",
                    result: describeToolResult(name, item.args, output, isFailed),
                  };
                }
                return item;
              })
            );

            if (name === "projectControl" && output) {
              updateProjectBuilderState(output, matchedArgs || {});
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

      {/* VS Code Project Builder HUD & Action Trigger HUD */}
      <div className="relative w-full max-w-lg mx-auto z-20 mb-6 flex flex-col gap-3" id="interactive-hud-panel">
        {/* VS Code Project Builder HUD */}
        <AnimatePresence>
          {(projectState.activePlan || projectState.lastApplied || projectState.activeProject) && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="glass-panel rounded-2xl p-4 flex flex-col gap-3 shadow-2xl border border-cyan-500/30 bg-slate-900/90 backdrop-blur-xl"
              id="vscode-project-panel"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                <div className="flex items-center gap-2">
                  <FolderTree className="w-4 h-4 text-cyan-400" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-200 font-bold">
                    VS Code Project Builder
                  </span>
                  {projectState.activeProject && (
                    <span className="text-[9px] font-mono bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${projectState.activeProject.active ? "bg-emerald-400 animate-pulse" : "bg-slate-400"}`} />
                      {projectState.activeProject.name}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setProjectState({})}
                  className="text-slate-500 hover:text-slate-300 text-[10px] font-mono uppercase transition-colors"
                >
                  Dismiss
                </button>
              </div>

              {/* Active Proposed Plan */}
              {projectState.activePlan && projectState.activePlan.status === "proposed" && (
                <div className="flex flex-col gap-2.5 bg-slate-950/60 rounded-xl p-3 border border-amber-500/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_#f59e0b]" />
                      <span className="text-[10px] font-mono uppercase text-amber-300 font-bold tracking-wider">
                        Proposed Structure — Awaiting Voice Approval
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">
                      {projectState.activePlan.files} files, {projectState.activePlan.dirs} folders
                    </span>
                  </div>

                  {/* Tree Preview */}
                  {projectState.activePlan.tree ? (
                    <pre className="text-[11px] font-mono text-cyan-300 bg-slate-950/90 p-3 rounded-lg overflow-x-auto max-h-36 leading-tight border border-white/5 scrollbar-thin scrollbar-thumb-slate-800">
                      {projectState.activePlan.tree}
                    </pre>
                  ) : (
                    <div className="max-h-32 overflow-y-auto flex flex-col gap-1 font-mono text-xs">
                      {projectState.activePlan.paths.map((p) => {
                        const isDir = p.endsWith("/");
                        return (
                          <div key={p} className="flex items-center gap-2 text-slate-300 py-0.5 px-1.5 rounded hover:bg-white/5">
                            {isDir ? (
                              <Folder className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                            ) : (
                              <FileCode className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            )}
                            <span className="text-[11px]">{p}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Overwrite warnings if any */}
                  {projectState.activePlan.overwrites.length > 0 && (
                    <div className="flex items-center gap-2 text-[10px] text-amber-300/90 bg-amber-950/40 p-2 rounded border border-amber-500/30">
                      <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>
                        Existing files will be modified: {projectState.activePlan.overwrites.join(", ")}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1 text-[10px] font-mono text-slate-400">
                    <span className="italic text-cyan-400/80">Voice permission: say "Yes, proceed" or "Create it"</span>
                    <span className="text-[9px] text-slate-500">Plan: {projectState.activePlan.planId.slice(0, 8)}...</span>
                  </div>
                </div>
              )}

              {/* Last Applied Result */}
              {projectState.lastApplied && (
                <div className="flex flex-col gap-2 bg-emerald-950/20 rounded-xl p-3 border border-emerald-500/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-[10px] font-mono uppercase text-emerald-300 font-bold tracking-wider">
                        Files & Folders Created
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-200 font-medium">{projectState.lastApplied.summary}</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {projectState.lastApplied.createdDirs.map((d) => (
                      <span key={d} className="inline-flex items-center gap-1 text-[10px] font-mono bg-cyan-950/60 text-cyan-300 px-2 py-0.5 rounded border border-cyan-500/30">
                        <Folder className="w-2.5 h-2.5" /> {d}/
                      </span>
                    ))}
                    {projectState.lastApplied.createdFiles.map((f) => (
                      <span key={f} className="inline-flex items-center gap-1 text-[10px] font-mono bg-emerald-950/60 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">
                        <FileCode className="w-2.5 h-2.5" /> {f}
                      </span>
                    ))}
                    {projectState.lastApplied.overwrittenFiles.map((f) => (
                      <span key={f} className="inline-flex items-center gap-1 text-[10px] font-mono bg-amber-950/60 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30">
                        <FileCode className="w-2.5 h-2.5" /> {f} (modified)
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Target Directory Path */}
              {projectState.activeProject?.root && (
                <div className="text-[9px] font-mono text-slate-500 truncate px-1">
                  Root: <span className="text-slate-400 select-all">{projectState.activeProject.root}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Register */}
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
                      {tool.name === "getSystemTime" ? (
                        <Clock className="w-3.5 h-3.5 text-cyan-400" />
                      ) : tool.name === "projectControl" ? (
                        <FolderTree className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Globe className="w-3.5 h-3.5 text-purple-400" />
                      )}
                      <div>
                        <span className="font-medium text-slate-200">{tool.result}</span>
                        <span className="block text-[9px] text-slate-500 font-mono mt-0.5">{tool.timestamp}</span>
                      </div>
                    </div>
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
