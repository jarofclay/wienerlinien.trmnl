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
  const out = run(sample);
  const d = out.data;

  assert.equal(d.title, 'Vienna Transit');
  assert.equal(d.updated, '14:08');
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
  assert.equal(s1.t1.t, '14:13');
  assert.equal(s1.t2.t, '14:43');

  const s2 = sbLines.find((r) => r.line === 'S2');
  assert.equal(s2.to, 'Mödling');
  assert.equal(s2.t1.t, '14:18'); // Real delayed time (14:15 + 3 min)
  assert.equal(s2.t1.d, 3);
  assert.equal(s2.t2.t, '14:45');

  // Tram excluded by default (include_tram: false)
  assert.equal(praterRoutes.filter((r) => r.mode === 'tram').length, 0);
});

test('skips cancelled S-Bahn trains and applies real-time delay clock', () => {
  const out = run(sample);
  const hbfRoutes = out.data.stops[1].routes;

  // S80 -> Leobersdorf had status "Ausfall", so it must be excluded
  assert.equal(hbfRoutes.some((r) => r.to === 'Leobersdorf'), false);

  // S1 -> Wien Liesing delayed +5 min: scheduled 14:17 -> real 14:22
  const s1 = hbfRoutes.find((r) => r.line === 'S1');
  assert.equal(s1.t1.t, '14:22');
  assert.equal(s1.t1.d, 5);
  assert.equal(s1.t2.t, '14:47');
});

test('applies minimum walk time buffer to avoid uncatchable 0-min departures', () => {
  const out = run(sample);
  const praterRoutes = out.data.stops[0].routes;
  // U1 -> Oberlaa had a 0-min departure at 14:08; with min_walk_minutes=1, t1 must be 14:12 (+2 delay)
  const u1Oberlaa = praterRoutes.find((r) => r.line === 'U1' && r.to === 'Oberlaa');
  assert.equal(u1Oberlaa.t1.t, '14:12');
  assert.equal(u1Oberlaa.t1.d, 2);
  assert.equal(u1Oberlaa.t2.t, '14:15');

  // 80A had a 0-min departure at 14:08; t1 must be 14:16, t2 14:23
  const bus80A = praterRoutes.find((r) => r.line === '80A');
  assert.equal(bus80A.t1.t, '14:16');
  assert.equal(bus80A.t2.t, '14:23');
});

test('excludes scheduled-only Wiener Linien departures when realtime_only is true', () => {
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
  assert.equal(rtOut.data.rows.length, 1);
  assert.equal(rtOut.data.rows[0].t1.t, '14:23');
  assert.equal(rtOut.data.rows[0].t2, null);

  // When realtime_only is false, scheduled-only departure is included
  schedInput.trmnl.plugin_settings.custom_fields_values.realtime_only = false;
  const allOut = run(schedInput);
  assert.equal(allOut.data.rows[0].t1.t, '14:15');
  assert.equal(allOut.data.rows[0].t2.t, '14:23');
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
  const out = run(single);
  const lines = out.data.rows.map((r) => `${r.line}:${r.to}`);
  assert.deepEqual(lines, [
    'U1:Leopoldau',
    'U1:Oberlaa',
    '5B:Bhf. Heiligenstadt',
    'O:Bruno-Marek-Allee',
    'O:Raxstraße',
  ]);
});

test('keeps transformed payload well under TRMNL 5 KB limit', () => {
  const out = run(sample);
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(bytes < 5000, `Expected payload < 5000 bytes, got ${bytes}`);
  console.log(`        (Transformed payload size: ${bytes} bytes)`);
});

test('handles empty or unconfigured input gracefully', () => {
  const out = run({});
  assert.equal(out.data.rows.length, 0);
  assert.ok(out.data.empty_message.includes('DIVA'));
});

if (!process.exitCode) {
  console.log(`\nAll ${passed} tests passed!`);
}
