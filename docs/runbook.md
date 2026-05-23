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
6. Confirm Slack receives the deploy result.
7. Confirm Plane moves to `Done`.
8. Confirm Plane receives a deployment comment with the GitHub Actions run URL, commit SHA, and PR URL.

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

1. Keep the oldest valid GitHub issue created for the Plane task.
2. Close duplicate GitHub issues as `not planned`.
3. Leave the Plane comment that points to the canonical GitHub issue.
4. Re-run the Plane Ready event only after confirming the duplicate guard returns the existing link.

## Recover from failed deploy

1. Open the GitHub Actions run from the Slack deployment message.
2. Fix the cause in a new branch and PR.
3. Merge only after PR Checks pass.
4. Confirm n8n moves Plane from `Blocked` to `Done` after the successful deploy.

## Logs to check

- Plane work item activity and comments.
- n8n execution history for the three production workflows.
- GitHub PR checks and `Deploy After Merge` runs.
- Slack `#workflow-builder` messages.
