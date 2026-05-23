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
- Confirm Plane receives a GitHub issue link comment or custom field update.
- Confirm a failed GitHub API call leaves Plane in `Ready` and creates a visible failure note where possible.

## GitHub PR to Slack

- Open a draft or test PR linked to a generated issue.
- Confirm Plane-backed PRs include `plane_issue_id: <uuid>` in the PR body.
- Confirm GitHub webhook signature validation rejects bad signatures.
- Confirm Slack receives the PR / merge link.
- Confirm checks show as pending, passing, failing, or unavailable without breaking the workflow.
- Confirm Plane receives a PR comment when Plane context can be resolved.

## Merge and Deploy

- Merge a test PR.
- Confirm `Deploy After Merge` starts from `main`.
- Confirm the deploy placeholder does not run from Codex or n8n.
- Confirm deployment result resolves the merged PR's `plane_issue_id` when present.
- Confirm Slack receives deployment success or failure.
- Confirm n8n moves Plane to `Done` on success.
- Confirm n8n moves Plane to `Blocked` or `Failed` on failure.

## Safety

- Confirm no credentials are committed.
- Confirm GitHub branch protection prevents direct commits to `main`.
- Confirm n8n workflow exports do not include credential material.
- Confirm webhook secrets are validated before workflow side effects.
- Confirm Slack failure paths do not leak tokens in logs.
