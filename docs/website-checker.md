# Website Checker

The website checker verifies that `http://www.tciallc.com/` responds with an HTTP 2xx or 3xx status.

## GitHub Actions

Workflow: `.github/workflows/website-checker.yml`

The workflow runs every 30 minutes and can also be started manually from GitHub Actions. Manual runs accept:

- `url` - defaults to `http://www.tciallc.com/`
- `timeout_ms` - defaults to `15000`

## Local Check

Run the same check locally:

```bash
node scripts/check-website.mjs --url http://www.tciallc.com/ --timeout-ms 15000
```

The script prints JSON with the requested URL, final URL after redirects, HTTP status, and response time. It exits with a non-zero status when the site does not return a 2xx or 3xx response.
