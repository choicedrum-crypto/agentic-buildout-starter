# Testing Checklist

Use this checklist before trusting the automation with real work.

## Local Repository

- Run `bash ./scripts/validate-workflows.sh`.
- Confirm every file in `n8n-workflows/` is valid JSON.
- Confirm each n8n workflow has a `CONFIG` Set node immediately after the webhook trigger.
- Confirm no workflow depends on enterprise/global n8n variables.
- Confirm `.github/workflows/pr-checks.yml` appears in a PR.
- Confirm `.github/workflows/deploy.yml` runs only on `main` pushes or manual dispatch.

## Plane to GitHub Issue

- Send a sample Plane payload where state is not `Ready`; expect no GitHub issue.
- Send a sample Plane payload where state is `Ready`; expect one GitHub issue.
- Send the same Ready payload again; expect no duplicate GitHub issue.
- Confirm repeated Plane Ready events return the existing GitHub issue link instead of creating a second issue.
- Send two Ready payloads at nearly the same time; expect at most one open canonical GitHub issue after duplicate cleanup completes.
- Confirm the `plane_ready_issue_locks` n8n Data Table records the canonical GitHub issue URL keyed by `plane_issue_id`.
- Confirm Plane receives a GitHub issue link comment or custom field update.
- Confirm a failed GitHub API call leaves Plane in `Ready` and creates a visible failure note where possible.

## GitHub Issue to Codex Request

- Send a GitHub `issues.opened` payload with labels `plane`, `codex-ready`, and `automation`.
- Confirm n8n ignores issues missing `plane_issue_id` or `plane_project_id`.
- Confirm n8n ignores issues already labeled `codex-in-progress`, `codex-pr-open`, `done`, or `blocked`.
- Confirm n8n claims eligible issues with `codex-in-progress`.
- Confirm n8n comments on the issue with `@codex` and required PR metadata instructions.
- Confirm Plane moves to `Building` only after the Codex request comment is created.

## Codex PR Publication Watchdog

- Confirm Codex-dispatched issues that publish a visible PR receive `codex-pr-open`.
- Confirm stale `codex-in-progress` issues with no matching PR receive `codex-pr-missing` and `blocked`.
- Confirm the missing-PR path sends exactly one Slack exception message.
- Confirm blocked issues are ignored on later watchdog runs.

## GitHub PR to Slack Approval

- Open a draft or test PR linked to a generated issue.
- Confirm Plane-backed PRs include `plane_issue_id: <uuid>` in the PR body.
- Confirm Plane-backed PRs include `plane_project_id: <uuid>` in the PR body.
- Confirm GitHub webhook signature validation rejects bad signatures.
- Confirm n8n moves linked Plane tasks to `Review` when a reviewable PR is opened.
- Confirm Plane receives a PR review link comment when Plane context can be resolved.
- Confirm Slack receives exactly one approval message with Approve, Request Changes, and Block actions.
- Confirm checks show as pending, passing, failing, or unavailable without breaking the workflow.

## Slack Approval to Merge

- Click Approve on a test approval message.
- Confirm n8n calls the GitHub PR merge endpoint.
- Confirm GitHub branch protection still prevents merge if required checks are failing.
- Click Request Changes on a test approval message.
- Confirm n8n comments on the PR with `/codex revise`.
- Click Block on a test approval message.
- Confirm n8n comments on the PR and automation stops.

## PR Feedback to Codex Revision

- Comment `/codex revise` on a Plane-backed PR with a requested change.
- Confirm n8n ignores ordinary comments and comments on non-PR issues.
- Confirm n8n moves linked Plane tasks to `In Progress`.
- Confirm Plane receives a revision request comment.
- Confirm Slack receives the Codex revision request with PR link, branch, Plane context, and feedback.
- Confirm GitHub receives a queued acknowledgement comment.
- Push a revision commit and confirm the PR synchronize event returns Plane to `Review`.

## Merge and Deploy

- Merge a test PR.
- Confirm `Deploy After Merge` starts from `main`.
- Confirm deployment does not run from Codex.
- Confirm n8n moves Plane to `Deploying` when the GitHub deploy workflow starts.
- Confirm the deploy job fails if `n8n-workflows/*.json` changed without a matching `scripts/build-n8n-workflows.mjs` change.
- Confirm the deploy job publishes n8n workflows through `scripts/build-n8n-workflows.mjs` using GitHub Secrets.
- Confirm deployment result resolves the merged PR's `plane_issue_id` when present.
- Confirm Slack receives one completion notification on deployment success.
- Confirm n8n moves Plane from `Deploying` to `Done` only on successful publish and verification.
- Confirm n8n comments on and closes the linked GitHub source issue only after successful deploy.
- Confirm n8n does not close a GitHub issue when the deploy PR lacks Plane metadata.
- Confirm n8n moves Plane out of `Deploying` on failure.
- Confirm failed deploys do not close the linked GitHub source issue.
- Confirm Plane receives a deployment comment with the GitHub Actions run URL, commit SHA, status, and PR URL.
- If the deployment comment is missing, confirm the `Comment on Plane with Deployment Result` node is manually bound to the `Plane Main` HTTP Header Auth credential in n8n.

## Email Categorizer Dry Run

- Confirm Microsoft Outlook OAuth2 credential exists in n8n.
- Confirm the `Email Categorizer` workflow exists in n8n and `/webhook/email-categorizer-test` returns dry-run classification JSON.
- Confirm `CONFIG.ms_user_email` is `dbradley@tciallc.com`.
- Confirm real Outlook dry run fetches unread metadata only and never requests body, bodyPreview, uniqueBody, or attachments.
- Confirm DBHub local LLM endpoint/model is documented before enabling Tier 3.
- Confirm the classifier directory is mounted read-only into n8n.
- Confirm the dedicated classifier Postgres database is reachable from n8n.
- Validate Outlook category labels match the `CONFIG` category map.
- Run the manual trigger with `CONFIG.dry_run` set to `true`.
- Confirm audit rows are created with quadrants `Q1`, `Q2`, `Q3`, `Q4`, or `QR`.
- Confirm tier zero and Tier 3 rows are accepted by the audit schema.
- Confirm no Outlook categories are changed during dry run.
- Confirm Slack posts only exceptions.

## Safety

- Confirm no credentials are committed.
- Confirm GitHub branch protection prevents direct commits to `main`.
- Confirm n8n workflow exports do not include credential material.
- Confirm webhook secrets are validated before workflow side effects.
- Confirm Slack failure paths do not leak tokens in logs.
