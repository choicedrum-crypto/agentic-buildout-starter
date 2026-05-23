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
- `/webhook/github-pr-review`
- `/webhook/github-deploy-result`

## 4. Plane

1. Create or confirm states named `Ready`, `Review`, `Done`, and `Blocked` or map the specs to your actual state names.
2. Add a custom field for the GitHub issue URL if available.
3. Configure a Plane webhook for issue update events.
4. Send the webhook to the Hostinger n8n Plane Ready workflow URL.
5. Include a shared secret header and validate it in n8n.

## 5. GitHub Webhooks

Create GitHub webhooks pointing to Hostinger n8n:

- Pull request webhook -> `/webhook/github-pr-review`
- Workflow run webhook -> `/webhook/github-deploy-result`

Use a GitHub webhook secret and validate `X-Hub-Signature-256` in n8n.

## 6. Slack

Create Slack destinations for:

- PR review messages.
- Deployment result messages.
- Optional queue/failure messages.

Messages should contain links, status, and next actions. They should not contain secrets or raw webhook payloads.

## 7. Codex Work Loop

1. Plane task moves to `Ready`.
2. n8n creates the GitHub issue.
3. Codex picks up the issue.
4. Codex creates a feature branch, implements the change, validates locally, and opens a PR.
5. GitHub Actions checks the PR.
6. Slack receives the review message.
7. You review and merge in GitHub.
8. GitHub Actions deploys from `main`.
9. n8n updates Plane and Slack with the deployment result.
