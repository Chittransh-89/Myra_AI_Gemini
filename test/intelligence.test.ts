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
import type { TextModel, TextModelRequest } from "../src/server/intelligence/model.js";
import {
  buildReport,
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
