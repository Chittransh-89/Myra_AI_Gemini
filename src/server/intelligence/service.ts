/**
 * Myra AI — Project Intelligence service.
 *
 * Owns the import -> analyse -> interview -> report lifecycle and the file store.
 * Transport-agnostic: routes.ts wires it to HTTP, and the existing WS server
 * uses voiceInstruction()/answerVoice() for Interview Mode voice. The engine
 * stays authoritative for every question, assessment and the final report;
 * the voice model only speaks questions and supplies transcription.
 *
 * Local scanning requires an explicitly approved root (native folder picker in
 * Electron runs). Nothing here writes to, renames or executes project files.
 */

import { DEFAULT_SCAN_LIMITS, type ScanLimits } from "./filter.js";
import { fetchGitHubProject } from "./githubSource.js";
import { buildKnowledge } from "./knowledge.js";
import {
  buildReport,
  buildVoiceInstruction,
  codeForQuestion,
  generateNextQuestion,
  newInterviewSession,
  requestExplanation,
  requestHint,
  skipQuestion,
  submitAnswer,
} from "./interview.js";
import { scanLocalProject } from "./localSource.js";
import type { TextModel } from "./model.js";
import { IntelligenceStore } from "./store.js";
import {
  IntelligenceError,
  type Difficulty,
  type ImportedProject,
  type InterviewReport,
  type InterviewSession,
  type InterviewType,
  type ProjectKnowledge,
} from "./types.js";

// Imported source stays in memory long enough to retry an analysis without
// making the user fetch the project again.
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING = 4;
const MAX_TURNS = 240;
const DEFAULT_REQUEST_CAP = 40;

export interface IntelligenceServiceOptions {
  dataDir: string;
  approvedRootsFile: string | null;
  electronMode: boolean;
  model: TextModel | null;
  limits?: Partial<ScanLimits>;
  /** Gemini text requests allowed per analysis run and per interview session. */
  requestCap?: number;
}

/** What the UI may see about an imported (not yet analysed) project. */
export interface ImportedProjectView {
  projectId: string;
  name: string;
  source: ImportedProject["source"];
  stats: ImportedProject["stats"];
  warnings: string[];
  tree: ImportedProject["tree"];
  skipped: ImportedProject["skipped"];
  importedAt: string;
}

function viewOf(project: ImportedProject): ImportedProjectView {
  return {
    projectId: project.projectId,
    name: project.name,
    source: project.source,
    stats: project.stats,
    warnings: project.warnings,
    tree: project.tree.slice(0, 400),
    skipped: project.skipped.slice(0, 120),
    importedAt: project.importedAt,
  };
}

export class IntelligenceService {
  private store: IntelligenceStore;
  private model: TextModel | null;
  private options: IntelligenceServiceOptions;
  private limits: ScanLimits;
  private requestCap: number;
  private pending = new Map<string, { project: ImportedProject; expiresAt: number }>();

  constructor(options: IntelligenceServiceOptions) {
    this.options = options;
    this.model = options.model;
    this.limits = { ...DEFAULT_SCAN_LIMITS, ...(options.limits ?? {}) };
    this.requestCap = Math.max(1, Math.floor(options.requestCap ?? DEFAULT_REQUEST_CAP));
    this.store = new IntelligenceStore(options.dataDir);
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  get storeHandle(): IntelligenceStore {
    return this.store;
  }

  hasModel(): boolean {
    return this.model !== null;
  }

  private requireModel(): TextModel {
    if (!this.model) {
      throw new IntelligenceError(
        "aiUnavailable",
        "Project analysis needs Gemini. Set GEMINI_API_KEY in the Myra .env file and restart the app.",
        503
      );
    }
    return this.model;
  }

  /**
   * Count one Gemini request against an interview before it is sent. The
   * counter lives on the persisted session, so the cap also holds across
   * restarts. Quota exhaustion itself is classified in GeminiTextModel.
   */
  private reserveInterviewRequest(session: InterviewSession): void {
    const used = session.requestsUsed ?? 0;
    if (used + 1 > this.requestCap) {
      throw new IntelligenceError(
        "requestCapReached",
        `This interview reached its Gemini request limit (${this.requestCap}). End it and start a new interview, or raise MYRA_INTELLIGENCE_REQUEST_CAP in the Myra .env file. Retry later.`,
        429
      );
    }
    session.requestsUsed = used + 1;
  }

  private remember(project: ImportedProject): void {
    this.pending.set(project.projectId, { project, expiresAt: Date.now() + PENDING_TTL_MS });
    if (this.pending.size > MAX_PENDING) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, value] of this.pending) {
        if (value.expiresAt < oldest) {
          oldest = value.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.pending.delete(oldestKey);
    }
  }

  private pendingProject(projectId: string): ImportedProject {
    const entry = this.pending.get(projectId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.pending.delete(projectId);
      throw new IntelligenceError(
        "projectFilesUnavailable",
        "The imported files are no longer in memory (the app may have restarted). Import the project again, then analyse it.",
        409
      );
    }
    // Every retry keeps the imported files alive; a failed analysis never
    // discards them.
    entry.expiresAt = Date.now() + PENDING_TTL_MS;
    return entry.project;
  }

  // --- import -------------------------------------------------------------

  async importLocal(folderPath: string): Promise<ImportedProjectView> {
    const project = await scanLocalProject(folderPath, {
      limits: this.limits,
      approvedRootsFile: this.options.approvedRootsFile,
      requireApproval: this.options.electronMode,
    });
    this.remember(project);
    console.log(
      `[intelligence] local import: ${project.stats.files} file(s), ${project.stats.redactions} redaction(s), ${project.stats.skipped} skipped`
    );
    return viewOf(project);
  }

  async importGitHub(url: string): Promise<ImportedProjectView> {
    const project = await fetchGitHubProject(url, { limits: this.limits });
    this.remember(project);
    console.log(
      `[intelligence] github import: ${project.stats.files} file(s), ${project.stats.redactions} redaction(s), ${project.stats.skipped} skipped`
    );
    return viewOf(project);
  }

  async analyze(projectId: string): Promise<ProjectKnowledge> {
    const model = this.requireModel();
    const existing = await this.store.getProject(projectId);
    if (!this.pending.has(projectId) && existing) return existing;

    const project = this.pendingProject(projectId);
    const knowledge = await buildKnowledge(project, model, { maxRequests: this.requestCap });
    await this.store.saveProject(knowledge);
    this.pending.delete(projectId);
    console.log(`[intelligence] analysis stored for ${knowledge.projectId} (${knowledge.name})`);
    return knowledge;
  }

  // --- projects -----------------------------------------------------------

  async listProjects() {
    return this.store.listProjects();
  }

  async getProject(projectId: string): Promise<ProjectKnowledge> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new IntelligenceError("projectNotFound", "That analysed project was not found.", 404);
    return project;
  }

  private async knowledgeFor(projectId: string): Promise<ProjectKnowledge> {
    return this.getProject(projectId);
  }

  // --- interviews ---------------------------------------------------------

  async createInterview(
    projectId: string,
    type: InterviewType,
    difficulty: Difficulty
  ): Promise<{ session: InterviewSession; question: InterviewSession["currentQuestion"] }> {
    const model = this.requireModel();
    const knowledge = await this.knowledgeFor(projectId);
    const session = newInterviewSession({ knowledge, type, difficulty });
    this.reserveInterviewRequest(session);
    const question = await generateNextQuestion(model, session, knowledge);
    if (!question) {
      throw new IntelligenceError("questionGenerationFailed", "The AI could not generate an opening question. Try again.", 502);
    }
    await this.store.saveInterview(session);
    return { session, question };
  }

  async getInterview(id: string): Promise<InterviewSession> {
    const session = await this.store.getInterview(id);
    if (!session) throw new IntelligenceError("interviewNotFound", "That interview was not found.", 404);
    return session;
  }

  async listInterviews(projectId?: string) {
    return this.store.listInterviews(projectId);
  }

  async answer(interviewId: string, answer: string) {
    const model = this.requireModel();
    const session = await this.getInterview(interviewId);
    const knowledge = await this.knowledgeFor(session.projectId);
    this.reserveInterviewRequest(session);
    const result = await submitAnswer(model, session, knowledge, answer);
    await this.store.saveInterview(result.session);
    return result;
  }

  async hint(interviewId: string): Promise<string[]> {
    const model = this.requireModel();
    const session = await this.getInterview(interviewId);
    const knowledge = await this.knowledgeFor(session.projectId);
    this.reserveInterviewRequest(session);
    const hints = await requestHint(model, session, knowledge);
    await this.store.saveInterview(session);
    return hints;
  }

  async explain(interviewId: string) {
    const model = this.requireModel();
    const session = await this.getInterview(interviewId);
    const knowledge = await this.knowledgeFor(session.projectId);
    this.reserveInterviewRequest(session);
    const explanation = await requestExplanation(model, session, knowledge);
    await this.store.saveInterview(session);
    return explanation;
  }

  async skip(interviewId: string) {
    const model = this.requireModel();
    const session = await this.getInterview(interviewId);
    const knowledge = await this.knowledgeFor(session.projectId);
    if (session.currentQuestion) this.reserveInterviewRequest(session);
    const question = await skipQuestion(model, session, knowledge);
    await this.store.saveInterview(session);
    return { session, question };
  }

  async showCode(interviewId: string) {
    const session = await this.getInterview(interviewId);
    const knowledge = await this.knowledgeFor(session.projectId);
    return codeForQuestion(session, knowledge);
  }

  async pause(interviewId: string): Promise<InterviewSession> {
    const session = await this.getInterview(interviewId);
    if (session.status === "ended") {
      throw new IntelligenceError("interviewEnded", "This interview has already ended.", 409);
    }
    session.status = "paused";
    session.updatedAt = new Date().toISOString();
    await this.store.saveInterview(session);
    return session;
  }

  async resume(interviewId: string): Promise<InterviewSession> {
    const model = this.requireModel();
    const session = await this.getInterview(interviewId);
    if (session.status === "ended") {
      throw new IntelligenceError("interviewEnded", "This interview has already ended.", 409);
    }
    session.status = "active";
    session.updatedAt = new Date().toISOString();

    // A paused interview resumed with no open question needs a fresh one.
    if (!session.currentQuestion) {
      const knowledge = await this.knowledgeFor(session.projectId);
      this.reserveInterviewRequest(session);
      await generateNextQuestion(model, session, knowledge);
    }
    await this.store.saveInterview(session);
    return session;
  }

  async endInterview(interviewId: string): Promise<{ session: InterviewSession; report: InterviewReport }> {
    const session = await this.getInterview(interviewId);

    if (session.reportId) {
      const existing = await this.store.getReport(session.reportId);
      if (existing) return { session, report: existing };
    }

    const model = this.requireModel();
    const knowledge = await this.knowledgeFor(session.projectId);
    this.reserveInterviewRequest(session);
    const report = await buildReport(model, session, knowledge);
    await this.store.saveReport(report);

    session.status = "ended";
    session.reportId = report.id;
    session.currentQuestion = null;
    session.updatedAt = new Date().toISOString();
    session.endedAt = session.updatedAt;
    await this.store.saveInterview(session);

    return { session, report };
  }

  async getReport(reportId: string): Promise<InterviewReport> {
    const report = await this.store.getReport(reportId);
    if (!report) throw new IntelligenceError("reportNotFound", "That report was not found.", 404);
    return report;
  }

  async getReportForInterview(interviewId: string): Promise<InterviewReport | null> {
    return this.store.getReportForInterview(interviewId);
  }

  // --- voice bridge (existing Gemini Live session) ------------------------

  /**
   * System-instruction addendum for an interview voice session. Loaded before
   * the existing AI session is created; returns null for an unusable id so the
   * normal assistant voice behaviour is never broken.
   *
   * The engine — not the live model — owns the question: if the session has no
   * open question, one is generated and stored before the voice session starts.
   */
  async voiceInstruction(interviewId: string): Promise<string | null> {
    try {
      const session = await this.store.getInterview(interviewId);
      if (!session || session.status === "ended") return null;
      const knowledge = await this.knowledgeFor(session.projectId);
      if (session.status === "paused") session.status = "active";
      if (!session.currentQuestion) {
        this.reserveInterviewRequest(session);
        await generateNextQuestion(this.requireModel(), session, knowledge);
        await this.store.saveInterview(session);
      }
      return buildVoiceInstruction(session);
    } catch (err) {
      console.warn(
        "[intelligence] interview voice context unavailable:",
        err instanceof Error ? err.message.slice(0, 160) : "unknown"
      );
      return null;
    }
  }

  /**
   * Evaluate a spoken answer with the SAME engine the text panel uses, then
   * return the engine-selected next question for the voice session to read.
   */
  async answerVoice(interviewId: string, answer: string) {
    const model = this.requireModel();
    const session = await this.getInterview(interviewId);
    const knowledge = await this.knowledgeFor(session.projectId);
    this.reserveInterviewRequest(session);
    const result = await submitAnswer(model, session, knowledge, answer, "voice");
    await this.store.saveInterview(result.session);
    return result;
  }

  /** Persist a transcript segment produced by the existing voice pipeline. */
  async recordTranscript(
    interviewId: string,
    role: "interviewer" | "candidate",
    text: string,
    source: "voice" | "text"
  ): Promise<void> {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 4000);
    if (!clean) return;
    try {
      const session = await this.store.getInterview(interviewId);
      if (!session || session.status === "ended") return;

      const last = session.turns[session.turns.length - 1];
      if (last && last.role === role && last.text.trim() === clean) return;

      session.turns.push({
        role,
        text: clean,
        at: new Date().toISOString(),
        source,
      });
      if (session.turns.length > MAX_TURNS) session.turns = session.turns.slice(-MAX_TURNS);
      session.updatedAt = new Date().toISOString();
      await this.store.saveInterview(session);
    } catch {
      // Transcript capture is best-effort; it must never break the voice call.
    }
  }
}
