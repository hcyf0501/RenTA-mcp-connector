#!/usr/bin/env node

import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "renta-platform";
const SERVER_VERSION = "0.1.0";
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_ENV_PATH = path.join(PLUGIN_ROOT, "config", ".env");

async function loadLocalEnvironment() {
  try {
    const content = await readFile(LOCAL_ENV_PATH, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;

      let value = match[2].trim();
      if (
        value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await loadLocalEnvironment();

function cleanBaseUrl(value, variableName = "RENTA_BASE_URL") {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) {
    throw new Error(`${variableName} is required. Configure it in config/.env or the MCP process environment.`);
  }
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${variableName} must use http:// or https://`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function cleanOptionalBaseUrl(value) {
  const text = String(value || "").trim();
  return text ? cleanBaseUrl(text, "RENTA_REGISTRY_URL") : "";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function config() {
  const baseUrl = cleanBaseUrl(process.env.RENTA_BASE_URL);
  return {
    baseUrl,
    modeRouterUrl: cleanBaseUrl(
      process.env.RENTA_MODE_ROUTER_URL || `${baseUrl}/mode-router`,
      "RENTA_MODE_ROUTER_URL",
    ),
    registryUrl: cleanOptionalBaseUrl(process.env.RENTA_REGISTRY_URL),
    apiToken: String(process.env.RENTA_API_TOKEN || "").trim(),
    requesterUserId: String(process.env.RENTA_REQUESTER_USER_ID || "").trim(),
    defaultTransport: String(process.env.RENTA_EXECUTION_TRANSPORT || "auto").trim(),
    outputRoot: path.resolve(
      String(process.env.RENTA_OUTPUT_ROOT || process.cwd()).trim(),
    ),
    defaultTimeoutSeconds: boundedInteger(
      process.env.RENTA_TIMEOUT_SECONDS,
      180,
      5,
      1800,
    ),
    saveMaxAttempts: boundedInteger(
      process.env.RENTA_SAVE_MAX_ATTEMPTS,
      2,
      1,
      3,
    ),
  };
}

function headers(settings, hasBody) {
  const result = {
    Accept: "application/json",
    "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
  };
  if (hasBody) result["Content-Type"] = "application/json";
  if (settings.apiToken) result.Authorization = `Bearer ${settings.apiToken}`;
  return result;
}

async function platformRequest(path, options = {}) {
  const settings = config();
  const requestBaseUrl = options.baseUrl || settings.baseUrl;
  const timeoutSeconds = boundedInteger(
    options.timeoutSeconds,
    settings.defaultTimeoutSeconds,
    1,
    1800,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(`${requestBaseUrl}${path}`, {
      method: options.method || "GET",
      headers: headers(settings, options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { rawText: text };
    }
    if (!response.ok) {
      const detail = payload?.detail || payload?.message || payload?.error_msg || text;
      throw new Error(`RenTA HTTP ${response.status}: ${String(detail || "request failed").slice(0, 500)}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`RenTA request timed out after ${timeoutSeconds} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resultText(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function executionSummary(response, fallbackTransport) {
  const execution = response?.execution || {};
  return {
    status: execution.status || response?.status || "unknown",
    mode: response?.decision?.mode || execution.mode || "",
    transport: execution.execution_transport || response?.transport_selection?.transport || fallbackTransport,
    finalResult: String(response?.final_result || execution?.final_result || "").trim(),
    executionId: execution.execution_id || "",
    planId: response?.plan?.plan_id || execution.plan_id || "",
    message: execution.message || "",
    runs: Array.isArray(execution.runs)
      ? execution.runs.map((run) => ({
          packageId: run.package_id || "",
          agentAic: run.agent_aic || run.agent?.aic || "",
          status: run.status || "",
          error: run.error || "",
        }))
      : [],
  };
}

function deliveryScore(saved) {
  if (saved.saveStatus === "complete") return Number.MAX_SAFE_INTEGER;
  return Number(saved.requiredFiles?.length || 0)
    - Number(saved.missingRequiredFiles?.length || 0)
    - Number(saved.unresolvedRequiredFiles?.length || 0);
}

function agentSummary(agent) {
  return {
    id: agent.id || "",
    aic: agent.aic || "",
    name: agent.name || "",
    version: agent.version || "",
    description: agent.description || "",
    isPublic: agent.isPublic ?? agent.is_public ?? true,
    approvalStatus: agent.approvalStatus || agent.approval_status || "",
    endpoints: agent.acs?.endPoints || agent.acs?.endpoints || [],
  };
}

function safeSegment(value, fallback = "artifact") {
  const clean = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 80);
  return clean || fallback;
}

function safeOutputDir(root, requested) {
  const relative = String(requested || "paper-demo-output").trim();
  if (!relative || path.isAbsolute(relative)) {
    throw new Error("output_dir must be a relative path inside the configured workspace");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("output_dir must remain inside the configured workspace");
  }
  return resolved;
}

function normalizedRequiredFiles(requiredFiles) {
  return Array.from(
    new Set(
      (Array.isArray(requiredFiles) ? requiredFiles : [])
        .map((item) => path.basename(String(item || "").trim()))
        .filter(Boolean),
    ),
  );
}

function buildFileDeliveryTask(task, requiredFiles) {
  const files = normalizedRequiredFiles(requiredFiles);
  if (!files.length) return task;
  return [
    task,
    ...academicWorkflowContract(requiredFiles),
    "",
    "[File delivery contract]",
    `Return a real structured artifact for every exact required filename: ${files.join(", ")}.`,
    "Do not omit a required file because source material or evidence is limited. Return the file with an explicit evidence-gap, placeholder-data, or diagnostic note instead of failing the role.",
    "Do not return only a plan, directory tree, local path, or completion claim.",
  ].join("\n");
}

const ACADEMIC_ROLE_FILES = [
  ["literature_review", ["literature-review.md", "evidence-matrix.json", "references.bib"]],
  ["paper_writing", ["paper.md"]],
  ["abstract_writing", ["abstract.md"]],
  ["chart_visualization", ["chart-data.json"]],
  ["latex", ["main.tex", "latex-diagnostics.json", "manifest.json"]],
];

const ACADEMIC_ROLE_SKILL_IDS = new Map([
  ["literature_review", "academic.literature.research"],
  ["paper_writing", "academic.paper.write"],
  ["abstract_writing", "academic.abstract.write"],
  ["chart_visualization", "academic.chart.visualize"],
  ["latex", "academic.latex.expert"],
]);

function inferredAcademicRoles(requiredFiles) {
  const files = new Set(normalizedRequiredFiles(requiredFiles));
  return ACADEMIC_ROLE_FILES
    .filter(([, roleFiles]) => roleFiles.some((filename) => files.has(filename)))
    .map(([role]) => role);
}

function academicWorkflowContract(requiredFiles) {
  const roles = inferredAcademicRoles(requiredFiles);
  if (roles.length < 2) return [];
  const objectives = new Map([
    ["literature_review", "verified literature review, evidence matrix, and bibliography"],
    ["paper_writing", "editable academic paper draft based on the literature evidence"],
    ["abstract_writing", "Chinese and English abstracts with keywords based on the paper draft"],
    ["chart_visualization", "chart data with explicit real-data or placeholder-data provenance"],
    ["latex", "LaTeX source, static diagnostics, and artifact manifest using upstream outputs"],
  ]);
  return [
    "",
    "[Academic workflow contract]",
    `Decompose this request into exactly ${roles.length} task nodes, one for each capability below, in this order and without combining or omitting a node:`,
    ...roles.map((role, index) => `${index + 1}. ${role}: ${objectives.get(role)}.`),
    "Do not add an unrelated integration, travel, route, POI, or validation-only task node.",
  ];
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function academicCandidate(agent, skill, ranking) {
  const acs = agent?.acs && typeof agent.acs === "object" ? agent.acs : {};
  return {
    aic: String(agent?.aic || agent?.agentAic || acs.aic || "").trim(),
    skillid: String(skill?.id || skill?.skillId || "").trim(),
    agent_name: String(agent?.name || acs.name || "").trim(),
    skill_name: String(skill?.name || skill?.id || skill?.skillId || "").trim(),
    description: String(skill?.description || agent?.description || acs.description || "").trim(),
    score: 1,
    ranking,
    acs: {
      ...acs,
      name: agent?.name || acs.name || "",
      description: agent?.description || acs.description || "",
      endPoints: acs.endPoints || acs.endpoints || [],
      skills: [skill],
    },
  };
}

async function resolveAcademicCandidates(settings, inferredRoles) {
  if (!inferredRoles.length) return { candidates: [], excludedAgentAics: [] };
  const response = await platformRequest(
    "/api/agent/public/recent?limit=100&with_users=false",
    { baseUrl: settings.baseUrl, timeoutSeconds: 30 },
  );
  const agents = Array.isArray(response?.items) ? response.items : [];
  const candidates = [];
  const missingRoles = [];
  const requiredSkillIds = new Set(inferredRoles.map((role) => ACADEMIC_ROLE_SKILL_IDS.get(role)));
  const allowedAgentAics = new Set();
  const eligibleAgents = agents.filter((agent) => {
    const isPublic = agent?.isPublic ?? agent?.is_public ?? true;
    const approvalStatus = String(agent?.approvalStatus || agent?.approval_status || "").toUpperCase();
    return isPublic !== false && (!approvalStatus || approvalStatus === "APPROVED");
  });

  for (const agent of eligibleAgents) {
    const skills = arrayValue(agent?.acs?.skills || agent?.skills || agent?.declaredSkills);
    const aic = String(agent?.aic || agent?.agentAic || agent?.acs?.aic || "").trim();
    if (aic && skills.some((skill) => requiredSkillIds.has(String(skill?.id || skill?.skillId || "").trim()))) {
      allowedAgentAics.add(aic);
    }
  }

  for (const role of inferredRoles) {
    const expectedSkillId = ACADEMIC_ROLE_SKILL_IDS.get(role);
    let match;
    for (const agent of eligibleAgents) {
      const skills = arrayValue(agent?.acs?.skills || agent?.skills || agent?.declaredSkills);
      const skill = skills.find((item) => String(item?.id || item?.skillId || "").trim() === expectedSkillId);
      const aic = String(agent?.aic || agent?.agentAic || agent?.acs?.aic || "").trim();
      if (skill && aic) {
        match = academicCandidate(agent, skill, candidates.length + 1);
        break;
      }
    }
    if (match) candidates.push(match);
    else missingRoles.push(role);
  }

  if (missingRoles.length) {
    throw new Error(`Required academic capabilities are unavailable: ${missingRoles.join(", ")}`);
  }
  const excludedAgentAics = eligibleAgents
    .map((agent) => String(agent?.aic || agent?.agentAic || agent?.acs?.aic || "").trim())
    .filter((aic) => aic && !allowedAgentAics.has(aic));
  return { candidates, excludedAgentAics };
}

function executionHints(args, inferredRoles) {
  const requested = args.hints && typeof args.hints === "object" ? args.hints : {};
  if (!inferredRoles.length) return requested;
  const requestedRoles = Array.isArray(requested.required_roles)
    ? requested.required_roles.map((role) => String(role || "").trim()).filter(Boolean)
    : [];
  return {
    ...requested,
    requires_independent_roles: requested.requires_independent_roles ?? true,
    parallelizable: requested.parallelizable ?? false,
    required_roles: Array.from(new Set([...requestedRoles, ...inferredRoles])),
  };
}

function artifactStage(artifact) {
  const artifactType = String(artifact?._artifactType || artifact?.artifact_type || "").toLowerCase();
  if (artifactType === "paper_draft") return "writing";
  if (artifactType === "literature_review") return "literature";
  if (artifactType === "abstract_draft") return "abstract";
  if (artifactType === "chart_asset") return "chart";
  if (artifactType === "latex_document") return "latex";
  const filename = String(
    artifact?.filename || artifact?.file_name || artifact?.name || "",
  ).toLowerCase();
  const agent = String(
    artifact?.agent_name || artifact?.agentName || artifact?.title || "",
  ).toLowerCase();
  if (filename === "paper.md" || agent.includes("writing")) return "writing";
  if (filename === "literature-review.md" || filename === "evidence-matrix.json" || agent.includes("literature")) return "literature";
  if (filename === "abstract.md" || agent.includes("abstract")) return "abstract";
  if (filename.startsWith("chart.") || agent.includes("chart")) return "chart";
  if (filename === "main.tex" || filename === "latex-diagnostics.json" || agent.includes("latex")) return "latex";
  return "artifacts";
}

function artifactFilename(artifact, index) {
  const raw = String(
    artifact?.filename || artifact?.file_name || artifact?.name || "",
  ).trim();
  const basename = path.basename(raw.replaceAll("\\", "/"));
  return safeSegment(basename, `artifact-${index + 1}.txt`);
}

function contentFromArtifact(artifact) {
  let content = artifact?.content ?? artifact?.text ?? artifact?.output_text ?? "";
  if (content && typeof content === "object") {
    content = JSON.stringify(content, null, 2);
  }
  return String(content || "");
}

function looksLikeHtmlDocument(content) {
  const text = String(content || "").trimStart();
  return /^<!doctype\s+html\b/i.test(text) || /^<html(?:\s|>)/i.test(text);
}

function expectedArtifactExtension(filename) {
  const normalized = String(filename || "").toLowerCase();
  return path.extname(normalized);
}

function validateArtifactDownload(artifact, content, contentType = "") {
  const filename = artifactFilename(artifact, 0);
  const expectedSha256 = String(artifact?.sha256 || artifact?.checksum || "").trim().toLowerCase();
  const expectedBytes = Number(artifact?.size_bytes ?? artifact?.sizeBytes ?? artifact?.bytes ?? NaN);
  const actualSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const actualBytes = Buffer.byteLength(content, "utf8");
  if (expectedSha256 && /^[a-f0-9]{64}$/.test(expectedSha256) && actualSha256 !== expectedSha256) {
    return { valid: false, reason: "sha256_mismatch", expectedSha256, actualSha256 };
  }
  if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && actualBytes !== expectedBytes) {
    return { valid: false, reason: "size_mismatch", expectedBytes, actualBytes };
  }
  const extension = expectedArtifactExtension(filename);
  const normalizedContentType = String(contentType || "").toLowerCase();
  if (looksLikeHtmlDocument(content) && extension !== ".html" && extension !== ".htm") {
    return { valid: false, reason: "unexpected_html_document", contentType: normalizedContentType };
  }
  if ((extension === ".json" || extension === ".tex" || extension === ".bib" || extension === ".md" || extension === ".txt" || extension === ".py")
      && normalizedContentType.includes("text/html")) {
    return { valid: false, reason: "unexpected_html_content_type", contentType: normalizedContentType };
  }
  return { valid: true, actualSha256, actualBytes };
}

function envelopeArtifacts(envelope) {
  const artifactType = String(envelope?.artifact_type || "");
  const content = envelope?.content;
  if (!artifactType || !content || typeof content !== "object" || Array.isArray(content)) return [];
  const base = { _artifactType: artifactType, agent_name: artifactType, source: "structured-envelope" };
  const artifacts = [];
  const add = (filename, value) => {
    if (value === undefined || value === null || value === "") return;
    artifacts.push({
      ...base,
      filename,
      content: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    });
  };
  if (artifactType === "paper_draft") add("paper.md", content.markdown || content.paper || content.body);
  if (artifactType === "literature_review") {
    add("literature-review.md", content.review_markdown || content.markdown);
    add("evidence-matrix.json", content.evidence_matrix || []);
    add("references.bib", content.bibtex || content.references_bib);
  }
  if (artifactType === "abstract_draft") {
    const lines = [];
    if (content.abstract) lines.push("# Abstract", "", String(content.abstract), "");
    if (Array.isArray(content.keywords) && content.keywords.length) {
      lines.push(`Keywords: ${content.keywords.join(", ")}`, "");
    }
    for (const variant of Array.isArray(content.variants) ? content.variants : []) {
      if (variant?.text) lines.push(`## ${variant.label || variant.language || "Variant"}`, "", String(variant.text), "");
    }
    add("abstract.md", lines.join("\n"));
  }
  if (artifactType === "chart_asset") add("chart-data.json", content);
  if (artifactType === "latex_document") {
    add("main.tex", content.main_tex);
    add("references.bib", content.references_bib);
    add("latex-diagnostics.json", content.diagnostics || []);
    add("manifest.json", {
      artifact_type: artifactType,
      task_id: envelope.task_id || "",
      status: envelope.status || "",
      compiled: false,
      source_files: envelope.files || [],
    });
  }
  return artifacts;
}

function collectArtifactCandidates(value, result = [], seen = new Set(), context = {}) {
  if (value === null || value === undefined) return result;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectArtifactCandidates(JSON.parse(trimmed), result, seen, context);
      } catch {
        // Ignore ordinary text that is not an artifact envelope.
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactCandidates(item, result, seen, context);
    return result;
  }
  if (typeof value !== "object") return result;

  const artifactType = String(value.artifact_type || context.artifactType || "");
  for (const artifact of envelopeArtifacts(value)) {
    const key = JSON.stringify([artifactType, artifact.filename, contentFromArtifact(artifact).slice(0, 300)]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(artifact);
    }
  }

  const filename = value.filename || value.file_name;
  const content = contentFromArtifact(value);
  const explicitDownload = value.download_url || value.downloadUrl || value.download_path || value.file_path;
  const hasFileShape = Boolean(
    filename || explicitDownload || value.path,
  );
  if (hasFileShape && (content || explicitDownload || value.path)) {
    const key = JSON.stringify([
      filename || value.name || "",
      content.slice(0, 300),
      explicitDownload || value.path || "",
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...value, ...(artifactType ? { _artifactType: artifactType } : {}) });
    }
  }
  for (const child of Object.values(value)) {
    if (child !== value) collectArtifactCandidates(child, result, seen, { artifactType });
  }
  return result;
}

async function fetchArtifactContent(artifact, settings, timeoutSeconds) {
  const inline = contentFromArtifact(artifact);
  if (inline) return { content: inline, source: "inline" };
  const rawUrl = String(
    artifact?.download_url || artifact?.downloadUrl || artifact?.download_path || artifact?.url || artifact?.uri || "",
  ).trim();
  if (!rawUrl) return { content: "", source: "missing" };
  const candidates = [];
  if (/^https?:\/\//i.test(rawUrl)) candidates.push(rawUrl);
  else {
    candidates.push(`${settings.modeRouterUrl}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`);
    candidates.push(`${settings.baseUrl}${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`);
  }
  let lastFailure = { source: "unavailable", url: rawUrl };
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      const requestHeaders = headers(settings, false);
      if (/^https?:\/\//i.test(url)) {
        const targetOrigin = new URL(url).origin;
        const allowedOrigins = new Set([
          new URL(settings.baseUrl).origin,
          new URL(settings.modeRouterUrl).origin,
        ]);
        if (!allowedOrigins.has(targetOrigin)) delete requestHeaders.Authorization;
      }
      const response = await fetch(url, { headers: requestHeaders, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const content = await response.text();
      const validation = validateArtifactDownload(artifact, content, response.headers.get("content-type") || "");
      if (!validation.valid) {
        lastFailure = { content: "", source: "invalid", url: rawUrl, reason: validation.reason, validation };
        continue;
      }
      return { content, source: "download", validation };
    } catch {
      // Try the next permitted platform URL.
    }
  }
  return lastFailure;
}

async function writeAtomic(filename, content) {
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filename);
}

async function saveExecutionArtifacts(response, task, outputDir, timeoutSeconds, requiredFiles = []) {
  const settings = config();
  const execution = response?.execution || {};
  const executionId = String(execution.execution_id || response?.execution_id || `exec-${Date.now()}`);
  const root = safeOutputDir(settings.outputRoot, outputDir);
  const target = path.join(root, safeSegment(executionId, `exec-${Date.now()}`));
  await mkdir(target, { recursive: true });
  const candidates = collectArtifactCandidates([
    execution.artifacts,
    response?.artifacts,
    ...(Array.isArray(execution.runs) ? execution.runs.map((run) => run.raw_response || run.output_text) : []),
  ]);
  const savedFiles = [];
  const unresolved = [];
  const duplicateArtifacts = [];
  const writtenKeys = new Set();
  const inlineKeys = new Set(
    candidates
      .filter((artifact) => contentFromArtifact(artifact))
      .map((artifact, index) => `${artifactStage(artifact)}/${artifactFilename(artifact, index)}`),
  );
  for (let index = 0; index < candidates.length; index += 1) {
    const artifact = candidates[index];
    const artifactKey = `${artifactStage(artifact)}/${artifactFilename(artifact, index)}`;
    if (!contentFromArtifact(artifact) && inlineKeys.has(artifactKey)) continue;
    const fetched = await fetchArtifactContent(artifact, settings, timeoutSeconds);
    const filename = artifactFilename(artifact, index);
    if (!fetched.content) {
      unresolved.push({ filename, url: fetched.url || "", reason: fetched.reason || fetched.source, validation: fetched.validation || undefined });
      continue;
    }
    const stage = artifactStage(artifact);
    const destination = path.join(target, stage, filename);
    const destinationKey = `${stage}/${filename}`;
    if (writtenKeys.has(destinationKey)) {
      duplicateArtifacts.push({ filename, stage, reason: "duplicate_filename" });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeAtomic(destination, fetched.content);
    writtenKeys.add(destinationKey);
    const sha256 = createHash("sha256").update(fetched.content, "utf8").digest("hex");
    savedFiles.push({
      path: path.relative(settings.outputRoot, destination).replaceAll("\\", "/"),
      filename,
      stage,
      bytes: Buffer.byteLength(fetched.content, "utf8"),
      sha256,
      source: fetched.source,
    });
  }
  const finalResult = String(response?.final_result || execution?.final_result || "").trim();
  if (finalResult) {
    const destination = path.join(target, "final-result.md");
    await writeAtomic(destination, `${finalResult}\n`);
    savedFiles.push({
      path: path.relative(settings.outputRoot, destination).replaceAll("\\", "/"),
      filename: "final-result.md",
      stage: "summary",
      bytes: Buffer.byteLength(finalResult, "utf8") + 1,
      sha256: createHash("sha256").update(`${finalResult}\n`, "utf8").digest("hex"),
      source: "orchestrator",
    });
  }
  const artifactFiles = savedFiles.filter((file) => file.source !== "orchestrator");
  const artifactFilesSaved = artifactFiles.length;
  const savedNames = new Set(artifactFiles.map((file) => file.filename));
  const normalizedRequired = Array.from(
    new Set(
      (Array.isArray(requiredFiles) ? requiredFiles : [])
        .map((item) => path.basename(String(item || "").trim()))
        .filter(Boolean),
    ),
  );
  const missingRequiredFiles = normalizedRequired.filter((filename) => !savedNames.has(filename));
  const unresolvedRequiredFiles = unresolved
    .map((item) => String(item.filename || ""))
    .filter((filename) => normalizedRequired.includes(filename) && !savedNames.has(filename));
  const manifest = {
    executionId,
    status: execution.status || response?.status || "unknown",
    task,
    outputDirectory: path.relative(settings.outputRoot, target).replaceAll("\\", "/"),
    savedFiles,
    unresolved,
    duplicateArtifacts,
    artifactCount: candidates.length,
    artifactFilesSaved,
    requiredFiles: normalizedRequired,
    missingRequiredFiles,
    unresolvedRequiredFiles,
    saveStatus: artifactFilesSaved > 0
      && unresolvedRequiredFiles.length === 0
      && missingRequiredFiles.length === 0
      ? "complete"
      : "incomplete",
  };
  await writeAtomic(path.join(target, "local-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, localDirectory: target };
}

const TOOLS = [
  {
    name: "renta_health",
    description: "Check whether the configured RenTA platform and Mode Router are reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "renta_list_agents",
    description: "List recently approved public RenTA Agents. Final dispatch eligibility is rechecked when a task executes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of Agents to return.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "renta_execute_task",
    description: "Ask RenTA to discover suitable Agents, execute a real single-Agent or multi-Agent task, and return the final result.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          description: "Complete objective, constraints, expected output, and acceptance criteria.",
        },
        dry_run: {
          type: "boolean",
          description: "Build a plan without calling Agents.",
          default: false,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        timeout_seconds: {
          type: "integer",
          minimum: 5,
          maximum: 1800,
          default: 180,
        },
        transport: {
          type: "string",
          enum: ["auto", "http_jsonrpc", "mq_inbox"],
          default: "auto",
        },
        hints: {
          type: "object",
          description: "Optional Mode Router hints such as requires_independent_roles or parallelizable.",
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "renta_execute_and_save",
    description: "Execute a real RenTA task (never a dry run), save returned file artifacts under the configured local workspace, write a SHA256 manifest, and return only verified paths.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          description: "Complete objective, constraints, expected output, and acceptance criteria.",
        },
        output_dir: {
          type: "string",
          default: "paper-demo-output",
          description: "Relative output directory inside the configured workspace.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        timeout_seconds: {
          type: "integer",
          minimum: 5,
          maximum: 1800,
          default: 600,
        },
        transport: {
          type: "string",
          enum: ["auto", "http_jsonrpc", "mq_inbox"],
          default: "auto",
        },
        hints: {
          type: "object",
          description: "Optional Mode Router hints such as requires_independent_roles or parallelizable.",
          additionalProperties: true,
        },
        required_files: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "File basenames that must be saved before the tool reports saveStatus=complete.",
        },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  if (name === "renta_health") {
    const settings = config();
    const health = await platformRequest("/health", {
      baseUrl: settings.modeRouterUrl,
      timeoutSeconds: 10,
    });
    const summary = {
      reachable: true,
      baseUrl: settings.baseUrl,
      modeRouter: health,
    };
    return resultText(`RenTA is reachable at ${settings.baseUrl}.`, summary);
  }

  if (name === "renta_list_agents") {
    const limit = boundedInteger(args.limit, 20, 1, 100);
    const response = await platformRequest(
      `/api/agent/public/recent?limit=${limit}&with_users=false`,
      { timeoutSeconds: 30 },
    );
    const rawItems = Array.isArray(response?.items) ? response.items : [];
    const agents = rawItems
      .map(agentSummary)
      .filter((agent) => agent.isPublic !== false);
    const summary = { agents, total: agents.length, requestedLimit: limit };
    return resultText(JSON.stringify(summary, null, 2), summary);
  }

  if (name === "renta_execute_task" || name === "renta_execute_and_save") {
    const task = String(args.task || "").trim();
    if (!task) throw new Error("task must be a non-empty string");
    const effectiveTask = name === "renta_execute_and_save"
      ? buildFileDeliveryTask(task, args.required_files)
      : task;
    const inferredRoles = name === "renta_execute_and_save"
      ? inferredAcademicRoles(args.required_files)
      : [];
    const settings = config();
    const academicPreflight = name === "renta_execute_and_save"
      ? await resolveAcademicCandidates(settings, inferredRoles)
      : { candidates: [], excludedAgentAics: [] };
    const timeoutSeconds = boundedInteger(
      args.timeout_seconds,
      settings.defaultTimeoutSeconds,
      5,
      1800,
    );
    const limit = boundedInteger(args.limit, inferredRoles.length || 20, 1, 100);
    const transport = String(args.transport || settings.defaultTransport || "auto");
    const payload = {
      task: effectiveTask,
      discovery_url: `${settings.baseUrl}/acps-adp-v2/discover`,
      requester_user_id: settings.requesterUserId,
      candidate_source: "registry",
      execution_transport: transport,
      dry_run: name === "renta_execute_task" && args.dry_run === true,
      save_report: false,
      limit,
      timeout: timeoutSeconds,
      agent_timeout: timeoutSeconds,
      execution_timeout: timeoutSeconds,
      hints: executionHints(args, inferredRoles),
    };
    if (academicPreflight.candidates.length) {
      payload.max_task_nodes = inferredRoles.length;
      payload.node_discovery_limit = 50;
      payload.exclude_agent_aics = academicPreflight.excludedAgentAics;
    }
    if (settings.registryUrl) payload.registry_url = settings.registryUrl;
    let response = await platformRequest("/orchestrator/execute", {
      baseUrl: settings.modeRouterUrl,
      method: "POST",
      body: payload,
      timeoutSeconds: timeoutSeconds + 10,
    });
    let summary = executionSummary(response, transport);
    if (name === "renta_execute_and_save") {
      let saved = await saveExecutionArtifacts(
        response,
        effectiveTask,
        args.output_dir,
        Math.min(timeoutSeconds, 60),
        args.required_files,
      );
      const attempts = [{
        executionId: saved.executionId,
        status: summary.status,
        saveStatus: saved.saveStatus,
        missingRequiredFiles: saved.missingRequiredFiles,
        unresolvedRequiredFiles: saved.unresolvedRequiredFiles,
      }];
      let best = { response, summary, saved };
      const requiredFiles = normalizedRequiredFiles(args.required_files);
      for (let attempt = 2; requiredFiles.length && saved.saveStatus !== "complete" && attempt <= settings.saveMaxAttempts; attempt += 1) {
        try {
          response = await platformRequest("/orchestrator/execute", {
            baseUrl: settings.modeRouterUrl,
            method: "POST",
            body: payload,
            timeoutSeconds: timeoutSeconds + 10,
          });
          summary = executionSummary(response, transport);
          saved = await saveExecutionArtifacts(
            response,
            effectiveTask,
            args.output_dir,
            Math.min(timeoutSeconds, 60),
            args.required_files,
          );
          attempts.push({
            executionId: saved.executionId,
            status: summary.status,
            saveStatus: saved.saveStatus,
            missingRequiredFiles: saved.missingRequiredFiles,
            unresolvedRequiredFiles: saved.unresolvedRequiredFiles,
          });
          if (deliveryScore(saved) > deliveryScore(best.saved)) best = { response, summary, saved };
        } catch (error) {
          attempts.push({
            executionId: "",
            status: "error",
            saveStatus: "not_saved",
            missingRequiredFiles: [],
            unresolvedRequiredFiles: [],
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
      ({ response, summary, saved } = best);
      const { localDirectory: manifestDirectory, ...selectedManifest } = saved;
      await writeAtomic(
        path.join(manifestDirectory, "local-manifest.json"),
        `${JSON.stringify({ ...selectedManifest, attempts }, null, 2)}\n`,
      );
      const { finalResult: _platformFinalResult, ...publicExecutionSummary } = summary;
      const saveSummary = { ...publicExecutionSummary, ...saved, attempts };
      const attemptText = attempts.length > 1 ? ` after ${attempts.length} attempts` : "";
      const text = saved.saveStatus === "complete"
        ? `RenTA execution ${saved.executionId} completed${attemptText} and saved ${saved.artifactFilesSaved} verified artifact file(s) under ${saved.outputDirectory}. Manifest: ${saved.outputDirectory}/local-manifest.json`
        : `RenTA execution ${saved.executionId} returned${attemptText}, but local artifact saving is incomplete. Saved ${saved.artifactFilesSaved} artifact file(s); unresolved required files: ${saved.unresolvedRequiredFiles.join(", ") || "none"}; missing required files: ${saved.missingRequiredFiles.join(", ") || "none"}. See ${saved.outputDirectory}/local-manifest.json.`;
      return resultText(text, saveSummary);
    }
    const text = summary.finalResult || JSON.stringify(summary, null, 2);
    return resultText(text, summary);
  }

  throw new Error(`Unknown RenTA tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  const { id, method, params = {} } = message;
  if (method.startsWith("notifications/")) return;

  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "Use RenTA tools to discover platform Agents and return real orchestration results.",
      });
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      try {
        sendResult(id, await callTool(params.name, params.arguments || {}));
      } catch (error) {
        sendResult(id, toolError(error));
      }
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    sendError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

let inputBuffer = Buffer.alloc(0);

function consumeInput() {
  while (inputBuffer.length) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (inputBuffer.toString("utf8", 0, Math.min(inputBuffer.length, 32)).startsWith("Content-Length:")) {
      if (headerEnd < 0) return;
      const headersText = inputBuffer.toString("utf8", 0, headerEnd);
      const match = headersText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (inputBuffer.length < bodyStart + length) return;
      const body = inputBuffer.toString("utf8", bodyStart, bodyStart + length);
      inputBuffer = inputBuffer.subarray(bodyStart + length);
      try {
        void handleMessage(JSON.parse(body));
      } catch (error) {
        process.stderr.write(`Invalid MCP message: ${error.message}\n`);
      }
      continue;
    }

    const lineEnd = inputBuffer.indexOf("\n");
    if (lineEnd < 0) return;
    const line = inputBuffer.toString("utf8", 0, lineEnd).trim();
    inputBuffer = inputBuffer.subarray(lineEnd + 1);
    if (!line) continue;
    try {
      void handleMessage(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`Invalid MCP message: ${error.message}\n`);
    }
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  consumeInput();
});
process.stdin.on("error", (error) => {
  process.stderr.write(`MCP stdin error: ${error.message}\n`);
});
