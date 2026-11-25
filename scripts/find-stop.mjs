#!/usr/bin/env node
/**
 * Vienna Stop ID Finder (Wiener Linien DIVA + ÖBB S-Bahn EVA ID)
 *
 * Usage:
 *   node scripts/find-stop.mjs "Praterstern"
 *   node scripts/find-stop.mjs "Karlsplatz"
 *   node scripts/find-stop.mjs "Wien Mitte"
 */

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.log('Usage: node scripts/find-stop.mjs "<station or bus stop name>"');
  console.log('Example: node scripts/find-stop.mjs "Praterstern"');
  process.exit(1);
}

const WL_STOPS_CSV = 'https://www.wienerlinien.at/ogd_realtime/doku/ogd/wienerlinien-ogd-haltestellen.csv';
const OEBB_MGATE = 'https://fahrplan.oebb.at/bin/mgate.exe';

function parseCsvLine(line, sep = ';') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

async function searchWienerLinien(q) {
  const res = await fetch(WL_STOPS_CSV);
  if (!res.ok) throw new Error(`Wiener Linien CSV HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.toUpperCase());
  const nameIdx = header.findIndex((h) => h === 'NAME' || h === 'STOPTEXT');
  const divaIdx = header.findIndex((h) => h === 'DIVA');
  const muniIdx = header.findIndex((h) => h === 'GEMEINDE' || h === 'MUNICIPALITY');

  const needle = q.toLowerCase();
  const matches = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = cols[nameIdx] || '';
    const diva = cols[divaIdx] || '';
    const muni = muniIdx !== -1 ? cols[muniIdx] : '';
    if (!diva) continue;
    if (name.toLowerCase().includes(needle)) {
      matches.push({ name, diva, muni });
    }
  }
  // Prefer Vienna stops & exact/prefix matches first
  matches.sort((a, b) => {
    const aWien = a.muni.toLowerCase() === 'wien' ? 0 : 1;
    const bWien = b.muni.toLowerCase() === 'wien' ? 0 : 1;
    if (aWien !== bWien) return aWien - bWien;
    const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.name.localeCompare(b.name, 'de');
  });
  return matches.slice(0, 12);
}

async function searchOebb(q) {
  const body = {
    client: { id: 'OEBB', type: 'WEB', name: 'webapp', l: 'vs_webapp' },
    auth: { type: 'AID', aid: 'OWDL4fE4ixNiPBBm' },
    lang: 'deu',
    ver: '1.67',
    formatted: false,
    svcReqL: [
      {
        meth: 'LocMatch',
        req: {
          input: {
            field: 'S',
            loc: { type: 'S', name: q },
            maxLoc: 10,
          },
        },
      },
    ],
  };

  const res = await fetch(OEBB_MGATE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ÖBB HAFAS HTTP ${res.status}`);
  const data = await res.json();
  const locs = data?.svcResL?.[0]?.res?.match?.locL || [];
  return locs
    .filter((l) => l.extId)
    .map((l) => ({ name: l.name, evaId: l.extId }));
}

console.log(`Searching Vienna stops for "${query}"...\n`);

const [wlRes, oebbRes] = await Promise.allSettled([
  searchWienerLinien(query),
  searchOebb(query),
]);

console.log('=== Wiener Linien (U-Bahn, Bus, Tram) — DIVA IDs ===');
if (wlRes.status === 'fulfilled' && wlRes.value.length > 0) {
  for (const m of wlRes.value) {
    console.log(`  ${m.diva.padEnd(10)} ${m.name}${m.muni ? ` (${m.muni})` : ''}`);
  }
} else {
  console.log('  No matches found.', wlRes.status === 'rejected' ? `(${wlRes.reason.message})` : '');
}

console.log('\n=== ÖBB (S-Bahn) — EVA IDs ===');
if (oebbRes.status === 'fulfilled' && oebbRes.value.length > 0) {
  for (const m of oebbRes.value) {
    console.log(`  ${String(m.evaId).padEnd(10)} ${m.name}`);
  }
} else {
  console.log('  No matches found.', oebbRes.status === 'rejected' ? `(${oebbRes.reason.message})` : '');
}
