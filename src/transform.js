/**
 * TRMNL Serverless Transform for Vienna Transit Departures
 *
 * Merges real-time departures from:
 *  1. Wiener Linien OGD Realtime API (U-Bahn, Bus, Tram — both directions via DIVA or stopId)
 *  2. ÖBB Scotty Live Ticker API (S-Bahn — both directions via EVA ID)
 *
 * Outputs a compact payload (<5 KB) grouped by station, showing each line/direction
 * with its transport mode and the next two real departure times.
 */

const MODE_ORDER = {
  metro: 0,
  sbahn: 1,
  bus: 2,
  tram: 3,
};

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1' || s === 'on') return true;
  if (s === 'false' || s === 'no' || s === '0' || s === 'off') return false;
  return fallback;
}

function decodeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIsoMs(isoStr) {
  if (!isoStr) return NaN;
  // Normalize +0100 -> +01:00 for strict ISO parsers
  const normalized = String(isoStr).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(normalized);
}

function getViennaNowParts(referenceMs) {
  const date = new Date(referenceMs || Date.now());
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Vienna',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = {};
    for (const p of fmt.formatToParts(date)) {
      parts[p.type] = p.value;
    }
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return {
      year: parseInt(parts.year, 10),
      month: parseInt(parts.month, 10),
      day: parseInt(parts.day, 10),
      hour: parseInt(hour, 10),
      minute: parseInt(parts.minute, 10),
      hhmm: `${hour}:${parts.minute}`,
    };
  } catch (_) {
    // Fallback to CET (+01:00) if ICU timezone data is unavailable
    const shifted = new Date(date.getTime() + 3600 * 1000);
    const h = String(shifted.getUTCHours()).padStart(2, '0');
    const m = String(shifted.getUTCMinutes()).padStart(2, '0');
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      hhmm: `${h}:${m}`,
    };
  }
}

function normalizeStationName(raw) {
  let name = decodeHtml(raw || '');
  if (!name) return 'Unknown Stop';

  // Strip Wiener Linien and ÖBB suffixes that prevent merging the same hub
  name = name
    .replace(/\s*\(U\)\s*$/i, '')
    .replace(/\s*\(S\)\s*$/i, '')
    .replace(/\s*\(S\+U\)\s*$/i, '')
    .replace(/\s+(?:S\s*U|U\s*S|SU|US|S|U)$/i, '')
    .replace(/\s+(?:Bahnhof|Bahnhst|Bf\.?)$/i, '')
    .replace(/\s*\([^)]*Bahnsteig[^)]*\)/gi, '')
    .trim();

  // Normalize "Wien Praterstern" -> "Praterstern", while preserving "Wien Mitte" and "Wien Hbf"
  if (/^Wien\s+/i.test(name) && !/^Wien\s+(?:Mitte|Hbf|Hauptbahnhof|Westbahnhof|Meidling|Nord)/i.test(name)) {
    name = name.replace(/^Wien\s+/i, '').trim();
  }

  // Normalize Hauptbahnhof variants so WL ("Hauptbahnhof") and ÖBB ("Wien Hbf") merge cleanly
  if (/^(?:Wien\s+)?Hauptbahnhof$/i.test(name) || /^Wien\s+Hbf$/i.test(name)) {
    return 'Wien Hbf';
  }
  if (/^Wien\s+Mitte(?:[- ]Landstra[ßs]e)?$/i.test(name) || /^Landstra[ßs]e$/i.test(name)) {
    return 'Wien Mitte';
  }
  if (/^(?:Wien\s+)?Westbahnhof$/i.test(name)) {
    return 'Westbahnhof';
  }
  if (/^(?:Wien\s+)?Meidling$/i.test(name) || /^Bahnhof\s+Meidling$/i.test(name)) {
    return 'Wien Meidling';
  }

  return name;
}

function stationMergeKey(displayName) {
  return displayName
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]/g, '');
}

function cleanTowards(raw) {
  let text = decodeHtml(raw || '');
  text = text
    .replace(/\s+(?:S\s*U|U\s*S|SU|US|S|U)$/i, '')
    .replace(/\s+(?:Bahnhof|Bahnhst)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function normalizeLineName(raw) {
  const s = decodeHtml(raw || '').toUpperCase();
  // Normalize "S 1" -> "S1", "U 2" -> "U2"
  return s.replace(/^([SU])\s+(\d+)/, '$1$2').trim();
}

function mapWlType(wlType) {
  switch (wlType) {
    case 'ptMetro':
      return 'metro';
    case 'ptBusCity':
    case 'ptBusNight':
    case 'ptBusRegion':
    case 'ptBus':
    case 'ptRufbus':
      return 'bus';
    case 'ptTram':
    case 'ptTramWLB':
    case 'ptTramVRT':
      return 'tram';
    case 'ptTrainS':
      return 'sbahn';
    default:
      return null;
  }
}

function naturalLineCompare(a, b) {
  const rx = /^([A-Z]*)(\d*)(.*)$/;
  const ma = a.match(rx) || ['', a, '', ''];
  const mb = b.match(rx) || ['', b, '', ''];
  if (ma[1] !== mb[1]) return ma[1].localeCompare(mb[1]);
  const na = ma[2] ? parseInt(ma[2], 10) : -1;
  const nb = mb[2] ? parseInt(mb[2], 10) : -1;
  if (na !== nb) return na - nb;
  return ma[3].localeCompare(mb[3]);
}

function extractPayloads(input) {
  if (!input || typeof input !== 'object') return [];
  const idxKeys = Object.keys(input)
    .filter((k) => /^IDX_\d+$/.test(k))
    .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));

  if (idxKeys.length > 0) {
    return idxKeys.map((k) => input[k]);
  }
  if (input.body !== undefined) {
    return [input.body];
  }
  return [input];
}

function tryParseOebbTicker(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && Array.isArray(raw.journey)) {
    return raw;
  }

  let text = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    if (typeof raw.data === 'string') text = raw.data;
    else if (typeof raw.body === 'string') text = raw.body;
    else if (typeof raw.content === 'string') text = raw.content;
  }

  if (!text || text.indexOf('journey') === -1) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && Array.isArray(parsed.journey)) return parsed;
  } catch (_) {
    // Fallback: remove trailing commas if ÖBB ticker emits any
    try {
      const cleaned = text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
      const parsed = JSON.parse(cleaned);
      if (parsed && Array.isArray(parsed.journey)) return parsed;
    } catch (__) {
      return null;
    }
  }
  return null;
}

function diffMinutesFromDateClock(dateStr, clockStr, nowParts) {
  // dateStr: "DD.MM.YYYY", clockStr: "HH:MM"
  const cMatch = /^(\d{1,2}):(\d{2})$/.exec(String(clockStr || '').trim());
  if (!cMatch) return null;
  const h = parseInt(cMatch[1], 10);
  const m = parseInt(cMatch[2], 10);

  let dayDiff = 0;
  const dMatch = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(dateStr || '').trim());
  if (dMatch) {
    const depDay = Date.UTC(
      parseInt(dMatch[3], 10),
      parseInt(dMatch[2], 10) - 1,
      parseInt(dMatch[1], 10)
    );
    const nowDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
    dayDiff = Math.round((depDay - nowDay) / 86400000);
  } else {
    // Infer midnight rollover if clock appears far earlier than now
    const rawDiff = h * 60 + m - (nowParts.hour * 60 + nowParts.minute);
    if (rawDiff < -360) dayDiff = 1;
  }

  return dayDiff * 1440 + (h * 60 + m) - (nowParts.hour * 60 + nowParts.minute);
}

function run(input) {
  const safeInput = input || {};
  const custom =
    (safeInput.trmnl &&
      safeInput.trmnl.plugin_settings &&
      safeInput.trmnl.plugin_settings.custom_fields_values) ||
    {};

  const includeModes = {
    metro: toBool(custom.include_metro, true),
    bus: toBool(custom.include_bus, true),
    sbahn: toBool(custom.include_sbahn, true),
    tram: toBool(custom.include_tram, true),
  };

  const realtimeOnly = toBool(custom.realtime_only, true);
  const minWalk = Math.max(0, parseInt(custom.min_walk_minutes ?? 1, 10) || 0);
  const timeDisplay = custom.time_display || 'clock';
  const widgetTitle = (custom.widget_title || 'Vienna Transit').trim() || 'Vienna Transit';

  const lineFilterSet = new Set(
    String(custom.line_filter || '')
      .split(',')
      .map((s) => normalizeLineName(s))
      .filter(Boolean)
  );

  const payloads = extractPayloads(safeInput);

  // Discover authoritative Vienna server time from any Wiener Linien payload
  let refServerMs = null;
  let updatedHHMM = null;
  for (const p of payloads) {
    const srv =
      (p && p.message && p.message.serverTime) ||
      (p && p.data && p.data.message && p.data.message.serverTime);
    if (srv) {
      const parsedMs = parseIsoMs(srv);
      if (!Number.isNaN(parsedMs)) {
        refServerMs = parsedMs;
        if (typeof srv === 'string' && srv.length >= 16) {
          updatedHHMM = srv.slice(11, 16);
        }
        break;
      }
    }
  }

  const nowParts = getViennaNowParts(refServerMs || Date.now());
  if (!updatedHHMM) updatedHHMM = nowParts.hhmm;

  // Map: stationKey -> { name, order, routes: Map(routeKey -> { mode, line, towards, deps: [] }) }
  const stationMap = new Map();
  let stationOrderCounter = 0;

  function addDeparture(stationDisplayName, mode, lineName, towards, depEntry) {
    if (!mode || !includeModes[mode]) return;
    if (lineFilterSet.size > 0 && !lineFilterSet.has(lineName)) return;
    if (!towards) return;

    const sKey = stationMergeKey(stationDisplayName);
    if (!stationMap.has(sKey)) {
      stationMap.set(sKey, {
        name: stationDisplayName,
        order: stationOrderCounter++,
        routes: new Map(),
      });
    }
    const station = stationMap.get(sKey);
    const rKey = `${mode}|${lineName}|${towards.toLowerCase()}`;
    if (!station.routes.has(rKey)) {
      station.routes.set(rKey, {
        mode,
        line: lineName,
        towards,
        deps: [],
      });
    }
    station.routes.get(rKey).deps.push(depEntry);
  }

  let parsedSourceCount = 0;

  for (const payload of payloads) {
    if (!payload) continue;

    // 1. Wiener Linien OGD Monitor JSON
    const monitors =
      (payload.data && Array.isArray(payload.data.monitors) && payload.data.monitors) ||
      (Array.isArray(payload.monitors) && payload.monitors) ||
      null;

    if (monitors) {
      parsedSourceCount++;
      const payloadServerMs =
        parseIsoMs(payload.message && payload.message.serverTime) || refServerMs || Date.now();

      for (const monitor of monitors) {
        const props = (monitor.locationStop && monitor.locationStop.properties) || {};
        const stationName = normalizeStationName(props.title || props.name || 'Vienna Stop');

        for (const line of monitor.lines || []) {
          const mode = mapWlType(line.type || (line.vehicle && line.vehicle.type));
          if (!mode) continue;

          const lineName = normalizeLineName(line.name);
          const lineRtSupported = line.realtimeSupported !== false;
          const baseTowards = cleanTowards(line.towards);

          const depList = (line.departures && line.departures.departure) || [];
          for (const dep of depList) {
            const dt = dep.departureTime || {};
            const hasReal = Boolean(dt.timeReal) && lineRtSupported;
            if (realtimeOnly && !hasReal) continue;

            const chosenIso = dt.timeReal || dt.timePlanned;
            if (!chosenIso) continue;

            const depMs = parseIsoMs(chosenIso);
            let minsAway;
            if (typeof dt.countdown === 'number') {
              minsAway = dt.countdown;
            } else if (!Number.isNaN(depMs)) {
              minsAway = Math.round((depMs - payloadServerMs) / 60000);
            } else {
              continue;
            }

            if (minsAway < minWalk) continue;

            let delayMin = 0;
            if (dt.timeReal && dt.timePlanned) {
              const realMs = parseIsoMs(dt.timeReal);
              const plannedMs = parseIsoMs(dt.timePlanned);
              if (!Number.isNaN(realMs) && !Number.isNaN(plannedMs)) {
                const diff = Math.round((realMs - plannedMs) / 60000);
                if (diff >= 1) delayMin = diff;
              }
            }

            const clock =
              typeof chosenIso === 'string' && chosenIso.length >= 16
                ? chosenIso.slice(11, 16)
                : '';
            if (!clock) continue;

            // Some WL departures override destination per vehicle (short-turn trains)
            const towards = cleanTowards(
              (dep.vehicle && dep.vehicle.towards) || baseTowards
            );

            addDeparture(stationName, mode, lineName, towards, {
              t: clock,
              m: minsAway,
              d: delayMin,
              rt: hasReal,
            });
          }
        }
      }
      continue;
    }

    // 2. ÖBB Scotty Live Ticker (S-Bahn)
    const oebb = tryParseOebbTicker(payload);
    if (oebb) {
      parsedSourceCount++;
      const feedHasRt = oebb.rtInfo !== false;
      const stationName = normalizeStationName(oebb.stationName || 'S-Bahn');

      for (const j of oebb.journey || []) {
        const rtObj = j.rt && typeof j.rt === 'object' ? j.rt : null;

        // Always skip cancelled S-Bahn trains so we show the next running trains
        if (rtObj && rtObj.status && /ausfall|cancel/i.test(String(rtObj.status))) {
          continue;
        }

        let clock = null;
        let dateStr = j.da;
        let delayMin = 0;
        let isReal = false;

        if (rtObj && rtObj.dlt) {
          clock = String(rtObj.dlt).trim();
          dateStr = rtObj.dld || j.da;
          const parsedDelay = parseInt(rtObj.dlm || '0', 10);
          delayMin = Number.isNaN(parsedDelay) ? 0 : Math.max(0, parsedDelay);
          isReal = true;
        } else if (j.rt === false && feedHasRt) {
          // ÖBB Scotty uses rt:false with rtInfo:true for live-monitored on-time trains
          clock = String(j.ti || '').trim();
          delayMin = 0;
          isReal = true;
        } else {
          clock = String(j.ti || '').trim();
          isReal = false;
        }

        if (realtimeOnly && !isReal) continue;
        if (!clock) continue;

        const minsAway = diffMinutesFromDateClock(dateStr, clock, nowParts);
        if (minsAway === null || minsAway < minWalk) continue;

        const lineName = normalizeLineName(j.pr || 'S');
        const towards = cleanTowards(j.st || j.lastStop || '');

        addDeparture(stationName, 'sbahn', lineName, towards, {
          t: clock,
          m: minsAway,
          d: delayMin,
          rt: isReal,
        });
      }
    }
  }

  // Build final sorted stations & flat rows list (compact keys for TRMNL payload limits)
  const stops = [];
  const rows = [];

  const sortedStations = Array.from(stationMap.values()).sort((a, b) => a.order - b.order);

  for (const st of sortedStations) {
    const sortedRoutes = Array.from(st.routes.values()).sort((a, b) => {
      const ma = MODE_ORDER[a.mode] ?? 9;
      const mb = MODE_ORDER[b.mode] ?? 9;
      if (ma !== mb) return ma - mb;
      const lc = naturalLineCompare(a.line, b.line);
      if (lc !== 0) return lc;
      return a.towards.localeCompare(b.towards, 'de');
    });

    const routeItems = [];
    for (const r of sortedRoutes) {
      // Sort chronologically and deduplicate identical clock times
      r.deps.sort((x, y) => x.m - y.m);
      const nextTwo = [];
      const seenTimes = new Set();
      for (const dep of r.deps) {
        if (seenTimes.has(dep.t)) continue;
        seenTimes.add(dep.t);
        const entry = { t: dep.t, m: dep.m };
        if (dep.d > 0) entry.d = dep.d;
        nextTwo.push(entry);
        if (nextTwo.length === 2) break;
      }
      if (nextTwo.length === 0) continue;

      const item = {
        mode: r.mode,
        line: r.line,
        to: r.towards,
        t1: nextTwo[0],
        t2: nextTwo[1] || null,
      };
      routeItems.push(item);
      rows.push({
        stop: st.name,
        ...item,
      });
    }

    if (routeItems.length > 0) {
      stops.push({
        name: st.name,
        routes: routeItems,
      });
    }
  }

  // Cap rows gracefully so the serialized TRMNL payload always stays well under 5 KB
  const MAX_TOTAL_ROWS = 24;
  const trimmedRows = rows.slice(0, MAX_TOTAL_ROWS);
  const trimmedStops = [];
  let remaining = MAX_TOTAL_ROWS;
  for (const st of stops) {
    if (remaining <= 0) break;
    const sliced = st.routes.slice(0, remaining);
    remaining -= sliced.length;
    trimmedStops.push({ name: st.name, routes: sliced });
  }

  // Balance stops across left & right Full Screen columns using visual unit budget
  // (each station header = 1 unit, each route row = 1 unit; max 11 units per column -> 1 header + 10 routes OR 2 headers + 9 routes with zero clipping at 800x480).
  // Annotate each stop with `col: "L" | "R"` in-place (avoids duplicating payload bytes!).
  const MAX_COL_UNITS = 11;
  let balancedStops = trimmedStops;
  if (trimmedStops.length >= 2) {
    let leftUnits = 0;
    let rightUnits = 0;
    const indexed = trimmedStops.map((st, idx) => ({ st, idx, weight: 1 + st.routes.length }));
    const byWeight = [...indexed].sort((a, b) => b.weight - a.weight || a.idx - b.idx);
    const assigned = [];
    for (const entry of byWeight) {
      if (leftUnits <= rightUnits) {
        const cap = Math.max(0, MAX_COL_UNITS - leftUnits - 1);
        if (cap > 0) {
          const sliced = entry.st.routes.slice(0, cap);
          assigned.push({ idx: entry.idx, name: entry.st.name, col: 'L', routes: sliced });
          leftUnits += 1 + sliced.length;
        }
      } else {
        const cap = Math.max(0, MAX_COL_UNITS - rightUnits - 1);
        if (cap > 0) {
          const sliced = entry.st.routes.slice(0, cap);
          assigned.push({ idx: entry.idx, name: entry.st.name, col: 'R', routes: sliced });
          rightUnits += 1 + sliced.length;
        }
      }
    }
    balancedStops = assigned
      .sort((a, b) => a.idx - b.idx)
      .map(({ name, col, routes }) => ({ name, col, routes }));
  }

  // half_horizontal and quadrant display at most 8 compact rows
  const compactRows = trimmedRows.slice(0, 8);

  let statusMessage = null;
  if (parsedSourceCount === 0) {
    statusMessage = 'Add a Wiener Linien DIVA/Stop ID or ÖBB S-Bahn EVA ID in plugin settings.';
  } else if (trimmedRows.length === 0) {
    statusMessage = 'No live departures found matching your current filters.';
  }

  return {
    data: {
      title: widgetTitle,
      updated: updatedHHMM,
      time_display: timeDisplay,
      rt_only: realtimeOnly,
      stop_count: balancedStops.length,
      route_count: trimmedRows.length,
      stops: balancedStops,
      rows: compactRows,
      empty_message: statusMessage,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { run, normalizeStationName, decodeHtml, tryParseOebbTicker };
}
