# personal-ops

Time-blocking and accountability. Separate project from Breezi.

**Milestone 0** — this repo right now. Two things, nothing else:

1. A hook collector that records when you work in Claude Code, and for how long.
2. The gym log, moved off Claude's artifact storage onto your own Postgres.

Milestone 1 (the Assistant calendar, gym blocks, reconciliation, SMS on a miss)
builds on top of this. Nothing here is throwaway.

---

## Why the gym log moved

The artifact version stored sessions in Claude's artifact database. There is no
public API for it, so a service on Railway cannot read your sessions — and
reading your sessions *is* the verification loop. It had zero rows, so this was
the free moment to move it.

Two fields are new: `started_at` and `ended_at`. `started_at` is captured on the
first keystroke into a set, not by a button you have to remember. Duration is
what makes express-vs-full measurable.

---

## Deploy

```bash
# 1. New Railway project, add a Postgres service (DATABASE_URL is injected).
# 2. Set the two secrets:
openssl rand -hex 24   # -> ASSISTANT_TOKEN
openssl rand -hex 24   # -> APP_TOKEN
# 3. Deploy. Schema runs automatically on boot and is idempotent.
```

| Variable | What it's for |
| --- | --- |
| `DATABASE_URL` | Injected by Railway |
| `ASSISTANT_TOKEN` | Bearer token Claude Code hooks send |
| `APP_TOKEN` | Bearer token the gym page uses |
| `SESSION_GAP_MINUTES` | Silence that ends a work session. Default 45. |
| `BEAT_CREDIT_CAP_MINUTES` | Max time one beat can credit. Default 30. |
| `BEAT_FLOOR_MINUTES` | Credit for a session's first beat. Default 3. |

## Wire up the hooks

Copy `.claude/settings.json` into each repo you want tracked
(`breezi-dispatcher`, `wireinv`, this one), replacing the URL. Put
`ASSISTANT_TOKEN` in your shell environment so `allowedEnvVars` can pass it
through.

Then forget about it. It accumulates quietly and nothing reads it until
milestone 5.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Point an uptime check here |
| `POST` | `/hooks/cc` | Claude Code hooks. Bearer `ASSISTANT_TOKEN`. |
| `GET` | `/` | The gym log |
| `GET/PUT` | `/api/gym/program` | Your three-day split |
| `GET/POST` | `/api/gym/sessions` | Logged workouts |
| `GET` | `/api/gym/week` | Sessions this week vs target, plus Claude Code minutes by project |

## How work time is measured

A hook beat means *a turn just finished* — the work happened before it.
Measuring first-beat-to-last-beat reports 0 minutes for a single-beat session
and undercounts sparse ones, so each beat is credited the time since the
previous beat, capped at `BEAT_CREDIT_CAP_MINUTES`. A gap longer than
`SESSION_GAP_MINUTES` starts a new session.

Verified against Postgres 16 with a simulated evening: 19:42–23:03 with a
45-minute walk-away reports two sessions and 118 active minutes, which is the
honest answer.

## Local

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL and the tokens
npm run dev
```
