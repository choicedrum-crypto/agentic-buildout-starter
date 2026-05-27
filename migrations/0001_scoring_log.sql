-- Migration: scoring_log audit table for DBhub scoring events.
-- Plane issue: 0b6f2784-ae89-4816-8cdd-5c9bf59e28cc

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS scoring_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id        text NOT NULL,
  workspace_id    text NOT NULL,
  project_id      text NOT NULL,
  prompt_version  text NOT NULL,
  model           text NOT NULL,
  raw_input       jsonb NOT NULL,
  raw_output      text,
  parsed_output   jsonb,
  computed_score  integer,
  success         boolean NOT NULL,
  error           text,
  event_type      text NOT NULL DEFAULT 'score',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scoring_log_issue_created
  ON scoring_log (issue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scoring_log_success_created
  ON scoring_log (success, created_at DESC);
