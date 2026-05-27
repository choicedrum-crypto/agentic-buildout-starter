# Automation Runbook

Use this when operating the GitHub-first Plane -> n8n -> GitHub -> Slack -> deploy flow.

## Start a Plane-backed task

1. Create or choose a Plane work item in project `TCIA`.
2. Move it to `Ready`.
3. Confirm n8n creates exactly one GitHub issue.
4. Build from the GitHub issue on a feature branch.
5. Open a PR that includes:

```text
plane_issue_id: <Plane work item UUID>
plane_url: <Plane task URL>
```

## Review and merge

1. Confirm PR Checks pass.
2. Confirm Plane moves to `Review`.
3. Confirm Slack receives the PR review message.
4. Merge the PR in GitHub.
5. Confirm `Deploy After Merge` runs from `main`.
6. Confirm Plane moves to `Deploying`.
7. Confirm the deploy job publishes n8n workflows through `scripts/build-n8n-workflows.mjs`.
8. Confirm Slack receives the deploy result.
9. Confirm Plane moves to `Done`.
10. Confirm Plane receives a deployment comment with the GitHub Actions run URL, commit SHA, and PR URL.
11. Confirm the linked GitHub source issue is commented and closed as completed.

If the deployment comment is missing but Slack and the Plane state update succeed, open the deployment workflow in n8n and confirm the `Comment on Plane with Deployment Result` node is bound to the existing `Plane Main` HTTP Header Auth credential. The node is intentionally placed after `Update Plane Status`, so the core status update and Slack notification remain the primary signal while credential binding is repaired.

## Request a revision

1. Open the GitHub PR from Slack or Plane.
2. Add a PR comment that starts with:

```text
/codex revise
```

3. Put the requested change below the command.
4. Confirm Plane moves back to `In Progress`.
5. Confirm Slack receives the revision request.
6. Ask Codex to execute the queued revision.
7. Confirm the next PR update moves Plane back to `Review`.

## Recover from duplicates

1. Check the `plane_ready_issue_locks` n8n Data Table for the Plane issue ID.
2. Keep the lowest-number open GitHub issue as canonical unless the table points to a different open issue.
3. Close duplicate GitHub issues as `not planned`.
4. Leave the Plane comment that points to the canonical GitHub issue.
5. Re-run the Plane Ready event only after confirming the duplicate guard returns the existing link.

The Plane Ready workflow waits after issue creation, re-searches GitHub, stores the canonical issue in `plane_ready_issue_locks`, and closes any just-created duplicate. If duplicates remain open, inspect the `Close Duplicate GitHub Issue` node and confirm it is bound to the `GitHub account` credential.

## Recover from missing Codex PR

Use this when Codex comments that it created a branch or PR, but no GitHub branch, commit, or PR exists.

1. Open the GitHub issue and capture the Codex task link from the connector comment.
2. Confirm the issue has `codex-pr-missing` and `blocked`.
3. Check repository events for a branch create, push, or pull request from `chatgpt-codex-connector[bot]`.
4. If no GitHub artifact exists, repair the Codex environment or GitHub connector PR publication setting.
5. Remove `blocked` and `codex-pr-missing` only after the connector is repaired.
6. Re-dispatch Codex or create the PR manually.

The `Codex PR Publication Watchdog` runs every 30 minutes and sends one Slack exception message for this state. Do not repeatedly tag `@codex` until the connector can publish a visible branch or PR.

## Recover from failed deploy

1. Open the GitHub Actions run from the Slack deployment message.
2. Fix the cause in a new branch and PR.
3. Merge only after PR Checks pass.
4. Confirm n8n moves Plane from `Deploying`, `Blocked`, or `Review` to `Done` only after the successful publish and verification run.

## Logs to check

- Plane work item activity and comments.
- n8n execution history for the three production workflows.
- GitHub PR checks and `Deploy After Merge` runs.
- Slack `#workflow-builder` messages.
