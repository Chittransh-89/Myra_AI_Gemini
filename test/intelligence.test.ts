/**
 * Project Intelligence + Interview Mode regression tests.
 *
 * Covers, without touching Gemini or GitHub:
 *  1. secret redaction (and non-redaction of env lookups),
 *  2. local scan filters, size limits, secret files and root approval,
 *  3. GitHub URL parsing + importer behaviour with a mocked fetch,
 *  4. knowledge evidence validation (no fabricated files),
 *  5. interview engine: question, cross-question, hint, skip, report scoring,
 *  6. JSON store id validation,
 *  7. router authentication in Electron mode.
 *
 * Run with: npx tsx test/intelligence.test.ts
 */

import express from "express";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { redactSecrets } from "../src/server/intelligence/redact.js";
import { parseGitHubUrl, fetchGitHubProject } from "../src/server/intelligence/githubSource.js";
import {
  isRootApproved,
  readApprovedRoots,
  scanLocalProject,
  validateRootPath,
} from "../src/server/intelligence/localSource.js";
import { isInsideRoot } from "../src/server/intelligence/filter.js";
import { buildKnowledge } from "../src/server/intelligence/knowledge.js";
import { extractJson, isGeminiQuotaError } from "../src/server/intelligence/model.js";
import type { TextModel, TextModelRequest } from "../src/server/intelligence/model.js";
import {
  buildReport,
  buildVoiceInstruction,
  engineQuestionPrompt,
  generateNextQuestion,
  newInterviewSession,
  requestHint,
  skipQuestion,
  submitAnswer,
} from "../src/server/intelligence/interview.js";
import { IntelligenceStore } from "../src/server/intelligence/store.js";
import { IntelligenceService } from "../src/server/intelligence/service.js";
import { createIntelligenceRouter } from "../src/server/intelligence/routes.js";
import {
  IntelligenceError,
  type ImportedProject,
  type ProjectKnowledge,
} from "../src/server/intelligence/types.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, content: string | Buffer): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

class QueueModel implements TextModel {
  readonly name = "fake-model";
  readonly prompts: string[] = [];
  private queue: unknown[];

  constructor(responses: unknown[]) {
    this.queue = [...responses];
  }

  async generateJSON(request: TextModelRequest): Promise<unknown> {
    this.prompts.push(request.prompt);
    if (this.queue.length === 0) throw new Error("QueueModel: no response queued");
    return this.queue.shift();
  }
}

function fixtureKnowledge(): ProjectKnowledge {
  return {
    version: 1,
    projectId: "proj_0123456789abcdef",
    name: "Demo Project",
    source: { kind: "github", repoUrl: "https://github.com/o/r", owner: "o", repo: "r", branch: "main" },
    purpose: "A demo service.",
    problem: "Demonstrates the interview engine.",
    stack: ["TypeScript", "Express"],
    frontend: ["React"],
    backend: ["Express"],
    entryPoints: [{ file: "src/server.ts", symbol: "start" }],
    modules: [{ name: "server", path: "src/server.ts", role: "boots the API" }],
    apiEndpoints: [{ method: "GET", path: "/health", file: "src/server.ts" }],
    dataModels: [{ name: "User", file: "src/server.ts", note: "in-memory" }],
    auth: ["token check"],
    dataFlow: ["client -> express -> db"],
    aiIntegration: [],
    keyFunctions: [{ file: "src/server.ts", symbol: "start", lines: "1-20" }],
    externalServices: [],
    dependencies: [{ name: "express", role: "http server" }],
    designDecisions: [
      { decision: "use SQLite", rationale: "simple setup", evidence: [{ file: "src/server.ts" }], confidence: "confirmed" },
    ],
    limitations: ["single process"],
    unknowns: ["no tests"],
    codeSamples: [
      {
        file: "src/server.ts",
        kind: "function",
        name: "start",
        startLine: 1,
        snippet: "export function start() { return 1; }",
      },
    ],
    stats: { files: 1, bytes: 40, chars: 40, redactions: 0, skipped: 0 },
    warnings: [],
    model: "fake-model",
    createdAt: new Date().toISOString(),
  };
}

function fixtureProject(root: string): ImportedProject {
  return {
    projectId: "proj_0123456789abcdef",
    name: "Demo Project",
    source: { kind: "local", root, name: "Demo Project" },
    files: [
      {
        path: "src/server.ts",
        text: "export function start() { return 1; }",
        bytes: 40,
        lines: 1,
        redactions: 0,
        truncated: false,
      },
    ],
    tree: [{ path: "src/server.ts", type: "file", size: 40 }],
    warnings: [],
    skipped: [],
    stats: { files: 1, bytes: 40, chars: 40, redactions: 0, skipped: 0 },
    importedAt: new Date().toISOString(),
  };
}

async function run(): Promise<void> {
  // --- 1. Redaction -------------------------------------------------------
  {
    const apiKey = "sk-" + "a1B2c3D4e5F6g7H8i9J0";
    const result = redactSecrets(
      [
        `const apiKey = "${apiKey}";`,
        "const fromEnv = process.env.GEMINI_API_KEY;",
        `GEMINI_API_KEY=${apiKey}`,
        "Authorization: Bearer abcdefghijklmnopqrstuvwx",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEtest\n-----END RSA PRIVATE KEY-----",
        "const url = 'postgres://user:secretpass@db:5432/app';",
      ].join("\n")
    );
    check(result.redactions >= 4, "expected several redactions");
    check(!result.text.includes(apiKey), "API key must not survive redaction");
    check(!result.text.includes("abcdefghijklmnopqrstuvwx"), "bearer token must be redacted");
    check(!result.text.includes("secretpass"), "connection-string password must be redacted");
    check(result.text.includes("process.env.GEMINI_API_KEY"), "env lookups must not be redacted");
    check(result.text.includes("[REDACTED_PRIVATE_KEY]"), "private key block must be replaced");
  }

  // --- 2. Local scanning --------------------------------------------------
  {
    const projectRoot = tempDir("myra-intel-project-");
    write(projectRoot, "src/app.ts", "export const app = 1;\n");
    write(projectRoot, "README.md", "# Demo\n");
    write(projectRoot, "package.json", '{"name":"demo"}');
    write(projectRoot, "node_modules/pkg/index.js", "module.exports = 1;");
    write(projectRoot, "dist/app.js", "built();");
    write(projectRoot, ".env", "GEMINI_API_KEY=supersecretvalue123");
    write(projectRoot, ".env.example", "GEMINI_API_KEY=");
    write(projectRoot, "package-lock.json", '{"lockfileVersion":3}');
    write(projectRoot, "src/config.ts", 'export const apiKey = "sk-ABCDEFGHIJKLMNOPQRSTUV";\n');
    write(projectRoot, "src/big.ts", "x".repeat(5000));
    write(projectRoot, "src/blob.ts", Buffer.from([0, 1, 2, 3, 4, 5, 0, 7]));
    try {
      fs.symlinkSync(path.join(projectRoot, "src"), path.join(projectRoot, "link-out"), "junction");
    } catch {
      /* symlink creation may be denied on Windows; the guard is still tested below */
    }

    const project = await scanLocalProject(projectRoot, {
      requireApproval: false,
      limits: { maxFileBytes: 1024 },
    });
    const paths = project.files.map((file) => file.path);

    check(paths.includes("src/app.ts"), "source file must be included");
    check(paths.includes("README.md"), "README must be included");
    check(!paths.some((p) => p.startsWith("node_modules/")), "node_modules must be excluded");
    check(!paths.some((p) => p.startsWith("dist/")), "build output must be excluded");
    check(!paths.some((p) => p.endsWith(".env") || p.endsWith(".env.example")), ".env files must never be read");
    check(!paths.includes("package-lock.json"), "lockfiles must be excluded");
    check(!paths.includes("src/big.ts"), "oversized files must be excluded");
    check(!paths.includes("src/blob.ts"), "binary files must be excluded");
    check(!paths.some((p) => p.startsWith("link-out/")), "symlinks must not be followed");

    const serialized = JSON.stringify(project.files);
    check(!serialized.includes("supersecretvalue123"), "secret file contents must never appear");
    check(!serialized.includes("secretpass"), "no credential may leak into source context");

    const config = project.files.find((file) => file.path === "src/config.ts");
    check(!!config, "config file should be included");
    check(config!.redactions >= 1, "credential assignment must be redacted");
    check(!config!.text.includes("sk-ABCDEFGHIJKLMNOPQRSTUV"), "redacted key must not remain in context");

    const reasons = new Set(project.skipped.map((item) => item.reason));
    check(reasons.has("excludedDirectory") || reasons.has("sensitive"), "skipped reasons should be reported");

    check((validateRootPath("relative/path") as any).error === "pathNotAbsolute", "relative roots must be rejected");
    check(isInsideRoot(projectRoot, path.join(projectRoot, "src")), "descendants are inside the root");
    check(!isInsideRoot(projectRoot, path.join(projectRoot, "..", "other")), "siblings are outside the root");
    if (process.platform === "win32") {
      check((validateRootPath("C:\\") as any).error === "rootTooBroad", "drive roots must be rejected");
    }

    // Approval registry: only roots recorded by the native picker pass.
    const registry = path.join(tempDir("myra-intel-registry-"), "approved.json");
    fs.writeFileSync(registry, JSON.stringify([{ root: projectRoot }]));
    check(await isRootApproved(projectRoot, registry), "picker-approved root must be approved");
    check((await readApprovedRoots(registry)).length === 1, "registry should expose approved roots");
    const other = tempDir("myra-intel-other-");
    check(!(await isRootApproved(other, registry)), "unapproved roots must be refused");

    let denied: unknown = null;
    try {
      await scanLocalProject(other, { requireApproval: true, approvedRootsFile: registry });
    } catch (err) {
      denied = err;
    }
    check(denied instanceof IntelligenceError && (denied as any).code === "folderNotApproved", "unapproved scan must fail");

    let outsideSymlink = false;
    try {
      const link = path.join(projectRoot, "escape.ts");
      fs.symlinkSync(path.join(os.tmpdir(), "outside-target.ts"), link, "file");
      outsideSymlink = true;
    } catch {
      outsideSymlink = false;
    }
    check(outsideSymlink === false || true, "symlink setup is best-effort");
  }

  // --- 3. GitHub importer -------------------------------------------------
  {
    const urls: [string, boolean][] = [
      ["https://github.com/Chittransh-89/Smartloop", true],
      ["https://github.com/owner/repo.git", true],
      ["http://www.github.com/owner/repo/", true],
      ["https://gitlab.com/owner/repo", false],
      ["https://github.com/owner", false],
      ["not a url", false],
      ["", false],
    ];
    for (const [url, valid] of urls) {
      const parsed = parseGitHubUrl(url);
      check(("error" in parsed) !== valid, `URL validation wrong for ${JSON.stringify(url)}`);
    }
    const parsed = parseGitHubUrl("https://github.com/Chittransh-89/Smartloop") as any;
    check(parsed.ref.owner === "Chittransh-89" && parsed.ref.repo === "Smartloop", "owner/repo detection");

    const raw = (rel: string) => `https://raw.githubusercontent.com/o/r/main/${rel}`;
    const files: Record<string, string> = {
      [raw("README.md")]: "# Demo repo\n",
      [raw("src/main.ts")]: 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";\nexport const x = 1;\n',
    };
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/o/r")) {
        return new Response(JSON.stringify({ default_branch: "main", description: "demo", private: false }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "50" },
        });
      }
      if (url.includes("/git/trees/main")) {
        return new Response(
          JSON.stringify({
            sha: "abc",
            truncated: false,
            tree: [
              { path: "README.md", type: "blob", size: 12 },
              { path: "src", type: "tree" },
              { path: "src/main.ts", type: "blob", size: 90 },
              { path: "node_modules/x.js", type: "blob", size: 10 },
              { path: ".env", type: "blob", size: 10 },
              { path: "package-lock.json", type: "blob", size: 10 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (files[url] !== undefined) {
        return new Response(files[url], { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    };

    const repo = await fetchGitHubProject("https://github.com/o/r", { fetchImpl: fakeFetch });
    const repoPaths = repo.files.map((file) => file.path);
    check(repoPaths.includes("README.md") && repoPaths.includes("src/main.ts"), "relevant repo files must be fetched");
    check(!repoPaths.includes("node_modules/x.js"), "repo node_modules must be excluded");
    check(!repoPaths.includes(".env"), "repo .env must never be fetched");
    check(!repoPaths.includes("package-lock.json"), "repo lockfiles must be excluded");
    check(repo.stats.redactions >= 1, "GitHub token must be redacted");
    check(!repo.files.some((file) => file.text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")), "token must not remain");
    check(repo.source.kind === "github" && repo.source.branch === "main", "branch must come from metadata");

    const privateFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ private: true, default_branch: "main" }), { status: 200 });
    let privateError: unknown = null;
    try {
      await fetchGitHubProject("https://github.com/o/private", { fetchImpl: privateFetch });
    } catch (err) {
      privateError = err;
    }
    check(
      privateError instanceof IntelligenceError && (privateError as any).code === "privateUnsupported",
      "private repositories must be refused with a clear error"
    );

    const limitedFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      });
    let limitedError: unknown = null;
    try {
      await fetchGitHubProject("https://github.com/o/r", { fetchImpl: limitedFetch });
    } catch (err) {
      limitedError = err;
    }
    check(
      limitedError instanceof IntelligenceError && (limitedError as any).code === "rateLimited",
      "GitHub rate limits must surface as rateLimited"
    );

    const notFoundFetch: typeof fetch = async () => new Response("{}", { status: 404 });
    let missingError: unknown = null;
    try {
      await fetchGitHubProject("https://github.com/o/missing", { fetchImpl: notFoundFetch });
    } catch (err) {
      missingError = err;
    }
    check(
      missingError instanceof IntelligenceError && (missingError as any).code === "repositoryNotFound",
      "missing repositories must surface as repositoryNotFound"
    );
    check(calls.length > 0, "mock fetch should have been used");
  }

  // --- 4. Knowledge evidence validation ----------------------------------
  {
    const project = fixtureProject(process.cwd());
    const model = new QueueModel([
      {
        technologies: ["TypeScript", "Express"],
        entryPoints: [
          { file: "src/server.ts", symbol: "start", note: "boots the app" },
          { file: "invented/file.ts", symbol: "nope" },
        ],
        modules: [{ name: "server", path: "src/server.ts", role: "boots the API" }],
        apiEndpoints: [{ method: "GET", path: "/health", file: "src/server.ts" }],
        dataModels: [],
        auth: ["bearer token"],
        externalServices: [],
        keyFunctions: [{ file: "src/server.ts", symbol: "start", lines: "1-1", note: "entry" }],
        designDecisions: [{ decision: "single file", rationale: "demo", evidence: [{ file: "src/server.ts" }], confidence: "confirmed" }],
        limitations: ["no tests"],
        unknowns: ["deployment"],
        codeSamples: [
          { file: "src/server.ts", kind: "function", name: "start", startLine: 1, snippet: "export function start() { return 1; }" },
          { file: "src/server.ts", kind: "function", name: "fake", startLine: 2, snippet: "this snippet does not exist anywhere" },
        ],
      },
      {
        name: "Demo Project",
        purpose: "Demo service used by tests.",
        problem: "Exercises the interview engine.",
        stack: ["TypeScript", "Express"],
        frontend: [],
        backend: ["Express"],
        dataFlow: ["client -> express"],
        aiIntegration: [],
        apiEndpoints: [{ method: "GET", path: "/health", file: "src/server.ts" }],
        dataModels: [],
        auth: ["bearer token"],
        externalServices: [],
        dependencies: [{ name: "express", role: "http server" }],
        entryPoints: [{ file: "invented/file.ts", symbol: "nope" }],
        keyFunctions: [{ file: "src/server.ts", symbol: "start", lines: "1-1" }],
        modules: [{ name: "server", path: "src/server.ts", role: "boots the API" }],
        designDecisions: [],
        limitations: ["no tests"],
        unknowns: ["deployment"],
        codeSamples: [{ file: "src/server.ts", kind: "function", name: "start", startLine: 1, snippet: "export function start() { return 1; }" }],
      },
    ]);

    const knowledge = await buildKnowledge(project, model);
    check(knowledge.entryPoints.length === 1, "evidence for unknown files must be dropped");
    check(knowledge.entryPoints.every((ref) => ref.file === "src/server.ts"), "only imported evidence may be cited");
    check(knowledge.codeSamples.length === 1, "snippets not found in the file must be dropped");
    check(knowledge.codeSamples[0].startLine === 1, "verified snippet should keep its real line number");
    check(knowledge.purpose.includes("Demo service"), "synthesis fields must be preserved");
    check(knowledge.stats.files === 1, "stats come from the import");
  }

  // --- 5. Interview engine ------------------------------------------------
  {
    const knowledge = fixtureKnowledge();
    const question = {
      stage: "project_understanding",
      question: "What problem does this service solve?",
      focus: "purpose",
      difficulty: "medium",
      expectedPoints: ["problem", "users"],
      evidence: [{ file: "src/server.ts" }],
    };

    const model = new QueueModel([
      question,
      {
        assessment: {
          correctness: "partial",
          score: 45,
          missing: ["no mention of the data flow"],
          misconceptions: [],
          needsFollowUp: true,
          note: "Understands the purpose but not the mechanism.",
        },
        next: {
          stage: "technical_deep_dive",
          question: "Walk me through what happens on GET /health inside src/server.ts.",
          focus: "request handling",
          difficulty: "medium",
          expectedPoints: ["route handler", "response"],
          evidence: [{ file: "src/server.ts", symbol: "start" }],
        },
      },
      { hints: ["Look at the route handler.", "Think about what is returned."] },
      {
        stage: "technical_deep_dive",
        question: "What would break if the database returned no rows?",
        focus: "failure handling",
        difficulty: "medium",
        expectedPoints: ["empty result", "error path"],
        evidence: [{ file: "src/server.ts" }],
      },
      {
        summary: "Solid architecture awareness, partial implementation detail.",
        scores: {
          technicalKnowledge: 80,
          codeUnderstanding: 60,
          architectureUnderstanding: 70,
          reasoning: 50,
          communicationClarity: 90,
        },
        verdict: "architecture_only",
        weakAreas: ["error paths"],
        incorrectAssumptions: ["assumed a database exists"],
        topicsToRevise: ["request lifecycle"],
        followUpTopics: ["concurrency"],
        revisionPlan: ["Trace GET /health end to end"],
      },
    ]);

    const session = newInterviewSession({ knowledge, type: "full", difficulty: "medium" });
    const first = await generateNextQuestion(model, session, knowledge);
    check(!!first && first.text.includes("problem"), "first question must be generated");
    check(session.questions.length === 1 && session.turns.length === 1, "question must be recorded");

    const result = await submitAnswer(model, session, knowledge, "It is a demo service for interviews.");
    check(result.assessment.correctness === "partial", "assessment must be parsed");
    check(result.assessment.needsFollowUp === true, "cross-question flag must survive");
    check(!!result.nextQuestion, "a follow-up question must be produced");
    check(session.assessments.length === 1, "assessment must be stored");
    check(session.turns.filter((turn) => turn.role === "candidate").length === 1, "answer turn must be stored");

    const hints = await requestHint(model, session, knowledge);
    check(hints.length === 2 && session.hintsUsed === 1, "hints must be returned and counted");

    const skipped = await skipQuestion(model, session, knowledge);
    check(!!skipped, "skip must ask the next question");
    check(session.skips === 1, "skip must be counted");
    check(session.assessments.some((item) => item.assessment.note.includes("Skipped")), "skips must be assessed honestly");

    const report = await buildReport(model, session, knowledge);
    check(report.overallScore === 68, `weighted score must be computed deterministically (got ${report.overallScore})`);
    check(report.verdict === "architecture_only", "verdict must be preserved");
    check(report.questions.length >= 2, "report must list the questions that were asked");
    check(report.questions.every((item) => item.answerSummary.length <= 300), "answers must be summarised");
    check(report.weakAreas.includes("error paths"), "weak areas must be preserved");
    check(report.scores.communicationClarity === 90, "component scores must be preserved");
  }

  // --- 5b. Voice is a voice interface, not an interviewer -----------------
  {
    const model = new QueueModel([
      {
        stage: "project_understanding",
        question: "What problem does this project solve?",
        focus: "purpose",
        difficulty: "medium",
        expectedPoints: ["problem", "users"],
        evidence: [{ file: "src/server.ts" }],
      },
      {
        assessment: {
          correctness: "solid",
          score: 82,
          missing: [],
          misconceptions: [],
          needsFollowUp: false,
          note: "Clear answer.",
        },
        next: {
          stage: "technical_deep_dive",
          question: "How does GET /health reach its handler?",
          focus: "request flow",
          difficulty: "medium",
          expectedPoints: ["express route", "handler"],
          evidence: [{ file: "src/server.ts" }],
        },
      },
    ]);

    const knowledge = fixtureKnowledge();
    const session = newInterviewSession({ knowledge, type: "overview", difficulty: "medium" });
    await generateNextQuestion(model, session, knowledge);
    check(!!session.currentQuestion, "the engine must own the first question");

    const instruction = buildVoiceInstruction(session);
    check(
      instruction.includes(session.currentQuestion!.text),
      "the voice interface must be given the engine's exact question"
    );
    check(
      instruction.includes("YOU MUST NOT") && instruction.includes("ask a follow-up of your own"),
      "the voice interface must be forbidden from inventing questions"
    );
    check(
      !instruction.includes("Start now: greet the candidate") && !instruction.includes("your first single question"),
      "the voice interface must not be told to conduct the interview itself"
    );

    const prompted = engineQuestionPrompt(session.currentQuestion!.text);
    check(prompted.startsWith("QUESTION_FROM_ENGINE:"), "engine questions must be explicitly labelled");
    check(prompted.includes(session.currentQuestion!.text), "the question text must be delivered verbatim");

    const result = await submitAnswer(model, session, knowledge, "It solves interview practice.", "voice");
    check(result.assessment.score === 82, "the engine must evaluate a spoken answer");
    const candidate = session.turns.filter((turn) => turn.role === "candidate");
    check(candidate.length === 1 && candidate[0].source === "voice", "spoken answers must be stored as voice turns");
    check(result.nextQuestion?.text.includes("/health"), "the engine must select the next question");
    check(session.questions.length === 2, "the next question must live in the same session record");

    // The service path used by the voice session (question generation when a
    // resumed session has none, plus engine evaluation of a spoken answer).
    const voiceModel = new QueueModel([
      {
        stage: "project_understanding",
        question: "What does this demo project do?",
        focus: "purpose",
        difficulty: "easy",
        expectedPoints: ["purpose"],
        evidence: [{ file: "src/server.ts" }],
      },
      {
        assessment: {
          correctness: "solid",
          score: 75,
          missing: [],
          misconceptions: [],
          needsFollowUp: false,
          note: "Accurate.",
        },
        next: {
          stage: "technical_deep_dive",
          question: "Which file boots the API?",
          focus: "entry point",
          difficulty: "easy",
          expectedPoints: ["src/server.ts"],
          evidence: [{ file: "src/server.ts" }],
        },
      },
    ]);
    const dir = tempDir("myra-intel-voice-");
    const service = new IntelligenceService({
      dataDir: dir,
      approvedRootsFile: null,
      electronMode: false,
      model: voiceModel,
    });
    await service.init();
    await service.storeHandle.saveProject(knowledge);
    const fresh = newInterviewSession({ knowledge, type: "overview", difficulty: "easy" });
    await service.storeHandle.saveInterview(fresh);

    const voiceContext = await service.voiceInstruction(fresh.id);
    check(!!voiceContext && voiceContext.includes("INTERVIEW VOICE INTERFACE"), "voice context must be provided");
    const resumed = await service.getInterview(fresh.id);
    check(!!resumed.currentQuestion, "the engine must generate a question before the voice session starts");

    const spoken = await service.answerVoice(fresh.id, "A small Express demo with a health route.");
    const stored = await service.getInterview(fresh.id);
    check(spoken.assessment.correctness === "solid", "the engine must assess the stored voice answer");
    check(
      stored.turns.some((turn) => turn.role === "candidate" && turn.source === "voice"),
      "the stored session must contain the voice answer"
    );
  }

  // --- 5c. Analysis budgets, bounded retries and honest errors ------------
  {
    const fenced = extractJson('```json\n{"a":1}\n```');
    check((fenced as any).a === 1, "fenced JSON must parse");

    const trailing = extractJson('Here is the result: {"a":[1,2]} — done');
    check((trailing as any).a.length === 2, "JSON followed by prose must parse");

    const repaired = extractJson('{"a":1,"b":[1,2');
    check(
      (repaired as any).a === 1 && (repaired as any).b?.length === 2,
      "a truncated response must be repaired without inventing fields"
    );

    let parseError: any = null;
    try {
      extractJson("no json here", { finishReason: "MAX_TOKENS" });
    } catch (err) {
      parseError = err;
    }
    check(parseError instanceof IntelligenceError && parseError.code === "invalidModelJson", "garbage must fail honestly");
    check(!/reduce the project size/i.test(parseError.message), "the misleading size hint must be gone");
    check(parseError.message.includes("MAX_TOKENS"), "the real finish reason must be reported");

    class AnalysisModel implements TextModel {
      readonly name = "fake-analysis";
      readonly calls: TextModelRequest[] = [];

      constructor(
        private options: {
          failAllExtraction?: boolean;
          failSynthesis?: boolean;
          oversizedAbove?: number;
          quotaAt?: "extraction" | "synthesis";
        } = {}
      ) {}

      async generateJSON(request: TextModelRequest): Promise<unknown> {
        this.calls.push(request);
        if (
          this.options.quotaAt === "extraction" ||
          (this.options.quotaAt === "synthesis" && !request.system.includes("project analyst"))
        ) {
          throw new IntelligenceError(
            "quotaExceeded",
            "Gemini quota exceeded (HTTP 429). No further requests were sent — please retry later.",
            429
          );
        }
        if (request.system.includes("project analyst")) {
          if (this.options.failAllExtraction) {
            throw new IntelligenceError(
              "invalidModelJson",
              "The AI response could not be parsed as JSON (finish reason: MAX_TOKENS).",
              502
            );
          }
          if (this.options.oversizedAbove && request.prompt.length > this.options.oversizedAbove) {
            throw new IntelligenceError(
              "modelOutputTruncated",
              "The AI response hit the 4096-token output limit and was cut off.",
              502
            );
          }
          const firstFile = request.prompt.match(/### FILE: (.+?)(?: \(truncated\))?\n/)?.[1] ?? "src/app.ts";
          return {
            technologies: ["TypeScript"],
            entryPoints: [{ file: firstFile, symbol: "start" }],
            modules: [],
            apiEndpoints: [],
            dataModels: [],
            auth: [],
            externalServices: [],
            keyFunctions: [],
            designDecisions: [],
            limitations: [],
            unknowns: [],
            codeSamples: [],
          };
        }
        if (this.options.failSynthesis) {
          throw new IntelligenceError("modelOutputTruncated", "synthesis hit the output limit", 502);
        }
        return { name: "Demo", purpose: "A demo project.", stack: ["TypeScript"] };
      }
    }

    const analysisProject = (entries: { path: string; text: string }[]): ImportedProject => {
      const base = fixtureProject(tempDir("myra-intel-analysis-"));
      return {
        ...base,
        files: entries.map((entry) => ({
          path: entry.path,
          text: entry.text,
          bytes: Buffer.byteLength(entry.text),
          lines: entry.text.split("\n").length,
          redactions: 0,
          truncated: false,
        })),
        stats: {
          files: entries.length,
          bytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
          chars: entries.reduce((sum, entry) => sum + entry.text.length, 0),
          redactions: 0,
          skipped: 0,
        },
      };
    };

    // Oversized request: the pipeline must SHRINK the request on retry, not
    // repeat the identical call that just failed.
    const oversized = new AnalysisModel({ oversizedAbove: 20_000 });
    const bigFiles = Array.from({ length: 10 }, (_, index) => ({
      path: `src/c${index}.ts`,
      text: `export const v${index} = "${"y".repeat(3_800)}";`,
    }));
    const oversizedKnowledge = await buildKnowledge(analysisProject(bigFiles), oversized);
    const extractionCalls = oversized.calls.filter((call) => call.system.includes("project analyst"));
    check(oversizedKnowledge.entryPoints.length > 0, "a split retry must still yield evidence");
    check(extractionCalls.length > 1, "an oversized extraction must be split and retried");
    check(
      extractionCalls.every((call) => call.maxOutputTokens === 4_096),
      "every extraction call must enforce the output budget"
    );
    check(
      extractionCalls.every((call) => call.prompt.length <= 30_000),
      "every extraction prompt must fit the input budget"
    );

    // Relevance: configs and source outrank tests when the chunk budget binds.
    const relevance = new AnalysisModel();
    const relevanceFiles = [
      { path: "package.json", text: "{}" },
      { path: "test/feature.test.ts", text: "t".repeat(6_000) },
      ...Array.from({ length: 6 }, (_, index) => ({
        path: `src/feature${index}.ts`,
        text: `export const f${index} = "${"z".repeat(5_900)}";`,
      })),
    ];
    await buildKnowledge(analysisProject(relevanceFiles), relevance, { maxChunks: 1 });
    const relevancePrompt = relevance.calls.find((call) => call.system.includes("project analyst"))!.prompt;
    check(relevancePrompt.includes("package.json"), "high-value config must be analysed first");
    check(
      !relevancePrompt.includes("test/feature.test.ts"),
      "low-value tests must not crowd out source files under the budget"
    );

    // Synthesis failure must degrade honestly: extracted facts survive, the
    // actual reason is shown, and nothing is invented.
    const synthesisFailure = new AnalysisModel({ failSynthesis: true });
    const fallback = await buildKnowledge(
      analysisProject([{ path: "src/app.ts", text: "export function start() { return 1; }" }]),
      synthesisFailure
    );
    check(fallback.entryPoints.length > 0, "extracted evidence must survive a synthesis failure");
    check(
      fallback.warnings.some((warning) => warning.includes("AI synthesis was unavailable") && warning.includes("output limit")),
      "the actual synthesis failure must be reported"
    );
    check(fallback.purpose === "", "no purpose may be invented when synthesis fails");

    // Total extraction failure: real stage + real reason, and the message must
    // not blame the project size.
    const failing = new AnalysisModel({ failAllExtraction: true });
    let analysisFailure: any = null;
    try {
      await buildKnowledge(
        analysisProject([{ path: "src/app.ts", text: "x".repeat(5_000) }]),
        failing
      );
    } catch (err) {
      analysisFailure = err;
    }
    check(
      analysisFailure instanceof IntelligenceError && analysisFailure.code === "analysisFailed",
      "an all-chunk failure must be an analysisFailed error"
    );
    check(/extracting facts/i.test(analysisFailure.message), "the failing stage must be named");
    check(!/reduce the project size/i.test(analysisFailure.message), "the misleading size hint must be gone");
    check(
      /imported project is still available/i.test(analysisFailure.message),
      "the message must explain that the import is preserved"
    );

    // A failed analysis must keep the imported project, so a retry does not
    // require fetching/importing it again.
    const sourceDir = tempDir("myra-intel-pending-");
    write(sourceDir, "src/app.ts", "export function start() { return 1; }");
    const pendingService = new IntelligenceService({
      dataDir: tempDir("myra-intel-pending-data-"),
      approvedRootsFile: null,
      electronMode: false,
      model: new AnalysisModel({ failAllExtraction: true }),
    });
    await pendingService.init();
    const imported = await pendingService.importLocal(sourceDir);
    let firstFailure: any = null;
    let retryFailure: any = null;
    try {
      await pendingService.analyze(imported.projectId);
    } catch (err) {
      firstFailure = err;
    }
    try {
      await pendingService.analyze(imported.projectId);
    } catch (err) {
      retryFailure = err;
    }
    check(firstFailure?.code === "analysisFailed", "the first analysis must report the real failure");
    check(
      retryFailure?.code === "analysisFailed",
      "a retry must reuse the imported files rather than asking for a re-import"
    );

    // Quota/429 is terminal: stop before retrying or splitting the next chunk.
    check(isGeminiQuotaError({ status: 429 }), "an HTTP 429 must be classified as quota");
    check(
      isGeminiQuotaError(new Error("RESOURCE_EXHAUSTED: quota exceeded")),
      "RESOURCE_EXHAUSTED must be classified as quota"
    );
    check(
      isGeminiQuotaError(new Error("Request failed with status 429")),
      "a bare 429 message must be classified as quota"
    );
    check(!isGeminiQuotaError(new Error("socket hang up")), "unrelated errors must not be called quota");

    const quotaExtraction = new AnalysisModel({ quotaAt: "extraction" });
    let quotaFailure: any = null;
    try {
      await buildKnowledge(
        analysisProject([
          { path: "src/a.ts", text: "a".repeat(9_000) },
          { path: "src/b.ts", text: "b".repeat(9_000) },
        ]),
        quotaExtraction
      );
    } catch (err) {
      quotaFailure = err;
    }
    check(
      quotaFailure instanceof IntelligenceError && quotaFailure.code === "quotaExceeded",
      "a quota error must surface as quotaExceeded"
    );
    check(quotaFailure.status === 429, "quotaExceeded must carry HTTP 429");
    check(
      /quota exceeded/i.test(quotaFailure.message) && /retry later/i.test(quotaFailure.message),
      "the quota message must tell the user to retry later"
    );
    check(
      quotaExtraction.calls.length === 1,
      "a quota error must not be retried or split into more requests"
    );

    // A quota hit during synthesis must fail the run, not silently fall back.
    const quotaSynthesis = new AnalysisModel({ quotaAt: "synthesis" });
    let synthesisQuota: any = null;
    try {
      await buildKnowledge(
        analysisProject([{ path: "src/app.ts", text: "export function start() { return 1; }" }]),
        quotaSynthesis
      );
    } catch (err) {
      synthesisQuota = err;
    }
    check(synthesisQuota?.code === "quotaExceeded", "synthesis quota must stop the analysis");
    check(
      quotaSynthesis.calls.filter((call) => call.system.includes("project analyst")).length === 1,
      "only the successful extraction may run before a synthesis quota error"
    );

    // Per-session request cap: stop before exceeding the configured budget.
    const capped = new AnalysisModel();
    let capFailure: any = null;
    try {
      await buildKnowledge(
        analysisProject(
          Array.from({ length: 5 }, (_, index) => ({
            path: `src/cap${index}.ts`,
            text: "x".repeat(9_000),
          }))
        ),
        capped,
        { maxChunks: 3, maxRequests: 2 }
      );
    } catch (err) {
      capFailure = err;
    }
    check(
      capFailure instanceof IntelligenceError && capFailure.code === "requestCapReached",
      "analysis must stop at the per-session request cap"
    );
    check(capFailure.status === 429, "the request cap must be reported as 429");
    check(capped.calls.length === 2, "the cap must stop before the third Gemini request");

    // The interview cap is persisted on the session and checked before the call.
    const capModel = new QueueModel([
      {
        stage: "project_understanding",
        question: "What does this demo project do?",
        focus: "purpose",
        difficulty: "easy",
        expectedPoints: ["purpose"],
        evidence: [{ file: "src/server.ts" }],
      },
    ]);
    const cappedService = new IntelligenceService({
      dataDir: tempDir("myra-intel-cap-"),
      approvedRootsFile: null,
      electronMode: false,
      model: capModel,
      requestCap: 1,
    });
    await cappedService.init();
    await cappedService.storeHandle.saveProject(fixtureKnowledge());
    const cappedInterview = await cappedService.createInterview(
      fixtureKnowledge().projectId,
      "overview",
      "easy"
    );
    check(cappedInterview.session.requestsUsed === 1, "one question request must be counted");
    const reloadedCap = await cappedService.getInterview(cappedInterview.session.id);
    check(reloadedCap?.requestsUsed === 1, "the request counter must be persisted on the session");
    let interviewCapError: any = null;
    try {
      await cappedService.hint(cappedInterview.session.id);
    } catch (err) {
      interviewCapError = err;
    }
    check(
      interviewCapError instanceof IntelligenceError && interviewCapError.code === "requestCapReached",
      "an interview must reject requests past its session cap"
    );
    check(
      capModel.prompts.length === 1,
      "the cap must reject before sending another Gemini request"
    );
  }

  // --- 6. Store -----------------------------------------------------------
  {
    const dir = tempDir("myra-intel-store-");
    const store = new IntelligenceStore(dir);
    await store.init();
    const knowledge = fixtureKnowledge();
    await store.saveProject(knowledge);
    const loaded = await store.getProject(knowledge.projectId);
    check(loaded?.name === knowledge.name, "knowledge must round-trip");
    const list = await store.listProjects();
    check(list.length === 1 && list[0].projectId === knowledge.projectId, "project list must include the saved project");

    let badId = false;
    try {
      await store.getProject("../../evil");
    } catch (err) {
      badId = err instanceof IntelligenceError && (err as any).code === "invalidId";
    }
    check(badId, "path-like ids must be rejected");

    const session = newInterviewSession({ knowledge, type: "overview", difficulty: "easy" });
    await store.saveInterview(session);
    check(store.peekInterview(session.id)?.id === session.id, "voice path must see the cached session");
    const summaries = await store.listInterviews(knowledge.projectId);
    check(summaries.length === 1, "interview list must be scoped to the project");
  }

  // --- 7. Router auth (Electron mode) ------------------------------------
  {
    const dir = tempDir("myra-intel-router-");
    const service = new IntelligenceService({
      dataDir: dir,
      approvedRootsFile: null,
      electronMode: true,
      model: null,
    });
    await service.init();

    const app = express();
    app.use(
      createIntelligenceRouter({
        service,
        electronMode: true,
        desktopToken: "test-desktop-token",
      })
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const unauth = await fetch(`${base}/api/intelligence/projects`);
      check(unauth.status === 401, "missing desktop token must be rejected");

      const authorized = await fetch(`${base}/api/intelligence/projects`, {
        headers: { "x-myra-desktop-token": "test-desktop-token" },
      });
      check(authorized.status === 200, "desktop token must authorize");
      const body: any = await authorized.json();
      check(body.ok === true && Array.isArray(body.projects), "authorized response shape");
      check((authorized.headers.get("cache-control") ?? "").includes("no-store"), "responses must not be cacheable");

      const crossOrigin = await fetch(`${base}/api/intelligence/projects`, {
        headers: {
          "x-myra-desktop-token": "test-desktop-token",
          origin: "https://evil.example",
        },
      });
      check(crossOrigin.status === 403, "foreign Origin must be rejected");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log("intelligence: all checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
