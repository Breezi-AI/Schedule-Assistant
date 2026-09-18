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

const port = process.env.PORT || 3000;

migrate()
  .then(() => {
    app.listen(port, () => console.log(`personal-ops listening on :${port}`));
  })
  .catch((err) => {
    console.error('migrate failed:', err);
    process.exit(1);
  });
