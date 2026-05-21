#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const entrypoint = resolve(__dirname, "../index.ts");

if (!existsSync(entrypoint)) {
  console.error("ai-commit entrypoint not found:", entrypoint);
  process.exit(1);
}

const bunCheck = spawnSync("bun", ["--version"], { stdio: "ignore" });
if (bunCheck.error || bunCheck.status !== 0) {
  console.error("Bun is required to run ai-commit. Install Bun: https://bun.sh");
  process.exit(1);
}

const result = spawnSync("bun", [entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
