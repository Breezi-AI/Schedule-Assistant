import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate, q } from './db/index.js';
import { hooks } from './routes/hooks.js';
import { gym } from './routes/gym.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));

// Liveness. Also the thing to point an uptime check at, so a dead
// service is something you find out about rather than infer from silence.
app.get('/health', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, at: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use('/hooks', hooks);
app.use('/api/gym', gym);

// The gym log UI.
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

/**
 * Last line of defence. Two jobs:
 *
 *  1. Answer. An async route that rejects reaches here via next(err), so the
 *     request gets a response instead of hanging until the client gives up.
 *  2. Keep /hooks quiet. A hook that receives an error is a hook that can
 *     surface a failure in the middle of the user's work, so anything under
 *     /hooks answers 200 regardless -- including a body express.json()
 *     could not parse. Telemetry never breaks the user's turn.
 */
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  if (req.path.startsWith('/hooks') || req.baseUrl?.startsWith('/hooks')) {
    return res.status(200).json({ ok: true, noted: false });
  }
  res.status(err.status && err.status < 500 ? err.status : 500)
     .json({ error: err.status === 400 ? 'bad request' : 'server error' });
});

const port = process.env.PORT || 3000;

/**
 * Railway can start this container before Postgres is accepting connections.
 * Retrying turns a first-boot race into a clean start rather than a red deploy.
 */
async function migrateWithRetry(attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await migrate();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      const wait = i * 2000;
      console.warn(`migrate attempt ${i}/${attempts} failed (${err.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

migrateWithRetry()
  .then(() => {
    app.listen(port, () => console.log(`personal-ops listening on :${port}`));
  })
  .catch((err) => {
    console.error('migrate failed:', err);
    process.exit(1);
  });
