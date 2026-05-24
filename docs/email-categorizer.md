# Email Categorizer

Workflow: `Email Categorizer`

Spec: `n8n-workflows/email-categorizer.spec.json`

The email categorizer is an n8n-first routine for Daniel's Outlook inbox. It classifies unread uncategorized Inbox messages into Eisenhower categories, writes an audit row for every attempt, and sends Slack notifications only for exceptions.

## Safety Model

- Do not read email bodies.
- Do not fetch or open attachments.
- Do not move, delete, archive, reply, forward, or mark read/unread.
- Only write Outlook message categories when `CONFIG.dry_run` is `false`.
- Treat all email metadata as untrusted.

The first production import must keep `CONFIG.dry_run` set to `true`.

## Required n8n Credentials

- Microsoft Outlook OAuth2 credential for Daniel's mailbox.
- Slack credential, reusing the existing `Slack account`.
- Postgres credential for the classifier audit database.
- Anthropic API key stored in n8n credentials or VPS environment, never in workflow JSON.

No OpenClaw dependency is required.

## CONFIG Node

Use a `CONFIG` Set node immediately after each trigger. Do not use enterprise/global variables.

Default values:

- `ms_user_email`: Daniel mailbox address.
- `dry_run`: `true`.
- `batch_limit`: `25`.
- `tier3_confidence_threshold`: `0.65`.
- `slack_exception_channel`: `#workflow-builder`.
- `classifier_mount_path`: `/data/classifier`.
- `audit_table`: `inbox_classifications`.

Category map:

- `Q1`: `Q1: Do Now`
- `Q2`: `Q2: Schedule`
- `Q3`: `Q3: Delegate`
- `Q4`: `Q4: Eliminate`
- `QR`: `QR: Quarantine`

Before live mode, confirm these labels match Outlook master categories. If Daniel's mailbox uses different labels, update only the CONFIG map.

## Audit Schema

Use `scripts/email-categorizer-audit.sql` for the dedicated classifier Postgres database. It intentionally stores:

- `quadrant` as `Q1`, `Q2`, `Q3`, `Q4`, or `QR`.
- `outlook_category_label` separately.
- `tier_fired` as `0`, `1`, `2`, or `3`.

This fixes the draft schema mismatch where Quarantine and tier zero states were not representable.

## Dry-Run Test

1. Confirm the Outlook OAuth2 credential exists in n8n.
2. Confirm the classifier directory is mounted read-only at `/data/classifier`.
3. Confirm Postgres is online and private to the Docker network.
4. Import or build the workflow from `n8n-workflows/email-categorizer.spec.json`.
5. Keep `CONFIG.dry_run` as `true`.
6. Run the manual trigger or POST to `/webhook/email-categorizer-test`.
7. Confirm representative messages create audit rows.
8. Confirm no Outlook message category changes occur.
9. Confirm Slack only posts exceptions.

## Live Pilot

Turn live mode on only after dry-run rows are reviewed.

1. Set `CONFIG.dry_run` to `false`.
2. Start with a small `batch_limit`.
3. Run one manual execution.
4. Confirm Q1/Q2/Q3/Q4/QR messages receive the correct Outlook category.
5. Confirm audit rows have `applied_ok = true` for successful PATCH calls.
6. Return to `dry_run = true` if any category map or PATCH error appears.

## Rollback

Set `CONFIG.dry_run` back to `true` or pause the workflow in n8n. Do not remove Outlook categories automatically; review audit rows first and adjust manually if needed.
