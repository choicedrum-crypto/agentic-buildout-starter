# Required Secrets and Credentials

Keep secrets in GitHub Secrets or n8n credentials only. Do not commit `.env` files, access tokens, webhook secrets, private keys, or exported n8n credentials.

## GitHub Actions Secrets

Add these in GitHub: repo -> Settings -> Secrets and variables -> Actions.

- `SLACK_WEBHOOK_URL` - Slack incoming webhook used by the deploy-after-merge workflow for deployment results.
- `N8N_BASE_URL` - Hostinger n8n API/MCP endpoint used by the post-merge deploy job to publish workflows.
- `N8N_API_KEY` - n8n API key used by the post-merge deploy job. Store only in GitHub Secrets.
- `N8N_REST_API_KEY` - n8n public API key used only when the Email Categorizer publish falls back to the REST API. Create this in n8n under Settings -> n8n API with workflow create/read/list/update/delete/activate scopes, then store it only in GitHub Secrets.

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
- Microsoft Outlook OAuth2 credential for the email categorizer workflow.
- Postgres credential named `Email Categorizer Postgres` for the dedicated email classifier audit database.
- DBHub direct Ollama endpoint/model for Tier 3 email classification. The current endpoint is `http://100.66.221.24:11434` over Tailscale and does not require a LiteLLM credential.
- Dedicated classifier Postgres credential for email categorizer audit rows.

After publishing workflow changes that add new Plane HTTP Request nodes, open each new node in n8n and confirm it is bound to the existing `Plane Main` HTTP Header Auth credential. The credential should send the Plane API key as the configured header value; do not paste the key into workflow node headers or `CONFIG`.

## n8n Workflow CONFIG Nodes

Do not use enterprise/global n8n variables for this starter. Each workflow must have a `CONFIG` Set node immediately after the trigger. Put shared constants and references there:

- `github_owner`
- `github_repo`
- `plane_workspace_slug`
- `plane_project_id`
- `plane_ready_state_name`, default `Ready`
- `plane_review_state_name`, default `Review`
- `plane_deploying_state_name`, default `Deploying`
- `plane_in_progress_state_name`, default `In Progress`
- `plane_done_state_name`, default `Done`
- `plane_failed_state_name`, default `Blocked`
- `slack_review_channel`
- `slack_deploy_channel`
- `public_n8n_base_url`, default `https://n8n.tradecredit.agency`
- `plane_ready_lock_table_id`, n8n Data Table ID for `plane_ready_issue_locks`
- `plane_ready_lock_table_name`, default `plane_ready_issue_locks`

Email categorizer workflow CONFIG values:

- `ms_user_email`
- `dry_run`, default `true`
- `batch_limit`, default `25`
- `tier3_confidence_threshold`, default `0.65`
- `slack_exception_channel`, default `#workflow-builder`
- `classifier_mount_path`, default `/data/classifier`
- `audit_table`, default `inbox_classifications`
- `outlook_category_map`
- `tier3_provider`, default `dbhub_ollama`
- `local_llm_base_url`
- `local_llm_model`
- `enable_tier3_local_llm`, default `true` for dry-run Tier 3 review

## Secret Handling Rules

- GitHub Actions deploys only after changes are merged into `main`.
- n8n creates issues, sends Slack notifications, and updates Plane, but does not deploy.
- Codex does not receive production deployment credentials.
- Slack messages should include links and statuses, never tokens or signed webhook payloads.
- Exported n8n workflows should be credential-free before committing.
- Shared constants belong in each workflow's `CONFIG` Set node, not in enterprise/global variables.
