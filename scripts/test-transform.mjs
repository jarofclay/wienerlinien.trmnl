import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { run, normalizeStationName, decodeHtml } = require('../src/transform.js');

const fixturePath = path.resolve(import.meta.dirname, '../fixtures/sample-payload.json');
const sample = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('Running Vienna Transit TRMNL transform tests...\n');

test('decodes HTML entities from ÖBB Scotty feed', () => {
  assert.equal(decodeHtml('M&#246;dling'), 'Mödling');
  assert.equal(decodeHtml('G&#228;nserndorf'), 'Gänserndorf');
  assert.equal(decodeHtml('St. P&#246;lten &amp; Wien'), 'St. Pölten & Wien');
});

test('normalizes and merges Wiener Linien & ÖBB station names', () => {
  assert.equal(normalizeStationName('Praterstern S U'), 'Praterstern');
  assert.equal(normalizeStationName('Praterstern SU'), 'Praterstern');
  assert.equal(normalizeStationName('Wien Praterstern Bahnhof'), 'Praterstern');
  assert.equal(normalizeStationName('Wien Hbf (U)'), 'Wien Hbf');
  assert.equal(normalizeStationName('Hauptbahnhof'), 'Wien Hbf');
  assert.equal(normalizeStationName('Landstraße'), 'Wien Mitte');
});

test('merges multi-URL Wiener Linien + ÖBB payloads and shows both directions', () => {
  const d = run(sample);

  assert.equal(d.title, 'Vienna Transit');
  assert.equal(d.updated, '14:08');
  assert.equal(d.times_per_route, 2);
  assert.equal(d.empty_message, null);

  // Praterstern WL + Praterstern ÖBB merge into 1 station; Wien Hbf is 2nd station
  assert.equal(d.stops.length, 2);
  assert.equal(d.stops[0].name, 'Praterstern');
  assert.equal(d.stops[1].name, 'Wien Hbf');

  const praterRoutes = d.stops[0].routes;
  // Both ways for U1 (Leopoldau & Oberlaa) and U2 (Karlsplatz & Seestadt)
  const u1Dirs = praterRoutes.filter((r) => r.line === 'U1').map((r) => r.to);
  assert.deepEqual(u1Dirs, ['Leopoldau', 'Oberlaa']);

  const u2Dirs = praterRoutes.filter((r) => r.line === 'U2').map((r) => r.to);
  assert.deepEqual(u2Dirs, ['Karlsplatz', 'Seestadt']);

  // Buses present
  const busLines = praterRoutes.filter((r) => r.mode === 'bus').map((r) => r.line);
  assert.deepEqual(busLines, ['5B', '80A', '82A']);

  // S-Bahn merged into Praterstern with decoded umlauts and real delay time
  const sbLines = praterRoutes.filter((r) => r.mode === 'sbahn');
  assert.equal(sbLines.length, 3);
  const s1 = sbLines.find((r) => r.line === 'S1');
  assert.equal(s1.to, 'Gänserndorf');
  assert.equal(s1.ts[0].t, '14:13');
  assert.equal(s1.ts[1].t, '14:43');

  const s2 = sbLines.find((r) => r.line === 'S2');
  assert.equal(s2.to, 'Mödling');
  assert.equal(s2.ts[0].t, '14:18'); // Real delayed time (14:15 + 3 min)
  assert.equal(s2.ts[0].d, 3);
  assert.equal(s2.ts[1].t, '14:45');

  // Tram excluded when include_tram: false
  assert.equal(praterRoutes.filter((r) => r.mode === 'tram').length, 0);
});

test('supports times_per_route = 3 and 4 for 15-minute Free TRMNL refresh', () => {
  const clone = structuredClone(sample);
  clone.trmnl.plugin_settings.custom_fields_values.times_per_route = '4';
  const d = run(clone);
  assert.equal(d.times_per_route, 4);

  const u1Leo = d.stops[0].routes.find((r) => r.line === 'U1' && r.to === 'Leopoldau');
  assert.deepEqual(
    u1Leo.ts.map((x) => x.t),
    ['14:11', '14:16', '14:21', '14:26']
  );

  const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
  assert.ok(bytes < 5000, `Expected payload < 5000 bytes with 4 times/route, got ${bytes}`);
  console.log(`        (Payload size with times_per_route=4: ${bytes} bytes)`);
});

test('skips cancelled S-Bahn trains and applies real-time delay clock', () => {
  const d = run(sample);
  const hbfRoutes = d.stops[1].routes;

  // S80 -> Leobersdorf had status "Ausfall", so it must be excluded
  assert.equal(hbfRoutes.some((r) => r.to === 'Leobersdorf'), false);

  // S1 -> Wien Liesing delayed +5 min: scheduled 14:17 -> real 14:22
  const s1 = hbfRoutes.find((r) => r.line === 'S1');
  assert.equal(s1.ts[0].t, '14:22');
  assert.equal(s1.ts[0].d, 5);
  assert.equal(s1.ts[1].t, '14:47');
});

test('applies minimum walk time buffer to avoid uncatchable 0-min departures', () => {
  const d = run(sample);
  const praterRoutes = d.stops[0].routes;
  // U1 -> Oberlaa had a 0-min departure at 14:08; with min_walk_minutes=1, ts[0] must be 14:12 (+2 delay)
  const u1Oberlaa = praterRoutes.find((r) => r.line === 'U1' && r.to === 'Oberlaa');
  assert.equal(u1Oberlaa.ts[0].t, '14:12');
  assert.equal(u1Oberlaa.ts[0].d, 2);
  assert.equal(u1Oberlaa.ts[1].t, '14:15');

  // 80A had a 0-min departure at 14:08; ts[0] must be 14:16, ts[1] 14:23
  const bus80A = praterRoutes.find((r) => r.line === '80A');
  assert.equal(bus80A.ts[0].t, '14:16');
  assert.equal(bus80A.ts[1].t, '14:23');
});

test('excludes scheduled-only Wiener Linien departures when realtime_only is true and tags fallback with s:1 when false', () => {
  const schedInput = {
    data: {
      monitors: [
        {
          locationStop: { properties: { title: 'Teststop' } },
          lines: [
            {
              name: '13A',
              towards: 'Alser Straße',
              type: 'ptBusCity',
              realtimeSupported: true,
              departures: {
                departure: [
                  { departureTime: { timePlanned: '2026-11-25T14:15:00.000+0100', countdown: 7 } }, // scheduled-only
                  { departureTime: { timePlanned: '2026-11-25T14:22:00.000+0100', timeReal: '2026-11-25T14:23:00.000+0100', countdown: 15 } },
                ],
              },
            },
          ],
        },
      ],
    },
    message: { serverTime: '2026-11-25T14:08:00.000+0100' },
    trmnl: { plugin_settings: { custom_fields_values: { realtime_only: true } } },
  };

  const rtOut = run(schedInput);
  assert.equal(rtOut.rows.length, 1);
  assert.equal(rtOut.rows[0].ts.length, 1);
  assert.equal(rtOut.rows[0].ts[0].t, '14:23');
  assert.equal(rtOut.rows[0].ts[0].s, undefined);

  // When realtime_only is false, scheduled-only departure is included and tagged with s: 1
  schedInput.trmnl.plugin_settings.custom_fields_values.realtime_only = false;
  const allOut = run(schedInput);
  assert.equal(allOut.rows[0].ts.length, 2);
  assert.equal(allOut.rows[0].ts[0].t, '14:15');
  assert.equal(allOut.rows[0].ts[0].s, 1);
  assert.equal(allOut.rows[0].ts[1].t, '14:23');
  assert.equal(allOut.rows[0].ts[1].s, undefined);
});

test('handles single-URL input, tram toggle, and line_filter', () => {
  const single = {
    ...sample.IDX_0,
    trmnl: {
      plugin_settings: {
        custom_fields_values: {
          include_metro: true,
          include_bus: true,
          include_tram: true,
          line_filter: 'U1, o, 5b',
        },
      },
    },
  };
  const d = run(single);
  const lines = d.rows.map((r) => `${r.line}:${r.to}`);
  assert.deepEqual(lines, [
    'U1:Leopoldau',
    'U1:Oberlaa',
    '5B:Bhf. Heiligenstadt',
    'O:Bruno-Marek-Allee',
    'O:Raxstraße',
  ]);
});

test('keeps transformed payload well under TRMNL 5 KB limit', () => {
  const d = run(sample);
  const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
  assert.ok(bytes < 5000, `Expected payload < 5000 bytes, got ${bytes}`);
  console.log(`        (Transformed payload size: ${bytes} bytes)`);
});

test('handles empty or unconfigured input gracefully', () => {
  const d = run({});
  assert.equal(d.rows.length, 0);
  assert.ok(d.empty_message.includes('DIVA'));
});

test('passes TRMNL Framework 3.4 lint checks (no custom font-size, opacity:1, or orientation media queries)', () => {
  const srcDir = path.resolve(import.meta.dirname, '../src');
  const liquidFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.liquid'));
  for (const file of liquidFiles) {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    assert.equal(/\bfont-size\s*:/i.test(content), false, `${file} must not declare custom font-size`);
    assert.equal(/-webkit-line-clamp\s*:/i.test(content), false, `${file} must not declare -webkit-line-clamp`);
    assert.equal(/@media[^{]*orientation/i.test(content), false, `${file} must not declare @media orientation`);
    assert.equal(/\bopacity\s*:\s*1\b/i.test(content), false, `${file} must not include redundant opacity: 1`);
  }
  const shared = fs.readFileSync(path.join(srcDir, 'shared.liquid'), 'utf8');
  assert.ok(shared.includes('lg:title--'), 'shared.liquid should use responsive lg:title-- steps');
  assert.ok(shared.includes('lg:value--'), 'shared.liquid should use responsive lg:value-- steps');
  assert.ok(shared.includes('lg:label--'), 'shared.liquid should use responsive lg:label-- steps');
  assert.ok(shared.includes('data-clamp="1" data-clamp-lg="2">{{ row.to }}'), 'shared.liquid should allow 2-line destination clamping on TRMNL X');
  assert.ok(shared.includes('data-clamp="1" data-clamp-lg="2">{{ row.stop }}'), 'shared.liquid should allow 2-line stop name clamping on TRMNL X');
  const full = fs.readFileSync(path.join(srcDir, 'full.liquid'), 'utf8');
  assert.ok(full.includes('hidden lg:visible'), 'full.liquid should reveal extra departures on TRMNL X');
  const halfH = fs.readFileSync(path.join(srcDir, 'half_horizontal.liquid'), 'utf8');
  assert.ok(halfH.includes('hidden lg:portrait:visible'), 'half_horizontal.liquid should separate X landscape and X portrait rows');
  const halfV = fs.readFileSync(path.join(srcDir, 'half_vertical.liquid'), 'utf8');
  assert.ok(halfV.includes('hidden lg:portrait:visible'), 'half_vertical.liquid should separate X landscape and X portrait rows');
  const quad = fs.readFileSync(path.join(srcDir, 'quadrant.liquid'), 'utf8');
  assert.ok(quad.includes('hidden lg:portrait:visible'), 'quadrant.liquid should keep rows past the fourth portrait-only on TRMNL X');
  const settings = fs.readFileSync(path.join(srcDir, 'settings.yml'), 'utf8');
  assert.ok(settings.includes('Clock and minutes (14:12 (6′))'), 'settings.yml should have human-readable time_display labels');
});

if (!process.exitCode) {
  console.log(`\nAll ${passed} tests passed!`);
}
