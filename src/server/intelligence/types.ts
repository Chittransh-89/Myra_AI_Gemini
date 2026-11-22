/**
 * Myra AI — Project Intelligence + Interview Mode types.
 *
 * Everything here is provider-agnostic and JSON-serialisable: analyses,
 * interviews and reports are persisted as JSON files, so no class instances or
 * buffers ever reach storage.
 */

export type ProjectSource =
  | { kind: "local"; root: string; name: string }
  | {
      kind: "github";
      repoUrl: string;
      owner: string;
      repo: string;
      branch: string;
      treeSha?: string;
    };

/** Where a technical claim in the knowledge profile came from. */
export interface EvidenceRef {
  file: string;
  symbol?: string;
  lines?: string;
  note?: string;
}

export type Confidence = "confirmed" | "inferred" | "unknown";

export interface DesignDecision {
  decision: string;
  rationale?: string;
  evidence: EvidenceRef[];
  confidence: Confidence;
}

export interface CodeSnippet {
  file: string;
  kind: string;
  name: string;
  startLine: number;
  snippet: string;
}

/** Written together with the last analysis run, before any AI call. */
export interface ImportedProject {
  projectId: string;
  name: string;
  source: ProjectSource;
  /** Relative POSIX paths only — never absolute paths from the scan. */
  files: ProjectFile[];
  tree: ProjectNode[];
  warnings: string[];
  skipped: { path: string; reason: string }[];
  stats: ProjectStats;
  importedAt: string;
}

export interface ProjectFile {
  path: string;
  text: string;
  bytes: number;
  lines: number;
  redactions: number;
  truncated: boolean;
}

export interface ProjectNode {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface ProjectStats {
  files: number;
  bytes: number;
  chars: number;
  redactions: number;
  skipped: number;
}

/** The reusable knowledge profile produced by Phase 2. */
export interface ProjectKnowledge {
  version: 1;
  projectId: string;
  name: string;
  source: ProjectSource;
  purpose: string;
  problem: string;
  stack: string[];
  frontend: string[];
  backend: string[];
  entryPoints: EvidenceRef[];
  modules: { name: string; path: string; role: string }[];
  apiEndpoints: { method?: string; path: string; file: string }[];
  dataModels: { name: string; file: string; note: string }[];
  auth: string[];
  dataFlow: string[];
  aiIntegration: string[];
  keyFunctions: EvidenceRef[];
  externalServices: string[];
  dependencies: { name: string; role: string }[];
  designDecisions: DesignDecision[];
  limitations: string[];
  unknowns: string[];
  codeSamples: CodeSnippet[];
  stats: ProjectStats;
  warnings: string[];
  model: string;
  createdAt: string;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  sourceKind: "local" | "github";
  sourceLabel: string;
  analyzedAt: string;
  stack: string[];
  files: number;
}

// ---------------------------------------------------------------------------
// Interview
// ---------------------------------------------------------------------------

export type InterviewType =
  | "overview"
  | "deep_dive"
  | "code"
  | "architecture"
  | "debugging"
  | "full";

export type Difficulty = "easy" | "medium" | "hard" | "brutal";

export type InterviewStage =
  | "project_understanding"
  | "technical_deep_dive"
  | "design_tradeoffs"
  | "code_level"
  | "debugging"
  | "cross_questioning";

export type InterviewStatus = "active" | "paused" | "ended";

export interface InterviewQuestion {
  id: string;
  text: string;
  stage: InterviewStage;
  focus: string;
  difficulty: Difficulty;
  expectedPoints: string[];
  evidence: EvidenceRef[];
  askedAt: string;
}

export interface InterviewTurn {
  role: "interviewer" | "candidate";
  text: string;
  at: string;
  questionId?: string;
  source: "text" | "voice";
}

export type AnswerCorrectness = "solid" | "partial" | "vague" | "incorrect";

export interface AnswerAssessment {
  correctness: AnswerCorrectness;
  score: number;
  missing: string[];
  misconceptions: string[];
  needsFollowUp: boolean;
  note: string;
}

export interface InterviewSession {
  version: 1;
  id: string;
  projectId: string;
  projectName: string;
  type: InterviewType;
  difficulty: Difficulty;
  status: InterviewStatus;
  stage: InterviewStage;
  stagePlan: InterviewStage[];
  stageIndex: number;
  currentQuestion: InterviewQuestion | null;
  questions: InterviewQuestion[];
  turns: InterviewTurn[];
  assessments: { questionId: string; assessment: AnswerAssessment }[];
  hintsUsed: number;
  skips: number;
  reportId: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface InterviewReport {
  version: 1;
  id: string;
  interviewId: string;
  projectId: string;
  projectName: string;
  type: InterviewType;
  difficulty: Difficulty;
  createdAt: string;
  questions: { question: string; answerSummary: string; stage: InterviewStage }[];
  overallScore: number;
  scores: {
    technicalKnowledge: number;
    codeUnderstanding: number;
    architectureUnderstanding: number;
    reasoning: number;
    communicationClarity: number;
  };
  verdict:
    | "strong_understanding"
    | "architecture_only"
    | "memorized"
    | "serious_gaps";
  summary: string;
  weakAreas: string[];
  incorrectAssumptions: string[];
  topicsToRevise: string[];
  followUpTopics: string[];
  revisionPlan: string[];
}

export interface InterviewSummary {
  id: string;
  projectId: string;
  projectName: string;
  type: InterviewType;
  difficulty: Difficulty;
  status: InterviewStatus;
  createdAt: string;
  updatedAt: string;
  questionCount: number;
  reportId: string | null;
}

/** A recoverable, user-facing failure. */
export class IntelligenceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "IntelligenceError";
    this.code = code;
    this.status = status;
  }
}
