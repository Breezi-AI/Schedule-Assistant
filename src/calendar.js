/**
 * Google Calendar, over plain REST.
 *
 * google-auth-library does the JWT dance and caches the access token; the
 * four calls this needs are a fetch each. The full googleapis package is
 * ~50MB of generated clients to avoid writing those four lines.
 *
 * Two hard rules, both learned the expensive way:
 *
 *   1. Address the calendar by id, never by enumerating calendarList. A
 *      service account does not accept sharing invitations, so its
 *      calendarList is permanently empty -- which looks exactly like the
 *      sharing having failed when it is fine.
 *
 *   2. Never send reminders.overrides. Reminders are per-identity and
 *      private to whoever is authenticated. Overrides written by a service
 *      account belong to the service account and are delivered to nobody.
 *      The phone notifications come from the calendar's own defaults, set
 *      in the owner's Google Calendar settings. Leaving the field absent
 *      is what lets those defaults apply.
 */
import { JWT } from 'google-auth-library';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

let client = null;

/**
 * Built on first use, not at import. The gym log has to keep serving on a
 * deployment where the calendar credentials are missing or wrong -- a
 * broken planner must not take down /health and the workout log with it.
 */
function authClient() {
  if (client) return client;
  const b64 = process.env.GOOGLE_SA_JSON_B64;
  if (!b64) throw new Error('GOOGLE_SA_JSON_B64 is not set');

  let sa;
  try {
    sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`GOOGLE_SA_JSON_B64 did not decode to JSON: ${err.message}`);
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('service account key is missing client_email or private_key');
  }

  client = new JWT({
    email: sa.client_email,
    key: String(sa.private_key).replace(/\\n/g, '\n'),
    scopes: [SCOPE],
  });
  return client;
}

export function calendarId() {
  const id = process.env.GYM_CALENDAR_ID;
  if (!id) throw new Error('GYM_CALENDAR_ID is not set');
  return id;
}

/** True when the calendar can be used at all. Lets callers degrade instead of throw. */
export function calendarConfigured() {
  return Boolean(process.env.GOOGLE_SA_JSON_B64 && process.env.GYM_CALENDAR_ID);
}

async function call(path, opts = {}) {
  const auth = authClient();
  const { token } = await auth.getAccessToken();
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
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }

  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || '';
    const detail = json?.error?.message || text.slice(0, 300);
    const err = new Error(`Calendar API ${res.status}: ${detail}${reason ? ` (${reason})` : ''}`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return json;
}

const enc = encodeURIComponent;

/**
 * Create an event from a local wall-clock time plus a zone.
 *
 * Sending { dateTime, timeZone } rather than a UTC instant is deliberate:
 * it records the intent ("17:45 in New York") rather than a derived offset,
 * so the event stays correct and self-describing across a DST change.
 */
export async function insertEvent({
  summary, location, startLocal, endLocal, zone, colorId, description,
}) {
  const body = {
    summary,
    location,
    start: { dateTime: startLocal, timeZone: zone },
    end: { dateTime: endLocal, timeZone: zone },
    transparency: 'opaque',
  };
  if (colorId) body.colorId = String(colorId);
  if (description) body.description = description;
  // No `reminders` key. See the header.
  return call(`/calendars/${enc(calendarId())}/events`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getEvent(eventId) {
  return call(`/calendars/${enc(calendarId())}/events/${enc(eventId)}`);
}

export async function deleteEvent(eventId) {
  return call(`/calendars/${enc(calendarId())}/events/${enc(eventId)}`, { method: 'DELETE' });
}

/** Events overlapping a window. Used to verify what actually landed. */
export async function listEvents({ timeMin, timeMax, maxResults = 50 }) {
  const qs = new URLSearchParams({
    timeMin, timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });
  const out = await call(`/calendars/${enc(calendarId())}/events?${qs}`);
  return out.items || [];
}
