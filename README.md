# Agentic Buildout Starter: Plane to GitHub to Codex to PR to Slack to Deploy

This repo is a starter kit for a GitHub-first automation workflow.

## Target Flow

Plane task moved to Ready
-> Hostinger n8n receives a Plane webhook
-> n8n creates a GitHub issue with a Codex-ready body
-> n8n dispatches OpenClaw to route the work to Codex or Hermes
-> Codex builds on a feature branch and opens a PR
-> GitHub Actions validates the PR
-> Slack receives one approval message with Approve / Request Changes / Block actions
-> Approval merges the PR through GitHub branch protection
-> GitHub Actions deploys from `main`
-> Plane moves to Done and Slack receives one completion message

## Core Principle

Codex builds. Hermes handles bounded small local tasks. GitHub gates and deploys. You approve from Slack. n8n orchestrates cloud events only.

OpenClaw is the messenger and agent router between n8n, Codex, Hermes, and Slack.

## Repository Structure

- `.github/workflows/` - GitHub Actions PR checks and deploy-after-merge placeholder.
- `docs/` - setup, secrets, workflow, and testing documentation.
- `n8n-workflows/` - credential-free workflow JSON specs for Hostinger n8n.
- `scripts/` - local and CI validation helpers.
- `tests/` - test notes and future fixtures.

## Included Automation

- Website checker: scheduled n8n workflow for checking `http://www.tciallc.com/`. See `docs/website-checker.md`.
- Email categorizer: dry-run-first n8n workflow spec for Outlook Eisenhower classification. See `docs/email-categorizer.md`.
- Agentic workflow plan: durable Plane -> GitHub -> OpenClaw -> Codex/Hermes -> Slack approval -> deploy loop. See `docs/agentic-workflow-implementation-plan.md`.

## First Setup

1. Push this repo to GitHub.
2. Add GitHub repo secrets listed in `docs/secrets.md`.
3. Import or build the n8n workflows from `n8n-workflows/`.
4. Configure Plane, GitHub, and GitHub Actions webhooks to point at Hostinger n8n.
5. Open this repo in Codex and run the prompt in `codex-start-prompt.md`.

See `docs/setup.md` for the full setup path, `docs/runbook.md` for operating steps, and `docs/testing-checklist.md` for validation.
