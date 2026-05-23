# Prompt to Run in Codex

Build this project into a working GitHub-first automation system.

Goal:
When a Plane task is moved to Ready, Hostinger n8n should create a GitHub issue with a Codex-ready body. Codex should build through a branch and PR. GitHub Actions should validate PRs. When a PR is opened, Slack should receive a review message with the GitHub PR merge link. After I merge the PR, GitHub Actions should deploy and notify Slack. Plane should be updated with GitHub links and final status.

Environment:
- n8n runs on Hostinger VPS.
- Plane, GitHub, and Slack are cloud services.
- OpenClaw is local but should not be required for this core flow.

Constraints:
- Do not use OpenClaw for the core workflow.
- Do not deploy directly from Codex.
- Do not commit directly to main.
- All build work must go through GitHub PRs.
- Keep secrets in GitHub Secrets or n8n credentials only.
- Include validation and safe failure handling.

Build in phases:
1. Validate and improve repo structure.
2. Implement GitHub Actions PR checks.
3. Implement deploy-after-merge workflow placeholder with Slack notification.
4. Create n8n workflow JSON/spec for Plane Ready to GitHub issue.
5. Create n8n workflow JSON/spec for GitHub PR to Slack review message.
6. Create n8n workflow JSON/spec for deployment result to Plane/Slack status update.
7. Add setup documentation and testing checklist.
8. Open a PR with a summary, risks, and next steps.
