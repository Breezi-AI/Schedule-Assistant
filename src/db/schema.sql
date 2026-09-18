-- personal-ops schema, milestone 0
-- Two concerns only: Claude Code session telemetry, and the gym log.
-- Everything else (commitments, calendar blocks, constraints) comes later.

-- ---------------------------------------------------------------
-- Claude Code hook events. Append-only. Never edited.
-- The server stamps received_at; nothing trusts a client clock.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cc_events (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id    TEXT,
  event_name    TEXT,
  cwd           TEXT,
  project       TEXT,          -- last path segment of cwd, for grouping
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cc_events_session_idx  ON cc_events (session_id, received_at);
CREATE INDEX IF NOT EXISTS cc_events_project_idx  ON cc_events (project, received_at);
CREATE INDEX IF NOT EXISTS cc_events_received_idx ON cc_events (received_at);

-- ---------------------------------------------------------------
-- Gym program. Single row, id = 1. Same shape as the artifact
-- version so the UI port is a straight swap.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gym_program (
  id          INT PRIMARY KEY DEFAULT 1,
  days        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gym_program_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------
-- Gym sessions. One row per logged workout.
-- started_at / ended_at are the addition over the artifact version.
-- started_at is captured when the first set is entered, not by a
-- button anyone has to remember to press.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gym_sessions (
  id            TEXT PRIMARY KEY,          -- YYYY-MM-DD-dayId
  session_date  DATE NOT NULL,
  day_id        TEXT NOT NULL,
  day_name      TEXT,
  sets          JSONB NOT NULL DEFAULT '{}'::jsonb,
  names         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  logged_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gym_sessions_date_idx ON gym_sessions (session_date DESC);

-- ---------------------------------------------------------------
-- Commitments. Things the assistant has put on the calendar and
-- intends to hold you to.
--
-- Named for what it becomes, not for what it holds today. Right now
-- every row is kind = 'gym', but the shape is deliberately general --
-- this is the table that later carries every kind of block, which is
-- why `kind` exists from the start rather than being retrofitted.
--
-- `id` is deterministic: "<kind>-<local date>", e.g. "gym-2026-09-21".
-- That is the whole idempotency mechanism. One commitment of a kind per
-- local date is enforced by the primary key, so a second planner run
-- cannot write a duplicate even if it races the first -- there is no
-- check-then-insert window to lose.
--
-- planned_start / planned_end are absolute instants. The local wall
-- clock they were derived from lives in the calendar event; storing an
-- instant here means a DST change cannot retroactively move a block.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commitments (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL DEFAULT 'gym',
  day_id            TEXT,
  planned_start     TIMESTAMPTZ NOT NULL,
  planned_end       TIMESTAMPTZ NOT NULL,
  calendar_event_id TEXT,
  status            TEXT NOT NULL DEFAULT 'planned',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commitments_start_idx ON commitments (planned_start);
CREATE INDEX IF NOT EXISTS commitments_kind_idx  ON commitments (kind, planned_start);
