-- #578 (epic #577, roadmap #525): owner-led visual-change PR auto-review scaffold.
-- Mirrors the submission-gate pattern (webhook -> queue -> D1 state) for a SEPARATE concern: visual
-- review of UI-changing PRs. This migration lands only the state plumbing; later child issues add
-- detection (#579), render/capture (#580/#581), diff (#582), R2 image hosting + managed comment (#583).
--
-- `visual_review_targets` tracks one review target per (repo, PR, head SHA): a fresh push (new head_sha)
-- becomes a new target so each commit is reviewed independently and idempotently. Lifecycle states:
--   queued -> capturing -> posted        (happy path; "posted" arrives once #583 ships the comment)
--   queued -> capturing -> failed        (terminal failure after the queue/DLQ exhausts retries)
-- `attempts` / `last_error` make a persistently-failing target observable instead of silently dropped.
CREATE TABLE IF NOT EXISTS visual_review_targets (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  installation_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivery_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Idempotency: re-delivery of the same PR/head SHA webhook upserts the existing target rather than
-- spawning duplicates (the submission-gate house pattern for webhook redelivery).
CREATE UNIQUE INDEX IF NOT EXISTS visual_review_targets_repo_pr_head_unique
  ON visual_review_targets (repo_full_name, pull_number, head_sha);
CREATE INDEX IF NOT EXISTS visual_review_targets_repo_status_idx
  ON visual_review_targets (repo_full_name, status);
CREATE INDEX IF NOT EXISTS visual_review_targets_status_updated_idx
  ON visual_review_targets (status, updated_at);

-- Per-repository enablement. Visual review is OPT-IN (default disabled): a repo only gets visual-change
-- PRs enqueued once an owner/operator flips `enabled`. Absence of a row == disabled.
CREATE TABLE IF NOT EXISTS visual_review_settings (
  repo_full_name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
