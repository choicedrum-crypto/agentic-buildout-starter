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

## GitHub PR to Slack

- Open a draft or test PR linked to a generated issue.
- Confirm Plane-backed PRs include `plane_issue_id: <uuid>` in the PR body.
- Confirm GitHub webhook signature validation rejects bad signatures.
- Confirm n8n moves linked Plane tasks to `Review` when a reviewable PR is opened.
- Confirm Plane receives a PR review link comment when Plane context can be resolved.
- Confirm Slack receives the PR / merge link.
- Confirm checks show as pending, passing, failing, or unavailable without breaking the workflow.

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
- Confirm the deploy placeholder does not run from Codex or n8n.
- Confirm deployment result resolves the merged PR's `plane_issue_id` when present.
- Confirm Slack receives deployment success or failure.
- Confirm n8n moves Plane to `Done` on success.
- Confirm n8n moves Plane to `Blocked` or `Failed` on failure.
- Confirm Plane receives a deployment comment with the GitHub Actions run URL, commit SHA, status, and PR URL.
- If the deployment comment is missing, confirm the `Comment on Plane with Deployment Result` node is manually bound to the `Plane Main` HTTP Header Auth credential in n8n.

## Email Categorizer Dry Run

- Confirm Microsoft Outlook OAuth2 credential exists in n8n.
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
