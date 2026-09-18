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

// ---------------------------------------------------------------------
// Local time. Every case below is one where offset arithmetic gets it wrong.
// ---------------------------------------------------------------------
const { weekStartDate, comingWeekStart, slotFor } = await import('../src/time.js');
const NY = 'America/New_York';

console.log('\nweekStartDate');

// The bug, stated as a test. 9pm Sunday in New York is already Monday in UTC,
// so date_trunc('week', now()) in a UTC database returned the NEXT Monday and
// the workout being logged at that moment fell outside "this week".
const sundayNight = new Date('2026-09-21T01:00:00Z'); // Sun 20 Sep, 21:00 New York
check('9pm Sunday in New York belongs to the week that started Mon 14 Sep',
  weekStartDate(sundayNight, NY) === '2026-09-14',
  `got ${weekStartDate(sundayNight, NY)} (UTC would say 2026-09-21, which was the bug)`);

check('the same instant read as UTC really does fall on the Monday',
  new Date(sundayNight).toISOString().slice(0, 10) === '2026-09-21',
  'if this fails the fixture is wrong, not the code');

const mondayJustAfter = new Date('2026-09-21T04:01:00Z'); // Mon 21 Sep, 00:01 New York
check('one minute past midnight Monday starts the new week',
  weekStartDate(mondayJustAfter, NY) === '2026-09-21',
  `got ${weekStartDate(mondayJustAfter, NY)}`);

const sundayJustBefore = new Date('2026-09-21T03:59:00Z'); // Sun 20 Sep, 23:59 New York
check('one minute before midnight Sunday is still the old week',
  weekStartDate(sundayJustBefore, NY) === '2026-09-14',
  `got ${weekStartDate(sundayJustBefore, NY)}`);

// 1 Nov 2026 is the Sunday the clocks go back, and it is also a Sunday night.
const dstSundayNight = new Date('2026-11-02T02:00:00Z'); // Sun 1 Nov, 21:00 New York (EST)
check('Sunday night of the DST changeover lands in the week from Mon 26 Oct',
  weekStartDate(dstSundayNight, NY) === '2026-10-26',
  `got ${weekStartDate(dstSundayNight, NY)}`);

console.log('\ncomingWeekStart');
check('run on Sunday evening, the coming week starts tomorrow',
  comingWeekStart(sundayNight, NY).toISODate() === '2026-09-21',
  `got ${comingWeekStart(sundayNight, NY).toISODate()}`);

const wednesday = new Date('2026-09-23T16:00:00Z');
check('run manually midweek, it still means the next calendar week',
  comingWeekStart(wednesday, NY).toISODate() === '2026-09-28',
  `got ${comingWeekStart(wednesday, NY).toISODate()}`);

console.log('\nslotFor (DST correctness)');

// Same wall-clock time either side of the November changeover must produce
// instants an hour apart. This is the check that offset arithmetic fails.
const edtWeek = comingWeekStart(new Date('2026-10-20T16:00:00Z'), NY); // -> Mon 26 Oct, EDT
const estWeek = comingWeekStart(new Date('2026-10-27T16:00:00Z'), NY); // -> Mon  2 Nov, EST

const edtMon = slotFor(edtWeek, 0, 17, 45, 60);
const estMon = slotFor(estWeek, 0, 17, 45, 60);

check('the week before the change starts Mon 26 Oct at UTC-04:00',
  edtMon.date === '2026-10-26' && edtMon.offset === '-04:00',
  `date=${edtMon.date} offset=${edtMon.offset}`);
check('the week after the change starts Mon 2 Nov at UTC-05:00',
  estMon.date === '2026-11-02' && estMon.offset === '-05:00',
  `date=${estMon.date} offset=${estMon.offset}`);
check('17:45 local is 21:45Z before the change',
  edtMon.startUtc.startsWith('2026-10-26T21:45'),
  `got ${edtMon.startUtc}`);
check('17:45 local is 22:45Z after it -- a naive fixed offset would say 21:45Z',
  estMon.startUtc.startsWith('2026-11-02T22:45'),
  `got ${estMon.startUtc}`);
check('the local wall clock is identical on both sides of the change',
  edtMon.startLocal.slice(11) === '17:45:00' && estMon.startLocal.slice(11) === '17:45:00',
  `${edtMon.startLocal} vs ${estMon.startLocal}`);

const friday = slotFor(estWeek, 4, 16, 5, 60);
check('Friday resolves to day 5 of the week at 16:05-17:05 local',
  friday.date === '2026-11-06' && friday.startLocal.endsWith('16:05:00') &&
  friday.endLocal.endsWith('17:05:00'),
  `${friday.date} ${friday.startLocal} -> ${friday.endLocal}`);

const wed = slotFor(estWeek, 2, 17, 45, 60);
check('Wednesday resolves to day 3 of the week',
  wed.date === '2026-11-04', `got ${wed.date}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
