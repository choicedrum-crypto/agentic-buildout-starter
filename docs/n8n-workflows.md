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
7. Add the GitHub issue link back to Plane as a comment or custom field.
8. Optionally notify Slack that work is queued.

The GitHub issue body must include:
- Plane task URL and ID.
- Goal and details from Plane.
- Acceptance criteria.
- Codex instructions to create a branch, test, open a PR, and not deploy.
- Automation metadata so later workflows can reconnect GitHub activity to Plane.

## Workflow B: GitHub PR to Slack Review

Spec: `n8n-workflows/github-pr-to-slack-review.spec.json`

Trigger:
- GitHub `pull_request` webhook for `opened`, `synchronize`, `reopened`, and `ready_for_review`.
- The workflow must validate `X-Hub-Signature-256`.

Core logic:
1. Extract PR title, URL, body, branch, commit SHA, and linked issue.
2. Parse Plane URL or Plane issue ID from the PR body or linked issue body.
3. Fetch current GitHub check status for the PR head SHA.
4. Optionally comment on Plane with the PR URL.
5. Send Slack a review message with the PR merge link.

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
2. Resolve the merged PR and linked Plane task from the deployment commit.
3. If deployment succeeded, move Plane to `Done` and add the workflow run link.
4. If deployment failed, move Plane to `Blocked` or `Failed` and add the run link.
5. Notify Slack with the final deployment result.

Safe behavior:
- If Plane cannot be resolved, still notify Slack with the GitHub Actions run URL.
- If Slack fails, let the GitHub webhook retry.
- n8n never runs deployment commands.
