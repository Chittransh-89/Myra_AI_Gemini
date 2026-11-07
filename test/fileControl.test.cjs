"use strict";

/**
 * Myra AI — file access / reading test suite.
 *
 * Exercises the REAL modules:
 *   - electron/lib/fileReader.cjs  (extraction, encoding, chunking, search)
 *   - electron/lib/fileControl.cjs (authorization, context, actions)
 *   - electron/lib/handoffAuthority.cjs (the signed completion that Gemini gets)
 *
 * Fixtures are generated at runtime (TXT, CSV, JSON, Python, UTF-16, Latin-1,
 * empty, binary, legacy .doc, one-line-huge, PDF, DOCX, .env) and deleted after.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { createFileControl } = require("../electron/lib/fileControl.cjs");
const { validateFilePath } = require("../electron/lib/fileReader.cjs");
const { createHandoffAuthority } = require("../electron/lib/handoffAuthority.cjs");
const { createKillSwitch } = require("../electron/lib/killSwitch.cjs");
const iv = require("../electron/lib/ipcValidate.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixture builders (PDF + DOCX are produced without any extra dependency)
// ---------------------------------------------------------------------------

function buildPdf(text) {
  const escaped = String(text).replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 18 Tf 72 700 Td (${escaped}) Tj ET`;
  const objects = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    4: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };

  let out = "%PDF-1.4\n";
  const offsets = { 0: 0 };
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, "latin1");
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const compressed = entry.deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));

    offset += 30 + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

function buildDocx(paragraphs) {
  const body = paragraphs
    .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
    .join("");
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;

  return buildZip([
    { name: "word/document.xml", data: documentXml, deflate: true },
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
      deflate: true,
    },
    {
      name: "_rels/.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      deflate: true,
    },
  ]);
}

// ---------------------------------------------------------------------------

async function runTests() {
  console.log("==================================================");
  console.log("  MYRA FILE ACCESS / READING TEST SUITE           ");
  console.log("==================================================");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-file-test-"));
  const fp = (name) => path.join(dir, name);
  const write = (name, data) => {
    fs.writeFileSync(fp(name), data);
    return fp(name);
  };

  const notesPath = write("notes.txt", "Myra file fixture\nLine two of notes.\n");
  const hindiPath = write("hindi.txt", "नमस्ते मायरा\nयह एक परीक्षण फ़ाइल है।\n");
  const pyPath = write(
    "script.py",
    [
      "# fixture module",
      "def compute_total(items):",
      "    return sum(items)",
      "",
      "class Greeter:",
      "    def hello(self):",
      '        return "hello"',
      "",
    ].join("\n")
  );
  write("data.csv", "name,score\nAsha,91\nRavi,84\n");
  write("config.json", JSON.stringify({ app: "myra", version: 2, features: ["files"] }, null, 2));
  write("utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hello UTF16\n", "utf16le")]));
  write("latin1.txt", Buffer.from("Caf\xe9 au lait\n", "latin1"));
  write("empty.txt", "");
  write("binary.bin", Buffer.from([0, 1, 2, 3, 255, 254, 0, 66, 67]));
  write("legacy.doc", "legacy binary document");
  write("report.pdf", buildPdf("Myra PDF fixture: alpha bravo charlie 42."));
  write("memo.docx", buildDocx(["Myra DOCX fixture", "Beta paragraph with 42."]));
  write(".env", "API_KEY=super-secret-value\n");
  write("compare-a.txt", "alpha\nbeta\ngamma\n");
  write("compare-b.txt", "alpha\nBETA\ngamma\ndelta\n");
  const singleLinePath = write("single-line.txt", "x".repeat(12000));

  const largeLines = [];
  for (let i = 1; i <= 20000; i++) largeLines.push("line " + String(i).padStart(5, "0") + " payload payload");
  const largeText = largeLines.join("\n") + "\n";
  const largePath = write("large.log", largeText);

  const states = [];
  const fc = createFileControl({
    audit: () => {},
    log: () => {},
    pickFiles: async () => ({ canceled: true, paths: [] }),
    confirmPath: async () => true,
    onState: (s) => states.push(s),
  });

  try {
    // -----------------------------------------------------------------------
    console.log("\n[TEST 1] Path validation...");
    assert.strictEqual(validateFilePath("relative.txt").error, "pathNotAbsolute");
    assert.strictEqual(validateFilePath("\\\\server\\share\\a.txt").error, "unsupportedPath");
    assert.strictEqual(validateFilePath("\\\\.\\C:\\a.txt").error, "unsupportedPath");
    assert.strictEqual(validateFilePath("C:\\tmp\\a:b.txt").error, "badPath");
    assert.strictEqual(validateFilePath("").error, "emptyPath");
    assert.strictEqual(validateFilePath(notesPath).ok, true);
    console.log("  ✔ TEST 1 PASSED: relative/UNC/device/ADS paths rejected");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 2] Unauthorized read leaks nothing...");
    const denied = await fc.run({ action: "read", path: notesPath });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error, "notAuthorized");
    assert.strictEqual(denied.requiresApproval, true);
    assert.ok(!("chunk" in denied), "no content may be returned before authorization");
    assert.ok(!("text" in denied));
    assert.strictEqual(fc.openCount(), 0);
    console.log("  ✔ TEST 2 PASSED: notAuthorized, approval required, no content");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 3] Authorization + real TXT content...");
    const authorized = await fc.run({ action: "authorize", path: notesPath });
    assert.strictEqual(authorized.ok, true);
    assert.strictEqual(authorized.action, "authorize");
    assert.ok(authorized.chunk.includes("Myra file fixture"));
    assert.ok(authorized.chunk.includes("Line two of notes."));
    assert.strictEqual(authorized.name, "notes.txt");
    assert.strictEqual(authorized.totalChars, authorized.chunk.length);
    assert.ok(states.some((s) => s.status === "ready"), "reading status was emitted");
    assert.strictEqual(fc.active().name, "notes.txt");
    console.log("  ✔ TEST 3 PASSED: explicit approval recorded, exact text returned");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 4] Declining authorization...");
    const declineFc = createFileControl({
      audit: () => {},
      log: () => {},
      confirmPath: async () => false,
      pickFiles: async () => ({ canceled: true, paths: [] }),
    });
    const declined = await declineFc.run({ action: "authorize", path: notesPath });
    assert.strictEqual(declined.ok, false);
    assert.strictEqual(declined.error, "notAuthorized");
    assert.strictEqual(declined.reason, "userDeclined");
    assert.strictEqual(declineFc.authorizedCount(), 0);
    console.log("  ✔ TEST 4 PASSED: a declined prompt authorizes nothing");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 5] Hindi text is preserved...");
    const hindi = await fc.run({ action: "authorize", path: hindiPath });
    assert.strictEqual(hindi.ok, true);
    assert.ok(hindi.chunk.includes("नमस्ते मायरा"));
    assert.strictEqual(hindi.encoding, "utf-8");
    console.log("  ✔ TEST 5 PASSED: UTF-8 Devanagari text intact");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 6] Source code + function search...");
    const py = await fc.run({ action: "authorize", path: pyPath });
    assert.strictEqual(py.ok, true);
    assert.ok(py.chunk.includes("def compute_total(items):"));
    const found = await fc.run({ action: "search", query: "compute_total" });
    assert.strictEqual(found.ok, true);
    assert.strictEqual(found.totalMatches, 1);
    assert.strictEqual(found.matches[0].line, 2);
    assert.strictEqual(found.matches[0].column, 5);
    assert.ok(found.matches[0].text.includes("def compute_total"));
    const missing = await fc.run({ action: "search", query: "definitely_not_there" });
    assert.strictEqual(missing.totalMatches, 0);
    console.log("  ✔ TEST 6 PASSED: exact code text and line-accurate search");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 7] Large file: chunk offsets continue without gaps...");
    const large1 = await fc.run({ action: "authorize", path: largePath, maxChars: 500 });
    assert.strictEqual(large1.ok, true);
    assert.strictEqual(large1.chunk.length, 500);
    assert.strictEqual(large1.hasMore, true);
    assert.strictEqual(large1.totalChars, largeText.length);
    const large2 = await fc.run({ action: "current", offset: large1.nextOffset, maxChars: 500 });
    assert.strictEqual(large2.ok, true);
    assert.strictEqual(large2.offset, 500);
    assert.strictEqual(large1.chunk + large2.chunk, largeText.slice(0, 1000));
    console.log("  ✔ TEST 7 PASSED: paginated reading is contiguous");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 8] Oversized single line stays within the completion budget...");
    const single = await fc.run({ action: "authorize", path: singleLinePath, maxChars: 12000 });
    assert.strictEqual(single.ok, true);
    assert.ok(single.chunk.length > 0);
    assert.ok(single.chunk.length < 12000, "chunk was trimmed to fit");
    assert.ok(JSON.stringify(single).length <= 7400, "payload within budget");
    assert.ok(iv.canonicalJsonOrNull(single, 8192), "canonical form fits MAX_RESULT_BYTES");
    console.log("  ✔ TEST 8 PASSED: long lines cannot break the signed completion");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 9] PDF text extraction...");
    const pdf = await fc.run({ action: "authorize", path: fp("report.pdf") });
    assert.strictEqual(pdf.ok, true, "pdf read: " + JSON.stringify(pdf));
    assert.strictEqual(pdf.kind, "pdf");
    assert.ok(pdf.chunk.includes("Myra PDF fixture: alpha bravo charlie 42."));
    assert.strictEqual(pdf.pages, 1);
    console.log("  ✔ TEST 9 PASSED: real PDF text extracted");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 10] DOCX text extraction...");
    const docx = await fc.run({ action: "authorize", path: fp("memo.docx") });
    assert.strictEqual(docx.ok, true, "docx read: " + JSON.stringify(docx));
    assert.strictEqual(docx.kind, "docx");
    assert.ok(docx.chunk.includes("Myra DOCX fixture"));
    assert.ok(docx.chunk.includes("Beta paragraph with 42."));
    console.log("  ✔ TEST 10 PASSED: real DOCX text extracted (ZIP + XML)");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 11] Encoding handling...");
    const utf16 = await fc.run({ action: "authorize", path: fp("utf16.txt") });
    assert.strictEqual(utf16.encoding, "utf-16le");
    assert.ok(utf16.chunk.includes("Hello UTF16"));
    const latin = await fc.run({ action: "authorize", path: fp("latin1.txt") });
    assert.strictEqual(latin.encoding, "latin1");
    assert.ok(latin.chunk.includes("Café au lait"));
    assert.ok(latin.warnings.includes("nonUtf8DecodedAsLatin1"));
    console.log("  ✔ TEST 11 PASSED: UTF-16 BOM + explicit Latin-1 fallback warning");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 12] Failure modes are explicit, never silently empty...");
    const empty = await fc.run({ action: "authorize", path: fp("empty.txt") });
    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.error, "emptyFile");
    const binary = await fc.run({ action: "authorize", path: fp("binary.bin") });
    assert.strictEqual(binary.ok, false);
    assert.strictEqual(binary.error, "unsupportedBinary");
    const legacy = await fc.run({ action: "authorize", path: fp("legacy.doc") });
    assert.strictEqual(legacy.ok, false);
    assert.strictEqual(legacy.error, "unsupportedFormat");
    const missingFile = await fc.run({ action: "authorize", path: fp("no-such-file.txt") });
    assert.strictEqual(missingFile.ok, false);
    assert.strictEqual(missingFile.error, "fileNotFound");
    const badAction = await fc.run({ action: "deleteEverything" });
    assert.strictEqual(badAction.ok, false);
    assert.strictEqual(badAction.error, "unsupportedAction");
    console.log("  ✔ TEST 12 PASSED: empty/binary/.doc/missing/unknown all report honest errors");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 13] Sensitive file needs its own approval...");
    const secretDenied = await fc.run({ action: "read", path: fp(".env") });
    assert.strictEqual(secretDenied.ok, false);
    assert.strictEqual(secretDenied.error, "notAuthorized");
    assert.strictEqual(secretDenied.sensitive, true);
    const secretAllowed = await fc.run({ action: "authorize", path: fp(".env") });
    assert.strictEqual(secretAllowed.ok, true);
    assert.strictEqual(secretAllowed.sensitive, true);
    assert.ok(secretAllowed.chunk.includes("API_KEY=super-secret-value"));
    console.log("  ✔ TEST 13 PASSED: .env flagged and only readable after explicit approval");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 14] Compare two files...");
    await fc.run({ action: "authorize", path: fp("compare-a.txt") });
    await fc.run({ action: "authorize", path: fp("compare-b.txt") });
    const compared = await fc.run({
      action: "compare",
      paths: [fp("compare-a.txt"), fp("compare-b.txt")],
    });
    assert.strictEqual(compared.ok, true, "compare: " + JSON.stringify(compared));
    assert.strictEqual(compared.files.length, 2);
    assert.ok(compared.files[0].preview.startsWith("alpha"));
    assert.strictEqual(compared.diff.changedLines, 2); // line 2 differs + trailing-line alignment
    assert.strictEqual(compared.diff.onlyInB, 1);
    assert.strictEqual(compared.diff.samples[0].line, 2);
    assert.ok(JSON.stringify(compared).length <= 7400);
    console.log("  ✔ TEST 14 PASSED: line-aligned diff with previews");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 15] Open-file context: list, switch, close...");
    const listed = await fc.run({ action: "list" });
    assert.strictEqual(listed.ok, true);
    assert.ok(listed.count >= 3);
    const switched = await fc.run({ action: "switch", name: "script.py" });
    assert.strictEqual(switched.ok, true);
    assert.strictEqual(switched.name, "script.py");
    assert.ok(switched.chunk.includes("class Greeter"));
    const closed = await fc.run({ action: "close" });
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(closed.closed, "script.py");
    const cleared = await fc.run({ action: "closeAll" });
    assert.strictEqual(cleared.ok, true);
    const noCurrent = await fc.run({ action: "current" });
    assert.strictEqual(noCurrent.ok, false);
    assert.strictEqual(noCurrent.error, "noOpenFile");
    console.log("  ✔ TEST 15 PASSED: context switches, closes and clears");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 16] Picker action...");
    const pickFc = createFileControl({
      audit: () => {},
      log: () => {},
      confirmPath: async () => false,
      pickFiles: async () => ({ canceled: false, paths: [notesPath] }),
    });
    const picked = await pickFc.run({ action: "pick" });
    assert.strictEqual(picked.ok, true);
    assert.strictEqual(picked.action, "pick");
    assert.ok(picked.chunk.includes("Myra file fixture"));
    assert.strictEqual(picked.files.length, 1);
    const canceledFc = createFileControl({
      audit: () => {},
      log: () => {},
      confirmPath: async () => false,
      pickFiles: async () => ({ canceled: true, paths: [] }),
    });
    const canceled = await canceledFc.run({ action: "pick" });
    assert.strictEqual(canceled.ok, false);
    assert.strictEqual(canceled.error, "pickerCanceled");
    console.log("  ✔ TEST 16 PASSED: picker selection authorizes and reads; cancel is explicit");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 17] Content reaches the signed completion (what Gemini gets)...");
    const emitted = [];
    const authorityFiles = createFileControl({
      audit: () => {},
      log: () => {},
      confirmPath: async () => true,
      pickFiles: async () => ({ canceled: true, paths: [] }),
    });
    const authority = createHandoffAuthority({
      audit: () => {},
      killSwitch: createKillSwitch(),
      receiptKey: crypto.randomBytes(32),
      emitCompletion: (frame) => {
        emitted.push(frame);
        return true;
      },
      notifyExecuting: () => {},
      file: authorityFiles,
    });
    const sessionId = "session_file_test_01";

    async function execute(callId, args) {
      const reg = authority.registerPendingCall({ callId, toolName: "fileControl", args, sessionId });
      assert.strictEqual(reg.ok, true, "registration must succeed: " + reg.reason);
      const res = authority.handleExecuteTool({ ticket: reg.ticket, name: "fileControl", args });
      assert.strictEqual(res.status, "accepted", "async executor ack");
      const startedAt = Date.now();
      while (Date.now() - startedAt < 6000 && !emitted.some((f) => f.receipt.callId === callId)) {
        await sleep(25);
      }
      const frame = emitted.find((f) => f.receipt.callId === callId);
      assert.ok(frame, "completion emitted for " + callId);
      return frame.receipt;
    }

    const txtReceipt = await execute("file_call_1", { action: "authorize", path: notesPath });
    assert.strictEqual(txtReceipt.executionStatus, "success", "TXT completion status");
    assert.ok(txtReceipt.result.chunk.includes("Line two of notes."));
    assert.ok(iv.canonicalJsonOrNull(txtReceipt.result, 8192), "TXT result fits the completion cap");

    const pdfReceipt = await execute("file_call_2", { action: "authorize", path: fp("report.pdf") });
    assert.strictEqual(pdfReceipt.executionStatus, "success", "PDF completion status");
    assert.ok(pdfReceipt.result.chunk.includes("alpha bravo charlie 42"));

    const docxReceipt = await execute("file_call_3", { action: "authorize", path: fp("memo.docx") });
    assert.strictEqual(docxReceipt.executionStatus, "success", "DOCX completion status");
    assert.ok(docxReceipt.result.chunk.includes("Myra DOCX fixture"));

    const codeReceipt = await execute("file_call_4", { action: "authorize", path: pyPath });
    assert.ok(codeReceipt.result.chunk.includes("def compute_total(items):"));

    const hiReceipt = await execute("file_call_5", { action: "authorize", path: hindiPath });
    assert.ok(hiReceipt.result.chunk.includes("नमस्ते मायरा"));

    const largeReceipt = await execute("file_call_6", { action: "authorize", path: largePath, maxChars: 12000 });
    assert.strictEqual(largeReceipt.executionStatus, "success");
    assert.ok(iv.canonicalJsonOrNull(largeReceipt.result, 8192), "large-file chunk fits the cap");
    console.log("  ✔ TEST 17 PASSED: real text arrives in signed completions for TXT/PDF/DOCX/code/Hindi/large");

    // -----------------------------------------------------------------------
    console.log("\n[TEST 18] Wiring: schema, preload bridge, main IPC, executor...");
    const root = path.join(__dirname, "..");
    const serverSource = fs.readFileSync(path.join(root, "src", "server", "index.ts"), "utf8");
    assert.ok(serverSource.includes('name: "fileControl"'), "tool declaration present");
    assert.ok(serverSource.includes('"fileControl",'), "registered as main-executed");
    for (const action of ["pick", "read", "authorize", "current", "search", "compare", "closeAll"]) {
      assert.ok(serverSource.includes('"' + action + '"'), "schema action " + action);
    }
    const preloadSource = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
    assert.ok(preloadSource.includes("fileAccess"));
    assert.ok(preloadSource.includes("myra:file:pick"));
    const mainSource = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
    assert.ok(mainSource.includes("myra:file:pick"));
    assert.ok(mainSource.includes("createFileControl"));
    const authoritySource = fs.readFileSync(path.join(root, "electron", "lib", "handoffAuthority.cjs"), "utf8");
    assert.ok(authoritySource.includes('"fileControl"'));
    console.log("  ✔ TEST 18 PASSED: tool, IPC, preload and executor wiring present");

    console.log("\n==================================================");
    console.log("  ALL FILE ACCESS TESTS PASSED                    ");
    console.log("==================================================");
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error("\nTEST FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
