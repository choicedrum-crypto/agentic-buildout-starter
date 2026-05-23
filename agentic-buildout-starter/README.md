# Agentic Buildout Starter: Plane → GitHub → Codex → PR → Slack → Deploy

This repo is a starter kit for a GitHub-first autonomous coding workflow.

## Target Flow

Plane task moved to Ready
→ Hostinger n8n receives Plane webhook
→ n8n creates GitHub issue
→ Codex builds branch + PR
→ GitHub Actions validates PR
→ Slack receives review message with PR/merge link
→ Human merges PR
→ GitHub Actions deploys
→ Slack and Plane receive final status

## Core Principle

Codex builds. GitHub gates. You approve. GitHub Actions deploys. n8n orchestrates cloud events only.

## First Steps

1. Push this repo to GitHub.
2. Add GitHub repo secrets listed in `docs/secrets.md`.
3. Import or build the n8n workflows from `n8n-workflows/`.
4. Configure Plane webhook to point to Hostinger n8n.
5. Open this repo in Codex and run the prompt in `codex-start-prompt.md`.

## Folder Structure

- `.github/workflows/` — GitHub Actions checks and deploy workflow.
- `docs/` — setup specs and implementation notes.
- `n8n-workflows/` — workflow specs/placeholders for n8n import/buildout.
- `scripts/` — helper scripts Codex can expand.
- `server-scripts/` — deploy-side scripts if needed.
- `tests/` — validation tests.
