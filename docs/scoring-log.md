# Scoring Log

Migration: `migrations/0001_scoring_log.sql`

The `scoring_log` table stores one audit row for each DBhub scoring event. It keeps the source Plane context, prompt/model version, raw LLM input, literal output, parsed JSON output when available, computed priority score, and failure details.

## Verification

After applying the migration on the n8n host Postgres database:

1. Insert a successful synthetic `score` event with `raw_input`, `raw_output`, `parsed_output`, and `computed_score`.
2. Insert a failed synthetic `score` event with `raw_input`, `raw_output`, `success = false`, and `error`.
3. Query by `issue_id` and confirm rows order by newest first.
4. Query by `success` and confirm the supporting index is used for recent success/failure review.

## Rollback

The table is additive and has no downstream dependencies at creation time. To roll back before live scoring uses it:

```sql
DROP TABLE IF EXISTS scoring_log;
```
