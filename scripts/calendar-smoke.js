/**
 * Throwaway auth check for the gym calendar. Builds nothing, imports nothing
 * from src/. Creates one event an hour from now, prints its link, deletes it.
 *
 *   npm run smoke:calendar
 *
 * Needs GOOGLE_SA_JSON_B64 and GYM_CALENDAR_ID in the environment.
 *
 * Service-account-to-shared-calendar has three failure modes that all present
 * as "no events appeared". This script separates the one that is separable
 * (a bad key fails at the token step, before any calendar is named) and says
 * plainly that the other two are indistinguishable from the outside, because
 * the Calendar API returns a bare 404 both when a calendar id is wrong and
 * when it is right but not shared.
 *
 * Two things it deliberately does NOT do:
 *   - enumerate calendarList. A service account never accepts a sharing
 *     invitation, so its calendarList is always empty and reading it looks
 *     exactly like the sharing having failed.
 *   - set reminders.overrides. Reminders are per-identity; overrides written
 *     by a service account belong to the service account and reach nobody.
 */
import { JWT } from 'google-auth-library';

const CAL = process.env.GYM_CALENDAR_ID;
const B64 = process.env.GOOGLE_SA_JSON_B64;
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';

function die(stage, msg, hint) {
  console.error(`\n  FAILED at: ${stage}\n  ${msg}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
}

if (!B64) die('environment', 'GOOGLE_SA_JSON_B64 is not set.');
if (!CAL) die('environment', 'GYM_CALENDAR_ID is not set.');

console.log('\ncalendar auth smoke test\n');
console.log(`  calendar id   ${CAL}`);

// ---- 1. the key parses -------------------------------------------------
let sa;
try {
  sa = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'));
} catch (err) {
  die('decoding the key',
    `GOOGLE_SA_JSON_B64 did not decode to JSON: ${err.message}`,
    'It must be base64 of the whole service account .json file. A common\n' +
    '  mistake is base64 of the private_key field alone, or a value that\n' +
    '  picked up a newline when it was pasted.');
}
for (const field of ['client_email', 'private_key', 'token_uri']) {
  if (!sa[field]) die('reading the key', `The decoded key has no "${field}".`);
}
console.log(`  service acct  ${sa.client_email}`);
console.log(`  project       ${sa.project_id || '(none in key)'}`);
console.log('  key decoded   OK');

// ---- 2. the key can mint a token --------------------------------------
// Nothing about the calendar is involved yet, so a failure here is the key
// and only the key.
const auth = new JWT({
  email: sa.client_email,
  key: String(sa.private_key).replace(/\\n/g, '\n'),
  scopes: [SCOPE],
});

let token;
try {
  const res = await auth.getAccessToken();
  token = res && res.token;
  if (!token) throw new Error('no token in response');
} catch (err) {
  die('exchanging the key for a token',
    err.message,
    'This is the key itself, not the calendar -- no calendar has been named\n' +
    '  yet. Usual causes: the private_key is truncated or its newlines were\n' +
    '  mangled, the service account was deleted, or its key was revoked.');
}
console.log('  token minted  OK');

async function cal(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
  return { status: res.status, json, text };
}

// ---- 3. write a real event --------------------------------------------
const start = new Date(Date.now() + 60 * 60 * 1000);
const end = new Date(start.getTime() + 30 * 60 * 1000);
const body = {
  summary: 'personal-ops auth smoke test (safe to ignore)',
  description: 'Created and deleted by scripts/calendar-smoke.js.',
  start: { dateTime: start.toISOString() },
  end: { dateTime: end.toISOString() },
  transparency: 'transparent',
  // reminders deliberately untouched -- see the header.
};

const created = await cal(`/calendars/${encodeURIComponent(CAL)}/events`, {
  method: 'POST',
  body: JSON.stringify(body),
});

if (created.status === 404) {
  die('creating the event',
    `404 from the Calendar API for calendar id "${CAL}".`,
    'From out here a wrong calendar id and a calendar that was never shared\n' +
    '  are the same 404 -- Google will not say which. Check both:\n' +
    '    1. The id matches Calendar settings -> Integrate calendar -> Calendar ID.\n' +
    `    2. That calendar is shared with ${sa.client_email}\n` +
    '       with "Make changes to events".');
}
if (created.status === 403) {
  const reason = created.json?.error?.errors?.[0]?.reason || '(none given)';
  die('creating the event',
    `403 from the Calendar API (reason: ${reason}).`,
    'The calendar was found, so the id is right and it is shared -- but the\n' +
    '  access level is too low. "See all event details" is not enough; it\n' +
    '  needs "Make changes to events". If the reason above mentions the API\n' +
    '  being disabled, enable the Google Calendar API on the key\'s project.');
}
if (created.status !== 200) {
  die('creating the event',
    `HTTP ${created.status}: ${created.text.slice(0, 400)}`);
}

const eventId = created.json.id;
console.log('  event created OK');
console.log(`\n  id        ${eventId}`);
console.log(`  when      ${created.json.start?.dateTime} -> ${created.json.end?.dateTime}`);
console.log(`  htmlLink  ${created.json.htmlLink}`);

// ---- 4. read it back ---------------------------------------------------
const fetched = await cal(`/calendars/${encodeURIComponent(CAL)}/events/${encodeURIComponent(eventId)}`);
console.log(`\n  read back     ${fetched.status === 200 ? 'OK' : `FAILED (${fetched.status})`}`);

// ---- 5. delete it ------------------------------------------------------
const deleted = await cal(`/calendars/${encodeURIComponent(CAL)}/events/${encodeURIComponent(eventId)}`,
  { method: 'DELETE' });
if (deleted.status !== 204 && deleted.status !== 200) {
  die('deleting the event',
    `HTTP ${deleted.status}: ${deleted.text.slice(0, 300)}`,
    `The event is still on the calendar. Remove "${eventId}" by hand.`);
}
console.log('  deleted       OK');

const after = await cal(`/calendars/${encodeURIComponent(CAL)}/events/${encodeURIComponent(eventId)}`);
const gone = after.status === 404 || after.json?.status === 'cancelled';
console.log(`  confirmed gone ${gone ? 'OK' : `NO -- still returns ${after.status}`}`);

console.log('\n  Round trip complete: the key works, the calendar id is right,');
console.log('  and the service account can write to it.\n');
process.exit(gone ? 0 : 1);
