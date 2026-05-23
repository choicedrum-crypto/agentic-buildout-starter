# Agentic Buildout Starter: Plane to GitHub to Codex to PR to Slack to Deploy

This repo is a starter kit for a GitHub-first automation workflow.

## Target Flow

Plane task moved to Ready
-> Hostinger n8n receives a Plane webhook
-> n8n creates a GitHub issue with a Codex-ready body
-> Codex builds on a feature branch and opens a PR
-> GitHub Actions validates the PR
-> Slack receives a review message with the GitHub PR merge link
-> A human merges the PR
-> GitHub Actions deploys from `main`
-> Slack and Plane receive final status

## Core Principle

Codex builds. GitHub gates. You approve. GitHub Actions deploys. n8n orchestrates cloud events only.

OpenClaw can remain local for separate workflows, but it is not required for this core flow.

## Repository Structure

- `.github/workflows/` - GitHub Actions PR checks and deploy-after-merge placeholder.
- `docs/` - setup, secrets, workflow, and testing documentation.
- `n8n-workflows/` - credential-free workflow JSON specs for Hostinger n8n.
- `scripts/` - local and CI validation helpers.
- `tests/` - test notes and future fixtures.

## First Setup

1. Push this repo to GitHub.
2. Add GitHub repo secrets listed in `docs/secrets.md`.
3. Import or build the n8n workflows from `n8n-workflows/`.
4. Configure Plane, GitHub, and GitHub Actions webhooks to point at Hostinger n8n.
5. Open this repo in Codex and run the prompt in `codex-start-prompt.md`.

See `docs/setup.md` for the full setup path and `docs/testing-checklist.md` for validation.
