# Email Categorizer

Workflow: `Email Categorizer`

Spec: `n8n-workflows/email-categorizer.spec.json`

Live n8n workflow ID: `KeM4JZWK01qt532V`

The email categorizer is an n8n-first routine for Daniel's Outlook inbox. It classifies unread uncategorized Inbox messages into Eisenhower categories, writes an audit row for every attempt, and sends Slack notifications only for exceptions.

## Safety Model

- Do not read email bodies.
- Do not fetch or open attachments.
- Do not move, delete, archive, reply, forward, or mark read/unread.
- Only write Outlook message categories when `CONFIG.dry_run` is `false`.
- Treat all email metadata as untrusted.

The deployed n8n workflow currently keeps `CONFIG.dry_run` set to `true` and exposes `/webhook/email-categorizer-test` for metadata-only dry-run testing. It fetches real unread Outlook metadata for `dbradley@tciallc.com`, validates category labels, sends only low-confidence metadata to DBHub Ollama Tier 3, and still keeps live Outlook PATCH disabled.

Until the n8n MCP `update_workflow` path reliably updates this workflow, maintain the live workflow with the create-and-swap approach: create a replacement workflow, verify the Outlook metadata dry run, archive the old workflow, then publish the replacement on the canonical `Email Categorizer` name and webhook path.

## Required n8n Credentials

- Microsoft Outlook OAuth2 credential for Daniel's mailbox.
- Slack credential, reusing the existing `Slack account`.
- Postgres credential for the classifier audit database.
- DBHub direct Ollama endpoint/model reachable from the n8n container for Tier 3 metadata classification.

No OpenClaw dependency is required.

## CONFIG Node

Use a `CONFIG` Set node immediately after each trigger. Do not use enterprise/global variables.

Default values:

- `ms_user_email`: `dbradley@tciallc.com`.
- `dry_run`: `true`.
- `batch_limit`: `25`.
- `tier3_confidence_threshold`: `0.65`.
- `slack_exception_channel`: `#workflow-builder`.
- `classifier_mount_path`: `/data/classifier`.
- `audit_table`: `inbox_classifications`.
- `tier3_provider`: `dbhub_ollama`.
- `local_llm_base_url`: `http://100.66.221.24:11434`.
- `local_llm_model`: `qwen2.5:7b`.
- `enable_tier3_local_llm`: `true`.

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
- `workflow_version` so daily correction reviews can trace which deployed classifier version made the prediction.
- `inbox_classification_corrections` rows for manual Outlook category changes detected later.

The deployed dry-run workflow writes `audit_rows` through the n8n Postgres credential named `Email Categorizer Postgres`. Keep this credential scoped to the dedicated classifier database and the `inbox_classifications` / `inbox_classification_corrections` tables.

## Manual Correction Review

The daily correction workflow should:

1. Read recent `inbox_classifications` rows that have not been reviewed for manual changes.
2. Fetch the current Outlook categories for those message IDs.
3. Compare `outlook_category_label` with the current Outlook category list.
4. Insert a row into `inbox_classification_corrections` when Daniel manually changed the category.
5. Avoid Slack summaries; this workflow only updates the audit database.

Weekly rule suggestions should read new correction rows, group repeated sender/domain and subject-keyword patterns, and create a GitHub issue or PR through the established PR pipeline.

This fixes the draft schema mismatch where Quarantine and tier zero states were not representable.

## Dry-Run Test

1. Confirm the Outlook OAuth2 credential exists in n8n.
2. Confirm the classifier directory is mounted read-only at `/data/classifier`.
3. Confirm Postgres is online and private to the Docker network before audit-row validation.
4. Confirm `http://100.66.221.24:11434/api/tags` returns Ollama models from n8n.
5. Import or build the workflow from `scripts/build-n8n-workflows.mjs --only "Email Categorizer"`.
6. Keep `CONFIG.dry_run` as `true`.
7. Run the manual trigger or POST metadata-only sample messages to `/webhook/email-categorizer-test`.
8. Confirm real Outlook dry runs fetch unread metadata only and do not request body, bodyPreview, uniqueBody, or attachments.
9. Confirm low-confidence messages show `tier3_status: applied_local_llm` or a clear Tier 3 failure status.
10. Confirm representative messages create audit rows after Postgres is configured.
11. Confirm no Outlook message category changes occur.
12. Confirm Slack only posts exceptions.

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
