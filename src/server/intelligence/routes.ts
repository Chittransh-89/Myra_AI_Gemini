/**
 * Myra AI — HTTP surface for Project Intelligence / Interview Mode.
 *
 * Mounted on the EXISTING Express server before Vite/static middleware.
 *
 * Access model:
 *  - Electron runs: requires the per-run desktop token header (same token the
 *    remote pairing API uses). The phone dashboard never gets this token, so
 *    source code is not reachable from the remote surface.
 *  - Standalone loopback dev: allowed only from a loopback peer with a
 *    same-host Origin (when present). Cross-origin browser calls are rejected.
 *  - Responses are always Cache-Control: no-store.
 */

import express, { type NextFunction, type Request, type Response, type Router } from "express";

import { timingSafeEq } from "../handoff.js";
import { IntelligenceService } from "./service.js";
import { IntelligenceError, type Difficulty, type InterviewType } from "./types.js";

export interface IntelligenceRouterOptions {
  service: IntelligenceService;
  electronMode: boolean;
  desktopToken?: string;
}

const INTERVIEW_TYPES = new Set<InterviewType>([
  "overview",
  "deep_dive",
  "code",
  "architecture",
  "debugging",
  "full",
]);

const DIFFICULTIES = new Set<Difficulty>(["easy", "medium", "hard", "brutal"]);

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function sameHostOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return true; // non-browser clients
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.headers.host;
    return !!requestHost && originHost === requestHost;
  } catch {
    return false;
  }
}

function fail(res: Response, error: unknown): void {
  if (error instanceof IntelligenceError) {
    res.status(error.status).json({ ok: false, error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("[intelligence] request failed:", message.slice(0, 300));
  res.status(500).json({ ok: false, error: "internalError", message: "Something went wrong in Project Intelligence." });
}

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(handler: Handler) {
  return (req: Request, res: Response, _next: NextFunction) => {
    handler(req, res).catch((error) => fail(res, error));
  };
}

export function createIntelligenceRouter(options: IntelligenceRouterOptions): Router {
  const { service, electronMode, desktopToken } = options;
  const router = express.Router();
  const json = express.json({ limit: "512kb", strict: true });

  router.use("/api/intelligence", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");

    if (electronMode) {
      const supplied =
        typeof req.headers["x-myra-desktop-token"] === "string"
          ? req.headers["x-myra-desktop-token"]
          : "";
      if (!desktopToken || !timingSafeEq(String(supplied), desktopToken)) {
        res.status(401).json({ ok: false, error: "unauthorized", message: "Desktop authentication failed." });
        return;
      }
    } else if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        ok: false,
        error: "localOnly",
        message: "Project Intelligence is only available on this computer.",
      });
      return;
    }

    if (!sameHostOrigin(req)) {
      res.status(403).json({ ok: false, error: "originRejected", message: "Request origin rejected." });
      return;
    }
    next();
  });

  // --- imports ------------------------------------------------------------

  router.post(
    "/api/intelligence/import/local",
    json,
    wrap(async (req, res) => {
      const folderPath = typeof req.body?.path === "string" ? req.body.path : "";
      const project = await service.importLocal(folderPath);
      res.json({ ok: true, project, aiAvailable: service.hasModel() });
    })
  );

  router.post(
    "/api/intelligence/import/github",
    json,
    wrap(async (req, res) => {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      const project = await service.importGitHub(url);
      res.json({ ok: true, project, aiAvailable: service.hasModel() });
    })
  );

  router.post(
    "/api/intelligence/projects/:projectId/analyze",
    json,
    wrap(async (req, res) => {
      const knowledge = await service.analyze(String(req.params.projectId));
      res.json({ ok: true, project: knowledge });
    })
  );

  // --- projects -----------------------------------------------------------

  router.get(
    "/api/intelligence/projects",
    wrap(async (_req, res) => {
      res.json({ ok: true, projects: await service.listProjects() });
    })
  );

  router.get(
    "/api/intelligence/projects/:projectId",
    wrap(async (req, res) => {
      const project = await service.getProject(String(req.params.projectId));
      res.json({
        ok: true,
        project,
        interviews: await service.listInterviews(project.projectId),
      });
    })
  );

  // --- interviews ---------------------------------------------------------

  router.post(
    "/api/intelligence/interviews",
    json,
    wrap(async (req, res) => {
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
      const type = String(req.body?.type ?? "") as InterviewType;
      const difficulty = String(req.body?.difficulty ?? "") as Difficulty;

      if (!INTERVIEW_TYPES.has(type)) {
        throw new IntelligenceError("invalidInterviewType", "Choose a valid interview type.", 400);
      }
      if (!DIFFICULTIES.has(difficulty)) {
        throw new IntelligenceError("invalidDifficulty", "Choose a valid difficulty.", 400);
      }

      const result = await service.createInterview(projectId, type, difficulty);
      res.json({ ok: true, ...result });
    })
  );

  router.get(
    "/api/intelligence/interviews",
    wrap(async (req, res) => {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      res.json({ ok: true, interviews: await service.listInterviews(projectId) });
    })
  );

  router.get(
    "/api/intelligence/interviews/:id",
    wrap(async (req, res) => {
      const session = await service.getInterview(String(req.params.id));
      const report = session.reportId ? await service.getReportForInterview(session.id) : null;
      res.json({ ok: true, session, report });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/answer",
    json,
    wrap(async (req, res) => {
      const answer = typeof req.body?.answer === "string" ? req.body.answer : "";
      if (answer.length > 8000) {
        throw new IntelligenceError("answerTooLong", "That answer is too long (8000 characters max).", 400);
      }
      const result = await service.answer(String(req.params.id), answer);
      res.json({ ok: true, ...result });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/hint",
    json,
    wrap(async (req, res) => {
      const hints = await service.hint(String(req.params.id));
      res.json({ ok: true, hints });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/explain",
    json,
    wrap(async (req, res) => {
      res.json({ ok: true, ...(await service.explain(String(req.params.id))) });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/skip",
    json,
    wrap(async (req, res) => {
      const result = await service.skip(String(req.params.id));
      res.json({ ok: true, ...result });
    })
  );

  router.get(
    "/api/intelligence/interviews/:id/code",
    wrap(async (req, res) => {
      res.json({ ok: true, samples: await service.showCode(String(req.params.id)) });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/pause",
    json,
    wrap(async (req, res) => {
      res.json({ ok: true, session: await service.pause(String(req.params.id)) });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/resume",
    json,
    wrap(async (req, res) => {
      res.json({ ok: true, session: await service.resume(String(req.params.id)) });
    })
  );

  router.post(
    "/api/intelligence/interviews/:id/end",
    json,
    wrap(async (req, res) => {
      const result = await service.endInterview(String(req.params.id));
      res.json({ ok: true, ...result });
    })
  );

  // Voice transcript segments are recorded server-side by the existing WS
  // pipeline. This endpoint exists only for the text panel to persist a spoken
  // answer the microphone captured while the panel had focus.
  router.post(
    "/api/intelligence/interviews/:id/transcript",
    json,
    wrap(async (req, res) => {
      const role = req.body?.role === "candidate" ? "candidate" : "interviewer";
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      const source = req.body?.source === "voice" ? "voice" : "text";
      await service.recordTranscript(String(req.params.id), role, text, source);
      res.json({ ok: true });
    })
  );

  router.get(
    "/api/intelligence/reports/:reportId",
    wrap(async (req, res) => {
      res.json({ ok: true, report: await service.getReport(String(req.params.reportId)) });
    })
  );

  return router;
}
