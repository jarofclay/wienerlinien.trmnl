# Vienna Transit Departures — TRMNL E-Ink Plugin

A **zero-backend** TRMNL plugin for Vienna public transit that displays **both directions** across **multiple stops**, covering **U-Bahn (Metro)**, **Bus**, **S-Bahn**, and optionally **Tram** — with dedicated Vienna transit logos and the **next two real-time departure times** designed specifically for low-refresh (5-minute) e-ink screens.

---

## Why This Plugin?

The existing Vienna metro plugin on TRMNL only queries a single Wiener Linien `stopId` (one platform / one direction) and doesn't cover S-Bahn or multi-stop setups. This plugin solves all of that with **no external server to host**:

| Feature | How It Works |
| --- | --- |
| **U-Bahn, Bus & Tram (both ways)** | Polls the official keyless **Wiener Linien OGD Realtime API** using 8-digit **DIVA** station IDs (which return every platform and both directions automatically) or individual RBL `stopId`s. |
| **S-Bahn (both ways)** | Polls **ÖBB Scotty Live Ticker** (`productsFilter=0000010000`) using ÖBB **EVA** station IDs for live S-Bahn departures, delays (`+5`), and automatic cancellation filtering (`Ausfall`). |
| **Real-Time Only (not scheduled)** | Filters strictly to `timeReal` (Wiener Linien) and live-monitored trains (ÖBB), hiding static-only timetable fallbacks by default. |
| **Built for 5- or 15-Minute Refresh** | Displays actual **clock times** (`14:11 · 14:21`) with a configurable `times_per_route` (`2` for 5-min TRMNL+ refresh, `3` or `4` for 15-min Free refresh) and walk-time buffer (`min_walk_minutes`) so departures stay accurate and catchable across the entire refresh window. |
| **Multi-Stop & Co-Located Merging** | Add several stops (comma-separated). Co-located Wiener Linien & ÖBB hubs (e.g., `Praterstern S U` + `Wien Praterstern Bahnhof`) merge automatically under one station header. |
| **All 4 TRMNL Layouts** | Crisp 1-bit/2-bit e-ink designs for `full`, `half_horizontal`, `half_vertical`, and `quadrant`, with custom inline SVG icons for **U-Bahn**, **S-Bahn**, **Bus**, and **Tram**. |

---

## Project Structure

```text
wienerlinien.trmnl/
├── .trmnlp.yml                 # Local config for official trmnlp dev server
├── src/
│   ├── settings.yml            # TRMNL polling strategy, dynamic multi-URL Liquid, custom fields
│   ├── transform.js            # Serverless Node transform (merges WL + ÖBB, <5 KB payload)
│   ├── shared.liquid           # E-ink CSS, inline SVG transit icons, reusable templates
│   ├── full.liquid             # 800×480 Full layout (1-col large or 2-col multi-stop)
│   ├── half_horizontal.liquid  # 800×240 Half Horizontal layout
│   ├── half_vertical.liquid    # 400×480 Half Vertical layout
│   └── quadrant.liquid         # 400×240 Quadrant layout
├── fixtures/
│   └── sample-payload.json     # Real captured Wiener Linien + ÖBB responses for offline tests
├── scripts/
│   ├── test-transform.mjs      # Unit & integration test suite
│   ├── preview.mjs             # Zero-dependency local TRMNL preview server (offline & live)
│   ├── find-stop.mjs           # CLI helper to look up any Vienna DIVA or ÖBB EVA station ID
│   └── package.sh              # Builds flat TRMNL-compliant ZIP archive in dist/
└── dist/
    └── vienna-transit-trmnl.zip
```

---

## Finding Your Vienna Stop IDs

Run the built-in stop finder with any Vienna station or bus stop name:

```bash
npm run find-stop -- "Praterstern"
npm run find-stop -- "Karlsplatz"
npm run find-stop -- "Wien Mitte"
```

- **8-digit DIVA ID** (e.g. `60201040` for Praterstern, `60200188` for Burggasse-Stadthalle): returns **all platforms and both directions** for U-Bahn, Bus, and Tram at that station.
- **1–5 digit RBL Stop ID**: returns one specific platform if you only want one direction.
- **ÖBB EVA ID** (e.g. `1290201` for Wien Praterstern, `1290401` for Wien Hbf): returns **real-time S-Bahn in both directions**.

You can enter multiple comma-separated IDs in both fields (e.g. `60201040, 60200188`).

---

## Local Testing & Preview

### 1. Run Automated Transform Tests
```bash
npm test
```

### 2. Launch the Local E-Ink Preview Server
```bash
npm run preview
# Open http://127.0.0.1:4567
```
Switch presets directly in the browser:
- `/?preset=multi` — Multi-stop (Praterstern + Wien Hbf)
- `/?preset=single` — Single-stop large display
- `/?preset=tram` — Includes Tram lines
- `/?preset=clock_min` — Clock time + countdown minutes
- `/?preset=live&wl=60201040&sb=1290201,1290401` — Fetches live Vienna APIs right now!

### 3. Official `trmnlp` CLI (Optional, via Docker)
If you want to run TRMNL's official containerized dev server and linter:
```bash
mkdir -p bin
docker run --rm --entrypoint cat trmnl/trmnlp /app/templates/init/bin/trmnlp > bin/trmnlp
chmod +x bin/trmnlp
./bin/trmnlp lint
./bin/trmnlp serve
```

---

## Deploying to TRMNL & Connecting via GitHub Sync

### Option 1: TRMNL GitHub Sync (Recommended — Auto-Updates from GitHub)
This repository uses TRMNL's standard `src/` folder layout (`src/settings.yml`, `src/transform.js`, `src/*.liquid`), so it connects cleanly to TRMNL's native **GitHub Sync** (`trmnl-sync` GitHub App):

1. Push this repository to GitHub (public or private).
2. In [usetrmnl.com](https://usetrmnl.com), open **Plugins → Private Plugin** (create a new Private Plugin or open your existing one).
3. In the plugin's settings, enable **GitHub Sync**, authorize the **TRMNL Sync** GitHub App for this repository, and select your `main` branch.
4. From then on, every push to `main` automatically syncs `src/` updates into your TRMNL Private Plugin (and edits made in TRMNL's web editor can sync back to GitHub).

### Option 2: Manual ZIP Import
```bash
npm run package
# Creates dist/vienna-transit-trmnl.zip (flat archive as required by TRMNL)
```
1. Sign in to [usetrmnl.com](https://usetrmnl.com) and go to **Plugins → Private Plugin → Import ZIP**.
2. Upload `dist/vienna-transit-trmnl.zip`.
3. Enter your **Wiener Linien Stops (DIVA/Stop IDs)** and optional **S-Bahn Stations (ÖBB EVA IDs)**, pick **Departures Per Route** (`2` for 5-min TRMNL+ refresh, `3` or `4` for 15-min Free refresh), and click **Force Refresh**.

### Publishing to the TRMNL Recipe Marketplace (for Everyone in Vienna)
1. Open your synced Private Plugin in the TRMNL dashboard.
2. Click **Publish as a Recipe** — TRMNL's **Chef** linter validates `src/settings.yml`, `src/transform.js`, and all four `.liquid` layouts.
3. Add a brief description and submit for review. Once approved, any Vienna user can install it in one click from the TRMNL Marketplace.
