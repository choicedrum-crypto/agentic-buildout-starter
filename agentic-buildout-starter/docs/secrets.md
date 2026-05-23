# Required Secrets and Credentials

## GitHub Repo Secrets

Add these in GitHub → Repo → Settings → Secrets and variables → Actions:

- `SLACK_WEBHOOK_URL` — Slack incoming webhook for deployment results.
- `N8N_API_URL` — Hostinger n8n base URL, e.g. `https://n8n.tradecredit.agency`.
- `N8N_API_KEY` — n8n API key, if using API-based workflow import/deploy.
- `PLANE_API_KEY` — Plane API token.
- `PLANE_WORKSPACE_SLUG` — Plane workspace slug.
- `PLANE_PROJECT_ID` — Plane project ID.

## n8n Credentials

Create credentials in Hostinger n8n for:

- GitHub API token with repo issue/PR read-write permissions.
- Slack bot or incoming webhook.
- Plane API token.

Do not commit credentials to this repo.
