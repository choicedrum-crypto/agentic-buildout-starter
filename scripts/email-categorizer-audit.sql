-- Dedicated audit schema for the Email Categorizer n8n workflow.
-- Keep this Postgres database private to the Hostinger Docker network.

CREATE TABLE IF NOT EXISTS inbox_classifications (
    id                      BIGSERIAL PRIMARY KEY,
    classified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_id              TEXT        NOT NULL,
    internet_message_id     TEXT,
    subject                 TEXT,
    sender                  TEXT,
    received_at             TIMESTAMPTZ,
    importance              TEXT,
    has_attachments         BOOLEAN,
    quadrant                TEXT        NOT NULL CHECK (quadrant IN ('Q1','Q2','Q3','Q4','QR')),
    outlook_category_label  TEXT,
    tier_fired              SMALLINT    NOT NULL CHECK (tier_fired IN (0,1,2,3)),
    confidence              NUMERIC(3,2),
    rule_matched            TEXT,
    llm_rationale           TEXT,
    dry_run                 BOOLEAN     NOT NULL DEFAULT TRUE,
    applied_ok              BOOLEAN     NOT NULL DEFAULT FALSE,
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
