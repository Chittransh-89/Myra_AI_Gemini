# Project Intelligence + Interview Mode

Myra can read a software project (a local folder or a public GitHub repository),
build an evidence-linked knowledge profile from the real code, and then run a
live technical interview about it — by voice through the existing Gemini Live
session, or by text in the Interview panel.

Nothing here is a second assistant: the feature is a new local API surface
(`/api/intelligence/*`) plus one UI panel. Voice reuse the same `/ws` session,
microphone, audio pipeline and Myra persona.

## Using it

1. Start Myra (desktop app or `npm run dev`).
2. Click **INTERVIEW** in the footer.
3. Choose a source:
   - **Local folder** — in the desktop app, click **Pick** and choose a folder.
     Only folders selected in the native picker may be scanned (see security).
     In a plain browser dev run, type an absolute path and tick the confirmation.
   - **GitHub** — paste a public repository URL, e.g.
     `https://github.com/Chittransh-89/Smartloop`. Private repositories are not
     supported yet.
   - **Saved** — previously analysed projects.
4. Review the scanned file list, then click **Analyse project**. Myra chunks the
   source, extracts facts, and synthesises a compact knowledge profile.
5. Pick an interview type and difficulty and click **Start interview**.
6. Answer by typing, or click **Start voice interview** so Myra asks the
   questions aloud through the existing voice pipeline. Spoken answers are
   transcribed into the same session.
7. Use **Hint**, **Explain**, **Code**, **Skip**, **Pause/Resume**, then
   **End interview & get report**.

## What is produced

A project knowledge profile (`ProjectKnowledge`) containing purpose, stack,
frontend/backend architecture, entry points, modules, API endpoints, data
models, auth, data flow, AI integration, key functions, dependencies, design
decisions, limitations and unknowns. Every technical claim points at a relative
file path (and usually a symbol/line range); evidence pointing at files that
were not imported is discarded, so the interview cannot cite code Myra never
saw.

An interview session stores every question and answer (text or voice), the
per-answer assessment, and the stage. End-of-interview reports contain weighted
scores (technical knowledge, code understanding, architecture, reasoning,
communication), an honest verdict, weak areas, incorrect assumptions, revision
topics and a revision plan.

## Storage

Plain JSON files, no new database:

```
<dataDir>/projects/<projectId>.json      analysed knowledge (no raw file contents)
<dataDir>/interviews/<interviewId>.json  questions, turns, assessments
<dataDir>/reports/<reportId>.json        final reports
```

`dataDir` is `MYRA_DATA_DIR`, or `./.myra-data` in a dev run. In Electron it is
`<userData>/myra-intelligence`. `.myra-data/` is git-ignored. Raw recordings
are never stored — only transcript text the voice pipeline produces.

## Security and limits

- **Read-only.** Files are opened with `fs.readFile` only. Nothing is written,
  renamed, moved, executed, installed or built.
- **Explicit scope.** Only the selected root is scanned. Drive roots and the
  user's home directory are rejected. Every resolved path is checked to be
  inside the root, and symlinks are never followed.
- **Picker approval (desktop).** The renderer can only open the native folder
  picker. Main records approved roots in
  `<userData>/approved-project-roots.json`; the server refuses any other path in
  Electron mode, even if a path is sent to the API directly.
- **Secrets.** `.env*`, keys, credentials, keystores, `.ssh/.aws/.kube` and
  similar paths are never read. Text that does leave the process is redacted
  (private keys, cloud/API tokens, JWTs, bearer tokens, connection strings and
  credential assignments).
- **Exclusions.** `node_modules`, `.git`, build output, caches, virtualenvs,
  lockfiles, minified bundles, binaries, media and oversized files are skipped.
- **Limits.** 200 KB per file, 160 files / 700 000 chars per import, 55 000
  chars per analysis chunk, at most 6 chunks, 220 GitHub requests, 15 s GitHub
  timeout, 90 s AI timeout.
- **Untrusted code.** Repository contents, READMEs and comments are data. The
  analysis and interviewer prompts explicitly forbid following instructions
  found inside project files, and Myra never executes them.
- **Access.** `/api/intelligence/*` requires the per-run desktop token in
  Electron mode and is loopback-only in standalone mode. The phone remote never
  receives that token, so source context is not reachable from `/remote`.
  Foreign `Origin` headers are rejected and responses are `no-store`.
- **No weakening of existing security.** Remote pairing, the handoff authority,
  kill switch and WS token checks are untouched.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYRA_INTELLIGENCE` | `1` | `0` disables the API and panel |
| `MYRA_DATA_DIR` | `./.myra-data` | JSON store location |
| `MYRA_INTELLIGENCE_MODEL` | `gemini-3.8-flash` | Gemini text model for analysis/interviews |
| `MYRA_APPROVED_PROJECTS_FILE` | set by Electron | approved folder roots |
| `MYRA_INTELLIGENCE_REQUEST_CAP` | `40` | max Gemini requests per analysis run / interview session |

Analysis and question generation use the same `GEMINI_API_KEY` as voice. Without
a key, import still works (file listing) but analysis/interviews report a clear
`aiUnavailable` error.

### Quota and request caps

Gemini quota/429 errors (`RESOURCE_EXHAUSTED`, `quota exceeded`, `rate limit`)
are classified as `quotaExceeded` before any retry: the run stops immediately,
chunks are never split, and the UI shows *"Gemini quota exceeded (HTTP 429). No
further requests were sent — please retry later…"*.

Every analysis run and every interview session also has a hard Gemini request
allowance (`MYRA_INTELLIGENCE_REQUEST_CAP`, default 40). Analysis counts each
chunk, split and synthesis attempt; interviews persist their counter on the
session, so the cap survives restarts. Exceeding it returns `requestCapReached`
and stops the operation instead of sending more requests.

## API (local only)

```
POST /api/intelligence/import/local              { path }
POST /api/intelligence/import/github             { url }
POST /api/intelligence/projects/:id/analyze
GET  /api/intelligence/projects
GET  /api/intelligence/projects/:id
POST /api/intelligence/interviews                { projectId, type, difficulty }
GET  /api/intelligence/interviews[?projectId=]
GET  /api/intelligence/interviews/:id
POST /api/intelligence/interviews/:id/answer     { answer }
POST /api/intelligence/interviews/:id/hint
POST /api/intelligence/interviews/:id/explain
POST /api/intelligence/interviews/:id/skip
GET  /api/intelligence/interviews/:id/code
POST /api/intelligence/interviews/:id/pause
POST /api/intelligence/interviews/:id/resume
POST /api/intelligence/interviews/:id/end
POST /api/intelligence/interviews/:id/transcript { role, text }
GET  /api/intelligence/reports/:reportId
GET  /api/gemini/usage
```

### Local Gemini usage counter

Every Gemini Live session and every `generateContent` request appends one line
to `gemini-usage.jsonl` in `MYRA_DATA_DIR` (no prompts or responses are stored,
only time, kind, model and feature). `GET /api/gemini/usage` returns the total,
the live/generate split and per-feature/per-model counts. Like the intelligence
API it is loopback-only outside Electron and requires the desktop token in
Electron mode; responses are `no-store`.

## Voice integration

`connectSession()` in `src/App.tsx` appends `&interview=<id>` to the existing
`/ws` URL. The server resolves the interview, appends an interviewer instruction
to Myra's normal system instruction, and enables Gemini Live input/output
transcription (`GeminiProvider`). A bad or ended interview id silently falls
back to the normal assistant, so the voice path can never be broken by this
feature.

The **backend Interview Engine stays authoritative** in voice mode too:

- The engine generates and stores every question (from the project evidence,
  the session stage and the previous answer). The Live model is only a voice
  interface: it reads the exact question it is given and then stays silent.
- Model speech is never written into the session. Only the candidate's
  transcription is buffered; after a short silence the server evaluates it with
  the same `submitAnswer()` the text panel uses, stores the assessment, and
  decides cross-questioning vs. advancing.
- The next engine question is sent to the SAME Gemini Live session with
  `sendText()` (`QUESTION_FROM_ENGINE:`), so questions, transcript,
  cross-questioning and the final report all come from one stored session
  record — identical to text mode.

## Known limitations

- Public GitHub repositories only; no OAuth/PAT, no submodules, no LFS.
- Very large repositories are sampled (highest-value files first); the profile
  says what was excluded.
- Voice answer capture depends on Gemini Live input transcription and a
  ~1.4 s silence window; if transcription is unavailable the answer is not
  evaluated, and the candidate can still type it in the panel.
- Analysis quality depends on the Gemini text model; a failed JSON response is
  reported to the user rather than guessed.
- No live progress percentage during analysis (the panel shows a status line);
  large projects can take up to a minute.
