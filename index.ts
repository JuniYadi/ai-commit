#!/usr/bin/env bun
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

type CommitCliOptions = {
  mode: "commit";
  branch?: string;
  currentBranch: boolean;
  base?: string;
  model: string;
  apiKey?: string;
  baseUrl: string;
  providerName: string;
  apiMode: ApiMode;
  responsesPath: string;
  remote: string;
  noPr: boolean;
  dryRun: boolean;
};

type SkillAction = "install" | "update" | "remove";
type SkillScope = "repo" | "user";
type SkillAgent = "codex" | "claude" | "generic";

type SkillCliOptions = {
  mode: "skill";
  skill: {
    action: SkillAction;
    scope: SkillScope;
    agent: SkillAgent;
    file?: string;
    name?: string;
    force: boolean;
  };
};

type CliOptions = CommitCliOptions | SkillCliOptions;

type AiMetadata = {
  commitMessage: string;
  prTitle: string;
  prBody: string;
};

type ApiMode = "chat" | "responses";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_RESPONSES_PATH = "/responses";

async function main() {
  const argv = Bun.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const options = parseArgs(argv);

  if (options.mode === "skill") {
    await runSkillCommand(options.skill);
    return;
  }

  await ensureToolExists("git");
  if (!options.noPr) {
    await ensureToolExists("gh");
  }

  await assertInsideGitRepo();

  const startingBranch = await getCurrentBranch();
  if (!startingBranch) {
    throw new Error(
      "No current branch detected (detached HEAD). Switch to a branch first or pass --branch.",
    );
  }

  const baseBranch = await resolveBaseBranch(options.base, options.remote, startingBranch);

  let workingBranch: string;
  if (options.currentBranch) {
    workingBranch = startingBranch;
    console.log(`Using current branch: ${workingBranch}`);
  } else {
    if (!options.branch) {
      throw new Error("Missing required flag: --branch <name> (or use --current-branch).");
    }
    await checkoutBranch(options.branch);
    workingBranch = options.branch;
  }

  if (!options.noPr && baseBranch === workingBranch) {
    throw new Error(
      `Base branch '${baseBranch}' cannot be the same as the working branch '${workingBranch}'. Pass --base explicitly or use --no-pr.`,
    );
  }

  await runGit(["add", "-A"]);

  const stagedFiles = await runGit(["diff", "--cached", "--name-only"]);
  if (!stagedFiles.trim()) {
    console.log("No staged changes after git add -A. Nothing to commit.");
    return;
  }

  const statusShort = await runGit(["status", "--short"]);
  const diffStat = await runGit(["diff", "--cached", "--stat"]);
  const diffPatchRaw = await runGit(["diff", "--cached", "--no-color"]);
  const diffPatch = truncate(diffPatchRaw, 18000);

  const aiMetadata = await generateAiMetadata({
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    providerName: options.providerName,
    apiMode: options.apiMode,
    responsesPath: options.responsesPath,
    branch: workingBranch,
    baseBranch,
    statusShort,
    diffStat,
    diffPatch,
  });

  console.log("\nAI-generated metadata:");
  console.log(`commit: ${aiMetadata.commitMessage}`);
  console.log(`prTitle: ${aiMetadata.prTitle}`);

  if (options.dryRun) {
    console.log("\nDry run enabled. Skipping commit/push/pr create.");
    console.log("\nPR body:\n");
    console.log(aiMetadata.prBody);
    return;
  }

  await runGit(["commit", "-m", aiMetadata.commitMessage], { stream: true });
  await runGit(["push", "-u", options.remote, workingBranch], { stream: true });

  if (!options.noPr) {
    await createPullRequest({
      baseBranch,
      branch: workingBranch,
      title: aiMetadata.prTitle,
      body: aiMetadata.prBody,
    });
  }

  console.log("\nDone.");
}

function parseArgs(argv: string[]): CliOptions {
  let branch: string | undefined;
  let currentBranch = false;
  let base: string | undefined;
  let model = getEnv("AI_COMMIT_MODEL", "OPENAI_MODEL") ?? DEFAULT_MODEL;
  let apiKey = getEnv("AI_COMMIT_API_KEY", "OPENAI_API_KEY");
  let baseUrl =
    getEnv(
      "AI_COMMIT_BASE_URL",
      "AI_COMMIT_API_URL",
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE_URL",
    ) ?? DEFAULT_BASE_URL;
  let providerName = getEnv("AI_COMMIT_PROVIDER_NAME") ?? "openai-compatible";
  let apiMode = resolveApiMode(
    getEnv("AI_COMMIT_API_MODE", "OPENAI_API_MODE"),
    getEnv("AI_COMMIT_USE_RESPONSES_API", "OPENAI_USE_RESPONSES_API"),
  );
  let responsesPath =
    getEnv("AI_COMMIT_RESPONSES_PATH", "OPENAI_RESPONSES_PATH") ??
    DEFAULT_RESPONSES_PATH;
  let remote = "origin";
  let noPr = false;
  let dryRun = false;
  let skillAction: SkillAction | undefined;
  let skillScope: SkillScope | undefined;
  let skillAgent: SkillAgent = "generic";
  let skillFile: string | undefined;
  let skillName: string | undefined;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--no-pr") {
      noPr = true;
      continue;
    }

    if (arg === "--current-branch") {
      currentBranch = true;
      noPr = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    const [flag, inlineValue] = splitFlag(arg);
    const value = inlineValue ?? argv[index + 1];

    if (flag === "--skill") {
      skillAction = parseSkillAction(requireValue(flag, value), flag);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--scope") {
      skillScope = parseSkillScope(requireValue(flag, value), flag);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--agent") {
      skillAgent = parseSkillAgent(requireValue(flag, value), flag);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--file") {
      skillFile = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--name") {
      skillName = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--branch") {
      branch = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--base") {
      base = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--model") {
      model = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--api-key") {
      apiKey = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--base-url") {
      baseUrl = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--api-mode") {
      apiMode = parseApiMode(requireValue(flag, value), flag);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--responses-path") {
      responsesPath = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--provider-name") {
      providerName = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    if (flag === "--remote") {
      remote = requireValue(flag, value);
      if (!inlineValue) {
        index += 1;
      }
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  if (skillAction) {
    if (branch || currentBranch || base || noPr || dryRun) {
      throw new Error("`--skill` cannot be combined with branch/commit flags.");
    }
    if (!skillScope) {
      throw new Error("Missing required flag for --skill: --scope <repo|user>.");
    }
    if ((skillAction === "install" || skillAction === "update") && !skillFile) {
      throw new Error(`--skill ${skillAction} requires --file <path/to/skill.md>.`);
    }
    if (skillAction === "remove" && !skillName) {
      throw new Error("--skill remove requires --name <skill-name>.");
    }

    return {
      mode: "skill",
      skill: {
        action: skillAction,
        scope: skillScope,
        agent: skillAgent,
        file: skillFile,
        name: skillName,
        force,
      },
    };
  }

  if (skillScope || skillFile || skillName || force || skillAgent !== "generic") {
    throw new Error("`--scope`, `--agent`, `--file`, `--name`, and `--force` require `--skill`.");
  }

  if (!branch && !currentBranch) {
    throw new Error("Missing required flag: --branch <name> (or use --current-branch).");
  }

  return {
    mode: "commit",
    branch,
    currentBranch,
    base,
    model,
    apiKey,
    baseUrl,
    providerName,
    apiMode,
    responsesPath,
    remote,
    noPr,
    dryRun,
  };
}

function parseSkillAction(value: string, source: string): SkillAction {
  const normalized = value.trim().toLowerCase();
  if (normalized === "install" || normalized === "update" || normalized === "remove") {
    return normalized;
  }
  throw new Error(`Invalid ${source}: '${value}'. Use install, update, or remove.`);
}

function parseSkillScope(value: string, source: string): SkillScope {
  const normalized = value.trim().toLowerCase();
  if (normalized === "repo" || normalized === "user") {
    return normalized;
  }
  throw new Error(`Invalid ${source}: '${value}'. Use repo or user.`);
}

function parseSkillAgent(value: string, source: string): SkillAgent {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude" || normalized === "generic") {
    return normalized;
  }
  throw new Error(`Invalid ${source}: '${value}'. Use codex, claude, or generic.`);
}

function getEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = Bun.env[key];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseApiMode(value: string, source = "api mode"): ApiMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "chat" || normalized === "completions" || normalized === "chat-completions") {
    return "chat";
  }
  if (normalized === "responses" || normalized === "response") {
    return "responses";
  }
  throw new Error(`Invalid ${source}: '${value}'. Use 'chat' or 'responses'.`);
}

function resolveApiMode(apiModeValue: string | undefined, useResponsesValue: string | undefined): ApiMode {
  if (apiModeValue) {
    return parseApiMode(apiModeValue, "AI_COMMIT_API_MODE/OPENAI_API_MODE");
  }

  if (!useResponsesValue) {
    return "chat";
  }

  const normalized = useResponsesValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return "responses";
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return "chat";
  }

  throw new Error(
    `Invalid AI_COMMIT_USE_RESPONSES_API/OPENAI_USE_RESPONSES_API value: '${useResponsesValue}'. Use true/false.`,
  );
}

function splitFlag(arg: string): [string, string | undefined] {
  const equalIndex = arg.indexOf("=");
  if (equalIndex === -1) {
    return [arg, undefined];
  }

  const flag = arg.slice(0, equalIndex);
  const value = arg.slice(equalIndex + 1);
  return [flag, value];
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function runSkillCommand(options: SkillCliOptions["skill"]): Promise<void> {
  const targetDir = resolveSkillDirectory(options.scope, options.agent);

  if (options.action === "remove") {
    const normalizedName = normalizeSkillName(options.name ?? "");
    const targetPath = join(targetDir, `${normalizedName}.md`);
    const exists = await pathExists(targetPath);
    if (!exists) {
      if (options.force) {
        console.log(`Skill '${normalizedName}' not found at ${targetPath}. Nothing to remove.`);
        return;
      }
      throw new Error(`Skill '${normalizedName}' not found at ${targetPath}.`);
    }

    await rm(targetPath);
    console.log(`Removed skill '${normalizedName}' from ${targetPath}`);
    return;
  }

  const sourcePath = resolve(options.file ?? "");
  const sourceInfo = await stat(sourcePath).catch(() => null);
  if (!sourceInfo || !sourceInfo.isFile()) {
    throw new Error(`Skill source file not found: ${sourcePath}`);
  }

  const content = await readFile(sourcePath, "utf8");
  const metadata = parseSkillFrontmatter(content);
  if (!metadata.name) {
    throw new Error("Skill markdown must include frontmatter field: name");
  }
  if (!metadata.description) {
    throw new Error("Skill markdown must include frontmatter field: description");
  }

  const normalizedName = normalizeSkillName(options.name ?? metadata.name);
  const targetPath = join(targetDir, `${normalizedName}.md`);
  const exists = await pathExists(targetPath);

  if (options.action === "install" && exists && !options.force) {
    throw new Error(`Skill '${normalizedName}' already exists at ${targetPath}. Use --force to overwrite.`);
  }

  if (options.action === "update" && !exists && !options.force) {
    throw new Error(`Skill '${normalizedName}' does not exist at ${targetPath}. Use --force to create.`);
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");

  if (options.action === "install") {
    console.log(`Installed skill '${normalizedName}' to ${targetPath}`);
    return;
  }

  if (exists) {
    console.log(`Updated skill '${normalizedName}' at ${targetPath}`);
    return;
  }

  console.log(`Created skill '${normalizedName}' at ${targetPath}`);
}

function resolveSkillDirectory(scope: SkillScope, agent: SkillAgent): string {
  const root = scope === "repo" ? process.cwd() : homedir();
  const relative = getSkillRelativeDirectory(agent);
  return resolve(root, relative);
}

function getSkillRelativeDirectory(agent: SkillAgent): string {
  if (agent === "codex") {
    return ".codex/skills";
  }
  if (agent === "claude") {
    return ".claude/skills";
  }
  return ".skills";
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("Skill markdown must start with YAML frontmatter (--- ... ---).");
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex < 1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']/, "").replace(/["']$/, "").trim();
    if (key && value) {
      fields[key] = value;
    }
  }

  return {
    name: fields.name,
    description: fields.description,
  };
}

function normalizeSkillName(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Skill name cannot be empty.");
  }

  const fromFilename = trimmed.replace(extname(trimmed), "");
  const normalized = fromFilename.toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9._-]+$/.test(normalized) || normalized.includes("..") || /[\\/]/.test(normalized)) {
    throw new Error(
      `Invalid skill name '${rawValue}'. Use letters, numbers, dot, underscore, and dash only.`,
    );
  }
  return normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureToolExists(name: string): Promise<void> {
  const result = await runCommand(["which", name]);
  if (result.exitCode !== 0) {
    throw new Error(`Required command not found: ${name}`);
  }
}

async function assertInsideGitRepo(): Promise<void> {
  const result = await runCommand(["git", "rev-parse", "--is-inside-work-tree"]);
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("Current directory is not a git repository.");
  }
}

async function getCurrentBranch(): Promise<string> {
  return runGit(["branch", "--show-current"]);
}

async function resolveBaseBranch(
  explicitBase: string | undefined,
  remote: string,
  fallbackCurrentBranch: string,
): Promise<string> {
  if (explicitBase) {
    return explicitBase;
  }

  const remoteHead = await runCommand([
    "git",
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  if (remoteHead.exitCode === 0) {
    const value = remoteHead.stdout.trim();
    const prefix = `${remote}/`;
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return value.slice(prefix.length);
    }
  }

  if (fallbackCurrentBranch) {
    return fallbackCurrentBranch;
  }

  throw new Error("Unable to detect base branch. Pass --base explicitly.");
}

async function checkoutBranch(branch: string): Promise<void> {
  const existing = await runCommand(["git", "rev-parse", "--verify", branch]);

  if (existing.exitCode === 0) {
    await runGit(["switch", branch], { stream: true });
    return;
  }

  await runGit(["switch", "-c", branch], { stream: true });
}

async function createPullRequest(options: {
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
}): Promise<void> {
  const args = [
    "gh",
    "pr",
    "create",
    "--base",
    options.baseBranch,
    "--head",
    options.branch,
    "--title",
    options.title,
    "--body",
    options.body,
  ];

  const result = await runCommand(args);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("already exists") || result.stdout.includes("already exists")) {
      console.log("PR already exists for this branch. Skipping pr create.");
      return;
    }

    throw new Error(
      `Failed to create pull request.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const url = result.stdout.trim();
  if (url) {
    console.log(`PR created: ${url}`);
  }
}

async function generateAiMetadata(input: {
  model: string;
  apiKey?: string;
  baseUrl: string;
  providerName: string;
  apiMode: ApiMode;
  responsesPath: string;
  branch: string;
  baseBranch: string;
  statusShort: string;
  diffStat: string;
  diffPatch: string;
}): Promise<AiMetadata> {
  const mockMetadata = Bun.env.AI_COMMIT_MOCK_METADATA_JSON;
  if (mockMetadata) {
    const parsedMock = tryParse(mockMetadata);
    if (!parsedMock) {
      throw new Error("AI_COMMIT_MOCK_METADATA_JSON is set but not valid JSON metadata.");
    }
    return parsedMock;
  }

  if (!input.apiKey) {
    throw new Error(
      "Missing API key. Set OPENAI_API_KEY or AI_COMMIT_API_KEY, or pass --api-key.",
    );
  }

  const provider = createOpenAICompatible({
    name: input.providerName,
    apiKey: input.apiKey,
    baseURL: input.baseUrl,
  });

  const prompt = [
    "You generate git commit and pull request metadata.",
    "Return STRICT JSON only. No markdown, no code fence, no extra text.",
    'JSON shape: {"commitMessage":"...","prTitle":"...","prBody":"..."}',
    "Rules:",
    "- commitMessage: single line, <= 72 chars, imperative mood.",
    "- prTitle: single line, <= 72 chars.",
    "- prBody: markdown with sections '## Summary' and '## Changes'.",
    "- Content must be based only on provided git diff.",
    "",
    `Base branch: ${input.baseBranch}`,
    `Feature branch: ${input.branch}`,
    "",
    "Git status --short:",
    input.statusShort || "(empty)",
    "",
    "Git diff --cached --stat:",
    input.diffStat || "(empty)",
    "",
    "Git diff --cached --no-color (truncated):",
    input.diffPatch || "(empty)",
  ].join("\n");

  if (input.apiMode === "responses") {
    const rawText = await generateTextViaResponsesApi({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      responsesPath: input.responsesPath,
      model: input.model,
      prompt,
    });
    return parseAiMetadata(rawText);
  }

  const response = await generateText({
    model: provider(input.model),
    prompt,
    temperature: 0.2,
  });

  return parseAiMetadata(response.text);
}

async function generateTextViaResponsesApi(input: {
  apiKey: string;
  baseUrl: string;
  responsesPath: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const url = resolveUrl(input.baseUrl, input.responsesPath);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      input: input.prompt,
      temperature: 0.2,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Responses API request failed (${response.status} ${response.statusText}).\nbody:\n${truncate(bodyText, 4000)}`,
    );
  }

  const parsed = safeParseJson(bodyText);
  if (!parsed) {
    throw new Error("Responses API returned non-JSON body.");
  }

  const outputText = extractResponsesOutputText(parsed);
  if (outputText) {
    return outputText;
  }

  throw new Error("Responses API returned no text output.");
}

function resolveUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractResponsesOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    output_text?: unknown;
    output?: unknown;
  };

  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }

  if (!Array.isArray(record.output)) {
    return null;
  }

  const chunks: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const maybeText = (part as { text?: unknown }).text;
      if (typeof maybeText === "string" && maybeText.trim()) {
        chunks.push(maybeText.trim());
      }
    }
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.join("\n");
}

function parseAiMetadata(rawText: string): AiMetadata {
  const candidate = rawText.trim();
  const direct = tryParse(candidate);
  if (direct) {
    return direct;
  }

  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const extracted = tryParse(jsonMatch[0]);
    if (extracted) {
      return extracted;
    }
  }

  const oneLine = sanitizeOneLine(candidate) || "chore: update project files";
  return {
    commitMessage: clamp(oneLine, 72),
    prTitle: clamp(oneLine, 72),
    prBody: "## Summary\n- Automated update\n\n## Changes\n- Updated repository files",
  };
}

function tryParse(text: string): AiMetadata | null {
  try {
    const parsed = JSON.parse(text) as Partial<AiMetadata>;
    if (
      typeof parsed.commitMessage !== "string" ||
      typeof parsed.prTitle !== "string" ||
      typeof parsed.prBody !== "string"
    ) {
      return null;
    }

    const commitMessage = clamp(sanitizeOneLine(parsed.commitMessage), 72);
    const prTitle = clamp(sanitizeOneLine(parsed.prTitle), 72);
    const prBody = parsed.prBody.trim();

    if (!commitMessage || !prTitle || !prBody) {
      return null;
    }

    return {
      commitMessage,
      prTitle,
      prBody,
    };
  } catch {
    return null;
  }
}

function sanitizeOneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n[TRUNCATED]`;
}

function clamp(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength).trim();
}

type RunOptions = {
  stream?: boolean;
};

async function runGit(args: string[], options: RunOptions = {}): Promise<string> {
  const command = ["git", ...args];
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trimEnd();
}

async function runCommand(
  cmd: string[],
  options: RunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: options.stream ? "inherit" : "pipe",
    stderr: options.stream ? "inherit" : "pipe",
    stdin: "ignore",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    options.stream || !proc.stdout
      ? Promise.resolve("")
      : new Response(proc.stdout).text(),
    options.stream || !proc.stderr
      ? Promise.resolve("")
      : new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function printHelp(): void {
  console.log(`ai-commit

Usage:
  ai-commit (--branch <name> | --current-branch) [options]
  ai-commit --skill <install|update|remove> --scope <repo|user> [options]

Required:
  --branch <name>         Branch to create/switch and push
  --current-branch        Commit/push current branch and skip PR creation
  --skill <action>        Optional skill manager: install | update | remove

Options:
  --base <branch>         Base branch for PR (default: remote HEAD, then current branch)
  --model <model>         Model id (default: gpt-4o-mini)
  --api-key <key>         API key (or OPENAI_API_KEY / AI_COMMIT_API_KEY)
  --base-url <url>        OpenAI-compatible base URL (default: https://api.openai.com/v1)
  --provider-name <name>  Provider name label for AI SDK (default: openai-compatible)
  --api-mode <mode>       AI API mode: chat | responses (default: chat)
  --responses-path <path> Responses API path (default: /responses)
  --remote <name>         Git remote name (default: origin)
  --no-pr                 Skip creating pull request
  --dry-run               Generate AI text but skip commit/push/pr
  --scope <repo|user>     Skill target scope (required for --skill)
  --agent <name>          Skill agent: codex | claude | generic (default: generic)
  --file <path>           Skill markdown source (required for install/update)
  --name <name>           Skill name; also target filename without .md
  --force                 Overwrite existing skill for install/update; ignore missing on remove
  -h, --help              Show this help
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
