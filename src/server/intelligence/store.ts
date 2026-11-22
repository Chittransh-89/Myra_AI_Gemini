/**
 * Myra AI — JSON persistence for projects, interview sessions and reports.
 *
 * Deliberately file-based: no new database or infrastructure. Layout:
 *   <dataDir>/projects/<projectId>.json
 *   <dataDir>/interviews/<interviewId>.json
 *   <dataDir>/reports/<reportId>.json
 *
 * Raw project file contents are NEVER stored — only the analysed knowledge
 * profile (which contains short, redacted code samples).
 */

import fs from "fs";
import path from "path";

import { IntelligenceError } from "./types.js";
import type {
  InterviewReport,
  InterviewSession,
  InterviewSummary,
  ProjectKnowledge,
  ProjectSummary,
} from "./types.js";

const ID_RX: Record<string, RegExp> = {
  proj: /^proj_[a-f0-9]{8,32}$/,
  itv: /^itv_[a-f0-9]{8,32}$/,
  rep: /^rep_[a-f0-9]{8,32}$/,
};

function assertId(kind: "proj" | "itv" | "rep", id: string): string {
  const value = String(id ?? "");
  if (!ID_RX[kind].test(value)) {
    throw new IntelligenceError("invalidId", "Invalid identifier.", 400);
  }
  return value;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await fs.promises.readFile(file, "utf8");
    return JSON.parse(text) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fs.promises.rename(temp, file);
}

async function listJson<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const value = await readJson<T>(path.join(dir, name));
    if (value) out.push(value);
  }
  return out;
}

export class IntelligenceStore {
  readonly root: string;
  /** Recently loaded interviews, so the voice server can read one synchronously. */
  private sessionCache = new Map<string, InterviewSession>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private projectFile(id: string) {
    return path.join(this.root, "projects", `${assertId("proj", id)}.json`);
  }

  private interviewFile(id: string) {
    return path.join(this.root, "interviews", `${assertId("itv", id)}.json`);
  }

  private reportFile(id: string) {
    return path.join(this.root, "reports", `${assertId("rep", id)}.json`);
  }

  async init(): Promise<void> {
    await Promise.all(
      ["projects", "interviews", "reports"].map((name) =>
        fs.promises.mkdir(path.join(this.root, name), { recursive: true })
      )
    );
  }

  // --- projects -----------------------------------------------------------

  async saveProject(knowledge: ProjectKnowledge): Promise<void> {
    await writeJson(this.projectFile(knowledge.projectId), knowledge);
  }

  async getProject(projectId: string): Promise<ProjectKnowledge | null> {
    return readJson<ProjectKnowledge>(this.projectFile(projectId));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await listJson<ProjectKnowledge>(path.join(this.root, "projects"));
    return projects
      .map((project) => ({
        projectId: project.projectId,
        name: project.name,
        sourceKind: project.source.kind,
        sourceLabel:
          project.source.kind === "github"
            ? project.source.repoUrl
            : project.source.root,
        analyzedAt: project.createdAt,
        stack: (project.stack ?? []).slice(0, 6),
        files: project.stats?.files ?? 0,
      }))
      .sort((a, b) => (a.analyzedAt < b.analyzedAt ? 1 : -1));
  }

  // --- interviews ---------------------------------------------------------

  async saveInterview(session: InterviewSession): Promise<void> {
    await writeJson(this.interviewFile(session.id), session);
    this.sessionCache.set(session.id, session);
  }

  async getInterview(id: string): Promise<InterviewSession | null> {
    const cached = this.sessionCache.get(id);
    if (cached) return cached;
    const session = await readJson<InterviewSession>(this.interviewFile(id));
    if (session) this.sessionCache.set(id, session);
    return session;
  }

  /** Synchronous cache read used when a voice session starts. */
  peekInterview(id: string): InterviewSession | null {
    try {
      assertId("itv", id);
    } catch {
      return null;
    }
    return this.sessionCache.get(id) ?? null;
  }

  async listInterviews(projectId?: string): Promise<InterviewSummary[]> {
    const sessions = await listJson<InterviewSession>(path.join(this.root, "interviews"));
    return sessions
      .filter((session) => !projectId || session.projectId === projectId)
      .map((session) => ({
        id: session.id,
        projectId: session.projectId,
        projectName: session.projectName,
        type: session.type,
        difficulty: session.difficulty,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        questionCount: session.questions.length,
        reportId: session.reportId,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  // --- reports ------------------------------------------------------------

  async saveReport(report: InterviewReport): Promise<void> {
    await writeJson(this.reportFile(report.id), report);
  }

  async getReport(reportId: string): Promise<InterviewReport | null> {
    return readJson<InterviewReport>(this.reportFile(reportId));
  }

  async getReportForInterview(interviewId: string): Promise<InterviewReport | null> {
    const reports = await listJson<InterviewReport>(path.join(this.root, "reports"));
    return reports.find((report) => report.interviewId === interviewId) ?? null;
  }
}
