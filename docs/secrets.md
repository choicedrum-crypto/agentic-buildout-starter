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
- GitHub webhook secret for validating `X-Hub-Signature-256`. The current builder marks this as `pending-secret-credential` until a credential-access pattern is added in n8n.
- Plane API token with issue read/write permissions.
- Plane webhook secret for validating `X-Plane-Signature`. The current builder captures raw webhook bodies but leaves validation marked `pending-secret-credential` until the secret can be read from an n8n credential.
- Slack bot token or Slack incoming webhook for review and status messages.

After publishing workflow changes that add new Plane HTTP Request nodes, open each new node in n8n and confirm it is bound to the existing `Plane Main` HTTP Header Auth credential. The credential should send the Plane API key as the configured header value; do not paste the key into workflow node headers or `CONFIG`.

## n8n Workflow CONFIG Nodes

Do not use enterprise/global n8n variables for this starter. Each workflow must have a `CONFIG` Set node immediately after the trigger. Put shared constants and references there:

- `github_owner`
- `github_repo`
- `plane_workspace_slug`
- `plane_project_id`
- `plane_ready_state_name`, default `Ready`
- `plane_review_state_name`, default `Review`
- `plane_in_progress_state_name`, default `In Progress`
- `plane_done_state_name`, default `Done`
- `plane_failed_state_name`, default `Blocked`
- `slack_review_channel`
- `slack_deploy_channel`
- `public_n8n_base_url`, default `https://n8n.tradecredit.agency`

## Secret Handling Rules

- GitHub Actions deploys only after changes are merged into `main`.
- n8n creates issues, sends Slack notifications, and updates Plane, but does not deploy.
- Codex does not receive production deployment credentials.
- Slack messages should include links and statuses, never tokens or signed webhook payloads.
- Exported n8n workflows should be credential-free before committing.
- Shared constants belong in each workflow's `CONFIG` Set node, not in enterprise/global variables.
