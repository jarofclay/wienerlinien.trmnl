#!/usr/bin/env node
/**
 * Zero-dependency local TRMNL preview server & static renderer.
 *
 * Usage:
 *   node scripts/preview.mjs                         # Starts preview server on http://localhost:4567
 *   node scripts/preview.mjs --port 4568             # Custom port
 *   node scripts/preview.mjs --live                  # Fetches live Vienna APIs on startup
 *   node scripts/preview.mjs --render-static ./_out  # Writes standalone HTML preview without starting server
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { run: runTransform } = require('../src/transform.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const FIXTURE_PATH = path.join(ROOT, 'fixtures/sample-payload.json');

// ---------------------------------------------------------------------------
// Minimal Liquid renderer supporting the exact subset used in src/*.liquid
// (templates, render, if/elsif/else, for with limit/offset, assign, filters)
// ---------------------------------------------------------------------------

function resolvePath(scope, expr) {
  const trimmed = expr.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === 'nil') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  const parts = trimmed.split('.');
  let cur = scope;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === 'size' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
    } else if (p === 'first' && Array.isArray(cur)) {
      cur = cur[0];
    } else if (p === 'last' && Array.isArray(cur)) {
      cur = cur[cur.length - 1];
    } else {
      cur = cur[p];
    }
  }
  return cur;
}

function applyFilter(val, filterExpr, scope) {
  const colonIdx = filterExpr.indexOf(':');
  const name = (colonIdx === -1 ? filterExpr : filterExpr.slice(0, colonIdx)).trim();
  const argRaw = colonIdx === -1 ? '' : filterExpr.slice(colonIdx + 1).trim();
  const arg = argRaw ? resolvePath(scope, argRaw) : undefined;

  switch (name) {
    case 'default':
      return val === undefined || val === null || val === '' || val === false ? arg : val;
    case 'plus':
      return (Number(val) || 0) + (Number(arg) || 0);
    case 'minus':
      return (Number(val) || 0) - (Number(arg) || 0);
    case 'divided_by':
      return Math.floor((Number(val) || 0) / (Number(arg) || 1));
    case 'strip':
      return String(val ?? '').trim();
    case 'upcase':
      return String(val ?? '').toUpperCase();
    case 'downcase':
      return String(val ?? '').toLowerCase();
    default:
      return val;
  }
}

function evalExpression(expr, scope) {
  const segments = expr.split('|').map((s) => s.trim());
  let val = resolvePath(scope, segments[0]);
  for (let i = 1; i < segments.length; i++) {
    val = applyFilter(val, segments[i], scope);
  }
  return val;
}

function evalCondition(condStr, scope) {
  const orParts = condStr.split(/\s+or\s+/);
  for (const orPart of orParts) {
    const andParts = orPart.split(/\s+and\s+/);
    let andOk = true;
    for (const part of andParts) {
      const m = part.trim().match(/^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
      if (m) {
        const l = evalExpression(m[1], scope);
        const r = evalExpression(m[3], scope);
        let res = false;
        if (m[2] === '==') res = l == r;
        else if (m[2] === '!=') res = l != r;
        else if (m[2] === '<=') res = Number(l) <= Number(r);
        else if (m[2] === '>=') res = Number(l) >= Number(r);
        else if (m[2] === '<') res = Number(l) < Number(r);
        else if (m[2] === '>') res = Number(l) > Number(r);
        if (!res) {
          andOk = false;
          break;
        }
      } else {
        const v = evalExpression(part, scope);
        if (!v) {
          andOk = false;
          break;
        }
      }
    }
    if (andOk) return true;
  }
  return false;
}

function tokenize(template) {
  const tokens = [];
  const regex = /(\{%-?[\s\S]*?-?%\}|\{\{-?[\s\S]*?-?\}\})/g;
  let last = 0;
  let match;
  while ((match = regex.exec(template)) !== null) {
    if (match.index > last) {
      tokens.push({ type: 'text', value: template.slice(last, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith('{{')) {
      tokens.push({ type: 'output', expr: raw.replace(/^\{\{-?/, '').replace(/-?\}\}$/, '').trim() });
    } else {
      tokens.push({ type: 'tag', content: raw.replace(/^\{%-?/, '').replace(/-?%\}$/, '').trim() });
    }
    last = regex.lastIndex;
  }
  if (last < template.length) {
    tokens.push({ type: 'text', value: template.slice(last) });
  }
  return tokens;
}

function parseNodes(tokens, start = 0, stopTags = []) {
  const nodes = [];
  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === 'text' || tok.type === 'output') {
      nodes.push(tok);
      i++;
      continue;
    }
    const tag = tok.content;
    const tagName = tag.split(/\s+/)[0];
    if (stopTags.includes(tagName)) {
      return { nodes, next: i, stopTag: tag };
    }
    if (tagName === 'template') {
      const name = tag.slice('template'.length).trim();
      const inner = parseNodes(tokens, i + 1, ['endtemplate']);
      nodes.push({ type: 'template', name, body: inner.nodes });
      i = inner.next + 1;
    } else if (tagName === 'if') {
      const branches = [];
      let cond = tag.slice(2).trim();
      let cur = parseNodes(tokens, i + 1, ['elsif', 'else', 'endif']);
      branches.push({ cond, body: cur.nodes });
      while (cur.stopTag && cur.stopTag.startsWith('elsif')) {
        cond = cur.stopTag.slice(5).trim();
        cur = parseNodes(tokens, cur.next + 1, ['elsif', 'else', 'endif']);
        branches.push({ cond, body: cur.nodes });
      }
      let elseBody = [];
      if (cur.stopTag && cur.stopTag.startsWith('else')) {
        cur = parseNodes(tokens, cur.next + 1, ['endif']);
        elseBody = cur.nodes;
      }
      nodes.push({ type: 'if', branches, elseBody });
      i = cur.next + 1;
    } else if (tagName === 'for') {
      const m = tag.match(/^for\s+(\w+)\s+in\s+([^\s]+)(.*)$/);
      const varName = m[1];
      const listExpr = m[2];
      const opts = m[3] || '';
      const limitMatch = opts.match(/limit:\s*([^\s]+)/);
      const offsetMatch = opts.match(/offset:\s*([^\s]+)/);
      const inner = parseNodes(tokens, i + 1, ['endfor']);
      nodes.push({
        type: 'for',
        varName,
        listExpr,
        limitExpr: limitMatch ? limitMatch[1] : null,
        offsetExpr: offsetMatch ? offsetMatch[1] : null,
        body: inner.nodes,
      });
      i = inner.next + 1;
    } else if (tagName === 'assign') {
      const eq = tag.indexOf('=');
      const name = tag.slice('assign'.length, eq).trim();
      const expr = tag.slice(eq + 1).trim();
      nodes.push({ type: 'assign', name, expr });
      i++;
    } else if (tagName === 'render') {
      nodes.push({ type: 'render', raw: tag.slice('render'.length).trim() });
      i++;
    } else {
      i++;
    }
  }
  return { nodes, next: i, stopTag: null };
}

function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function renderNodes(nodes, scope, templates) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
    } else if (node.type === 'output') {
      out += escapeHtml(evalExpression(node.expr, scope));
    } else if (node.type === 'template') {
      templates[node.name] = node.body;
    } else if (node.type === 'assign') {
      scope[node.name] = evalExpression(node.expr, scope);
    } else if (node.type === 'if') {
      let matched = false;
      for (const b of node.branches) {
        if (evalCondition(b.cond, scope)) {
          out += renderNodes(b.body, scope, templates);
          matched = true;
          break;
        }
      }
      if (!matched && node.elseBody.length > 0) {
        out += renderNodes(node.elseBody, scope, templates);
      }
    } else if (node.type === 'for') {
      const arr = evalExpression(node.listExpr, scope);
      if (!Array.isArray(arr)) continue;
      const offset = node.offsetExpr ? Number(evalExpression(node.offsetExpr, scope)) || 0 : 0;
      const limit = node.limitExpr ? Number(evalExpression(node.limitExpr, scope)) : arr.length;
      const slice = arr.slice(offset, offset + limit);
      for (let idx = 0; idx < slice.length; idx++) {
        scope[node.varName] = slice[idx];
        scope.forloop = { index: idx + 1, index0: idx, first: idx === 0, last: idx === slice.length - 1 };
        out += renderNodes(node.body, scope, templates);
      }
    } else if (node.type === 'render') {
      const nameMatch = node.raw.match(/^["']([^"']+)["'](?:,(.*))?$/);
      if (!nameMatch) continue;
      const tplName = nameMatch[1];
      const argsStr = nameMatch[2] || '';
      const childScope = {};
      if (argsStr.trim()) {
        for (const pair of argsStr.split(',')) {
          const ci = pair.indexOf(':');
          if (ci === -1) continue;
          const k = pair.slice(0, ci).trim();
          const vExpr = pair.slice(ci + 1).trim();
          childScope[k] = evalExpression(vExpr, scope);
        }
      }
      if (templates[tplName]) {
        out += renderNodes(templates[tplName], childScope, templates);
      }
    }
  }
  return out;
}

function renderLiquid(sharedSrc, layoutSrc, data) {
  const combined = `${sharedSrc}\n${layoutSrc}`;
  const tokens = tokenize(combined);
  const { nodes } = parseNodes(tokens);
  const templates = {};
  const scope = { ...data };
  return renderNodes(nodes, scope, templates);
}

// ---------------------------------------------------------------------------
// Live API fetcher (optional when running locally with internet access)
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'vienna-transit-trmnl/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`Upstream HTTP ${res.status} for ${url}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

async function fetchLivePayloads(wlStopsStr, sbStopsStr, overrides = {}) {
  const wlList = String(wlStopsStr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sbList = String(sbStopsStr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const urls = [];
  if (wlList.length > 0) {
    const qs = wlList
      .map((sid) => (sid.length >= 7 ? `diva=${encodeURIComponent(sid)}` : `stopId=${encodeURIComponent(sid)}`))
      .join('&');
    urls.push({ kind: 'json', url: `https://www.wienerlinien.at/ogd_realtime/monitor?${qs}` });
  }
  for (const eid of sbList) {
    urls.push({
      kind: 'text',
      url: `https://fahrplan.oebb.at/bin/stboard.exe/dn?L=vs_scotty.vs_liveticker&tickerID=dep&start=yes&eqstops=no&evaId=${encodeURIComponent(eid)}&productsFilter=0000010000&showJourneys=30&boardType=dep&outputMode=tickerDataOnly`,
    });
  }

  const input = {
    trmnl: {
      plugin_settings: {
        custom_fields_values: {
          wiener_linien_stops: wlStopsStr,
          sbahn_stops: sbStopsStr,
          include_metro: true,
          include_bus: true,
          include_sbahn: true,
          include_tram: true,
          line_filter: '',
          min_walk_minutes: 1,
          realtime_only: true,
          time_display: 'clock',
          widget_title: 'Vienna Transit',
          ...overrides,
        },
      },
    },
  };

  const results = await Promise.all(
    urls.map(async (u) => {
      const res = await fetchWithRetry(u.url, 3);
      if (u.kind === 'json') return res.json();
      const buf = Buffer.from(await res.arrayBuffer());
      return { data: buf.toString('latin1') };
    })
  );

  if (results.length === 1) {
    Object.assign(input, results[0]);
  } else {
    results.forEach((r, idx) => {
      input[`IDX_${idx}`] = r;
    });
  }
  return input;
}

// ---------------------------------------------------------------------------
// Preview Page Builder (mirrors TRMNL Framework v2 800x480 e-ink canvas)
// ---------------------------------------------------------------------------

function buildPreviewHtml(rawInput, modeLabel, queryState = {}) {
  const data = runTransform(rawInput);
  const payloadBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');

  const shared = fs.readFileSync(path.join(SRC_DIR, 'shared.liquid'), 'utf8');
  const fullHtml = renderLiquid(shared, fs.readFileSync(path.join(SRC_DIR, 'full.liquid'), 'utf8'), data);
  const halfHHtml = renderLiquid(shared, fs.readFileSync(path.join(SRC_DIR, 'half_horizontal.liquid'), 'utf8'), data);
  const halfVHtml = renderLiquid(shared, fs.readFileSync(path.join(SRC_DIR, 'half_vertical.liquid'), 'utf8'), data);
  const quadHtml = renderLiquid(shared, fs.readFileSync(path.join(SRC_DIR, 'quadrant.liquid'), 'utf8'), data);

  const curWl = queryState.wl ?? '60201040';
  const curSb = queryState.sb ?? '1290201';
  const curLines = queryState.lines ?? '';
  const curTime = queryState.time_display ?? 'clock';
  const curTimesPerRoute = String(queryState.times_per_route ?? '2');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vienna Transit — TRMNL E-Ink Preview</title>
  <style>
    :root {
      --bg: #eceae4;
      --card: #f8f7f3;
      --ink: #111111;
      --muted: #5a5955;
      --bezel: #181818;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 24px 48px;
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    }
    .chrome {
      max-width: 1260px;
      margin: 0 auto 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      border-bottom: 1px solid #d4d1c9;
      padding-bottom: 16px;
    }
    .chrome-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .chrome h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .chrome p {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--muted);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .controls a {
      text-decoration: none;
      color: var(--ink);
      background: #fff;
      border: 1.5px solid #222;
      padding: 6px 11px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
    }
    .controls a:hover {
      background: #111;
      color: #fff;
    }
    .live-form {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-end;
      background: #e2dfd7;
      padding: 10px 12px;
      border-radius: 8px;
    }
    .live-form label {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #333;
    }
    .live-form input, .live-form select {
      padding: 6px 8px;
      border: 1.5px solid #222;
      border-radius: 5px;
      font-size: 13px;
      background: #fff;
      color: #111;
      font-family: inherit;
    }
    .live-form button {
      padding: 7px 14px;
      background: #111;
      color: #fff;
      border: 1.5px solid #111;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .live-form button:hover {
      background: #333;
    }
    .meta-pill {
      font-size: 12px;
      font-weight: 600;
      background: #dfddd6;
      padding: 6px 10px;
      border-radius: 6px;
    }
    .gallery {
      max-width: 1260px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }
    .row-group {
      display: flex;
      flex-wrap: wrap;
      gap: 28px;
      align-items: flex-start;
    }
    .frame-wrap {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .frame-label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .trmnl-bezel {
      background: var(--bezel);
      padding: 14px;
      border-radius: 14px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.16);
      display: inline-block;
      align-self: flex-start;
      width: fit-content;
    }

    /* Official TRMNL e-paper screen & Framework v2 primitives */
    .screen {
      background: #ffffff;
      color: #000000;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: none;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      border: 1px solid #000;
    }
    .screen--full { width: 800px; height: 480px; }
    .screen--half-h { width: 800px; height: 240px; }
    .screen--half-v { width: 400px; height: 480px; }
    .screen--quad { width: 400px; height: 240px; }

    .view {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      padding: 14px 16px 10px;
    }
    .screen--quad .view,
    .screen--half-h .view {
      padding: 10px 14px 8px;
    }
    .layout {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      width: 100%;
      overflow: hidden;
    }
    .layout--col { flex-direction: column; }
    .layout--top { justify-content: flex-start; }

    .title_bar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      height: 30px;
      border-top: 2px solid #000000;
      margin-top: 8px;
      padding-top: 6px;
      font-size: 13px;
      line-height: 1;
    }
    .screen--quad .title_bar,
    .screen--half-h .title_bar {
      height: 24px;
      margin-top: 5px;
      padding-top: 4px;
      font-size: 11px;
    }
    .title_bar .title {
      font-weight: 800;
      margin-right: auto;
      letter-spacing: 0.01em;
    }
    .title_bar .instance {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
  </style>
</head>
<body>
  <div class="chrome">
    <div class="chrome-top">
      <div>
        <h1>Vienna Transit Departures — TRMNL E-Ink Preview</h1>
        <p>Source: <strong>${modeLabel}</strong> &middot; Payload: <strong>${payloadBytes} bytes</strong> (TRMNL limit: 5,120 bytes) &middot; Routes: <strong>${data.route_count}</strong> across <strong>${data.stop_count}</strong> stop(s)</p>
      </div>
      <div class="controls">
        <a href="/?preset=live&wl=60201040&sb=">Praterstern WL (Live)</a>
        <a href="/?preset=live&wl=60201040&sb=1290201,1290401">Praterstern + Wien Hbf S-Bahn (Live)</a>
        <a href="/?preset=live&wl=60201040,60200188&sb=1290201">Multi-Hub DIVAs (Live)</a>
        <a href="/?preset=multi">Offline Fixture</a>
      </div>
    </div>
    <form class="live-form" method="GET" action="/">
      <input type="hidden" name="preset" value="live" />
      <label>
        Wiener Linien Stops (DIVA or RBL)
        <input name="wl" value="${curWl}" style="width: 240px;" placeholder="60201040, 60200188" />
      </label>
      <label>
        S-Bahn EVA IDs (optional)
        <input name="sb" value="${curSb}" style="width: 150px;" placeholder="1290201" />
      </label>
      <label>
        Line Filter (optional)
        <input name="lines" value="${curLines}" style="width: 180px;" placeholder="U1, 5B, S2" />
      </label>
      <label>
        Time Format
        <select name="time_display">
          <option value="clock" ${curTime === 'clock' ? 'selected' : ''}>Clock (14:12)</option>
          <option value="clock_and_min" ${curTime === 'clock_and_min' ? 'selected' : ''}>Clock + Min</option>
          <option value="minutes" ${curTime === 'minutes' ? 'selected' : ''}>Minutes (3')</option>
        </select>
      </label>
      <label>
        Times / Route
        <select name="times_per_route">
          <option value="2" ${curTimesPerRoute === '2' ? 'selected' : ''}>2 (5-min refresh)</option>
          <option value="3" ${curTimesPerRoute === '3' ? 'selected' : ''}>3 (15-min refresh)</option>
          <option value="4" ${curTimesPerRoute === '4' ? 'selected' : ''}>4 (15-min refresh)</option>
        </select>
      </label>
      <button type="submit">Fetch Live Data</button>
    </form>
  </div>

  <div class="gallery">
    <div class="frame-wrap">
      <div class="frame-label">Full Screen &mdash; 800 &times; 480 px (full.liquid)</div>
      <div class="trmnl-bezel">
        <div class="screen screen--full"><div class="view view--full">${fullHtml}</div></div>
      </div>
    </div>

    <div class="frame-wrap">
      <div class="frame-label">Half Horizontal &mdash; 800 &times; 240 px (half_horizontal.liquid)</div>
      <div class="trmnl-bezel">
        <div class="screen screen--half-h"><div class="view view--half_horizontal">${halfHHtml}</div></div>
      </div>
    </div>

    <div class="row-group">
      <div class="frame-wrap">
        <div class="frame-label">Half Vertical &mdash; 400 &times; 480 px (half_vertical.liquid)</div>
        <div class="trmnl-bezel">
          <div class="screen screen--half-v"><div class="view view--half_vertical">${halfVHtml}</div></div>
        </div>
      </div>

      <div class="frame-wrap">
        <div class="frame-label">Quadrant &mdash; 400 &times; 240 px (quadrant.liquid)</div>
        <div class="trmnl-bezel">
          <div class="screen screen--quad"><div class="view view--quadrant">${quadHtml}</div></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function getFixturePreset(preset) {
  const base = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  if (preset === 'single') {
    return {
      ...base.IDX_0,
      trmnl: {
        plugin_settings: {
          custom_fields_values: {
            ...base.trmnl.plugin_settings.custom_fields_values,
            line_filter: 'U1, U2, 5B, 80A',
          },
        },
      },
    };
  }
  if (preset === 'tram') {
    base.trmnl.plugin_settings.custom_fields_values.include_tram = true;
    return base;
  }
  if (preset === 'clock_min') {
    base.trmnl.plugin_settings.custom_fields_values.time_display = 'clock_and_min';
    return base;
  }
  return base;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const staticIdx = args.indexOf('--render-static');
const portIdx = args.indexOf('--port');
const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 4567;
const presetArgIdx = args.indexOf('--preset');
const initialPreset = presetArgIdx !== -1 ? args[presetArgIdx + 1] : 'multi';

if (staticIdx !== -1) {
  const outDir = path.resolve(args[staticIdx + 1] || path.join(ROOT, '_preview'));
  fs.mkdirSync(outDir, { recursive: true });
  const multiHtml = buildPreviewHtml(getFixturePreset('multi'), 'Fixture (Praterstern + Wien Hbf)');
  const singleHtml = buildPreviewHtml(getFixturePreset('single'), 'Fixture (Single Stop Large)');
  fs.writeFileSync(path.join(outDir, 'index.html'), multiHtml, 'utf8');
  fs.writeFileSync(path.join(outDir, 'single.html'), singleHtml, 'utf8');
  console.log(`Static preview written to ${path.join(outDir, 'index.html')}`);
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://localhost:${port}`);
    const preset = urlObj.searchParams.get('preset') || initialPreset;

    let rawInput;
    let label;
    const wl = urlObj.searchParams.has('wl') ? urlObj.searchParams.get('wl') : '60201040';
    const sb = urlObj.searchParams.has('sb') ? urlObj.searchParams.get('sb') : '1290201';
    const lines = urlObj.searchParams.get('lines') || '';
    const timeDisplay = urlObj.searchParams.get('time_display') || 'clock';
    const timesPerRoute = urlObj.searchParams.get('times_per_route') || '2';

    if (preset === 'live') {
      rawInput = await fetchLivePayloads(wl, sb, {
        line_filter: lines,
        time_display: timeDisplay,
        times_per_route: timesPerRoute,
      });
      label = `LIVE APIs (WL: ${wl || 'none'}${sb ? ` | S-Bahn: ${sb}` : ''}${lines ? ` | Filter: ${lines}` : ''} | ${timesPerRoute} times/route)`;
    } else {
      rawInput = getFixturePreset(preset);
      rawInput.trmnl.plugin_settings.custom_fields_values.times_per_route = timesPerRoute;
      label = `Fixture (${preset}, ${timesPerRoute} times/route)`;
    }

    const html = buildPreviewHtml(rawInput, label, { wl, sb, lines, time_display: timeDisplay, times_per_route: timesPerRoute });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Preview error: ${err.message}\n${err.stack}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Vienna Transit TRMNL preview running at http://127.0.0.1:${port}`);
  console.log('Presets: /?preset=multi | /?preset=single | /?preset=tram | /?preset=clock_min | /?preset=live');
});
