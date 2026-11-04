"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { createProjectControl, normalizeRelative, isPathInside, generateAsciiTree } = require("../electron/lib/projectControl.cjs");

async function runTests() {
  console.log("==================================================");
  console.log("  MYRA AI — VS CODE PROJECT BUILDER TEST SUITE   ");
  console.log("==================================================");

  const testDir = path.join(__dirname, "..", "test_scratch_vscode_builder");
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  const auditEvents = [];
  const logMessages = [];
  const pc = createProjectControl({
    audit: (evt, data) => auditEvents.push({ evt, data }),
    log: (...args) => logMessages.push(args.join(" ")),
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Detect active VS Code project
    // -------------------------------------------------------------------------
    console.log("\n[TEST 1] Detect active VS Code project...");
    const det = await pc.detect();
    console.log("  detect() result:", { ok: det.ok, name: det.name, root: det.root, source: det.source });
    assert.strictEqual(det.ok, true, "detect() should succeed when VS Code storage or workspace is present");
    assert.ok(typeof det.root === "string" && det.root.length > 0, "root should be a valid string path");
    assert.ok(typeof det.name === "string" && det.name.length > 0, "name should be a valid string");
    console.log("  ✔ TEST 1 PASSED: Detected active workspace:", det.name);

    // -------------------------------------------------------------------------
    // 2. Reference folder inspection
    // -------------------------------------------------------------------------
    console.log("\n[TEST 2] Inspect reference folder hierarchy...");
    const refDir = path.join(testDir, "reference_project");
    fs.mkdirSync(path.join(refDir, "src", "controllers"), { recursive: true });
    fs.writeFileSync(path.join(refDir, "src", "index.js"), "// index.js content", "utf8");
    fs.writeFileSync(path.join(refDir, "src", "controllers", "user.js"), "// user controller", "utf8");
    fs.writeFileSync(path.join(refDir, "package.json"), "{}", "utf8");

    const ref = await pc.reference({ path: refDir });
    console.log("  reference() result:", { ok: ref.ok, dirs: ref.dirs, files: ref.files, entries: ref.entries });
    assert.strictEqual(ref.ok, true, "reference() should succeed");
    assert.ok(ref.dirs >= 2, "Should find at least 2 directories");
    assert.ok(ref.files >= 3, "Should find at least 3 files");
    assert.ok(ref.entries.some((e) => e.includes("package.json")), "Entries should include package.json");
    console.log("  ✔ TEST 2 PASSED: Scanned reference hierarchy correctly");

    // -------------------------------------------------------------------------
    // 3. Security: Prevent path traversal and dangerous inputs
    // -------------------------------------------------------------------------
    console.log("\n[TEST 3] Security: Reject path traversal, colons, device names, absolute paths...");
    const badPaths = [
      "../outside.txt",
      "../../etc/passwd",
      "C:\\Windows\\System32\\calc.exe",
      "/etc/shadow",
      "\\\\unc\\share\\test",
      "test.txt:stream",
      "NUL",
      "CON.txt",
      "COM1",
      "PRN.doc",
      "folder/../escape.py",
      "invalid<char>.txt",
      "pipe|name.py",
    ];

    for (const bad of badPaths) {
      const norm = normalizeRelative(bad);
      assert.strictEqual(norm.ok, false, `Path "${bad}" must be rejected by normalizeRelative`);
    }

    const targetProject = path.join(testDir, "fastapi_target_project");
    fs.mkdirSync(targetProject, { recursive: true });

    const traversalPlan = await pc.plan({
      root: targetProject,
      structure: [{ path: "../../evil.py", type: "file", content: "print('hacked')" }],
    });
    assert.strictEqual(traversalPlan.ok, false, "Plan with traversal path must be rejected");

    // A link inside an otherwise-valid relative path must not redirect a write
    // outside the approved root. Junctions are the Windows equivalent of a
    // directory symlink, so this verifies the boundary used by VS Code.
    const outsideDir = path.join(testDir, "outside_target");
    const linkedDir = path.join(targetProject, "linked");
    fs.mkdirSync(outsideDir, { recursive: true });
    try {
      fs.symlinkSync(outsideDir, linkedDir, "junction");
      const linkPlan = await pc.plan({
        root: targetProject,
        structure: [{ path: "linked/escape.py", type: "file", content: "print('must not escape')" }],
      });
      assert.strictEqual(linkPlan.ok, true, "The safe relative path may be planned");
      const blockedLinkApply = await pc.apply({ planId: linkPlan.planId });
      assert.strictEqual(blockedLinkApply.ok, false, "Write through a junction must be blocked");
      assert.strictEqual(fs.existsSync(path.join(outsideDir, "escape.py")), false, "No file may be written outside root");
    } catch (err) {
      // Some locked-down Windows installations disallow link creation. The
      // production guard is still covered where the OS exposes junctions.
      if (err && err.code !== "EPERM") throw err;
    } finally {
      try { fs.unlinkSync(linkedDir); } catch {}
    }
    console.log("  ✔ TEST 3 PASSED: All path traversal attempts blocked structurally");

    // -------------------------------------------------------------------------
    // 4. Understand requested structure & generate proposed tree (FastAPI example)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 4] Plan proposed FastAPI project tree...");
    const fastApiStructure = [
      { path: "app/", type: "dir" },
      {
        path: "app/main.py",
        type: "file",
        content: `from fastapi import FastAPI
from app.routes import items

app = FastAPI(title="Myra Built FastAPI Service", version="1.0.0")

app.include_router(items.router, prefix="/api/v1")

@app.get("/")
def read_root():
    return {"message": "Hello from Myra AI project!"}
`,
      },
      { path: "app/routes/", type: "dir" },
      {
        path: "app/routes/__init__.py",
        type: "file",
        content: `from fastapi import APIRouter

router = APIRouter()

@router.get("/items")
def get_items():
    return [{"id": 1, "name": "Item One"}]
`,
      },
      { path: "app/models/", type: "dir" },
      {
        path: "app/models/__init__.py",
        type: "file",
        content: `from pydantic import BaseModel

class Item(BaseModel):
    id: int
    name: str
`,
      },
      {
        path: "requirements.txt",
        type: "file",
        content: `fastapi>=0.110.0\nuvicorn>=0.28.0\npydantic>=2.6.0\n`,
      },
    ];

    const planned = await pc.plan({
      root: targetProject,
      request: "Create a FastAPI project structure",
      structure: fastApiStructure,
    });

    console.log("  plan() result:", {
      ok: planned.ok,
      planId: planned.planId,
      dirs: planned.dirs,
      files: planned.files,
      requiresConfirmation: planned.requiresConfirmation,
    });
    console.log("  ASCII tree:\n" + planned.tree);

    assert.strictEqual(planned.ok, true, "plan() must succeed");
    assert.ok(typeof planned.planId === "string" && planned.planId.length === 32, "planId must be 32-char hex");
    assert.strictEqual(planned.requiresConfirmation, true, "Plan must require explicit confirmation");
    assert.strictEqual(planned.dirs, 3, "Expected 3 directories planned (app, app/routes, app/models)");
    assert.strictEqual(planned.files, 4, "Expected 4 files planned");
    assert.ok(planned.tree.includes("app/"), "Tree must include app/");
    assert.ok(planned.tree.includes("requirements.txt"), "Tree must include requirements.txt");

    // -------------------------------------------------------------------------
    // 5. Verification: NOTHING is created before approval
    // -------------------------------------------------------------------------
    console.log("\n[TEST 5] Verify zero files created before explicit approval...");
    assert.strictEqual(fs.existsSync(path.join(targetProject, "app")), false, "app/ must NOT exist yet");
    assert.strictEqual(fs.existsSync(path.join(targetProject, "requirements.txt")), false, "requirements.txt must NOT exist yet");
    console.log("  ✔ TEST 5 PASSED: Target directory remains untouched");

    // -------------------------------------------------------------------------
    // 6. Security: Single-use and planId binding
    // -------------------------------------------------------------------------
    console.log("\n[TEST 6] Apply approved plan (creating multiple files in one approved task)...");
    const applied = await pc.apply({ planId: planned.planId });
    console.log("  apply() result:", {
      ok: applied.ok,
      counts: applied.counts,
      summary: applied.summary,
    });

    assert.strictEqual(applied.ok, true, "apply() must succeed");
    assert.strictEqual(applied.counts.createdFiles, 4, "Must create 4 files");
    assert.strictEqual(applied.counts.createdDirs, 3, "Must create 3 dirs");
    assert.strictEqual(applied.counts.failed, 0, "No files should fail");
    console.log("  ✔ TEST 6 PASSED: Multiple files and nested folders created in single task");

    // Verify on disk
    console.log("\n[TEST 7] Verify created files on disk with requested content...");
    const mainPyPath = path.join(targetProject, "app", "main.py");
    const reqsPath = path.join(targetProject, "requirements.txt");
    const routesInitPath = path.join(targetProject, "app", "routes", "__init__.py");
    const modelsInitPath = path.join(targetProject, "app", "models", "__init__.py");

    assert.ok(fs.existsSync(mainPyPath), "app/main.py must exist");
    assert.ok(fs.existsSync(reqsPath), "requirements.txt must exist");
    assert.ok(fs.existsSync(routesInitPath), "app/routes/__init__.py must exist");
    assert.ok(fs.existsSync(modelsInitPath), "app/models/__init__.py must exist");

    const mainContent = fs.readFileSync(mainPyPath, "utf8");
    assert.ok(mainContent.includes("FastAPI"), "app/main.py must contain FastAPI code");
    const reqsContent = fs.readFileSync(reqsPath, "utf8");
    assert.ok(reqsContent.includes("uvicorn"), "requirements.txt must contain uvicorn");
    console.log("  ✔ TEST 7 PASSED: Files and code verified on disk");

    // -------------------------------------------------------------------------
    // 7. Security: Plan single-use (replay rejected)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 8] Security: Plan single-use (replay rejected)...");
    const replay = await pc.apply({ planId: planned.planId });
    console.log("  replay apply() result:", replay);
    assert.strictEqual(replay.ok, false, "Replay must fail");
    assert.strictEqual(replay.error, "planAlreadyUsed", "Error must be planAlreadyUsed");
    console.log("  ✔ TEST 8 PASSED: Replay attack rejected");

    // -------------------------------------------------------------------------
    // 8. Security: Never overwrite existing files without explicit approval
    // -------------------------------------------------------------------------
    console.log("\n[TEST 9] Security: Overwrite protection without approval...");
    const plan2 = await pc.plan({
      root: targetProject,
      request: "Modify requirements.txt",
      structure: [{ path: "requirements.txt", type: "file", content: "fastapi\nredis\n" }],
    });

    assert.strictEqual(plan2.ok, true);
    assert.strictEqual(plan2.overwrites.length, 1, "Must detect requirements.txt as overwrite");
    assert.strictEqual(plan2.requiresOverwriteConfirmation, true, "Must flag requiresOverwriteConfirmation");

    const deniedApply = await pc.apply({ planId: plan2.planId, confirmOverwrite: false });
    assert.strictEqual(deniedApply.ok, false, "Must deny overwrite without confirmOverwrite: true");
    assert.strictEqual(deniedApply.error, "overwriteNotConfirmed", "Must report overwriteNotConfirmed");

    // Requirements.txt should remain untouched
    const unmodReqs = fs.readFileSync(reqsPath, "utf8");
    assert.ok(unmodReqs.includes("uvicorn"), "File must NOT be overwritten when denied");
    console.log("  ✔ TEST 9 PASSED: Overwrite blocked without explicit permission");

    // -------------------------------------------------------------------------
    // 9. Overwrite with explicit user approval
    // -------------------------------------------------------------------------
    console.log("\n[TEST 10] Overwrite with explicit user approval (confirmOverwrite: true)...");
    const approvedApply = await pc.apply({ planId: plan2.planId, confirmOverwrite: true });
    assert.strictEqual(approvedApply.ok, true, "Must succeed with confirmOverwrite: true");
    assert.strictEqual(approvedApply.counts.overwrittenFiles, 1, "Must report 1 overwritten file");
    const modifiedReqs = fs.readFileSync(reqsPath, "utf8");
    assert.ok(modifiedReqs.includes("redis"), "File must now contain updated content");
    console.log("  ✔ TEST 10 PASSED: Overwrite succeeded after user approval");

    // -------------------------------------------------------------------------
    // 10. Write code into selected files via edit()
    // -------------------------------------------------------------------------
    console.log("\n[TEST 11] Write code into selected file via edit()...");
    const editResult = await pc.edit({
      root: targetProject,
      path: "app/main.py",
      content: `from fastapi import FastAPI
# Updated by Myra AI voice command
app = FastAPI(title="Updated App")

@app.get("/status")
def status():
    return {"status": "ok"}
`,
      confirmOverwrite: true,
    });

    assert.strictEqual(editResult.ok, true, "edit() must succeed");
    assert.strictEqual(editResult.counts.overwrittenFiles, 1, "Must report 1 overwritten file");
    const updatedMain = fs.readFileSync(mainPyPath, "utf8");
    assert.ok(updatedMain.includes("/status"), "main.py must have new endpoint");
    console.log("  ✔ TEST 11 PASSED: Code written into selected file successfully");

    // -------------------------------------------------------------------------
    // 11. Summary reporting
    // -------------------------------------------------------------------------
    console.log("\n[TEST 12] Summary of created and modified files...");
    assert.ok(applied.summary.includes("Created"), "Summary must mention created files");
    assert.ok(approvedApply.summary.includes("modified"), "Summary must mention modified files");
    console.log("  Creation summary:", applied.summary);
    console.log("  Modification summary:", approvedApply.summary);
    console.log("  ✔ TEST 12 PASSED: Summary reporting verified");

    console.log("\n==================================================");
    console.log("  ALL 12 TESTS PASSED PERFECTLY!                 ");
    console.log("==================================================");
  } finally {
    // Clean up test scratch
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
