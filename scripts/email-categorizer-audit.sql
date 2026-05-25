-- Dedicated audit schema for the Email Categorizer n8n workflow.
-- Keep this Postgres database private to the Hostinger Docker network.

CREATE TABLE IF NOT EXISTS inbox_classifications (
    id                      BIGSERIAL PRIMARY KEY,
    classified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_id              TEXT        NOT NULL,
    internet_message_id     TEXT,
    subject                 TEXT,
    sender                  TEXT,
    sender_domain           TEXT,
    received_at             TIMESTAMPTZ,
    importance              TEXT,
    has_attachments         BOOLEAN,
    original_categories     JSONB       NOT NULL DEFAULT '[]'::JSONB,
    quadrant                TEXT        NOT NULL CHECK (quadrant IN ('Q1','Q2','Q3','Q4','QR')),
    outlook_category_label  TEXT,
    tier_fired              SMALLINT    NOT NULL CHECK (tier_fired IN (0,1,2,3)),
    confidence              NUMERIC(3,2),
    rule_matched            TEXT,
    llm_rationale           TEXT,
    dry_run                 BOOLEAN     NOT NULL DEFAULT TRUE,
    applied_ok              BOOLEAN     NOT NULL DEFAULT FALSE,
    workflow_version        TEXT,
    error_text              TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_classifications_classified_at
    ON inbox_classifications (classified_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_classifications_received_at
    ON inbox_classifications (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_classifications_quadrant
    ON inbox_classifications (quadrant);

CREATE INDEX IF NOT EXISTS idx_inbox_classifications_message_id
    ON inbox_classifications (message_id);

CREATE INDEX IF NOT EXISTS idx_inbox_classifications_sender_domain
    ON inbox_classifications (sender_domain);

CREATE TABLE IF NOT EXISTS inbox_classification_corrections (
    id                          BIGSERIAL PRIMARY KEY,
    detected_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    classification_id           BIGINT REFERENCES inbox_classifications(id),
    message_id                  TEXT        NOT NULL,
    predicted_quadrant          TEXT        NOT NULL CHECK (predicted_quadrant IN ('Q1','Q2','Q3','Q4','QR')),
    predicted_category_label    TEXT,
    observed_category_label     TEXT        NOT NULL,
    correction_source           TEXT        NOT NULL DEFAULT 'outlook_manual_change',
    rule_suggestion_status      TEXT        NOT NULL DEFAULT 'new',
    notes                       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_corrections_message_observed
    ON inbox_classification_corrections (message_id, observed_category_label);

CREATE INDEX IF NOT EXISTS idx_inbox_corrections_status
    ON inbox_classification_corrections (rule_suggestion_status, detected_at DESC);

CREATE OR REPLACE VIEW v_today_by_quadrant AS
SELECT
    quadrant,
    outlook_category_label,
    COUNT(*) AS n,
    AVG(confidence)::NUMERIC(3,2) AS avg_confidence,
    SUM(CASE WHEN tier_fired = 3 THEN 1 ELSE 0 END) AS tier3_hits,
    SUM(CASE WHEN dry_run THEN 1 ELSE 0 END) AS dry_run_hits,
    SUM(CASE WHEN applied_ok THEN 1 ELSE 0 END) AS applied_hits
FROM inbox_classifications
WHERE classified_at >= date_trunc('day', NOW())
GROUP BY quadrant, outlook_category_label
ORDER BY quadrant, outlook_category_label;
