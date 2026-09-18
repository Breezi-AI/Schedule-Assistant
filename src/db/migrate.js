/**
 * Standalone schema runner: `npm run migrate`.
 *
 * package.json referenced this file but it did not exist, so the script
 * failed with MODULE_NOT_FOUND. The server already migrates on boot; this
 * is for applying the schema to a database without starting anything.
 */
import { migrate, pool } from './index.js';

try {
  await migrate();
  console.log('schema applied');
} catch (err) {
  console.error('migrate failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
