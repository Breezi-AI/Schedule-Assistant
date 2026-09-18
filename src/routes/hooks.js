import { Router } from 'express';
import { q } from '../db/index.js';

export const hooks = Router();

/**
 * Last path segment of a cwd, used to group beats by project.
 *
 * Claude Code sends the OS-native cwd, so on Windows this arrives as
 * "C:\Users\Kaylee\breezi-dispatcher". Splitting on "/" alone stored the
 * entire path as the project name. Split on both separators.
 */
export function projectFromCwd(cwd) {
  if (typeof cwd !== 'string') return null;
  const seg = cwd.split(/[\\/]+/).filter(Boolean).pop();
  if (!seg) return null;
  return /^[A-Za-z]:$/.test(seg) ? null : seg; // bare drive root is not a project
}

/**
 * Shape of a turn, never its contents (CLAUDE.md rule 4).
 *
 * Verified against Claude Code 2.1.191: a Stop payload carries
 * session_id, transcript_path, cwd, permission_mode, agent_id, agent_type,
 * effort, hook_event_name, stop_hook_active, last_assistant_message,
 * background_tasks and session_crons.
 *
 * It does NOT carry tool_calls -- that was an assumption, and tool_names /
 * tool_count sat empty because of it. Parsing is kept so the shape is still
 * captured if a PostToolUse hook is ever pointed here, but nothing in
 * milestone 0 depends on it: session grouping reads only received_at,
 * session_id and project.
 *
 * last_assistant_message and transcript_path are deliberately dropped.
 */
export function shapeOf(b) {
  const toolCalls = Array.isArray(b.tool_calls) ? b.tool_calls : null;
  return {
    permission_mode: typeof b.permission_mode === 'string' ? b.permission_mode : null,
    agent_type: typeof b.agent_type === 'string' ? b.agent_type : null,
    agent_id: typeof b.agent_id === 'string' ? b.agent_id : null,
    effort: b.effort && typeof b.effort.level === 'string' ? b.effort.level : null,
    stop_hook_active: typeof b.stop_hook_active === 'boolean' ? b.stop_hook_active : null,
    background_tasks: Array.isArray(b.background_tasks) ? b.background_tasks.length : 0,
    tool_names: toolCalls
      ? toolCalls.map((t) => t && t.tool_name).filter((n) => typeof n === 'string').slice(0, 40)
      : [],
    tool_count: toolCalls ? toolCalls.length : 0,
  };
}

/**
 * POST /hooks/cc
 *
 * Receives Claude Code hook events. Configure in a repo's
 * .claude/settings.json -- see .claude/settings.json in this repo
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

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const cwd = typeof b.cwd === 'string' ? b.cwd : null;

  try {
    await q(
      `INSERT INTO cc_events (session_id, event_name, cwd, project, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        typeof b.session_id === 'string' ? b.session_id : null,
        typeof b.hook_event_name === 'string' ? b.hook_event_name : 'Stop',
        cwd,
        projectFromCwd(cwd),
        shapeOf(b),
      ]
    );
  } catch (err) {
    // Never fail the user's Claude Code turn over telemetry.
    console.error('[hooks/cc] insert failed:', err.message);
  }

  res.status(200).json({ ok: true });
});
