import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import RemoteApp from "./RemoteApp";

/**
 * Render errors inside the remote tree must show a readable card, not an empty
 * white page. The entry is a separate bundle from the desktop app, so it gets
 * its own small boundary.
 */
class RemoteErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  declare props: Readonly<{ children: ReactNode }>;
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : "Unexpected error" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[remote] Render error:", error.message, info.componentStack);
  }

  render() {
    if (this.state.message) {
      return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-slate-950 px-6 text-center text-slate-200">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-300">
            Myra Remote
          </p>
          <h1 className="text-base font-semibold">The dashboard hit an error</h1>
          <p className="max-w-xs text-xs leading-relaxed text-slate-400">
            {this.state.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-cyan-200"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
if (container) {
  try {
    createRoot(container).render(
      <StrictMode>
        <RemoteErrorBoundary>
          <RemoteApp />
        </RemoteErrorBoundary>
      </StrictMode>
    );
  } catch (error) {
    console.error("[remote] Failed to mount:", error);
    container.innerHTML =
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e2e8f0;font-family:system-ui,sans-serif;padding:1.5rem;text-align:center">' +
      "<div><p style=\"font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:#22d3ee\">Myra Remote</p>" +
      '<p style="margin-top:.75rem;font-size:.85rem;color:#94a3b8">The dashboard could not start. Reload the page, or check that Myra is still running on your PC.</p>' +
      '<p style="margin-top:1rem"><a href="/remote" style="color:#a5f3fc">Reload</a></p></div></div>';
  }
}
