#!/usr/bin/env node
// CLI for driving the strava.com route builder through a persistent Chrome window.
// The browser keeps its own profile (.browser-profile/) so the Strava login
// survives between commands and sessions. See CLAUDE.md for the full reference.
//
// How it works on strava.com/maps/create:
//   - Strava renders the map with its own WebGL engine (no mapbox API access),
//     but keeps a read-only MapLibre mirror in sync for browser extensions
//     ("ThirdPartyPluginLayer"). We READ camera state + pixel projections from
//     that mirror and NEVER write to it (writing desyncs it permanently).
//   - Camera moves are done with real user inputs (mouse wheel to zoom, drags
//     to pan) in a closed feedback loop against the mirror until the target
//     view is reached.
//   - Waypoints are added by clicking the projected pixel of each lat/lng.
//     Plotted points are tracked in the page so pan-drags never start on top
//     of the route (dragging the route line would edit it).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error(`Missing dependency (playwright-core). Run once:\n  npm install --prefix "${ROOT}"`);
  process.exit(1);
}

const PORT = 9777;
const CDP_URL = `http://127.0.0.1:${PORT}`;
const ROUTE_BUILDER_URL = 'https://www.strava.com/maps/create';

// Login profile + screenshots live under the user's home dir so plugin
// updates / repo moves can't wipe them. A legacy repo-local profile is
// honored so existing logins keep working.
const DATA_DIR = process.env.STRAVA_MAP_HOME ?? path.join(os.homedir(), '.strava-map');
const LEGACY_PROFILE = path.join(ROOT, '.browser-profile');
const PROFILE_DIR = fs.existsSync(LEGACY_PROFILE) ? LEGACY_PROFILE : path.join(DATA_DIR, 'browser-profile');

// Cmd on macOS, Ctrl elsewhere — for the builder's shortcuts (undo, manual mode).
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const BROWSER_PATHS = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const WHEEL_PER_ZOOM = 342;   // measured: 400 wheel units ~ 1.17 zoom levels
// Framing tolerance only — clicks use projection, not the center. Must stay
// above the map engine's ~6px click-vs-drag threshold or drags are ignored
// and the goto loop deadlocks; zooming in magnifies smaller residuals into
// draggable sizes.
const CENTER_TOL_PX = 15;
// The engine's smallest wheel-zoom step is ~0.4 levels; a tighter tolerance
// than half that ping-pongs forever around the target zoom.
const ZOOM_TOL = 0.25;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function cdpAlive() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function connect() {
  if (!(await cdpAlive())) die(`No browser listening on port ${PORT}. Run: node strava.js start`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => p.url().includes('strava.com')) ?? ctx.pages()[0];
  if (!page) page = await ctx.newPage();
  // Playwright silently dismisses native confirm()/alert() dialogs otherwise —
  // Strava uses them for destructive confirmations (e.g. deleting a route).
  page.on('dialog', async d => {
    console.log(`[native ${d.type()}] "${d.message()}" -> accepted`);
    await d.accept().catch(() => {});
  });
  return { browser, page };
}

// Runs inside the page. Detects the environment and installs window.__cc with a
// normalized read interface. Returns the mode ('strava', 'mapbox', 'leaflet') or
// null. Idempotent; re-scans if a previously found map went stale.
const PAGE_BOOTSTRAP = () => {
  const CC_VERSION = 4;
  try {
    if (window.__cc && window.__cc.v === CC_VERSION && window.__cc.ok()) return window.__cc.kind();
  } catch {}

  const isMapbox = o => !!o && typeof o.getCenter === 'function' && typeof o.project === 'function' && typeof o.jumpTo === 'function';
  const isLeaflet = o => !!o && typeof o.getCenter === 'function' && typeof o.latLngToContainerPoint === 'function';
  const classify = o => {
    try {
      if (!o || typeof o !== 'object') return null;
      return isMapbox(o) ? 'mapbox' : isLeaflet(o) ? 'leaflet' : null;
    } catch {
      return null;
    }
  };

  let map = null;
  let iface = null;

  for (const k of Object.getOwnPropertyNames(window)) {
    try {
      const c = classify(window[k]);
      if (c) { map = window[k]; iface = c; break; }
    } catch {}
  }

  if (!map) {
    const roots = document.querySelectorAll('.mapboxgl-map, .maplibregl-map, .leaflet-container, [class*="map" i]');
    outer: for (const el of roots) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fk) continue;
      const seenFibers = new Set();
      const seenObjs = new Set();
      const scan = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 4 || seenObjs.has(o)) return null;
        seenObjs.add(o);
        const c = classify(o);
        if (c) { iface = c; return o; }
        if (o instanceof Node) return null;
        for (const key of Object.keys(o)) {
          try {
            const r = scan(o[key], depth + 1);
            if (r) return r;
          } catch {}
        }
        return null;
      };
      const queue = [el[fk]];
      let hops = 0;
      while (queue.length && hops++ < 20000) {
        const f = queue.shift();
        if (!f || seenFibers.has(f)) continue;
        seenFibers.add(f);
        for (const holder of [f.memoizedProps, f.memoizedState, f.stateNode]) {
          const r = scan(holder, 0);
          if (r) { map = r; break outer; }
        }
        queue.push(f.child, f.sibling, f.return);
      }
    }
  }

  const stravaCanvas = () => document.querySelector('div[class*="Map_map"] canvas');
  const isStrava = location.hostname.endsWith('strava.com') && !!stravaCanvas();
  if (!map && !isStrava) return null;
  const kind = isStrava ? 'strava' : iface;

  const parseHash = () => {
    const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    return m ? { zoom: +m[1], lat: +m[2], lng: +m[3] } : null;
  };
  const mercator = (lat, lng, zoom) => {
    const s = 512 * Math.pow(2, zoom);
    const siny = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lng + 180) / 360) * s,
      y: (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * s,
    };
  };
  const container = () => (map.getContainer ? map.getContainer() : map._container);
  const realCanvas = () => (isStrava ? stravaCanvas() : container());
  const mirrorAlive = () => {
    try { return !!map && document.contains(container()) && container().getBoundingClientRect().width > 0; } catch { return false; }
  };
  const camera = () => {
    if (isStrava) {
      if (mirrorAlive()) {
        const c = map.getCenter();
        return { lat: c.lat, lng: c.lng, zoom: map.getZoom(), source: 'mirror' };
      }
      const h = parseHash();
      return h ? { ...h, source: 'hash' } : null;
    }
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom(), source: 'instance' };
  };

  window.__ccMap = map;
  window.__ccPlotted ??= [];
  window.__cc = {
    v: CC_VERSION,
    kind: () => kind,
    ok: () => {
      if (!isStrava) return mirrorAlive();
      if (!stravaCanvas()) return false;
      // The plugin-layer mirror initializes late after page load: if we have
      // no instance but its element is in the DOM now, force a rescan.
      if (!map && document.querySelector('.maplibregl-map, .mapboxgl-map')) return false;
      if (map && !mirrorAlive()) return false;
      return true;
    },
    // Camera state + real canvas rect + hash (for sync diagnostics).
    view: () => {
      const cam = camera();
      if (!cam) return null;
      const r = realCanvas().getBoundingClientRect();
      return { kind, ...cam, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, hash: location.hash || null, plotted: window.__ccPlotted.length };
    },
    // Page pixel of a lat/lng under the current camera. inView applies margins
    // that keep clicks off Strava's floating toolbar (top) and canvas edges.
    project: (lat, lng) => {
      let px;
      const r = realCanvas().getBoundingClientRect();
      if ((isStrava && mirrorAlive()) || (!isStrava && iface === 'mapbox')) {
        const cr = container().getBoundingClientRect();
        const p = map.project([lng, lat]);
        px = { x: cr.x + p.x, y: cr.y + p.y };
      } else if (!isStrava && iface === 'leaflet') {
        const cr = container().getBoundingClientRect();
        const p = map.latLngToContainerPoint([lat, lng]);
        px = { x: cr.x + p.x, y: cr.y + p.y };
      } else {
        const cam = camera();
        if (!cam) return null;
        const c = mercator(cam.lat, cam.lng, cam.zoom);
        const p = mercator(lat, lng, cam.zoom);
        px = { x: r.x + r.width / 2 + (p.x - c.x), y: r.y + r.height / 2 + (p.y - c.y) };
      }
      const inView = px.x >= r.x + 15 && px.x <= r.x + r.width - 15 && px.y >= r.y + 60 && px.y <= r.y + r.height - 15;
      return { ...px, inView };
    },
    // Generic (non-Strava) pages only: move the map instance directly.
    center: (lat, lng, zoom) => {
      if (isStrava) throw new Error('direct centering not available on strava; use closed-loop goto');
      if (iface === 'mapbox') map.jumpTo({ center: [lng, lat], ...(zoom == null ? {} : { zoom }) });
      else map.setView([lat, lng], zoom ?? map.getZoom(), { animate: false });
    },
    trackPlot: (lat, lng) => { window.__ccPlotted.push({ lat, lng }); },
    clearPlots: () => { window.__ccPlotted = []; },
    // Choose a safe drag start so panning never grabs a waypoint or the route
    // line. Candidates ranked by distance to the plotted route (with segment
    // interpolation); both start and end of the drag must stay on the canvas.
    dragPlan: (dx, dy, skip) => {
      const r = realCanvas().getBoundingClientRect();
      const obstacles = [];
      const pts = window.__ccPlotted;
      const proj = p => window.__cc.project(p.lat, p.lng);
      for (let i = 0; i < pts.length; i++) {
        obstacles.push(proj(pts[i]));
        if (i > 0) {
          const a = proj(pts[i - 1]), b = proj(pts[i]);
          for (const t of [0.25, 0.5, 0.75]) obstacles.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
      const candidates = [];
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const sx = r.x + r.width * fx;
          const sy = r.y + r.height * fy;
          const ex = sx + dx, ey = sy + dy;
          if (ex < r.x + 10 || ex > r.x + r.width - 10 || ey < r.y + 70 || ey > r.y + r.height - 10) continue;
          if (sy < r.y + 70) continue;
          // The start must land on the actual map canvas — floating panels and
          // toolbars over the map swallow drags.
          const hit = document.elementFromPoint(sx, sy);
          if (!hit || hit.tagName !== 'CANVAS') continue;
          const minDist = obstacles.length ? Math.min(...obstacles.map(o => Math.hypot(o.x - sx, o.y - sy))) : 1e9;
          candidates.push({ sx, sy, minDist });
        }
      }
      candidates.sort((a, b) => b.minDist - a.minDist);
      return candidates[skip ?? 0] ?? null;
    },
  };
  return kind;
};

async function ensureMap(page) {
  const kind = await page.evaluate(PAGE_BOOTSTRAP);
  if (!kind) {
    die(
      'No map found on this page.\n' +
      `Current URL: ${page.url()}\n` +
      'If you are not on the route builder, run: node strava.js open\n' +
      'If the page needs login, log in inside the browser window first.\n' +
      'Otherwise inspect with: node strava.js screenshot / node strava.js html'
    );
  }
  return kind;
}

const getView = page => page.evaluate(() => window.__cc.view());
const project = (page, lat, lng) => page.evaluate(([a, b]) => window.__cc.project(a, b), [lat, lng]);

async function wheelZoom(page, view, levels) {
  // Wheel over a point that is actually the map canvas — popups/panels over
  // the center would swallow the wheel events. Off-center zoom anchors there
  // and shifts the center, but the closed loop re-pans afterwards.
  const pos = await page.evaluate(() => {
    const canvas = document.querySelector('div[class*="Map_map"] canvas') ?? document.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.3, 0.5], [0.7, 0.5], [0.5, 0.7], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) {
      const x = r.x + r.width * fx;
      const y = r.y + r.height * fy;
      const el = document.elementFromPoint(x, y);
      if (el && el.tagName === 'CANVAS') return { x, y };
    }
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.wheel(0, -levels * WHEEL_PER_ZOOM);
  await sleep(800);
}

// Photo popups (from clicking a photo marker) block part of the map and eat
// input; a small pan drag dismisses them.
async function dismissPhotoPopup(page) {
  if (!(await photoPopupOpen(page))) return;
  const plan = await page.evaluate(([a, b]) => window.__cc.dragPlan(a, b, 0), [50, 25]);
  if (!plan) return;
  await page.mouse.move(plan.sx, plan.sy);
  await page.mouse.down();
  await page.mouse.move(plan.sx + 50, plan.sy + 25, { steps: 6 });
  await page.mouse.up();
  await sleep(600);
}

// The mirror is created at an integer zoom and only syncs after the first real
// camera move; if it disagrees with the URL hash, nudge the camera (zero-sum
// wheel) to force a sync.
async function ensureSynced(page) {
  await ensureMap(page);
  const v = await getView(page);
  if (!v || v.kind !== 'strava' || v.source !== 'mirror' || !v.hash) return;
  const hashZoom = +v.hash.match(/^#(\d+(?:\.\d+)?)/)?.[1];
  if (Number.isFinite(hashZoom) && Math.abs(hashZoom - v.zoom) > 0.05) {
    await wheelZoom(page, v, 0.12);
    await wheelZoom(page, v, -0.12);
  }
}

// Closed-loop camera move: pan with drags until the target sits at canvas
// center, then wheel to the target zoom, re-checking against the mirror after
// every input. Zooming out first when the target is beyond reach.
// Informational modals ("Made for your desktop" after a window resize, the
// heatmap welcome, …) eat all mouse input. Auto-dismiss the benign ones via
// their acknowledge button; only report blocked for unknown dialogs (e.g. a
// form) that a human/Claude should look at.
async function modalBlocking(page) {
  for (let i = 0; i < 2; i++) {
    const info = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return null;
      const btn = [...dlg.querySelectorAll('button')].find(b =>
        /^(got it|ok|okay|close|explore the heatmap)$/i.test((b.textContent || '').trim()));
      if (!btn) return { blocked: true };
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (btn.textContent || '').trim() };
    });
    if (!info) return false;
    if (info.blocked) return true;
    console.log(`Dismissing modal via "${info.label}"`);
    await page.mouse.click(info.x, info.y);
    await sleep(700);
  }
  return page.evaluate(() => !!document.querySelector('[role="dialog"]'));
}

async function cameraGoto(page, lat, lng, targetZoom = null) {
  await ensureMap(page);
  if (await modalBlocking(page)) {
    die('A modal dialog is blocking the map (it eats all mouse input). See it with screenshot, dismiss with ui "<button text>" --click.');
  }
  let dragSkip = 0;
  for (let iter = 0; iter < 60; iter++) {
    const v = await getView(page);
    if (!v) die('Lost the map view state.');
    if (v.kind !== 'strava') {
      await page.evaluate(([a, b, z]) => window.__cc.center(a, b, z ?? undefined), [lat, lng, targetZoom]);
      await sleep(300);
      return;
    }
    const p = await project(page, lat, lng);
    const cx = v.rect.x + v.rect.w / 2;
    const cy = v.rect.y + v.rect.h / 2;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.hypot(dx, dy);
    const reach = Math.max(v.rect.w, v.rect.h) * 2.5;

    if (dist > reach && v.zoom > 2.5) {
      // Far away: zoom out hard (up to 2.8 levels at once) until in reach.
      console.log(`  [cam] z${v.zoom.toFixed(2)} (${v.source}), target ${Math.round(dist)}px away -> zoom out`);
      await wheelZoom(page, v, -Math.min(2.8, v.zoom - 2.5));
      continue;
    }
    if (dist > CENTER_TOL_PX) {
      // Drag the map so the target lands at center: drag vector is (-dx, -dy),
      // clamped to stay on-canvas. If no safe start point fits the vector,
      // halve it and try again.
      const maxLen = Math.min(v.rect.w, v.rect.h) * 0.6;
      const scale = Math.min(1, maxLen / dist);
      let vx = -dx * scale;
      let vy = -dy * scale;
      let plan = null;
      for (let half = 0; half < 3 && !plan; half++) {
        plan = await page.evaluate(([a, b, s]) => window.__cc.dragPlan(a, b, s), [vx, vy, dragSkip]);
        if (!plan) {
          vx /= 2;
          vy /= 2;
          dragSkip = 0;
        }
      }
      if (!plan) die('No safe drag start point found — the map may be covered by overlays. Check with screenshot.');
      console.log(`  [cam] z${v.zoom.toFixed(2)} (${v.source}), target ${Math.round(dist)}px away -> drag (${Math.round(vx)},${Math.round(vy)})`);
      await page.mouse.move(plan.sx, plan.sy);
      await page.mouse.down();
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(plan.sx + (vx * i) / steps, plan.sy + (vy * i) / steps, { steps: 2 });
      }
      await page.mouse.up();
      await sleep(650);
      if (v.source !== 'mirror') {
        // Hash center goes stale after drags; a zero-sum wheel forces a rewrite.
        await page.mouse.wheel(0, 40);
        await sleep(450);
        await page.mouse.wheel(0, -40);
        await sleep(450);
      }
      const after = await getView(page);
      const moved = Math.hypot(after.lat - v.lat, after.lng - v.lng);
      if (v.source === 'mirror' && moved < 1e-7) {
        // Drag didn't pan -> we probably grabbed a waypoint or UI. Undo any
        // accidental edit and retry from a different start point.
        await page.keyboard.press(`${MOD}+z`);
        await sleep(400);
        dragSkip++;
      } else {
        dragSkip = 0;
      }
      continue;
    }
    const tz = targetZoom ?? v.zoom;
    const dz = tz - v.zoom;
    if (Math.abs(dz) > ZOOM_TOL) {
      // Center is already on target here, and wheel zoom anchors at center, so
      // big steps are safe; residual drift is re-panned next iteration.
      console.log(`  [cam] z${v.zoom.toFixed(2)} (${v.source}), centered -> zoom ${dz > 0 ? 'in' : 'out'} toward z${tz}`);
      await wheelZoom(page, v, Math.max(-2, Math.min(2, dz)));
      continue;
    }
    return;
  }
  die(`Could not reach ${lat},${lng}${targetZoom ? ` z${targetZoom}` : ''} after 30 camera steps.`);
}

const MIN_PLOT_ZOOM = 14;   // below this, POI markers swallow clicks and 1px = >10m
const MAX_PLOT_ZOOM = 18.5;

const photoPopupOpen = page =>
  page.evaluate(() =>
    !!document.querySelector('[class*="SelectedPhotoPopup"], [class*="Popup_popup"]') ||
    !![...document.querySelectorAll('button')].find(b => /start here|see this place/i.test(b.textContent || '')));

async function clickPoint(page, lat, lng) {
  await ensureMap(page);
  if (await modalBlocking(page)) {
    die('A modal dialog is blocking the map. See it with screenshot, dismiss with ui "<button text>" --click.');
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    await dismissPhotoPopup(page);
    let v = await getView(page);
    if (v.kind === 'strava' && v.zoom < MIN_PLOT_ZOOM) {
      await cameraGoto(page, lat, lng, 15);
      v = await getView(page);
    }
    let p = await project(page, lat, lng);
    if (!p || !p.inView) {
      await cameraGoto(page, lat, lng);
      p = await project(page, lat, lng);
      if (!p || !p.inView) die(`Point ${lat},${lng} still not clickable after recentering.`);
    }
    if (v.kind === 'strava') {
      // A DOM marker (photo/POI pin) on the target pixel would swallow the click.
      const blocked = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return !el || el.tagName !== 'CANVAS';
      }, [p.x, p.y]);
      if (blocked) {
        if (v.zoom >= MAX_PLOT_ZOOM) break;
        // Markers keep their pixel size; zooming in moves them off the target.
        await cameraGoto(page, lat, lng, Math.min(v.zoom + 1, MAX_PLOT_ZOOM));
        continue;
      }
    }
    await page.mouse.click(p.x, p.y);
    await sleep(900); // photo popups load slowly; don't declare success too early
    if (v.kind === 'strava' && (await photoPopupOpen(page))) {
      // Click hit a canvas-rendered photo marker: no waypoint was added and a
      // popup opened. Panning/zooming dismisses it; retry one level closer.
      if (v.zoom >= MAX_PLOT_ZOOM) break;
      await cameraGoto(page, lat, lng, Math.min(v.zoom + 1, MAX_PLOT_ZOOM));
      continue;
    }
    await page.evaluate(([a, b]) => window.__cc.trackPlot(a, b), [lat, lng]);
    return;
  }
  die(`Could not click ${lat},${lng}: a map marker keeps swallowing the click even zoomed in. Inspect with screenshot.`);
}

// Route distance from the stats bar under the map ("Distance 0.76 mi"), or null.
const readDistance = page =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll('div,span,dt,p,h3,h4')].find(e => (e.textContent || '').trim() === 'Distance');
    if (!label) return null;
    return (label.parentElement.innerText.match(/([\d.]+)\s*(mi|km)/) || [])[0] ?? null;
  });

function parsePoints(tokens) {
  let raw;
  if (tokens.length === 1 && tokens[0].endsWith('.json')) {
    raw = JSON.parse(fs.readFileSync(tokens[0], 'utf8'));
  } else {
    raw = tokens.map(t => t.split(','));
  }
  const points = raw.map(p => (Array.isArray(p) ? { lat: +p[0], lng: +p[1] } : { lat: +p.lat, lng: +p.lng }));
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      die(`Bad point in input: ${JSON.stringify(p)}. Expected "lat,lng" pairs or a JSON array of [lat,lng] / {lat,lng}.`);
    }
  }
  if (!points.length) die('No points given.');
  return points;
}

// Pulls --flag / --flag value options out of argv, returns [flags, positionals].
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--delay') flags.delay = +argv[++i];
    else if (argv[i] === '--index') flags.index = +argv[++i];
    else if (argv[i] === '--click') flags.click = true;
    else if (argv[i] === '--desc') flags.desc = argv[++i];
    else if (argv[i] === '--private') flags.private = true;
    else if (argv[i] === '--public') flags.public = true;
    else rest.push(argv[i]);
  }
  return [flags, rest];
}

const USAGE = `Usage: node strava.js <command> [args]

Browser lifecycle
  start                     Launch the persistent Chrome window (log into Strava in it once)
  stop                      Quit that Chrome window
  status                    Show current URL, title, and camera state

Navigation
  open                      Go to the Strava route builder (${ROUTE_BUILDER_URL})
  nav <url>                 Go to an arbitrary URL
  goto <lat> <lng> [zoom]   Move the camera (closed-loop wheel/drag; no waypoints added)
  zoom <z>                  Set zoom, keep center

Plotting
  click <lat,lng>           Add one waypoint
  plot <pts.json | lat,lng lat,lng ...>   Add waypoints in order
       [--delay ms]                       (default 1200ms between clicks)
  save <name> [--desc "..."] [--private|--public]   Save the plotted route
  delete-route <url|id>     Delete a saved route (auto-confirms!)
  undo                      Press Cmd/Ctrl+Z (remove last waypoint)

Inspection / escape hatches
  screenshot [file]         Screenshot the page (default ~/.strava-map/shot.png)
  ui <text> [--click] [--index n]   List clickable elements matching text; --click clicks one
  key <combo>               Send a keyboard shortcut (e.g. "Meta+z", "Escape")
  js <expression>           Evaluate JS in the page, print JSON result (read-only helpers on window.__cc)
  html [selector]           Dump outerHTML (default body, truncated)`;

async function main() {
  const [flags, argv] = parseArgs(process.argv.slice(2));
  const cmd = argv[0];

  switch (cmd) {
    case 'start': {
      if (await cdpAlive()) {
        console.log('Browser already running.');
        return;
      }
      const bin = process.env.STRAVA_MAP_BROWSER ?? BROWSER_PATHS.find(p => fs.existsSync(p));
      if (!bin) die(`No Chromium-based browser found (set STRAVA_MAP_BROWSER to override). Looked for:\n${BROWSER_PATHS.join('\n')}`);
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      spawn(bin, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        'https://www.strava.com/login',
      ], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 50 && !(await cdpAlive()); i++) await sleep(200);
      if (!(await cdpAlive())) die('Browser did not come up on the debugging port.');
      console.log(`Browser running (CDP on :${PORT}, profile in ${PROFILE_DIR}).`);
      console.log('If this is the first run, log into Strava in the window that opened.');
      return;
    }

    case 'stop': {
      if (!(await cdpAlive())) {
        console.log('Browser is not running.');
        return;
      }
      const { browser } = await connect();
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => {});
      console.log('Browser closed.');
      return;
    }

    case 'status': {
      const { page } = await connect();
      console.log(`url:   ${page.url()}`);
      console.log(`title: ${await page.title()}`);
      const kind = await page.evaluate(PAGE_BOOTSTRAP);
      if (kind) {
        const v = await getView(page);
        console.log(`map:   ${v.kind} (${v.source}) @ ${v.lat.toFixed(5)},${v.lng.toFixed(5)} z${(+v.zoom).toFixed(2)}, ${v.plotted} plotted point(s) tracked`);
      } else {
        console.log('map:   none found on this page');
      }
      return;
    }

    case 'open': {
      const { page } = await connect();
      await page.goto(ROUTE_BUILDER_URL, { waitUntil: 'domcontentloaded' });
      await sleep(3500);
      console.log(`Now at: ${page.url()}`);
      const kind = await page.evaluate(PAGE_BOOTSTRAP);
      console.log(kind ? `Map detected (${kind}).` : 'No map detected yet — may need login or more load time; check with status/screenshot.');
      return;
    }

    case 'nav': {
      if (!argv[1]) die('Usage: node strava.js nav <url>');
      const { page } = await connect();
      await page.goto(argv[1], { waitUntil: 'domcontentloaded' });
      console.log(`Now at: ${page.url()}`);
      return;
    }

    case 'goto': {
      const lat = +argv[1], lng = +argv[2];
      const zoom = argv[3] == null ? null : +argv[3];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) die('Usage: node strava.js goto <lat> <lng> [zoom]');
      const { page } = await connect();
      await ensureSynced(page);
      await cameraGoto(page, lat, lng, zoom);
      const v = await getView(page);
      console.log(`camera @ ${v.lat.toFixed(5)},${v.lng.toFixed(5)} z${(+v.zoom).toFixed(2)}`);
      return;
    }

    case 'zoom': {
      const z = +argv[1];
      if (!Number.isFinite(z)) die('Usage: node strava.js zoom <z>');
      const { page } = await connect();
      await ensureSynced(page);
      const v = await getView(page);
      await cameraGoto(page, v.lat, v.lng, z);
      const after = await getView(page);
      console.log(`camera @ ${after.lat.toFixed(5)},${after.lng.toFixed(5)} z${(+after.zoom).toFixed(2)}`);
      return;
    }

    case 'click': {
      const [lat, lng] = (argv[1] ?? '').split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) die('Usage: node strava.js click <lat,lng>');
      const { page } = await connect();
      await ensureSynced(page);
      await clickPoint(page, lat, lng);
      console.log(`Clicked ${lat},${lng}`);
      return;
    }

    case 'plot': {
      const points = parsePoints(argv.slice(1));
      const delay = Number.isFinite(flags.delay) ? flags.delay : 1200;
      const { page } = await connect();
      await ensureSynced(page);
      for (let i = 0; i < points.length; i++) {
        const { lat, lng } = points[i];
        await clickPoint(page, lat, lng);
        console.log(`[${i + 1}/${points.length}] ${lat},${lng}`);
        if (i < points.length - 1) await sleep(delay);
      }
      await sleep(1500);
      const dist = await readDistance(page);
      console.log(`Done${dist ? ` — route is now ${dist}` : ''}. Verify with: node strava.js screenshot`);
      return;
    }

    case 'save': {
      const name = argv.slice(1).join(' ').trim();
      if (!name) die('Usage: node strava.js save <name> [--desc "..."] [--private|--public]');
      const { page } = await connect();
      const dist = await readDistance(page);
      if (dist && /^0(\.0+)?\s/.test(dist)) die(`Nothing to save — route distance is ${dist}. Plot waypoints first.`);
      const titleSel = '[role="dialog"] input#title';
      if (!(await page.$(titleSel))) {
        const opened = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b => /save route/i.test(b.textContent || ''));
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!opened) die('No "Save Route" button found — is the route builder open with a plotted route?');
        try {
          await page.waitForSelector(titleSel, { timeout: 8000 });
        } catch {
          die('Save dialog did not open — is the route empty? Check with screenshot.');
        }
      }
      await page.fill(titleSel, name);
      if (flags.desc) await page.fill('[role="dialog"] #description', flags.desc);
      if (flags.private || flags.public) {
        await page.evaluate(v => {
          const r = document.querySelector(`[role="dialog"] input[name="visibility"][value="${v}"]`);
          if (r && !r.checked) (r.closest('label') ?? r).click();
        }, flags.private ? 'OnlyMe' : 'Everyone');
        await sleep(300);
      }
      await page.click('[role="dialog"] button[type="submit"]');
      try {
        await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 15000 });
      } catch {
        die('Save dialog did not close — Strava may have shown an error. Check with screenshot.');
      }
      await sleep(3000);
      console.log(`Saved "${name}". Now at: ${page.url()}`);
      return;
    }

    case 'delete-route': {
      const arg = argv[1];
      if (!arg) die('Usage: node strava.js delete-route <route URL or id>');
      const id = (arg.match(/(\d{6,})/) ?? [])[1];
      if (!id) die(`Could not parse a route id from: ${arg}`);
      const { page } = await connect();
      await page.goto(`https://www.strava.com/routes/${id}`, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      const opened = await page.evaluate(() => {
        const anchor = [...document.querySelectorAll('button')].find(b => /^(Saved|Save Route)$/.test((b.textContent || '').trim()));
        if (!anchor) return false;
        const btn = [...anchor.closest('div').parentElement.querySelectorAll('button')]
          .find(b => b !== anchor && !(b.textContent || '').trim());
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!opened) die('Could not find the route actions menu — is this your route page?');
      await sleep(600);
      const rect = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [role="button"], li, a, button, div')]
          .filter(e => (e.textContent || '').trim() === 'Delete');
        const item = items.pop();
        if (!item) return null;
        const r = item.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!rect) die('No Delete option found in the route menu.');
      await page.mouse.click(rect.x, rect.y);
      await sleep(2000); // native confirm is auto-accepted by the dialog handler
      console.log(`Deleted route ${id}. Now at: ${page.url()}`);
      return;
    }

    case 'undo': {
      const { page } = await connect();
      await page.keyboard.press(`${MOD}+z`);
      console.log(`Sent ${MOD}+z`);
      return;
    }

    case 'screenshot': {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = path.resolve(argv[1] ?? path.join(DATA_DIR, 'shot.png'));
      const { page } = await connect();
      await page.screenshot({ path: file });
      console.log(file);
      return;
    }

    case 'ui': {
      const text = argv[1];
      if (!text) die('Usage: node strava.js ui <text> [--click] [--index n]');
      const { page } = await connect();
      const result = await page.evaluate(([needle, doClick, idx]) => {
        const sel = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="radio"], [role="switch"], input[type="submit"], input[type="button"], label';
        const collect = root => {
          const found = [...root.querySelectorAll(sel)];
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) found.push(...collect(el.shadowRoot));
          }
          return found;
        };
        const seen = new Set();
        const matches = [];
        for (const el of collect(document)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.value]
            .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          if (label.toLowerCase().includes(needle.toLowerCase())) {
            matches.push({ el, tag: el.tagName.toLowerCase(), label: label.slice(0, 100) });
          }
        }
        const out = matches.map((m, i) => ({ i, tag: m.tag, label: m.label }));
        if (doClick) {
          const pick = matches[idx ?? 0];
          if (!pick) return { matches: out, clicked: null };
          let r = pick.el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
            // Only scroll when off-screen: scrolling closes open menus.
            pick.el.scrollIntoView({ block: 'center' });
            r = pick.el.getBoundingClientRect();
          }
          return { matches: out, clicked: idx ?? 0, rect: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
        }
        return { matches: out, clicked: null };
      }, [text, !!flags.click, Number.isFinite(flags.index) ? flags.index : null]);
      if (!result.matches.length) {
        console.log('No matches.');
      } else {
        for (const m of result.matches) console.log(`[${m.i}] <${m.tag}> ${m.label}`);
        if (result.rect) {
          // Trusted mouse click — synthetic el.click() is ignored by some menus.
          await page.mouse.click(result.rect.x, result.rect.y);
          await sleep(800); // let any native confirm() fire while we can accept it
          console.log(`Clicked [${result.clicked}]`);
        } else if (flags.click) {
          console.log('Nothing clicked (index out of range).');
        }
      }
      return;
    }

    case 'key': {
      if (!argv[1]) die('Usage: node strava.js key <combo>   e.g. key Meta+z');
      const { page } = await connect();
      await page.keyboard.press(argv[1]);
      console.log(`Sent ${argv[1]}`);
      return;
    }

    case 'js': {
      const code = argv.slice(1).join(' ');
      if (!code) die('Usage: node strava.js js <expression>');
      const { page } = await connect();
      await page.evaluate(PAGE_BOOTSTRAP);
      const result = await page.evaluate(code);
      console.log(result === undefined ? 'undefined' : JSON.stringify(result, null, 2));
      return;
    }

    case 'html': {
      const { page } = await connect();
      const selector = argv[1] ?? 'body';
      const html = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? el.outerHTML : null;
      }, selector);
      if (html == null) die(`No element matches: ${selector}`);
      console.log(html.length > 30000 ? html.slice(0, 30000) + '\n…[truncated]' : html);
      return;
    }

    default:
      console.log(USAGE);
      if (cmd) process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err?.message ?? err);
    process.exit(1);
  }
);
