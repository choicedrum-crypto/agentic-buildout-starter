# Codex Instructions

You are building a sturdy GitHub-first automation system.

Rules:
- Create a branch for every implementation task.
- Never commit directly to `main`.
- Open a pull request for all changes.
- If the work came from Plane, include `plane_issue_id: <uuid>` and the Plane URL in the PR body.
- Do not deploy directly from Codex.
- Use GitHub Actions for tests/checks/deployments.
- Use n8n only for orchestration, Slack notifications, Plane sync, and webhooks.
- Keep secrets in GitHub Secrets or n8n credentials only.
- Avoid storing credentials in files.
- Add clear setup instructions for Daniel to follow.

Expected deliverables:
- Working GitHub Actions files.
- n8n workflow JSON or detailed node-by-node specs.
- Slack message templates with PR review/merge link.
- Plane/GitHub sync logic.
- Safe deploy flow after PR merge.
- README updates.
