# Setup Guide

This guide wires the starter into a GitHub-first automation system. The intended deployment environment is Hostinger n8n plus cloud Plane, GitHub, and Slack.

## 1. GitHub Repository

1. Push this repository to GitHub.
2. Protect `main`.
3. Require pull requests before merging.
4. Require the `PR Checks / Validate automation specs` check before merge.
5. Add the GitHub Actions secrets from `docs/secrets.md`.

Codex should work on feature branches and open pull requests. It should not commit directly to `main` and should not deploy.

## 2. GitHub Actions

The repo includes:

- `.github/workflows/pr-checks.yml` for PR validation.
- `.github/workflows/deploy.yml` for deployment after merge to `main`.

The deployment workflow currently contains a placeholder deploy step. Replace only that step when the real production target is defined. Keep Slack notification and failure behavior in place.

## 3. Hostinger n8n

1. Create n8n credentials listed in `docs/secrets.md`.
2. Build workflows from the JSON specs in `n8n-workflows/`.
3. Add a `CONFIG` Set node immediately after each webhook trigger.
4. Put shared constants and references in the workflow's `CONFIG` Set node, not enterprise/global variables.
5. Store webhook secrets in n8n credentials.
6. Activate each workflow after testing with sample payloads.

Suggested webhook paths:

- `/webhook/plane-ready`
- `/webhook/github-issue-agent-dispatch`
- `/webhook/agent-result`
- `/webhook/github-pr-review`
- `/webhook/slack-agent-approval`
- `/webhook/github-deploy-result`

## 4. Plane

1. Create or confirm states named `Ready`, `Building`, `Review`, `Changes Requested`, `Approved`, `Deploying`, `Done`, and `Blocked` or map the specs to your actual state names.
2. Add a custom field for the GitHub issue URL if available.
3. Configure a Plane webhook for issue update events.
4. Send the webhook to the Hostinger n8n Plane Ready workflow URL.
5. Include a shared secret header and validate it in n8n.

## 5. GitHub Webhooks

Create GitHub webhooks pointing to Hostinger n8n:

- Pull request webhook -> `/webhook/github-pr-review`
- Issues webhook -> `/webhook/github-issue-agent-dispatch`
- Issue comment webhook -> `/webhook/github-pr-feedback`
- Workflow run webhook -> `/webhook/github-deploy-result`

Use a GitHub webhook secret and validate `X-Hub-Signature-256` in n8n.

## 6. Slack

Create Slack destinations for:

- One PR approval message.
- One deployment completion message.
- Optional queue/failure messages.

Configure Slack interactivity to send button callbacks to `/webhook/slack-agent-approval`. Messages should contain links, status, and next actions. They should not contain secrets or raw webhook payloads.

## 7. Codex Work Loop

1. Plane task moves to `Ready`.
2. n8n creates the GitHub issue.
3. n8n dispatches the issue to OpenClaw.
4. OpenClaw routes the task to Codex by default, or Hermes for bounded small tasks.
5. Codex creates a feature branch, implements the change, validates locally, and opens a PR.
6. GitHub Actions checks the PR.
7. Slack receives one approval message with Approve, Request Changes, and Block buttons.
8. Approval merges the PR through GitHub branch protection.
9. GitHub Actions deploys from `main`.
10. n8n updates Plane, closes the GitHub issue, and sends one completion message.
