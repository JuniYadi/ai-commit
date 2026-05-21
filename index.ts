#!/usr/bin/env bun
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
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
  debug: boolean;
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
type StagedFileDiff = {
  path: string;
  patch: string;
};
type FileDiffSummary = {
  path: string;
  summary: string;
};

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_RESPONSES_PATH = "/responses";
const DEFAULT_CHAT_COMPLETIONS_PATH = "/chat/completions";
const DEFAULT_DIFF_PATCH_MAX_LENGTH = 6000;
const DEFAULT_DIFF_SUMMARY_CONCURRENCY = 4;

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

  debugLog(options.debug, "Starting ai-commit in debug mode.");
  debugLog(options.debug, `API mode=${options.apiMode} baseUrl=${options.baseUrl}`);

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
  const stagedPaths = stagedFiles
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (stagedPaths.length === 0) {
    console.log("No staged changes after git add -A. Nothing to commit.");
    return;
  }

  const statusShort = await runGit(["status", "--short"]);
  const diffStat = await runGit(["diff", "--cached", "--stat"]);
  const stagedDiffs = await collectStagedFileDiffs({
    stagedPaths,
    maxPatchLength: DEFAULT_DIFF_PATCH_MAX_LENGTH,
  });

  const aiMetadata = await generateAiMetadata({
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    providerName: options.providerName,
    apiMode: options.apiMode,
    responsesPath: options.responsesPath,
    debug: options.debug,
    branch: workingBranch,
    baseBranch,
    statusShort,
    diffStat,
    stagedDiffs,
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
  let debug = parseBooleanEnv(Bun.env.AI_COMMIT_DEBUG);
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

    if (arg === "--debug") {
      debug = true;
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
    if (branch || currentBranch || base || noPr || dryRun || debug) {
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
    debug,
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

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid AI_COMMIT_DEBUG value: '${value}'. Use true/false.`);
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
  const frontmatterBlock = match?.[1];
  if (!frontmatterBlock) {
    throw new Error("Skill markdown must start with YAML frontmatter (--- ... ---).");
  }

  const fields: Record<string, string> = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
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
  debug: boolean;
  branch: string;
  baseBranch: string;
  statusShort: string;
  diffStat: string;
  stagedDiffs: StagedFileDiff[];
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

  if (input.stagedDiffs.length === 0) {
    throw new Error("No staged diff content found.");
  }

  try {
    if (input.apiMode === "chat") {
      return await generateAiMetadataViaToolWorkflow(input);
    }
  } catch (error) {
    debugLog(
      input.debug,
      `Tool workflow failed (${error instanceof Error ? error.message : String(error)}). Falling back to direct summaries.`,
    );
  }

  const fileSummaries = await summarizeStagedDiffs({
    ...input,
    stagedDiffs: input.stagedDiffs,
  });
  const metadataPrompt = buildMetadataPrompt({
    branch: input.branch,
    baseBranch: input.baseBranch,
    statusShort: input.statusShort,
    diffStat: input.diffStat,
    summaries: fileSummaries,
  });

  if (input.apiMode === "responses") {
    const rawText = await generateTextViaResponsesApi({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      responsesPath: input.responsesPath,
      model: input.model,
      prompt: metadataPrompt,
      debug: input.debug,
    });
    return parseAiMetadata(rawText);
  }

  const rawText = await generateTextViaChatCompletionsApi({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    prompt: metadataPrompt,
    model: input.model,
    providerName: input.providerName,
    debug: input.debug,
  });
  return parseAiMetadata(rawText);
}

async function generateAiMetadataViaToolWorkflow(input: {
  model: string;
  apiKey: string;
  baseUrl: string;
  providerName: string;
  apiMode: ApiMode;
  responsesPath: string;
  debug: boolean;
  branch: string;
  baseBranch: string;
  statusShort: string;
  diffStat: string;
  stagedDiffs: StagedFileDiff[];
}): Promise<AiMetadata> {
  const provider = createOpenAICompatible({
    baseURL: input.baseUrl,
    name: input.providerName,
    apiKey: input.apiKey,
    fetch: createDebugFetch(input.debug),
  });

  const diffMap = new Map(input.stagedDiffs.map((diff) => [diff.path, diff] as const));
  const stagedFilesList = input.stagedDiffs.map((diff) => diff.path);

  const toolPrompt = [
    "You generate git commit and pull request metadata.",
    "First call summarize_diffs exactly once using all staged files, then respond with STRICT JSON only.",
    'JSON shape: {"commitMessage":"...","prTitle":"...","prBody":"..."}',
    "Rules:",
    "- commitMessage: single line, <= 72 chars, imperative mood.",
    "- prTitle: single line, <= 72 chars.",
    "- prBody: markdown with sections '## Summary' and '## Changes'.",
    "- Content must be based only on git status, diff stat, and tool summaries.",
    "",
    `Base branch: ${input.baseBranch}`,
    `Feature branch: ${input.branch}`,
    "",
    "Staged files:",
    ...stagedFilesList.map((filePath) => `- ${filePath}`),
    "",
    "Git status --short:",
    input.statusShort || "(empty)",
    "",
    "Git diff --cached --stat:",
    input.diffStat || "(empty)",
  ].join("\n");

  const { text } = await generateText({
    model: provider.chatModel(input.model),
    prompt: toolPrompt,
    temperature: 0.2,
    toolChoice: { type: "tool", toolName: "summarize_diffs" },
    stopWhen: stepCountIs(3),
    tools: {
      summarize_diffs: tool({
        description: "Summarize staged git diffs per file for commit and PR generation.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            files: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
              description: "List of staged file paths to summarize.",
            },
          },
          required: ["files"],
          additionalProperties: false,
        }),
        execute: async ({ files }) => {
          const selected = Array.isArray(files)
            ? files
                .map((value) => String(value).trim())
                .filter((value) => value && diffMap.has(value))
            : [];
          const effectiveFiles = selected.length > 0 ? selected : stagedFilesList;
          const targetDiffs = effectiveFiles
            .map((filePath) => diffMap.get(filePath))
            .filter((value): value is StagedFileDiff => Boolean(value));
          const summaries = await summarizeStagedDiffs({
            ...input,
            stagedDiffs: targetDiffs,
          });
          return { summaries };
        },
      }),
    },
  });

  return parseAiMetadata(text);
}

async function summarizeStagedDiffs(input: {
  model: string;
  apiKey: string;
  baseUrl: string;
  providerName: string;
  apiMode: ApiMode;
  responsesPath: string;
  debug: boolean;
  stagedDiffs: StagedFileDiff[];
}): Promise<FileDiffSummary[]> {
  const concurrency = resolveSummaryConcurrency();
  return mapWithConcurrency(input.stagedDiffs, concurrency, async (diff) => {
    const summary = await summarizeSingleDiff({ ...input, diff });
    return { path: diff.path, summary };
  });
}

async function summarizeSingleDiff(input: {
  model: string;
  apiKey: string;
  baseUrl: string;
  providerName: string;
  apiMode: ApiMode;
  responsesPath: string;
  debug: boolean;
  diff: StagedFileDiff;
}): Promise<string> {
  const summaryPrompt = [
    "Summarize the staged git diff for one file.",
    "Return plain text only.",
    "Rules:",
    "- 1 sentence only.",
    "- Max 180 characters.",
    "- Mention concrete behavior or content changes, not generic wording.",
    "",
    `File: ${input.diff.path}`,
    "",
    "Diff:",
    input.diff.patch || "(empty)",
  ].join("\n");

  const rawText =
    input.apiMode === "responses"
      ? await generateTextViaResponsesApi({
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          responsesPath: input.responsesPath,
          model: input.model,
          prompt: summaryPrompt,
          debug: input.debug,
        })
      : await generateTextViaChatCompletionsApi({
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          prompt: summaryPrompt,
          model: input.model,
          providerName: input.providerName,
          debug: input.debug,
        });

  const cleaned = sanitizeOneLine(rawText).replace(/^-+\s*/, "");
  if (cleaned) {
    return clamp(cleaned, 180);
  }
  return `Updated ${input.diff.path}.`;
}

function buildMetadataPrompt(input: {
  branch: string;
  baseBranch: string;
  statusShort: string;
  diffStat: string;
  summaries: FileDiffSummary[];
}): string {
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
    "File-level staged diff summaries:",
    ...input.summaries.map((item) => `- ${item.path}: ${item.summary}`),
  ].join("\n");
  return prompt;
}

function resolveSummaryConcurrency(): number {
  const rawValue = Bun.env.AI_COMMIT_SUMMARY_CONCURRENCY;
  if (!rawValue) {
    return DEFAULT_DIFF_SUMMARY_CONCURRENCY;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `Invalid AI_COMMIT_SUMMARY_CONCURRENCY value: '${rawValue}'. Use integer >= 1.`,
    );
  }
  return Math.min(parsed, 12);
}

async function collectStagedFileDiffs(input: {
  stagedPaths: string[];
  maxPatchLength: number;
}): Promise<StagedFileDiff[]> {
  const results = await mapWithConcurrency(input.stagedPaths, 6, async (filePath) => {
    const patch = await runGit(["diff", "--cached", "--no-color", "--", filePath]);
    return {
      path: filePath,
      patch: truncate(patch, input.maxPatchLength),
    };
  });

  return results.filter((item) => item.patch.trim().length > 0);
}

async function generateTextViaResponsesApi(input: {
  apiKey: string;
  baseUrl: string;
  responsesPath: string;
  model: string;
  prompt: string;
  debug: boolean;
}): Promise<string> {
  const url = resolveUrl(input.baseUrl, input.responsesPath);
  const requestBody = {
    model: input.model,
    input: input.prompt,
    temperature: 0.2,
  };
  debugHttpRequest(input.debug, {
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${maskSecret(input.apiKey)}`,
    },
    body: JSON.stringify(requestBody),
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const bodyText = await response.text();
  debugHttpResponse(input.debug, response, bodyText);
  if (!response.ok) {
    throw new Error(
      `Responses API request failed (${response.status} ${response.statusText}).\nbody:\n${truncate(bodyText, 4000)}`,
    );
  }

  const parsed = parseJsonPayload(bodyText);
  if (!parsed) {
    throw new Error(
      `Invalid JSON response from Responses API. body:\n${truncate(bodyText, 4000)}`,
    );
  }

  const outputText = extractResponsesOutputText(parsed);
  if (outputText) {
    return outputText;
  }

  throw new Error("Responses API returned no text output.");
}

async function generateTextViaChatCompletionsApi(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  providerName: string;
  debug: boolean;
}): Promise<string> {
  try {
    const provider = createOpenAICompatible({
      baseURL: input.baseUrl,
      name: input.providerName,
      apiKey: input.apiKey,
      fetch: createDebugFetch(input.debug),
    });
    const { text } = await generateText({
      model: provider.chatModel(input.model),
      prompt: input.prompt,
      temperature: 0.2,
    });
    const outputText = text?.trim() ?? "";
    if (!outputText) {
      throw new Error("Chat Completions API returned no text output via AI SDK.");
    }
    return outputText;
  } catch (error) {
    debugLog(
      input.debug,
      `AI SDK chat call failed (${error instanceof Error ? error.message : String(error)}). Falling back to direct HTTP request.`,
    );
    return generateTextViaChatCompletionsHttp(input);
  }
}

async function generateTextViaChatCompletionsHttp(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  debug: boolean;
}): Promise<string> {
  const url = resolveUrl(input.baseUrl, DEFAULT_CHAT_COMPLETIONS_PATH);
  const requestBody = {
    model: input.model,
    messages: [
      {
        role: "user",
        content: input.prompt,
      },
    ],
    temperature: 0.2,
  };

  debugHttpRequest(input.debug, {
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${maskSecret(input.apiKey)}`,
      "x-fallback-mode": "direct-http",
    },
    body: JSON.stringify(requestBody),
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const bodyText = await response.text();
  debugHttpResponse(input.debug, response, bodyText);
  if (!response.ok) {
    throw new Error(
      `Chat Completions API fallback request failed (${response.status} ${response.statusText}).\nbody:\n${truncate(bodyText, 4000)}`,
    );
  }

  const parsed = parseJsonPayload(bodyText);
  if (!parsed) {
    throw new Error(
      `Invalid JSON response from Chat Completions API fallback.\nbody:\n${truncate(bodyText, 4000)}`,
    );
  }

  const outputText = extractChatCompletionsText(parsed);
  if (!outputText) {
    throw new Error("Chat Completions API fallback returned no text output.");
  }
  return outputText;
}

function resolveUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  const joinedPath = [basePath, normalizedPath].filter(Boolean).join("/");
  url.pathname = joinedPath.startsWith("/") ? joinedPath : `/${joinedPath}`;
  return url.toString();
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonPayload(value: string): unknown {
  const direct = safeParseJson(value);
  if (direct) {
    return direct;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const sseLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  if (sseLines.length > 0) {
    const ssePayload = sseLines.join("\n");
    const sseParsed = safeParseJson(ssePayload);
    if (sseParsed) {
      return sseParsed;
    }
  }

  const doneIndex = trimmed.indexOf("data: [DONE]");
  if (doneIndex > 0) {
    const beforeDone = trimmed.slice(0, doneIndex).trim();
    const beforeDoneParsed = safeParseJson(beforeDone);
    if (beforeDoneParsed) {
      return beforeDoneParsed;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return safeParseJson(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
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

      const maybeText = extractTextFromResponsePart(part);
      if (maybeText) {
        chunks.push(maybeText);
      }
    }
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.join("\n");
}

function extractTextFromResponsePart(part: unknown): string | null {
  if (!part || typeof part !== "object") {
    return null;
  }

  const maybeText = (part as { text?: unknown }).text;
  if (typeof maybeText === "string" && maybeText.trim()) {
    return maybeText.trim();
  }

  const typed = part as { type?: unknown };
  if (typed.type !== "output_text") {
    return null;
  }

  return typeof maybeText === "string" && maybeText.trim() ? maybeText.trim() : null;
}

function extractChatCompletionsText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as { choices?: unknown };
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    return null;
  }

  const firstChoice = record.choices[0] as { message?: unknown } | undefined;
  if (!firstChoice || typeof firstChoice !== "object") {
    return null;
  }

  const message = firstChoice.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      chunks.push(text.trim());
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : null;
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function createDebugFetch(enabled: boolean): typeof fetch | undefined {
  if (!enabled) {
    return undefined;
  }

  return async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const headers = sanitizeDebugHeaders(headersToRecord(request.headers));
    const requestBody = await readRequestBodyForDebug(request);
    debugHttpRequest(enabled, {
      method: request.method,
      url: request.url,
      headers,
      body: requestBody,
    });

    const response = await fetch(request);
    const bodyText = await readResponseBodyForDebug(response);
    debugHttpResponse(enabled, response, bodyText);
    return response;
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

function sanitizeDebugHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      const match = value.match(/^Bearer\s+(.+)$/i);
      sanitized[key] = match ? `Bearer ${maskSecret(match[1])}` : maskSecret(value);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

async function readRequestBodyForDebug(request: Request): Promise<string> {
  if (request.method.toUpperCase() === "GET" || request.method.toUpperCase() === "HEAD") {
    return "";
  }
  try {
    return await request.clone().text();
  } catch {
    return "(unavailable)";
  }
}

async function readResponseBodyForDebug(response: Response): Promise<string> {
  try {
    return await response.clone().text();
  } catch {
    return "(unavailable)";
  }
}

function debugLog(enabled: boolean, message: string): void {
  if (!enabled) {
    return;
  }
  console.error(`[debug] ${message}`);
}

function debugHttpRequest(
  enabled: boolean,
  request: { method: string; url: string; headers: Record<string, string>; body: string },
): void {
  if (!enabled) {
    return;
  }
  debugLog(enabled, `Request ${request.method} ${request.url}`);
  debugLog(enabled, `Request headers: ${JSON.stringify(request.headers)}`);
  debugLog(enabled, `Request body: ${truncate(request.body, 4000)}`);
}

function debugHttpResponse(enabled: boolean, response: Response, bodyText: string): void {
  if (!enabled) {
    return;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }
  debugLog(enabled, `Response status: ${response.status} ${response.statusText}`);
  debugLog(enabled, `Response headers: ${JSON.stringify(headers)}`);
  debugLog(enabled, `Response body: ${truncate(bodyText, 4000)}`);
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

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.floor(limit));
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(normalizedLimit, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
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
  --debug                 Print API request/response diagnostics
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
