"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { createProjectControl } = require("../electron/lib/projectControl.cjs");

async function main() {
  console.log("=== Testing Actual File Creation inside VS Code Project ===");

  const pc = createProjectControl({ log: console.log });

  // 1. Detect
  const det = await pc.detect();
  console.log("1. Detected VS Code Project:", det.name, "at", det.root);
  assert.strictEqual(det.ok, true, "Detection failed");
  
  // Use the workspace root for sandbox testing (or detected root if same)
  const projectRoot = process.cwd();
  console.log("Using workspace root for file creation testing:", projectRoot);

  // We test building inside a dedicated demo subfolder in the detected project:
  const demoRelDir = "myra_fastapi_verified_demo";
  const demoTargetAbs = path.join(projectRoot, demoRelDir);

  // Clean if previously existing
  if (fs.existsSync(demoTargetAbs)) {
    fs.rmSync(demoTargetAbs, { recursive: true, force: true });
  }

  // 2. Plan FastAPI project structure
  console.log("\n2. Planning FastAPI project structure...");
  const fastApiStructure = [
    { path: `${demoRelDir}/app/`, type: "dir" },
    {
      path: `${demoRelDir}/app/main.py`,
      type: "file",
      content: `from fastapi import FastAPI
from app.routes import items
from app.models import item

app = FastAPI(title="Verified FastAPI Project", version="1.0.0")

@app.get("/")
def root():
    return {"status": "ok", "message": "Myra AI FastAPI builder works!"}
`,
    },
    { path: `${demoRelDir}/app/routes/`, type: "dir" },
    {
      path: `${demoRelDir}/app/routes/__init__.py`,
      type: "file",
      content: `# Routes module\n`,
    },
    { path: `${demoRelDir}/app/models/`, type: "dir" },
    {
      path: `${demoRelDir}/app/models/__init__.py`,
      type: "file",
      content: `# Models module\n`,
    },
    {
      path: `${demoRelDir}/requirements.txt`,
      type: "file",
      content: `fastapi>=0.110.0\nuvicorn>=0.28.0\npydantic>=2.6.0\n`,
    },
  ];

  const planned = await pc.plan({
    root: projectRoot,
    request: "Create a FastAPI project structure",
    structure: fastApiStructure,
  });

  assert.strictEqual(planned.ok, true);
  console.log("Proposed Tree:\n" + planned.tree);
  console.log("Plan ID:", planned.planId);
  console.log("Requires confirmation:", planned.requiresConfirmation);

  // 3. Verify zero files exist before approval
  console.log("\n3. Verifying zero files created before approval...");
  assert.strictEqual(fs.existsSync(path.join(demoTargetAbs, "app")), false);
  assert.strictEqual(fs.existsSync(path.join(demoTargetAbs, "requirements.txt")), false);
  console.log("  ✔ Verified: Target files do NOT exist before approval.");

  // 4. Apply
  console.log("\n4. Applying plan after approved permission...");
  const applied = await pc.apply({ planId: planned.planId });
  console.log("apply result:", applied);
  assert.strictEqual(applied.ok, true);
  console.log("Apply Summary:", applied.summary);
  console.log("Created Dirs:", applied.createdDirs);
  console.log("Created Files:", applied.createdFiles);

  // 5. Verify actual file creation on disk
  console.log("\n5. Verifying files exist on disk with correct content...");
  const mainPy = path.join(demoTargetAbs, "app", "main.py");
  const reqs = path.join(demoTargetAbs, "requirements.txt");
  const routesInit = path.join(demoTargetAbs, "app", "routes", "__init__.py");
  const modelsInit = path.join(demoTargetAbs, "app", "models", "__init__.py");

  assert.ok(fs.existsSync(mainPy), "app/main.py was not created");
  assert.ok(fs.existsSync(reqs), "requirements.txt was not created");
  assert.ok(fs.existsSync(routesInit), "app/routes/__init__.py was not created");
  assert.ok(fs.existsSync(modelsInit), "app/models/__init__.py was not created");

  const mainPyContent = fs.readFileSync(mainPy, "utf8");
  assert.ok(mainPyContent.includes("FastAPI"), "main.py content missing FastAPI");
  console.log("  ✔ All files exist with expected content on disk.");

  // 6. Test edit
  console.log("\n6. Testing edit on app/main.py...");
  const editRes = await pc.edit({
    root: projectRoot,
    path: `${demoRelDir}/app/main.py`,
    content: mainPyContent + "\n# Extra route added by Myra\n@app.get('/health')\ndef health(): return {'status': 'healthy'}\n",
    confirmOverwrite: true,
  });
  assert.strictEqual(editRes.ok, true);
  assert.strictEqual(editRes.counts.overwrittenFiles, 1);
  const updatedContent = fs.readFileSync(mainPy, "utf8");
  assert.ok(updatedContent.includes("/health"), "Updated content missing /health");
  console.log("  ✔ File successfully edited with requested code.");

  // 7. Clean up demo folder
  fs.rmSync(demoTargetAbs, { recursive: true, force: true });
  console.log("\n✔ SUCCESS: Actual file creation inside VS Code verified end-to-end!");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
