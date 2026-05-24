# n8n Workflow Specs

The files in `n8n-workflows/` are credential-free JSON specs for building or importing workflows in Hostinger n8n. They describe the nodes, templates, credentials, and failure handling required for the core GitHub-first flow.

Each workflow must include a `CONFIG` Set node immediately after the webhook trigger. Use that node for shared constants such as GitHub owner/repo, Plane workspace/project IDs, state names, Slack channels, and the public n8n base URL. Do not use enterprise/global n8n variables for this starter.

## Workflow A: Plane Ready to GitHub Issue

Spec: `n8n-workflows/plane-ready-to-github-issue.spec.json`

Trigger:
- Plane cloud webhook for issue update events.
- The workflow must verify the webhook secret before doing any work.

Core logic:
1. Normalize the Plane payload into issue ID, title, description, status, and URL.
2. Load shared constants from the `CONFIG` Set node.
3. Continue only when the state equals `CONFIG.plane_ready_state_name`.
4. Check for an existing GitHub issue URL on the Plane task.
5. Search GitHub for the Plane issue ID to avoid duplicate issues.
6. Create a GitHub issue with a Codex-ready body.
7. Wait briefly and re-search GitHub so simultaneous Ready deliveries can converge on one canonical open issue.
8. Persist the canonical issue in the `plane_ready_issue_locks` n8n Data Table keyed by `plane_issue_id`.
9. Close any just-created duplicate GitHub issue that is not canonical.
10. Add the GitHub issue link back to Plane as a comment or custom field.
11. Optionally notify Slack that work is queued.

The GitHub issue body must include:
- Plane task URL and ID.
- Goal and details from Plane.
- Acceptance criteria.
- Codex instructions to create a branch, test, open a PR, and not deploy.
- Automation metadata so later workflows can reconnect GitHub activity to Plane.

Duplicate handling:
- Normal retries return the existing open GitHub issue.
- Simultaneous Ready deliveries may briefly create more than one issue before GitHub search indexes both.
- The workflow waits, re-searches, chooses the lowest-number open issue as canonical, stores it in `plane_ready_issue_locks`, and closes any just-created duplicate.

## Workflow B: GitHub PR to Slack Review

Spec: `n8n-workflows/github-pr-to-slack-review.spec.json`

Trigger:
- GitHub `pull_request` webhook for `opened`, `synchronize`, `reopened`, and `ready_for_review`.
- The workflow must validate `X-Hub-Signature-256`.

Core logic:
1. Extract PR title, URL, body, branch, commit SHA, and linked issue.
2. Parse Plane URL or Plane issue ID from the PR body or linked issue body.
3. Move linked Plane tasks to `Review` when `plane_issue_id` is present.
4. Fetch current GitHub check status for the PR head SHA.
5. Comment on Plane with the PR URL when Plane context is resolved.
6. Send Slack a review message with the PR merge link.

Slack message must include:
- Plane link, if available.
- GitHub issue link, if available.
- PR / merge link.
- Check status.
- Summary and risk notes from the PR body where available.
- Next step: review and merge in GitHub.

## Workflow C: Deployment Result to Plane and Slack

Spec: `n8n-workflows/deployment-result-to-plane-slack.spec.json`

Trigger:
- GitHub `workflow_run` webhook for the `Deploy After Merge` workflow.
- The workflow must validate `X-Hub-Signature-256`.

Core logic:
1. Continue only when the deploy workflow has completed.
2. Resolve the merged PR and linked Plane task from the deployment commit and PR body.
3. When the deploy workflow starts, move Plane to `Deploying`.
4. The GitHub deploy job validates specs, verifies n8n spec changes have matching builder/import code, and publishes n8n workflows from `scripts/build-n8n-workflows.mjs`.
5. If deployment and verification succeeded, move Plane to `Done` and add the workflow run link.
6. If deployment succeeded and both a Plane task and linked GitHub issue are resolved from the PR body, comment on that issue and close it as completed.
7. If deployment failed, move Plane out of `Deploying` and add the run link. Use `Review` for code/test failures and `Blocked` for missing external prerequisites.
8. Notify Slack with the final deployment result.

PR body handoff:
- Codex PRs created from Plane tasks should include `plane_issue_id: <uuid>`.
- Include the Plane URL when available.
- The deployment-result workflow uses this metadata after merge to update the correct Plane task.
- n8n workflow PRs are not considered deployable when they only add or edit `n8n-workflows/*.json` specs. They must also update the builder/import implementation so the workflow is published before Plane can become `Done`.

Safe behavior:
- If Plane cannot be resolved, still notify Slack with the GitHub Actions run URL.
- If Slack fails, let the GitHub webhook retry.
- Do not close linked GitHub issues on failed deploys or PRs that are not Plane-backed.
- Do not move Plane to `Done` until the post-merge publish and verification job has succeeded.

## Workflow D: GitHub PR Feedback to Codex Revision Queue

Spec: `n8n-workflows/github-pr-feedback-to-codex-revision.spec.json`

Trigger:
- GitHub `issue_comment` webhook for `created`.
- The workflow must validate `X-Hub-Signature-256`.

Core logic:
1. Continue only when the comment is on a PR and starts with `/codex revise`.
2. Fetch PR details and parse `plane_issue_id`, Plane URL, PR URL, branch, and revision request.
3. Move linked Plane tasks to `In Progress`.
4. Comment on Plane with the requested revision.
5. Notify Slack that Codex revision is queued.
6. Acknowledge the request on the GitHub PR.

Example PR comment:

```text
/codex revise
Please rebuild this as an n8n workflow instead of a GitHub Actions workflow.
```
- n8n never runs deployment commands.

## Workflow E: Email Categorizer

Spec: `n8n-workflows/email-categorizer.spec.json`

Trigger:
- n8n schedule every minute.
- Manual and test webhook triggers for dry-run validation.

Core logic:
1. Load shared constants and the Outlook category map from the workflow-local `CONFIG` Set node.
2. Discover live Outlook master categories and verify Q1/Q2/Q3/Q4/QR labels are mapped.
3. Fetch unread uncategorized Inbox message metadata only.
4. Run Tier 1/Tier 2 classification from the mounted classifier directory.
5. Escalate low-confidence cases to Claude using metadata only, never email bodies or attachments.
6. Merge Tier 3 results by message ID.
7. In dry run, skip Outlook PATCH and write audit rows.
8. In live mode, PATCH Outlook categories and write audit rows.
9. Notify Slack only for exceptions such as Quarantine, Claude failures, parse failures, Outlook PATCH failures, or Postgres audit failures.

Safe behavior:
- Keep `CONFIG.dry_run` true until representative audit rows are reviewed.
- Do not use global variables for shared constants.
- Do not store Microsoft, Anthropic, Slack, or Postgres secrets in workflow JSON.
- Do not move, delete, archive, reply, forward, or mark messages read/unread.
