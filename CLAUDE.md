# strava-map

CLI that plots routes in the **strava.com route builder UI** through a persistent
logged-in Chrome window — no Strava API needed. Claude generates lat/lng
coordinates and drives the builder with `node strava.js` commands.

## Quickstart

```bash
node strava.js start        # launch the dedicated Chrome window (once)
# → bring that Chromium window to the foreground and log into Strava there
#   (login persists in ~/.strava-map/; a legacy repo-local .browser-profile/
#   is still honored if present)
node strava.js open         # go to the route builder (strava.com/maps/create)
node strava.js goto 40.7715 -73.9730 15          # aim the camera (lat lng zoom)
node strava.js plot "40.7680,-73.9819" "40.7736,-73.9770" "40.7791,-73.9695"
node strava.js screenshot   # look at the result (prints path; Read the png)
```

The browser stays open between commands and sessions; each CLI call attaches via
CDP (port 9777). If a command says no browser is listening, run `start`.

This repo is also a **Claude Code plugin** (see README): `.claude-plugin/`
holds the manifest + marketplace, `skills/strava-route/` holds the skill that
teaches Claude this workflow. Data (login profile, screenshots) lives in
`~/.strava-map/`, overridable via `STRAVA_MAP_HOME`.

## Commands

| Command | What it does |
|---|---|
| `start` / `stop` | Launch / quit the dedicated Chrome window |
| `status` | URL, title, camera state, tracked plot count |
| `open` | Navigate to the route builder |
| `nav <url>` | Navigate anywhere |
| `goto <lat> <lng> [zoom]` | Move camera (closed-loop; adds no waypoints) |
| `zoom <z>` | Set zoom, keep center |
| `click <lat,lng>` | Add one waypoint |
| `plot <pts.json \| lat,lng ...> [--delay ms]` | Add waypoints in order (default 1200ms apart); prints resulting distance |
| `save <name> [--desc "..."] [--private\|--public]` | Save the plotted route; prints the new route URL |
| `delete-route <url\|id>` | Delete a saved route — **auto-confirms, cannot be undone** |
| `undo` | Cmd+Z — removes last waypoint |
| `screenshot [file]` | Screenshot page → `~/.strava-map/shot.png` by default |
| `ui <text> [--click] [--index n]` | Find/click buttons, links, toggles by visible text (trusted mouse click; scrolls only if off-screen) |
| `key <combo>` | Keyboard shortcut, e.g. `key Meta+m` |
| `js <expr>` | Evaluate JS in the page, JSON result |
| `html [selector]` | Dump outerHTML |

`plot` accepts inline `lat,lng` pairs or one JSON file: `[[lat,lng], ...]` or
`[{"lat":..,"lng":..}, ...]`.

## Plotting session checklist

1. `status` → make sure the dedicated Chromium window is visible, unminimized,
   and in the foreground → `open`. CDP being reachable does **not** mean a
   human can see the browser; ask the user to bring it forward if necessary.
   Informational modals are auto-dismissed.
2. **Turn off the Community Photos layer before plotting** — photo markers
   swallow waypoint clicks at exactly the photogenic places people want routes
   through: `ui "Change map style" --click`, then `ui "Community Photos"
   --click`. The next map click may be consumed closing the popover — the
   `plot` command and the screenshot's distance bar make a no-op visible.
3. Check sport/routing prefs in the panel (Run + "Follow most popular" is the
   default and right for trails).
4. `goto <lat> <lng> 15` for the area, then plot **short hops**. For trail
   routes, place shaping waypoints at every meaningful junction and roughly
   every 0.3–0.6 mi (0.5–1 km); never make a trail-routing request longer
   than 0.75 mi (1.2 km) in one click. The requested stops can be farther
   apart, but connect them through these intermediate points. Points off-screen
   auto-recenter; below zoom 14 plotting refuses and zooms in first. Use
   `click` one-at-a-time or small `plot` batches with `--delay 2000` when the
   terrain is complex.
5. Verify visually: overview screenshot + zoom onto each critical junction.
   **Waypoints snap to Strava's routing graph, not to what you clicked or to
   the heatmap** — a heavily-used trail can still be missing from the graph
   (e.g. the Seceda summit→Jëuf de Pana crest segment). To check a waypoint
   landed where intended: `goto <its coords> 16.5` and confirm the orange
   line passes through the canvas center.
6. `save "Name" [--private]` → prints URL. Iterating? Save the new version
   first, then `delete-route` the old one.

### Routing error recovery

If Strava says it could not complete an action or asks for more frequent
waypoints, do not retry the same long leg. Take a screenshot and read the
distance bar first: the CLI's tracked-point count records click attempts, not
proof that Strava retained the route. If the distance is zero, reopen the
builder and rebuild from the start with short hops. Otherwise retain the valid
portion and add 0.3–0.6 mi shaping waypoints along the intended mapped trail.
For a POI marker that swallows a click (especially lift stations and huts),
place the waypoint 30–100 m along the outgoing trail rather than on the marker.

## Non-routable segments: manual mode

When the router won't follow a real trail (snaps the waypoint elsewhere):

1. `key Meta+m` → a Warning dialog appears once — `ui "Continue" --click`.
2. Verify: `js` read the panel checkbox (label "Manual mode") — the panel may
   be collapsed at narrow widths; expand with `ui "→" --click` first.
3. `click <lat,lng>` — the vertex lands exactly there, leg drawn as a
   straight line (fine for short ridge/connector legs; note it in the route
   description so the runner follows the real trail).
4. `key Meta+m` to go back to snapped routing, verify the toggle is off.
   Subsequent road-mode legs route from the manual vertex's nearest graph
   point — usually exactly what you want.

## Route-builder facts (Strava UI)

- **Keyboard shortcuts**: ⌘Z undo, ⌘M manual mode, ⌘S save route (Ctrl on
  Linux/Windows; the CLI picks the right modifier itself).
- **Save**: the `save` command fills the whole dialog (input `#title`,
  textarea `#description`, radios `name="visibility"` value
  `Everyone`/`OnlyMe`) and submits. Without `--private`/`--public` the
  account default (Everyone) is kept.
- **Delete**: route page → unlabeled chevron next to Edit → Delete item
  (needs trusted click) → native confirm. `delete-route` does all of it.
- **Native confirm() dialogs are auto-accepted** by every command (Playwright
  would otherwise silently dismiss them). Only click destructive things
  deliberately.
- **Window size is flexible**: all geometry is re-read live per command;
  tested at 1200px and 840px widths. Below ~600px Strava's own layout covers
  the map. At narrow widths the builder panel collapses behind a `→` pull
  tab and floats OVER the canvas when expanded.
- **Informational modals are auto-dismissed** ("Made for your desktop" appears
  on every load in narrow windows; heatmap welcome; buttons Got it/OK/Close).
  Unknown dialogs stop the command with an error — inspect via screenshot.
- **Photo popups**: clicking a photo marker opens a popup instead of adding a
  waypoint. Two variants: "Start here" (pre-route) and "Route to here"
  (mid-route); the latter does NOT dismiss on pan. `click`/`plot` detect and
  recover (drag-dismiss, zoom in, retry), but turning the layer off (checklist
  #2) avoids the whole class.
- **Escape**: unreliable — sometimes closes the builder panel, sometimes
  nothing. Don't rely on it; re-enter with `ui "Create Route" --click`.
- After several `undo`s, verify with the printed distance — counting is
  error-prone and one extra Cmd+Z silently removes a wanted waypoint.
- Free accounts may have limited route-builder access (subscription feature).

## Coordinate sourcing (do this before plotting)

Verify every stop against real data — memory gets mountains wrong:

- **Nominatim** (any named place, huts, hotels, passes):
  `https://nominatim.openstreetmap.org/search?q=<name>&format=json&limit=5`
  via WebFetch.
- **Overpass** (lift stations, categories near a point):
  `https://overpass-api.de/api/interpreter?data=[out:json];nwr(around:2500,<lat>,<lng>)[aerialway=station];out center tags;`
  — this resolved the Seceda cable-car *station* (46.59794,11.72435) vs the
  *summit* (46.60059,11.72578) that Wikipedia's lift article confused.
- Wikipedia infoboxes are fine for peaks/huts but cross-check: two sources
  disagreeing by >100 m means dig further.
- Shaping waypoints (forcing a descent variant, avoiding a lift) don't need
  precision — the router snaps them; ~50–100 m is fine.

## How it works / debugging notes

Strava's map is a **custom WebGL engine** (canvas inside `div[class*="Map_map"]`)
— there is no mapbox/leaflet API on it. The page also keeps a **read-only
MapLibre mirror** of the camera (`ThirdPartyPluginLayer`, for browser
extensions), which `strava.js` uses for camera state and lat/lng→pixel
projection. **Never call jumpTo/setCenter on that mirror** (`window.__ccMap`) —
writing desyncs it from the real map until the builder is re-entered. Setting
`location.hash` does not steer the map either.

Camera moves therefore use real inputs in a feedback loop against the mirror:
mouse-wheel to zoom (~342 wheel units/level, smallest step ~0.4 — hence zoom
tolerance 0.25), drags to pan (center tolerance 15px: below the engine's ~6px
click-vs-drag threshold drags are ignored, and zooming in magnifies residual
error into draggable size — this breaks what would otherwise deadlock).
Wheel position and drag starts are hit-tested to land on the actual canvas
(popups/panels eat input silently). Waypoints are added by clicking the
mirror-projected pixel; plotted points are tracked in `window.__ccPlotted` so
pan-drags start away from the route (dragging a waypoint/route line edits it;
a drag that doesn't pan triggers ⌘Z + retry from another corner).

Page-side helpers (installed on demand, versioned via `__cc.v` — bump
`CC_VERSION` when changing them, stale copies persist in the page):
`window.__cc.view()`, `.project(lat,lng)`, `.trackPlot/.clearPlots`,
`.dragPlan(dx,dy,skip)`. The URL hash (`#zoom/lat/lng`) is Strava-written
fallback state — it updates on zoom but lags after drags; prefer the mirror.
The mirror initializes late after page load; `__cc.ok()` forces a rescan when
the element exists but no instance was captured.

If projection/camera misbehaves: `status` (mirror vs hash source),
`screenshot`, and `open` to get a fresh synced mirror.
