import { Router } from 'express';
import { q } from '../db/index.js';

export const hooks = Router();

/**
 * POST /hooks/cc
 *
 * Receives Claude Code hook events. Configure in a repo's
 * .claude/settings.json — see .claude/settings.json in this repo
 * for the exact block to copy.
 *
 * Two rules this endpoint exists to enforce:
 *  1. The SERVER stamps the time. Nothing trusts a payload clock.
 *  2. It returns fast and does no thinking. Hooks have a short budget.
 */
hooks.post('/cc', async (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!process.env.ASSISTANT_TOKEN || token !== process.env.ASSISTANT_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const b = req.body || {};
  const cwd = typeof b.cwd === 'string' ? b.cwd : null;
  const project = cwd ? cwd.split('/').filter(Boolean).pop() ?? null : null;

  // Transcripts can be large and contain everything you have ever typed.
  // Store the shape of the turn, not its contents.
  const payload = {
    permission_mode: b.permission_mode ?? null,
    agent_type: b.agent_type ?? null,
    tool_names: Array.isArray(b.tool_calls)
      ? b.tool_calls.map((t) => t?.tool_name).filter(Boolean).slice(0, 40)
      : [],
    tool_count: Array.isArray(b.tool_calls) ? b.tool_calls.length : 0,
  };

  try {
    await q(
      `INSERT INTO cc_events (session_id, event_name, cwd, project, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [b.session_id ?? null, b.hook_event_name ?? 'Stop', cwd, project, payload]
    );
  } catch (err) {
    // Never fail the user's Claude Code turn over telemetry.
    console.error('[hooks/cc] insert failed:', err.message);
  }

  res.status(200).json({ ok: true });
});
