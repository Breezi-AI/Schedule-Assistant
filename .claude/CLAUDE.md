# personal-ops

Time-blocking and accountability for Jake. **Separate project from Breezi** — no
shared package, no plugin. Read `docs/STATE.md` before doing anything.

## Shape

`src/index.js` boots, runs the schema, serves. Modules:

- `src/db/` — pool, schema, the session-grouping queries
- `src/routes/hooks.js` — receives Claude Code hook beats
- `src/routes/gym.js` — gym program and sessions API
- `src/public/` — the gym log UI, plain HTML, no build step

## Rules

1. **The server stamps time.** Never trust a timestamp from a payload. Client
   clocks get guarded or discarded.
2. **Ingest returns fast and does no thinking.** Hooks have a short budget;
   never block a turn on this service.
3. **Telemetry never breaks the user's work.** A failed insert in `/hooks/cc`
   logs and returns 200.
4. **Store shapes, not contents.** Tool names and counts, never transcripts or
   message bodies.
5. **No build step for the UI.** It's one HTML file on purpose — it has to be
   openable and fixable from a phone.
6. **Schema changes go in `schema.sql`** and must stay idempotent; it runs on
   every boot.

## Not in scope yet

Calendar writes, SMS, commitments, constraints, email, the learning layer.
They have a design in the project doc, but this repo is milestone 0.
