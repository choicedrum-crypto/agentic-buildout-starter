# Website Checker

The website checker is an n8n routine that verifies `http://www.tciallc.com/` responds with an HTTP 2xx or 3xx status.

## n8n Workflow

Workflow: `Website Checker`

Spec: `n8n-workflows/website-checker.spec.json`

The workflow runs every 30 minutes in Hostinger n8n. It checks the configured website URL, follows redirects, and posts to Slack only when the site is down or the request fails.

## Defaults

- URL: `http://www.tciallc.com/`
- Timeout: `15000` milliseconds
- Slack channel: `#workflow-builder`

Routine automations should default to n8n workflows unless there is a specific reason to use GitHub Actions.
