# Required Secrets and Credentials

Keep secrets in GitHub Secrets or n8n credentials only. Do not commit `.env` files, access tokens, webhook secrets, private keys, or exported n8n credentials.

## GitHub Actions Secrets

Add these in GitHub: repo -> Settings -> Secrets and variables -> Actions.

- `SLACK_WEBHOOK_URL` - Slack incoming webhook used by the deploy-after-merge workflow for deployment results.

Optional, depending on how you later replace the deploy placeholder:

- `PRODUCTION_DEPLOY_TOKEN` - deployment provider token.
- `PRODUCTION_DEPLOY_URL` - deployment target URL.

## n8n Credentials on Hostinger

Create these in Hostinger n8n credentials:

- GitHub API token or GitHub App credential with issue, pull request, and check read permissions plus issue write permissions.
- GitHub webhook secret for validating `X-Hub-Signature-256`.
- Plane API token with issue read/write permissions.
- Plane webhook secret or shared secret header value.
- Slack bot token or Slack incoming webhook for review and status messages.

## n8n Variables

Configure these as n8n variables or workflow-level constants:

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `PLANE_WORKSPACE_SLUG`
- `PLANE_PROJECT_ID`
- `PLANE_READY_STATE_NAME`, default `Ready`
- `PLANE_DONE_STATE_NAME`, default `Done`
- `PLANE_FAILED_STATE_NAME`, default `Blocked`
- `SLACK_REVIEW_CHANNEL`
- `SLACK_DEPLOY_CHANNEL`

## Secret Handling Rules

- GitHub Actions deploys only after changes are merged into `main`.
- n8n creates issues, sends Slack notifications, and updates Plane, but does not deploy.
- Codex does not receive production deployment credentials.
- Slack messages should include links and statuses, never tokens or signed webhook payloads.
- Exported n8n workflows should be credential-free before committing.
