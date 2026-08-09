import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");

let mockServer;
let mockBaseUrl;
let externalServer;
let externalBaseUrl;
let child;
let outputRoot;
let nextId = 1;
let stdoutBuffer = "";
const pending = new Map();
let forcedExecutionStatus = "done";
const observed = { executeBody: null, authorization: [] };
let externalAuthorization = "";
const taskAttempts = new Map();

function academicAgent(aic, name, skillId) {
  return {
    id: aic,
    aic,
    name,
    description: `${name} capability`,
    is_public: true,
    approval_status: "APPROVED",
    acs: {
      name,
      description: `${name} capability`,
      endPoints: [{ url: `amqps://platform.example/acps?inbox=${aic}`, transport: "AMQP" }],
      skills: [{ id: skillId, name, description: `${name} capability` }],
    },
  };
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function request(method, params = {}, framed = false) {
  const id = nextId++;
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP response timed out for ${method}`));
    }, 5000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
  if (framed) {
    child.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  } else {
    child.stdin.write(`${message}\n`);
  }
  return promise;
}

before(async () => {
  mockServer = http.createServer((req, res) => {
    observed.authorization.push(req.headers.authorization || "");
    if (req.method === "GET" && req.url === "/router-direct/health") {
      jsonResponse(res, 200, { status: "ok", service: "mode-router" });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/agent/public/recent")) {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const academicAgents = requestUrl.searchParams.get("limit") === "100"
        ? [
            academicAgent("aic-literature", "Literature Research", "academic.literature.research"),
            academicAgent("aic-writing", "Paper Writing", "academic.paper.write"),
            academicAgent("aic-abstract", "Abstract Writing", "academic.abstract.write"),
            academicAgent("aic-chart", "Chart Visualization", "academic.chart.visualize"),
            academicAgent("aic-latex", "LaTeX Expert", "academic.latex.expert"),
          ]
        : [];
      jsonResponse(res, 200, {
        items: [
          { id: "agent-on", aic: "aic-on", name: "Online Agent", is_public: true, approval_status: "APPROVED" },
          { id: "agent-off", aic: "aic-off", name: "Paused Agent", is_public: false, approval_status: "APPROVED" },
          ...academicAgents,
        ],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/router-direct/orchestrator/execute") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        observed.executeBody = JSON.parse(body);
        const task = observed.executeBody.task
          .split("\n\n[Academic workflow contract]\n", 1)[0]
          .split("\n\n[File delivery contract]\n", 1)[0];
        const invalidDownload = task === "Reject an invalid downloaded artifact.";
        const optionalInvalidDownload = task === "Create the required paper and ignore an invalid optional attachment.";
        const duplicateRequiredDownload = task === "Create the paper and include a duplicate broken manifest link.";
        const sourceUrl = task === "Do not turn a citation URL into a file.";
        const duplicateInline = task === "Create the paper and include duplicate inline files.";
        const externalDownload = task === "Download an external attachment without leaking platform credentials.";
        const taskAttempt = (taskAttempts.get(task) || 0) + 1;
        taskAttempts.set(task, taskAttempt);
        const transientRecovery = task === "Recover a transient missing file.";
        if (task === "Keep the first delivery when recovery fails." && taskAttempt >= 2) {
          jsonResponse(res, 503, { detail: "transient recovery outage" });
          return;
        }
        jsonResponse(res, 200, {
          decision: { mode: "mode_1" },
          transport_selection: { transport: "mq_inbox" },
          execution: {
            execution_id: "exec-test",
            status: forcedExecutionStatus,
            runs: [{ package_id: "pkg-1", agent_aic: "aic-on", status: "completed" }],
            artifacts: invalidDownload
              ? [{ filename: "manifest.json", download_path: "/artifacts/home/manifest.json" }]
              : [
                  {
                    filename: "paper.md",
                    agent_name: "Academic Writing",
                    content: "# Verified paper\n",
                  },
                  {
                    filename: "main.tex",
                    agent_name: "LaTeX",
                    content: "\\documentclass{article}\n",
                  },
                  ...(transientRecovery && taskAttempt >= 2
                    ? [{ filename: "abstract.md", agent_name: "Abstract", content: "# Recovered abstract\n" }]
                    : []),
                  ...(optionalInvalidDownload
                    ? [{ filename: "optional.json", download_path: "/artifacts/home/manifest.json" }]
                    : []),
                  ...(duplicateRequiredDownload
                    ? [
                        { filename: "manifest.json", agent_name: "LaTeX", content: "{\"status\":\"complete\"}\n" },
                        { filename: "manifest.json", agent_name: "Academic Writing", download_path: "/artifacts/home/manifest.json" },
                      ]
                    : []),
                  ...(sourceUrl
                    ? [{ title: "Verified source", url: "https://doi.org/10.0000/example" }]
                    : []),
                  ...(duplicateInline
                    ? [{ filename: "paper.md", agent_name: "Academic Writing", content: "# Duplicate paper\n" }]
                    : []),
                  ...(externalDownload
                    ? [{ filename: "external.txt", download_url: `${externalBaseUrl}/external.txt` }]
                    : []),
                ],
          },
          final_result: "RenTA completed the test task.",
        });
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/artifacts/home/manifest.json")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>RenTA home</body></html>");
      return;
    }
    jsonResponse(res, 404, { detail: "not found" });
  });
  externalServer = http.createServer((req, res) => {
    externalAuthorization = req.headers.authorization || "";
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("verified external attachment\n");
  });
  await new Promise((resolve) => externalServer.listen(0, "127.0.0.1", resolve));
  const externalAddress = externalServer.address();
  externalBaseUrl = `http://127.0.0.1:${externalAddress.port}`;
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const address = mockServer.address();
  mockBaseUrl = `http://127.0.0.1:${address.port}`;
  outputRoot = await mkdtemp(path.join(os.tmpdir(), "renta-save-test-"));

  child = spawn(process.execPath, [serverPath], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      RENTA_BASE_URL: mockBaseUrl,
      RENTA_MODE_ROUTER_URL: `${mockBaseUrl}/router-direct`,
      RENTA_REGISTRY_URL: "",
      RENTA_API_TOKEN: "test-token",
      RENTA_REQUESTER_USER_ID: "test-user",
      RENTA_OUTPUT_ROOT: outputRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const lineEnd = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, lineEnd).trim();
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
});

after(async () => {
  if (child && !child.killed) child.kill();
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve));
  if (externalServer) await new Promise((resolve) => externalServer.close(resolve));
  if (outputRoot) await rm(outputRoot, { recursive: true, force: true });
});

test("implements initialize and tools/list over stdio", async () => {
  const initialized = await request("initialize", { protocolVersion: "2025-06-18" }, true);
  assert.equal(initialized.result.serverInfo.name, "renta-platform");
  assert.equal(initialized.result.protocolVersion, "2025-06-18");

  const listed = await request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["renta_health", "renta_list_agents", "renta_execute_task", "renta_execute_and_save"],
  );
});

test("checks health without exposing the token", async () => {
  const response = await request("tools/call", {
    name: "renta_health",
    arguments: {},
  });
  assert.equal(response.result.isError, undefined);
  assert.match(response.result.content[0].text, /RenTA is reachable/);
  assert.equal(response.result.content[0].text.includes("test-token"), false);
});

test("filters non-public Agents from public listing", async () => {
  const response = await request("tools/call", {
    name: "renta_list_agents",
    arguments: { limit: 10 },
  });
  assert.equal(response.result.structuredContent.total, 1);
  assert.equal(response.result.structuredContent.agents[0].id, "agent-on");
});

test("executes through the Mode Router and returns the final result", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_task",
    arguments: {
      task: "Complete a deterministic test task.",
      timeout_seconds: 30,
      transport: "auto",
    },
  });
  assert.equal(response.result.content[0].text, "RenTA completed the test task.");
  assert.equal(response.result.structuredContent.status, "done");
  assert.equal(response.result.structuredContent.transport, "mq_inbox");
  assert.equal(observed.executeBody.execution_transport, "auto");
  assert.equal(observed.executeBody.candidate_source, "registry");
  assert.equal(Object.hasOwn(observed.executeBody, "registry_url"), false);
  assert.equal(observed.executeBody.requester_user_id, "test-user");
  assert.equal(observed.authorization.every((value) => value === "Bearer test-token"), true);
});

test("forces real execution and writes verified artifacts inside the workspace", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Create and save an academic deliverable.",
      output_dir: "paper-demo-output",
      required_files: ["paper.md", "main.tex"],
      timeout_seconds: 30,
      transport: "auto",
    },
  });
  assert.equal(response.result.isError, undefined);
  assert.equal(observed.executeBody.dry_run, false);
  assert.match(observed.executeBody.task, /\[File delivery contract\]/);
  assert.match(observed.executeBody.task, /paper\.md/);
  assert.match(observed.executeBody.task, /main\.tex/);
  assert.equal(response.result.structuredContent.finalResult, undefined);
  assert.equal(response.result.structuredContent.saveStatus, "complete");
  assert.equal(response.result.structuredContent.artifactFilesSaved, 2);
  assert.deepEqual(response.result.structuredContent.missingRequiredFiles, []);
  assert.equal(response.result.structuredContent.savedFiles.some((file) => file.path.endsWith("writing/paper.md")), true);
  assert.equal(response.result.structuredContent.savedFiles.some((file) => file.path.endsWith("latex/main.tex")), true);

  const directory = path.join(outputRoot, "paper-demo-output", "exec-test");
  assert.equal(await readFile(path.join(directory, "writing", "paper.md"), "utf8"), "# Verified paper\n");
  assert.equal(await readFile(path.join(directory, "latex", "main.tex"), "utf8"), "\\documentclass{article}\n");
  const manifest = JSON.parse(await readFile(path.join(directory, "local-manifest.json"), "utf8"));
  assert.equal(manifest.saveStatus, "complete");
  assert.equal(manifest.savedFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
});

test("infers the five academic roles from the required file contract", async () => {
  await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Create the complete academic paper package.",
      output_dir: "paper-demo-output-academic-roles",
      required_files: [
        "paper.md",
        "literature-review.md",
        "evidence-matrix.json",
        "references.bib",
        "abstract.md",
        "chart-data.json",
        "main.tex",
        "latex-diagnostics.json",
        "manifest.json",
      ],
      timeout_seconds: 30,
    },
  });
  assert.equal(observed.executeBody.limit, 5);
  assert.equal(observed.executeBody.hints.requires_independent_roles, true);
  assert.equal(observed.executeBody.hints.parallelizable, false);
  assert.deepEqual(observed.executeBody.hints.required_roles, [
    "literature_review",
    "paper_writing",
    "abstract_writing",
    "chart_visualization",
    "latex",
  ]);
  assert.equal(Object.hasOwn(observed.executeBody, "skills"), false);
  assert.equal(observed.executeBody.max_task_nodes, 5);
  assert.equal(observed.executeBody.node_discovery_limit, 50);
  assert.deepEqual(observed.executeBody.exclude_agent_aics, ["aic-on"]);
  assert.match(observed.executeBody.task, /exactly 5 task nodes/);
  assert.match(observed.executeBody.task, /abstract_writing/);
  assert.match(observed.executeBody.task, /Do not add an unrelated integration, travel, route, POI/);
});

test("reports incomplete when a required file was not returned", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Require an artifact that the mock execution does not return.",
      output_dir: "paper-demo-output-missing",
      required_files: ["paper.md", "chart-data.json"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "incomplete");
  assert.deepEqual(response.result.structuredContent.missingRequiredFiles, ["chart-data.json"]);
});

test("rejects output paths outside the configured workspace", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Do not write outside the workspace.",
      output_dir: "../escape",
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /inside the configured workspace/);
});

test("does not save an HTML landing page as a downloaded JSON artifact", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Reject an invalid downloaded artifact.",
      output_dir: "paper-demo-output-invalid-download",
      required_files: ["manifest.json"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "incomplete");
  assert.deepEqual(response.result.structuredContent.missingRequiredFiles, ["manifest.json"]);
  assert.equal(response.result.structuredContent.unresolved[0].reason, "unexpected_html_document");
});

test("completes required delivery while reporting invalid optional downloads", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Create the required paper and ignore an invalid optional attachment.",
      output_dir: "paper-demo-output-optional-invalid",
      required_files: ["paper.md"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "complete");
  assert.deepEqual(response.result.structuredContent.missingRequiredFiles, []);
  assert.deepEqual(response.result.structuredContent.unresolvedRequiredFiles, []);
  assert.equal(response.result.structuredContent.unresolved.length, 1);
});

test("does not block on a failed duplicate when a required filename was saved inline", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Create the paper and include a duplicate broken manifest link.",
      output_dir: "paper-demo-output-duplicate-required",
      required_files: ["paper.md", "manifest.json"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "complete");
  assert.deepEqual(response.result.structuredContent.missingRequiredFiles, []);
  assert.deepEqual(response.result.structuredContent.unresolvedRequiredFiles, []);
});

test("ignores ordinary source URLs instead of downloading them as artifacts", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Do not turn a citation URL into a file.",
      output_dir: "paper-demo-output-source-url",
      required_files: ["paper.md"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "complete");
  assert.equal(response.result.structuredContent.unresolved.length, 0);
});

test("keeps only one saved file for duplicate filenames", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Create the paper and include duplicate inline files.",
      output_dir: "paper-demo-output-duplicate-inline",
      required_files: ["paper.md"],
      timeout_seconds: 30,
    },
  });
  const paperFiles = response.result.structuredContent.savedFiles.filter((file) => file.filename === "paper.md");
  assert.equal(paperFiles.length, 1);
  assert.equal(response.result.structuredContent.duplicateArtifacts.length, 1);
});

test("does not send the RenTA token to an external artifact origin", async () => {
  externalAuthorization = "not-requested";
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Download an external attachment without leaking platform credentials.",
      output_dir: "paper-demo-output-external-download",
      required_files: ["external.txt"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "complete");
  assert.equal(externalAuthorization, "");
});

test("separates complete local delivery from a partial platform execution", async () => {
  forcedExecutionStatus = "partial";
  try {
    const response = await request("tools/call", {
      name: "renta_execute_and_save",
      arguments: {
        task: "Save every required artifact despite an unrelated failed run.",
        output_dir: "paper-demo-output-partial-execution",
        required_files: ["paper.md", "main.tex"],
        timeout_seconds: 30,
      },
    });
    assert.equal(response.result.structuredContent.status, "partial");
    assert.equal(response.result.structuredContent.saveStatus, "complete");
    assert.deepEqual(response.result.structuredContent.missingRequiredFiles, []);
  } finally {
    forcedExecutionStatus = "done";
  }
});

test("retries an incomplete required delivery once", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Recover a transient missing file.",
      output_dir: "paper-demo-output-recovery",
      required_files: ["paper.md", "abstract.md"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.structuredContent.saveStatus, "complete");
  assert.equal(response.result.structuredContent.attempts.length, 2);
  assert.equal(response.result.structuredContent.attempts[0].saveStatus, "incomplete");
  assert.equal(response.result.structuredContent.attempts[1].saveStatus, "complete");
  assert.match(response.result.content[0].text, /after 2 attempts/);
  const manifest = JSON.parse(await readFile(path.join(outputRoot, "paper-demo-output-recovery", "exec-test", "local-manifest.json"), "utf8"));
  assert.equal(manifest.attempts.length, 2);
});

test("keeps the first saved delivery when the recovery request fails", async () => {
  const response = await request("tools/call", {
    name: "renta_execute_and_save",
    arguments: {
      task: "Keep the first delivery when recovery fails.",
      output_dir: "paper-demo-output-recovery-error",
      required_files: ["paper.md", "abstract.md"],
      timeout_seconds: 30,
    },
  });
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.saveStatus, "incomplete");
  assert.equal(response.result.structuredContent.attempts.length, 2);
  assert.equal(response.result.structuredContent.attempts[1].status, "error");
  assert.match(response.result.structuredContent.attempts[1].error, /503/);
});
