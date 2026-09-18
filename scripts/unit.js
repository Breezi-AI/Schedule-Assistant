/**
 * Unit checks for the pure parts of hook ingest. No database, no network.
 *
 *   npm run test:unit
 *
 * These exist because both functions are where a silent wrong answer is
 * possible: projectFromCwd returning a whole path still stores a row, and
 * shapeOf leaking a message body still returns 200.
 */
// hooks.js pulls in the db module, which refuses to load without a
// DATABASE_URL. Nothing here touches the database, so a placeholder is
// enough -- the pool is lazy and never connects.
process.env.DATABASE_URL ||= 'postgres://unit:test@127.0.0.1:1/none';
const { projectFromCwd, shapeOf } = await import('../src/routes/hooks.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

console.log('\nprojectFromCwd');
const cases = [
  ['C:\\Users\\Kaylee\\breezi-dispatcher', 'breezi-dispatcher', 'Windows path'],
  ['C:\\Users\\Kaylee\\personal-ops', 'personal-ops', 'Windows path'],
  ['/home/jake/wireinv', 'wireinv', 'POSIX path'],
  ['C:\\Users\\Kaylee\\repo\\', 'repo', 'trailing separator'],
  ['C:/Users/Kaylee/mixed\\sep', 'sep', 'mixed separators'],
  ['C:\\', null, 'bare drive root is not a project'],
  ['/', null, 'filesystem root is not a project'],
  [null, null, 'null cwd'],
  [undefined, null, 'missing cwd'],
  [42, null, 'non-string cwd'],
];
for (const [input, want, why] of cases) {
  const got = projectFromCwd(input);
  check(`${why}: ${JSON.stringify(input)} -> ${JSON.stringify(want)}`,
    got === want, `got ${JSON.stringify(got)}`);
}

console.log('\nshapeOf');
const full = shapeOf({
  permission_mode: 'acceptEdits',
  agent_type: 'main',
  effort: { level: 'high' },
  stop_hook_active: false,
  background_tasks: [1, 2],
  last_assistant_message: 'SECRET-MESSAGE-BODY',
  transcript_path: 'C:\\Users\\Kaylee\\.claude\\x.jsonl',
});
check('captures permission_mode', full.permission_mode === 'acceptEdits', JSON.stringify(full));
check('flattens effort to its level', full.effort === 'high', JSON.stringify(full));
check('counts background tasks', full.background_tasks === 2, JSON.stringify(full));
check('keeps stop_hook_active as a boolean', full.stop_hook_active === false, JSON.stringify(full));
check('never stores the assistant message',
  !JSON.stringify(full).includes('SECRET-MESSAGE-BODY'), JSON.stringify(full));
check('never stores the transcript path',
  !JSON.stringify(full).includes('.jsonl'), JSON.stringify(full));

const empty = shapeOf({});
check('an empty payload produces a safe shape',
  empty.tool_count === 0 && Array.isArray(empty.tool_names) && empty.tool_names.length === 0 &&
  empty.permission_mode === null && empty.effort === null,
  JSON.stringify(empty));

const hostile = shapeOf({
  permission_mode: { nope: 1 },
  effort: 'not-an-object',
  stop_hook_active: 'yes',
  background_tasks: 'lots',
  tool_calls: 'not-an-array',
});
check('hostile types are coerced to null rather than stored',
  hostile.permission_mode === null && hostile.effort === null &&
  hostile.stop_hook_active === null && hostile.background_tasks === 0 &&
  hostile.tool_count === 0,
  JSON.stringify(hostile));

const withTools = shapeOf({
  tool_calls: [{ tool_name: 'Bash' }, { tool_name: 'Read' }, {}, null, { tool_name: 7 }],
});
check('tool_calls parsing survives junk entries if ever sent',
  withTools.tool_count === 5 &&
  withTools.tool_names.length === 2 &&
  withTools.tool_names[0] === 'Bash' && withTools.tool_names[1] === 'Read',
  JSON.stringify(withTools));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
