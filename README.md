# ai-commit

`ai-commit` is a Bun CLI that:

1. Creates/switches to a branch
2. Stages all tracked and untracked changes
3. Uses AI SDK (chat-completions) or OpenAI Responses API to generate commit + PR summary
4. Commits, pushes, and opens a PR using `gh`

## Requirements

- [Bun](https://bun.com)
- `git`
- `gh` (GitHub CLI) for PR creation
- OpenAI-compatible API credentials

## Install

```bash
bun install
```

## Run in development

```bash
bun run index.ts --branch feat/my-change
```

## Run as command

```bash
bun link
ai-commit --branch feat/my-change
```

## CLI usage

```bash
ai-commit --branch <name> [options]
# or
ai-commit --current-branch [options]
```

Required:

- `--branch <name>` branch to create/switch and push, or
- `--current-branch` commit/push current branch and skip PR creation

Options:

- `--base <branch>` base branch for PR (default: remote HEAD, fallback current branch)
- `--model <model>` model id (default: `gpt-4o-mini`)
- `--api-key <key>` API key (or env vars)
- `--base-url <url>` OpenAI-compatible API base URL
- `--provider-name <name>` provider label used by AI SDK
- `--api-mode <mode>` `chat` or `responses` (default: `chat`)
- `--responses-path <path>` responses API path (default: `/responses`)
- `--remote <name>` git remote name (default: `origin`)
- `--no-pr` skip PR creation
- `--dry-run` only generate AI metadata

## Environment variables

- `OPENAI_API_KEY` or `AI_COMMIT_API_KEY`
- `OPENAI_BASE_URL` or `OPENAI_API_BASE_URL` or `AI_COMMIT_BASE_URL` or `AI_COMMIT_API_URL`
- `OPENAI_MODEL` or `AI_COMMIT_MODEL`
- `AI_COMMIT_PROVIDER_NAME` (optional)
- `AI_COMMIT_API_MODE` or `OPENAI_API_MODE` (`chat` or `responses`)
- `AI_COMMIT_USE_RESPONSES_API` or `OPENAI_USE_RESPONSES_API` (`true`/`false`)
- `AI_COMMIT_RESPONSES_PATH` or `OPENAI_RESPONSES_PATH` (default: `/responses`)
- `AI_COMMIT_MOCK_METADATA_JSON` (optional, local testing without API calls)

CLI args override environment variables.

## Build binaries (macOS + Linux)

```bash
bun run build:local
./dist/ai-commit --branch feat/my-change

# build all targets
bun run build:all
bun run build:mac-arm64
bun run build:mac-amd64
bun run build:linux-amd64
bun run build:linux-arm64
```

Output binaries are written to `dist/`:

- `ai-commit-macos-arm64`
- `ai-commit-macos-amd64`
- `ai-commit-linux-arm64`
- `ai-commit-linux-amd64`

## GitHub Release from tag

This repo includes a release workflow at `.github/workflows/release.yml`.

When you push a tag like `v1.0.0`, GitHub Actions will:

1. Run builds for:
   - Linux AMD64
   - Linux ARM64
   - macOS AMD64
   - macOS ARM64
2. Use Node.js `20` and Bun in the workflow.
3. Upload all binaries to the GitHub Release for that tag.
4. Upload `checksums.txt` (SHA-256 for all release binaries).

Tag and push example:

```bash
git tag v1.0.0
git push origin v1.0.0
```
