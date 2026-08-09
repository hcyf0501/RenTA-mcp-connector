#!/usr/bin/env node

import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);

if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  throw new Error(`Node.js 18 or later is required; found ${process.version}.`);
}

function usage() {
  console.log("Usage: node scripts/install-local.mjs [--codex-home <path>]");
}

function parseArgs(argv) {
  let codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument === "--codex-home") {
      codexHome = argv[++index];
      if (!codexHome) throw new Error("--codex-home requires a path.");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return path.resolve(codexHome);
}

function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

async function ensureEnvironment() {
  const envPath = path.join(root, "config", ".env");
  const examplePath = path.join(root, "config", ".env.example");
  try {
    await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await copyFile(examplePath, envPath);
    try {
      await chmod(envPath, 0o600);
    } catch {
      // Windows does not expose POSIX file modes; the file remains local and Git-ignored.
    }
    console.log(`Created ${envPath}. Fill in its placeholders, then run this command again.`);
    return false;
  }

  const values = parseEnv(await readFile(envPath, "utf8"));
  const missing = ["RENTA_BASE_URL", "RENTA_REQUESTER_USER_ID"].filter((name) => {
    const value = values.get(name) || "";
    return !value || value.includes("example.com") || value.includes("replace-with");
  });
  if (missing.length) {
    throw new Error(`Fill these config/.env values before installing: ${missing.join(", ")}`);
  }
  return true;
}

function tomlPath(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function install(codexHome) {
  if (!(await ensureEnvironment())) return;

  const configPath = path.join(codexHome, "config.toml");
  await mkdir(codexHome, { recursive: true });
  let current = "";
  try {
    current = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (/^\[mcp_servers\.renta-platform\]$/m.test(current)) {
    console.log(`RenTA is already configured in ${configPath}. No changes made.`);
    return;
  }

  const serverPath = tomlPath(path.join(root, "mcp", "server.mjs"));
  const skillPath = tomlPath(path.join(root, "skills", "renta-escalation", "SKILL.md"));
  const block = `

# BEGIN renta-mcp-connector
[mcp_servers.renta-platform]
command = "node"
args = ["${serverPath}"]
default_tools_approval_mode = "approve"

[[skills.config]]
path = "${skillPath}"
enabled = true
# END renta-mcp-connector
`;
  await writeFile(configPath, `${current.replace(/\s*$/, "")}${block}`, "utf8");
  console.log(`RenTA MCP and the escalation Skill were added to ${configPath}. Start a new Codex session.`);
}

install(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
