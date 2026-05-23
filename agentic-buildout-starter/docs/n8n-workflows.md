# n8n Workflow Specs

## Workflow A: Plane Ready → GitHub Issue

Trigger:
- Webhook node receiving Plane work item update.

Logic:
1. Receive Plane webhook.
2. Filter where status changed to `Ready`.
3. Check whether the Plane issue already has a GitHub issue URL.
4. Create GitHub issue if missing.
5. Update/comment on Plane issue with GitHub issue URL.
6. Optional Slack message: task queued for Codex.

GitHub issue body should include:
- Plane task URL.
- Goal.
- Acceptance criteria.
- Relevant files/systems.
- Risk level.
- Codex instruction: create branch, implement, test, open PR, do not deploy.

## Workflow B: GitHub PR Opened → Slack Review Message

Trigger:
- GitHub webhook for `pull_request` opened/synchronize/reopened.

Logic:
1. Receive PR event.
2. Fetch PR title/body/URL.
3. Fetch linked issue if present.
4. Fetch GitHub checks status if available.
5. Send Slack review message including PR URL.

Slack message must include:
- Plane link, if available.
- GitHub issue link.
- PR / merge link.
- Summary.
- Tests/check status.
- Risks.
- Next step: review and merge in GitHub.

## Workflow C: Deployment Result → Plane + Slack

Trigger:
- GitHub deployment workflow completion webhook, or GitHub Actions Slack notification.

Logic:
1. Receive deployment result.
2. If successful, move Plane task to `Done`.
3. If failed, move Plane task to `Blocked` or `Failed`.
4. Send Slack result summary.
