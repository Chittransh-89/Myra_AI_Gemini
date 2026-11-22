import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Code2,
  FolderOpen,
  Github,
  GraduationCap,
  History,
  Lightbulb,
  Loader2,
  Pause,
  Play,
  Send,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import type {
  Difficulty,
  InterviewReport,
  InterviewSession,
  InterviewSummary,
  InterviewType,
  ProjectKnowledge,
  ProjectSummary,
  ProjectSource,
} from "../server/intelligence/types";
import type { AssistantState } from "../types";

const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = {
  overview: "Project Overview",
  deep_dive: "Technical Deep Dive",
  code: "Code-Level",
  architecture: "Architecture",
  debugging: "Debugging & Edge Cases",
  full: "Full Technical Interview",
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  brutal: "Brutal / Company-level",
};

const STAGE_LABELS: Record<string, string> = {
  project_understanding: "Project Understanding",
  technical_deep_dive: "Technical Deep Dive",
  design_tradeoffs: "Design & Trade-offs",
  code_level: "Code-Level",
  debugging: "Debugging",
  cross_questioning: "Cross-Questioning",
};

const VERDICT_LABELS: Record<InterviewReport["verdict"], string> = {
  strong_understanding: "Strong understanding of the project",
  architecture_only: "Understands the architecture, not the implementation",
  memorized: "Recites explanations but cannot reason about the code",
  serious_gaps: "Serious gaps in understanding",
};

interface ImportedProjectView {
  projectId: string;
  name: string;
  source: ProjectSource;
  stats: { files: number; bytes: number; chars: number; redactions: number; skipped: number };
  warnings: string[];
  tree: { path: string; type: "file" | "dir"; size?: number }[];
  skipped: { path: string; reason: string }[];
}

interface LiveTranscriptLine {
  role: "interviewer" | "candidate";
  text: string;
}

interface InterviewModeProps {
  open: boolean;
  onClose: () => void;
  electronMode: boolean;
  voiceState: AssistantState;
  voiceTranscript: LiveTranscriptLine[];
  onStartVoice: (interviewId: string) => void;
  onStopVoice: () => void;
}

type View = "setup" | "interview" | "report";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function InterviewMode({
  open,
  onClose,
  electronMode,
  voiceState,
  voiceTranscript,
  onStartVoice,
  onStopVoice,
}: InterviewModeProps) {
  const [view, setView] = useState<View>("setup");
  const [tab, setTab] = useState<"saved" | "local" | "github">("saved");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [knowledge, setKnowledge] = useState<ProjectKnowledge | null>(null);
  const [imported, setImported] = useState<ImportedProjectView | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [localConfirmed, setLocalConfirmed] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [showTree, setShowTree] = useState(false);
  const [interviewType, setInterviewType] = useState<InterviewType>("full");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [answer, setAnswer] = useState("");
  const [assessment, setAssessment] = useState<string | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [codeSamples, setCodeSamples] = useState<
    { file: string; name: string; startLine: number; snippet: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const desktopToken =
    typeof (window as any).myraDesktop?.wsAuthToken === "string"
      ? ((window as any).myraDesktop.wsAuthToken as string)
      : null;

  const api = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
      if (init?.body) headers["content-type"] = "application/json";
      if (desktopToken) headers["x-myra-desktop-token"] = desktopToken;
      const res = await fetch(path, { ...init, headers, cache: "no-store" });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
      }
      return data as T;
    },
    [desktopToken]
  );

  const refreshProjects = useCallback(async () => {
    try {
      const data = await api<{ projects: ProjectSummary[] }>("/api/intelligence/projects");
      setProjects(data.projects ?? []);
    } catch {
      /* projects are optional until the first import */
    }
  }, [api]);

  useEffect(() => {
    if (!open) return;
    void refreshProjects();
    void api<{ interviews: InterviewSummary[] }>("/api/intelligence/interviews")
      .then((data) => setInterviews(data.interviews ?? []))
      .catch(() => {});
  }, [open, api, refreshProjects]);

  // While a voice interview is running, mirror the turns the server records.
  useEffect(() => {
    if (view !== "interview" || !session || voiceState === "disconnected") return;
    const interval = window.setInterval(() => {
      void api<{ session: InterviewSession }>(`/api/intelligence/interviews/${session.id}`)
        .then((data) => data.session && setSession(data.session))
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(interval);
  }, [view, session?.id, voiceState, api]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [session?.turns.length]);

  const resetToSetup = () => {
    if (session && voiceState !== "disconnected") onStopVoice();
    setView("setup");
    setSession(null);
    setReport(null);
    setAssessment(null);
    setHints([]);
    setExplanation(null);
    setCodeSamples([]);
    setAnswer("");
  };

  const selectProject = async (projectId: string) => {
    setBusy(true);
    setError(null);
    setStatus("Loading analysed project…");
    try {
      const data = await api<{ project: ProjectKnowledge; interviews: InterviewSummary[] }>(
        `/api/intelligence/projects/${projectId}`
      );
      setKnowledge(data.project);
      setInterviews(data.interviews ?? []);
      setImported(null);
      setStatus("");
    } catch (err) {
      setError(errorText(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const importLocal = async () => {
    setError(null);
    const picker = (window as any).myraDesktop?.projectFolder;
    let target = folderPath.trim();

    if (picker?.pick) {
      setBusy(true);
      setStatus("Waiting for the folder picker…");
      try {
        const picked = await picker.pick();
        if (!picked || picked.canceled || !picked.path) {
          setStatus("");
          setBusy(false);
          return;
        }
        target = String(picked.path);
        setFolderPath(target);
      } catch (err) {
        setBusy(false);
        setStatus("");
        setError(`Folder picker failed: ${errorText(err)}`);
        return;
      }
    } else if (!localConfirmed) {
      setError("Confirm that Myra may read this folder before importing.");
      return;
    }

    if (!target) {
      setError("Choose a project folder first.");
      setBusy(false);
      setStatus("");
      return;
    }

    setBusy(true);
    setStatus("Scanning the folder (read-only)…");
    try {
      const data = await api<{ project: ImportedProjectView; aiAvailable: boolean }>(
        "/api/intelligence/import/local",
        { method: "POST", body: JSON.stringify({ path: target }) }
      );
      setImported(data.project);
      setKnowledge(null);
      setShowTree(true);
      setStatus(
        `Scanned ${data.project.stats.files} file(s). ${data.project.stats.redactions} secret(s) redacted.`
      );
    } catch (err) {
      setError(errorText(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const importGitHub = async () => {
    if (!githubUrl.trim()) {
      setError("Paste a public GitHub repository URL first.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("Fetching the public repository from GitHub…");
    try {
      const data = await api<{ project: ImportedProjectView; aiAvailable: boolean }>(
        "/api/intelligence/import/github",
        { method: "POST", body: JSON.stringify({ url: githubUrl.trim() }) }
      );
      setImported(data.project);
      setKnowledge(null);
      setShowTree(true);
      setStatus(
        `Fetched ${data.project.stats.files} file(s). ${data.project.stats.redactions} secret(s) redacted.`
      );
    } catch (err) {
      setError(errorText(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const analyse = async () => {
    const projectId = imported?.projectId ?? knowledge?.projectId;
    if (!projectId) return;
    setBusy(true);
    setError(null);
    setStatus("Analysing the code with Gemini — this can take up to a minute…");
    try {
      const data = await api<{ project: ProjectKnowledge }>(
        `/api/intelligence/projects/${projectId}/analyze`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setKnowledge(data.project);
      setImported(null);
      setStatus(`Knowledge profile ready for ${data.project.name}.`);
      await refreshProjects();
    } catch (err) {
      setError(errorText(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const startInterview = async () => {
    if (!knowledge) return;
    setBusy(true);
    setError(null);
    setStatus("Preparing the interviewer…");
    try {
      const data = await api<{ session: InterviewSession }>("/api/intelligence/interviews", {
        method: "POST",
        body: JSON.stringify({
          projectId: knowledge.projectId,
          type: interviewType,
          difficulty,
        }),
      });
      setSession({ ...data.session, currentQuestion: data.session.currentQuestion });
      setReport(null);
      setAssessment(null);
      setHints([]);
      setExplanation(null);
      setCodeSamples([]);
      setAnswer("");
      setView("interview");
      setStatus("");
    } catch (err) {
      setError(errorText(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = async () => {
    if (!session || !answer.trim()) return;
    setBusy(true);
    setError(null);
    setHints([]);
    setExplanation(null);
    try {
      const data = await api<{
        session: InterviewSession;
        assessment: InterviewSession["assessments"][number]["assessment"];
        nextQuestion: InterviewSession["currentQuestion"];
        finished: boolean;
      }>(`/api/intelligence/interviews/${session.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer }),
      });
      setSession(data.session);
      setAnswer("");
      const a = data.assessment;
      setAssessment(
        `${a.note} ${a.correctness.replace(/^./, (c) => c.toUpperCase())} — ${a.score}/100.` +
          (a.missing.length ? ` Missing: ${a.missing.join("; ")}` : "") +
          (a.misconceptions.length ? ` Incorrect: ${a.misconceptions.join("; ")}` : "")
      );
      if (data.finished) {
        setStatus("No further questions are open. End the interview to get your report.");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "hint" | "explain" | "skip" | "pause" | "resume" | "end") => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "hint") {
        const data = await api<{ hints: string[] }>(`/api/intelligence/interviews/${session.id}/hint`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setHints(data.hints ?? []);
        const fresh = await api<{ session: InterviewSession }>(
          `/api/intelligence/interviews/${session.id}`
        );
        if (fresh.session) setSession(fresh.session);
      } else if (action === "explain") {
        const data = await api<{ concept: string; explanation: string }>(
          `/api/intelligence/interviews/${session.id}/explain`,
          { method: "POST", body: JSON.stringify({}) }
        );
        setExplanation(`${data.concept}: ${data.explanation}`);
      } else if (action === "skip") {
        const data = await api<{ session: InterviewSession }>(
          `/api/intelligence/interviews/${session.id}/skip`,
          { method: "POST", body: JSON.stringify({}) }
        );
        setSession(data.session);
        setHints([]);
        setExplanation(null);
        setAssessment(null);
      } else if (action === "pause" || action === "resume") {
        const data = await api<{ session: InterviewSession }>(
          `/api/intelligence/interviews/${session.id}/${action}`,
          { method: "POST", body: JSON.stringify({}) }
        );
        setSession(data.session);
        if (action === "pause" && voiceState !== "disconnected") onStopVoice();
      } else if (action === "end") {
        if (voiceState !== "disconnected") onStopVoice();
        setStatus("Generating your honest interview report…");
        const data = await api<{ session: InterviewSession; report: InterviewReport }>(
          `/api/intelligence/interviews/${session.id}/end`,
          { method: "POST", body: JSON.stringify({}) }
        );
        setSession(data.session);
        setReport(data.report);
        setView("report");
        setStatus("");
        void api<{ interviews: InterviewSummary[] }>("/api/intelligence/interviews")
          .then((list) => setInterviews(list.interviews ?? []))
          .catch(() => {});
      }
    } catch (err) {
      setError(errorText(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const showCode = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{
        samples: { file: string; name: string; startLine: number; snippet: string }[];
      }>(`/api/intelligence/interviews/${session.id}/code`);
      setCodeSamples(data.samples ?? []);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const openPrevious = async (interviewId: string) => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ session: InterviewSession; report: InterviewReport | null }>(
        `/api/intelligence/interviews/${interviewId}`
      );
      setSession(data.session);
      if (data.report) {
        setReport(data.report);
        setView("report");
      } else {
        setView("interview");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const currentSourceLabel = useMemo(() => {
    const source = knowledge?.source ?? imported?.source;
    if (!source) return "";
    return source.kind === "github" ? source.repoUrl : source.root;
  }, [knowledge, imported]);

  if (!open) return null;

  const stageLabel = session ? STAGE_LABELS[session.stage] ?? session.stage : "";
  const voiceActive = voiceState !== "disconnected";

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-slate-950/97 border-l border-white/10 backdrop-blur-2xl flex flex-col shadow-2xl"
      id="interview-mode-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl border border-cyan-500/30 bg-cyan-500/10 flex items-center justify-center shrink-0">
            <GraduationCap className="w-4 h-4 text-cyan-300" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">Project Intelligence</p>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">
              Interview Mode
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg border border-white/10 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Close interview mode"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        {error && (
          <div className="text-[11px] text-red-200 bg-red-950/50 border border-red-500/30 rounded-xl px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-400" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-300/80 hover:text-white" aria-label="Dismiss error">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {(busy || status) && (
          <div className="text-[11px] text-cyan-200/90 bg-cyan-950/40 border border-cyan-500/25 rounded-xl px-3 py-2 flex items-start gap-2">
            {busy ? <Loader2 className="w-3.5 h-3.5 shrink-0 mt-0.5 animate-spin" /> : null}
            <span className="flex-1">{status || "Working…"}</span>
          </div>
        )}

        {view === "setup" && (
          <>
            {/* Source tabs */}
            <div className="grid grid-cols-3 gap-1.5 bg-slate-900/70 border border-white/5 rounded-xl p-1">
              {(
                [
                  ["saved", "Saved"],
                  ["local", "Local folder"],
                  ["github", "GitHub"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-colors ${
                    tab === key ? "bg-cyan-500/15 text-cyan-200 border border-cyan-500/30" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "saved" && (
              <div className="flex flex-col gap-2">
                {projects.length === 0 && (
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    No analysed projects yet. Import a local folder or a public GitHub repository.
                  </p>
                )}
                {projects.map((project) => (
                  <button
                    key={project.projectId}
                    onClick={() => void selectProject(project.projectId)}
                    className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                      knowledge?.projectId === project.projectId
                        ? "border-cyan-500/40 bg-cyan-950/30"
                        : "border-white/10 bg-white/2 hover:bg-white/5"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-100 truncate">{project.name}</span>
                      <span className="font-mono text-[9px] text-slate-500 shrink-0">
                        {project.sourceKind === "github" ? "GitHub" : "Local"}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[9px] text-slate-500 truncate">{project.sourceLabel}</p>
                    <p className="mt-1 text-[10px] text-slate-400">
                      {project.files} file(s)
                      {project.stack.length > 0 ? ` · ${project.stack.slice(0, 3).join(", ")}` : ""}
                    </p>
                  </button>
                ))}
              </div>
            )}

            {tab === "local" && (
              <div className="flex flex-col gap-2.5">
                <div className="flex gap-2">
                  <input
                    value={folderPath}
                    onChange={(event) => setFolderPath(event.target.value)}
                    placeholder={electronMode ? "Folder chosen with the picker" : "E:\\path\\to\\project"}
                    className="flex-1 min-w-0 bg-slate-900/80 border border-white/10 rounded-xl px-3 py-2 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
                  />
                  {electronMode && (
                    <button
                      onClick={() => void importLocal()}
                      className="shrink-0 px-3 py-2 rounded-xl border border-cyan-500/30 bg-cyan-950/40 text-cyan-200 text-[10px] font-mono uppercase tracking-wider hover:bg-cyan-900/40 flex items-center gap-1.5"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Pick
                    </button>
                  )}
                </div>
                {!electronMode && (
                  <label className="flex items-start gap-2 text-[10px] text-slate-400 leading-relaxed">
                    <input
                      type="checkbox"
                      checked={localConfirmed}
                      onChange={(event) => setLocalConfirmed(event.target.checked)}
                      className="mt-0.5 accent-cyan-500"
                    />
                    I confirm Myra may read this folder. It is read-only, outside files are never scanned, and
                    secrets are redacted.
                  </label>
                )}
                <button
                  onClick={() => void importLocal()}
                  disabled={busy}
                  className="py-2 rounded-xl border border-cyan-500/30 bg-cyan-950/40 text-cyan-200 text-[10px] font-mono uppercase tracking-wider hover:bg-cyan-900/40 disabled:opacity-50"
                >
                  {electronMode ? "Import selected folder" : "Scan folder"}
                </button>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Only that folder is scanned. <span className="text-slate-400">node_modules</span>, build output,
                  caches, binaries, lockfiles and secret files are skipped; symlinks are never followed.
                </p>
              </div>
            )}

            {tab === "github" && (
              <div className="flex flex-col gap-2.5">
                <input
                  value={githubUrl}
                  onChange={(event) => setGithubUrl(event.target.value)}
                  placeholder="https://github.com/owner/repository"
                  className="bg-slate-900/80 border border-white/10 rounded-xl px-3 py-2 text-[11px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
                />
                <button
                  onClick={() => void importGitHub()}
                  disabled={busy}
                  className="py-2 rounded-xl border border-purple-500/30 bg-purple-950/40 text-purple-200 text-[10px] font-mono uppercase tracking-wider hover:bg-purple-900/40 disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  <Github className="w-3.5 h-3.5" />
                  Fetch public repository
                </button>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Public repositories only. Files are fetched read-only through the GitHub API; nothing is cloned,
                  installed or executed, and repository instructions are treated as untrusted data.
                </p>
              </div>
            )}

            {/* Imported project preview */}
            {imported && (
              <div className="rounded-xl border border-white/10 bg-white/2 p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-100 truncate">{imported.name}</span>
                  <span className="font-mono text-[9px] text-slate-500">
                    {imported.stats.files} files · {Math.round(imported.stats.chars / 1000)}k chars
                  </span>
                </div>
                <p className="font-mono text-[9px] text-slate-500 break-all">{currentSourceLabel}</p>
                {imported.stats.redactions > 0 && (
                  <p className="text-[10px] text-amber-300/90">
                    {imported.stats.redactions} secret(s) were redacted before analysis.
                  </p>
                )}
                {imported.warnings.length > 0 && (
                  <p className="text-[10px] text-slate-400">{imported.warnings.slice(0, 2).join(" ")}</p>
                )}
                <button
                  onClick={() => setShowTree((value) => !value)}
                  className="self-start text-[9px] font-mono uppercase tracking-wider text-slate-400 hover:text-slate-200"
                >
                  {showTree ? "Hide files" : "Show files"}
                </button>
                {showTree && (
                  <div className="max-h-32 overflow-y-auto font-mono text-[9px] text-slate-400 flex flex-col gap-0.5">
                    {imported.tree.slice(0, 200).map((node) => (
                      <span key={node.path} className={node.type === "dir" ? "text-cyan-300/80" : ""}>
                        {node.path}
                      </span>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => void analyse()}
                  disabled={busy}
                  className="mt-1 py-2 rounded-xl border border-emerald-500/30 bg-emerald-950/40 text-emerald-200 text-[10px] font-mono uppercase tracking-wider hover:bg-emerald-900/40 disabled:opacity-50"
                >
                  Analyse project
                </button>
              </div>
            )}

            {/* Knowledge summary */}
            {knowledge && (
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-950/15 p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="text-xs font-medium text-slate-100 truncate">{knowledge.name}</span>
                </div>
                {knowledge.purpose && <p className="text-[11px] text-slate-300 leading-relaxed">{knowledge.purpose}</p>}
                {knowledge.stack.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {knowledge.stack.slice(0, 8).map((item) => (
                      <span
                        key={item}
                        className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-cyan-500/20 bg-cyan-950/40 text-cyan-200"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                )}
                <p className="font-mono text-[9px] text-slate-500 break-all">{currentSourceLabel}</p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="font-mono text-[9px] uppercase text-slate-500">Files</p>
                    <p className="text-xs text-slate-200">{knowledge.stats.files}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[9px] uppercase text-slate-500">Endpoints</p>
                    <p className="text-xs text-slate-200">{knowledge.apiEndpoints.length}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[9px] uppercase text-slate-500">Redacted</p>
                    <p className="text-xs text-slate-200">{knowledge.stats.redactions}</p>
                  </div>
                </div>
                {knowledge.unknowns.length > 0 && (
                  <p className="text-[9px] text-slate-500 leading-relaxed">
                    Not covered: {knowledge.unknowns.slice(0, 2).join(" ")}
                  </p>
                )}
              </div>
            )}

            {/* Interview configuration */}
            <div className="flex flex-col gap-2.5 border-t border-white/10 pt-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">Interview setup</p>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-slate-400">Interview type</span>
                <select
                  value={interviewType}
                  onChange={(event) => setInterviewType(event.target.value as InterviewType)}
                  className="bg-slate-900/80 border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-slate-200 focus:outline-none focus:border-cyan-500/40"
                >
                  {Object.entries(INTERVIEW_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-slate-400">Difficulty</span>
                <select
                  value={difficulty}
                  onChange={(event) => setDifficulty(event.target.value as Difficulty)}
                  className="bg-slate-900/80 border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-slate-200 focus:outline-none focus:border-cyan-500/40"
                >
                  {Object.entries(DIFFICULTY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => void startInterview()}
                disabled={!knowledge || busy}
                className="py-2.5 rounded-xl border border-cyan-500/40 bg-cyan-950/50 text-cyan-100 text-[10px] font-mono uppercase tracking-[0.15em] hover:bg-cyan-900/50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Play className="w-3.5 h-3.5" />
                Start interview
              </button>
              <p className="text-[9px] text-slate-500 leading-relaxed">
                Questions are generated from this project's code and from your earlier answers — there is no fixed
                question bank. Difficulty changes the depth of questioning.
              </p>
            </div>

            {/* Previous interviews */}
            {interviews.length > 0 && (
              <div className="flex flex-col gap-1.5 border-t border-white/10 pt-3">
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500 flex items-center gap-1.5">
                  <History className="w-3 h-3" /> Previous sessions
                </p>
                {interviews.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => void openPrevious(item.id)}
                    className="text-left rounded-lg border border-white/5 bg-white/2 hover:bg-white/5 px-2.5 py-2 flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-[11px] text-slate-200 truncate">
                        {INTERVIEW_TYPE_LABELS[item.type] ?? item.type} · {DIFFICULTY_LABELS[item.difficulty]}
                      </span>
                      <span className="block font-mono text-[9px] text-slate-500">
                        {item.projectName} · {item.questionCount} questions · {item.status}
                      </span>
                    </span>
                    {item.reportId && <span className="text-[9px] font-mono text-emerald-300 shrink-0">report</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {view === "interview" && session && (
          <>
            <button
              onClick={resetToSetup}
              className="self-start flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-slate-500 hover:text-slate-300"
            >
              <ChevronLeft className="w-3 h-3" /> Setup
            </button>

            <div className="rounded-xl border border-white/10 bg-white/2 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-100 truncate">{session.projectName}</span>
                <span
                  className={`font-mono text-[9px] px-1.5 py-0.5 rounded border ${
                    session.status === "active"
                      ? "border-emerald-500/30 bg-emerald-950/40 text-emerald-300"
                      : session.status === "paused"
                        ? "border-amber-500/30 bg-amber-950/40 text-amber-300"
                        : "border-slate-600/40 bg-slate-900 text-slate-400"
                  }`}
                >
                  {session.status}
                </span>
              </div>
              <p className="mt-1 font-mono text-[9px] text-slate-500">
                {INTERVIEW_TYPE_LABELS[session.type]} · {DIFFICULTY_LABELS[session.difficulty]} · {stageLabel} ·{" "}
                {session.questions.length} questions
              </p>
            </div>

            <div
              ref={scrollRef}
              className="max-h-64 overflow-y-auto flex flex-col gap-2 pr-1"
              id="interview-transcript"
            >
              {session.turns.length === 0 && (
                <p className="text-[11px] text-slate-500">The interviewer will open with the first question.</p>
              )}
              {session.turns.map((turn, index) => (
                <div
                  key={`${turn.at}-${index}`}
                  className={`rounded-xl px-3 py-2 text-[11px] leading-relaxed border ${
                    turn.role === "interviewer"
                      ? "border-cyan-500/20 bg-cyan-950/25 text-slate-200"
                      : "border-white/5 bg-white/2 text-slate-300 ml-4"
                  }`}
                >
                  <p className="font-mono text-[8px] uppercase tracking-wider text-slate-500 mb-0.5">
                    {turn.role === "interviewer" ? "Myra" : "You"}
                    {turn.source === "voice" ? " · voice" : ""}
                  </p>
                  {turn.text}
                </div>
              ))}
              {voiceActive &&
                voiceTranscript.slice(-4).map((line, index) => (
                  <div
                    key={`live-${index}`}
                    className="rounded-xl px-3 py-1.5 text-[10px] italic text-slate-400 border border-dashed border-white/10"
                  >
                    live · {line.role === "interviewer" ? "Myra" : "You"}: {line.text}
                  </div>
                ))}
            </div>

            {session.currentQuestion ? (
              <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-3 flex flex-col gap-2">
                <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-cyan-300/80">Current question</p>
                <p className="text-[13px] leading-relaxed text-slate-100">{session.currentQuestion.text}</p>
                {session.currentQuestion.evidence.length > 0 && (
                  <p className="font-mono text-[9px] text-slate-500">
                    evidence: {session.currentQuestion.evidence.map((item) => item.file).join(", ")}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/2 p-3">
                <p className="text-[11px] text-slate-300">
                  No question is open. End the interview to generate your report.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Answer in your own words…"
                rows={3}
                className="bg-slate-900/80 border border-white/10 rounded-xl px-3 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40 resize-none"
              />
              <button
                onClick={() => void submitAnswer()}
                disabled={busy || !answer.trim() || session.status !== "active" || !session.currentQuestion}
                className="py-2 rounded-xl border border-cyan-500/40 bg-cyan-950/50 text-cyan-100 text-[10px] font-mono uppercase tracking-wider hover:bg-cyan-900/50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" /> Submit answer
              </button>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  onClick={() => void act("hint")}
                  disabled={busy || !session.currentQuestion}
                  className="py-1.5 rounded-lg border border-amber-500/25 bg-amber-950/30 text-amber-200 text-[9px] font-mono uppercase tracking-wider hover:bg-amber-900/30 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  <Lightbulb className="w-3 h-3" /> Hint
                </button>
                <button
                  onClick={() => void act("explain")}
                  disabled={busy || !session.currentQuestion}
                  className="py-1.5 rounded-lg border border-sky-500/25 bg-sky-950/30 text-sky-200 text-[9px] font-mono uppercase tracking-wider hover:bg-sky-900/30 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  <BookOpen className="w-3 h-3" /> Explain
                </button>
                <button
                  onClick={() => void showCode()}
                  disabled={busy}
                  className="py-1.5 rounded-lg border border-purple-500/25 bg-purple-950/30 text-purple-200 text-[9px] font-mono uppercase tracking-wider hover:bg-purple-900/30 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  <Code2 className="w-3 h-3" /> Code
                </button>
              </div>
            </div>

            {assessment && (
              <div className="rounded-xl border border-white/10 bg-white/2 p-2.5 text-[10px] text-slate-300 leading-relaxed">
                <p className="font-mono text-[8px] uppercase tracking-wider text-slate-500 mb-1">Assessment</p>
                {assessment}
              </div>
            )}

            {hints.length > 0 && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-950/20 p-2.5 text-[10px] text-amber-100/90 leading-relaxed flex flex-col gap-1">
                <p className="font-mono text-[8px] uppercase tracking-wider text-amber-300/80">Hints (not the answer)</p>
                {hints.map((hint, index) => (
                  <p key={index}>· {hint}</p>
                ))}
              </div>
            )}

            {explanation && (
              <div className="rounded-xl border border-sky-500/25 bg-sky-950/20 p-2.5 text-[10px] text-sky-100/90 leading-relaxed">
                <p className="font-mono text-[8px] uppercase tracking-wider text-sky-300/80 mb-1">Concept</p>
                {explanation}
              </div>
            )}

            {codeSamples.length > 0 && (
              <div className="rounded-xl border border-purple-500/25 bg-purple-950/15 p-2.5 flex flex-col gap-2">
                <p className="font-mono text-[8px] uppercase tracking-wider text-purple-300/80">
                  Imported code evidence
                </p>
                {codeSamples.map((sample, index) => (
                  <div key={`${sample.file}-${index}`} className="flex flex-col gap-1">
                    <p className="font-mono text-[9px] text-slate-400">
                      {sample.file} · {sample.name}
                      {sample.startLine ? ` · line ${sample.startLine}` : ""}
                    </p>
                    <pre className="max-h-40 overflow-auto text-[9px] font-mono text-slate-300 bg-slate-950/80 border border-white/5 rounded-lg p-2 whitespace-pre-wrap">
                      {sample.snippet}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            {/* Voice + controls */}
            <div className="border-t border-white/10 pt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
                  Voice interview
                </span>
                <span className="font-mono text-[9px] text-slate-400">{voiceState}</span>
              </div>
              {voiceActive ? (
                <button
                  onClick={onStopVoice}
                  className="py-2 rounded-xl border border-red-500/30 bg-red-950/40 text-red-200 text-[10px] font-mono uppercase tracking-wider hover:bg-red-900/40 flex items-center justify-center gap-1.5"
                >
                  <Square className="w-3 h-3" /> Stop voice
                </button>
              ) : (
                <button
                  onClick={() => onStartVoice(session.id)}
                  disabled={session.status === "ended"}
                  className="py-2 rounded-xl border border-emerald-500/30 bg-emerald-950/40 text-emerald-200 text-[10px] font-mono uppercase tracking-wider hover:bg-emerald-900/40 disabled:opacity-40 flex items-center justify-center gap-1.5"
                >
                  <Play className="w-3 h-3" /> Start voice interview
                </button>
              )}
              <p className="text-[9px] text-slate-500 leading-relaxed">
                Voice uses Myra's existing Gemini Live session and microphone — Myra asks the questions aloud and
                your spoken answers are transcribed into this session.
              </p>

              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => void act("skip")}
                  disabled={busy || !session.currentQuestion}
                  className="py-1.5 rounded-lg border border-white/10 bg-white/2 text-slate-300 text-[9px] font-mono uppercase tracking-wider hover:bg-white/5 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  <SkipForward className="w-3 h-3" /> Skip
                </button>
                {session.status === "paused" ? (
                  <button
                    onClick={() => void act("resume")}
                    disabled={busy}
                    className="py-1.5 rounded-lg border border-emerald-500/25 bg-emerald-950/30 text-emerald-200 text-[9px] font-mono uppercase tracking-wider hover:bg-emerald-900/30 disabled:opacity-40 flex items-center justify-center gap-1"
                  >
                    <Play className="w-3 h-3" /> Resume
                  </button>
                ) : (
                  <button
                    onClick={() => void act("pause")}
                    disabled={busy || session.status === "ended"}
                    className="py-1.5 rounded-lg border border-amber-500/25 bg-amber-950/30 text-amber-200 text-[9px] font-mono uppercase tracking-wider hover:bg-amber-900/30 disabled:opacity-40 flex items-center justify-center gap-1"
                  >
                    <Pause className="w-3 h-3" /> Pause
                  </button>
                )}
              </div>
              <button
                onClick={() => void act("end")}
                disabled={busy}
                className="py-2 rounded-xl border border-white/15 bg-slate-900 text-slate-200 text-[10px] font-mono uppercase tracking-wider hover:bg-slate-800 disabled:opacity-40"
              >
                End interview & get report
              </button>
            </div>
          </>
        )}

        {view === "report" && report && (
          <>
            <button
              onClick={resetToSetup}
              className="self-start flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-slate-500 hover:text-slate-300"
            >
              <ChevronLeft className="w-3 h-3" /> Setup
            </button>

            <div className="rounded-xl border border-white/10 bg-white/2 p-3">
              <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-slate-500">Interview report</p>
              <p className="mt-1 text-sm font-semibold text-white">{report.projectName}</p>
              <p className="font-mono text-[9px] text-slate-500">
                {INTERVIEW_TYPE_LABELS[report.type]} · {DIFFICULTY_LABELS[report.difficulty]} ·{" "}
                {new Date(report.createdAt).toLocaleString()}
              </p>
            </div>

            <div className="rounded-xl border border-cyan-500/25 bg-cyan-950/20 p-4 text-center">
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">Overall score</p>
              <p className="text-4xl font-light text-white mt-1">
                {report.overallScore}
                <span className="text-sm text-slate-500">/100</span>
              </p>
              <p className="mt-2 text-[11px] text-cyan-100/90">{VERDICT_LABELS[report.verdict]}</p>
            </div>

            <div className="flex flex-col gap-2">
              {(
                [
                  ["Technical knowledge", report.scores.technicalKnowledge],
                  ["Code understanding", report.scores.codeUnderstanding],
                  ["Architecture", report.scores.architectureUnderstanding],
                  ["Reasoning", report.scores.reasoning],
                  ["Communication", report.scores.communicationClarity],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 text-[10px] text-slate-400">{label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-purple-500"
                      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-[10px] text-slate-300">{value}</span>
                </div>
              ))}
            </div>

            {report.summary && (
              <div className="rounded-xl border border-white/10 bg-white/2 p-3 text-[11px] text-slate-300 leading-relaxed">
                {report.summary}
              </div>
            )}

            {(
              [
                ["Weak areas", report.weakAreas],
                ["Incorrect assumptions", report.incorrectAssumptions],
                ["Topics to revise", report.topicsToRevise],
                ["Suggested follow-up interviews", report.followUpTopics],
                ["Revision plan", report.revisionPlan],
              ] as const
            ).map(([label, items]) =>
              items.length === 0 ? null : (
                <div key={label} className="rounded-xl border border-white/10 bg-white/2 p-3">
                  <p className="font-mono text-[8px] uppercase tracking-wider text-slate-500 mb-1.5">{label}</p>
                  <ul className="flex flex-col gap-1">
                    {items.map((item, index) => (
                      <li key={index} className="text-[10px] text-slate-300 leading-relaxed flex gap-1.5">
                        <span className="text-slate-600">·</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}

            <div className="rounded-xl border border-white/10 bg-white/2 p-3">
              <p className="font-mono text-[8px] uppercase tracking-wider text-slate-500 mb-1.5">
                Questions & answers ({report.questions.length})
              </p>
              <div className="flex flex-col gap-2">
                {report.questions.map((item, index) => (
                  <div key={index} className="border-l border-white/10 pl-2">
                    <p className="text-[10px] text-slate-200 leading-relaxed">
                      {index + 1}. {item.question}
                    </p>
                    <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5">You: {item.answerSummary}</p>
                    <p className="font-mono text-[8px] uppercase tracking-wider text-slate-600 mt-0.5">
                      {STAGE_LABELS[item.stage] ?? item.stage}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  void startInterview();
                }}
                disabled={busy || !knowledge}
                className="py-2 rounded-xl border border-cyan-500/30 bg-cyan-950/40 text-cyan-200 text-[9px] font-mono uppercase tracking-wider hover:bg-cyan-900/40 disabled:opacity-40"
              >
                New interview
              </button>
              <button
                onClick={resetToSetup}
                className="py-2 rounded-xl border border-white/10 bg-white/2 text-slate-300 text-[9px] font-mono uppercase tracking-wider hover:bg-white/5"
              >
                Back to projects
              </button>
            </div>
          </>
        )}
      </div>
    </motion.aside>
  );
}
