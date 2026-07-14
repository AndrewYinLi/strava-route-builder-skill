---
name: strava-route
description: Plot, save, edit, or delete Strava routes by driving the strava.com route-builder UI with the bundled strava.js CLI (no Strava API). Use when the user asks to create or plot a Strava route/map, plan a run/ride/hike route on Strava, add stops to a route, or delete a saved route.
---

# Strava route plotting

This skill ships with its own CLI. The tool root is two directories above this
SKILL.md (`${CLAUDE_PLUGIN_ROOT}` when installed as a plugin; the repo root
when working in a clone). All commands below run as:

```bash
node "<tool-root>/strava.js" <command>
```

First use on a machine: if it reports a missing dependency, run
`npm install --prefix "<tool-root>"`. The Strava login is done once by the
user, in the window that `start` opens; it persists in `~/.strava-map/`.

**Before doing anything else, read `CLAUDE.md` at the tool root** — it has the
full command table, the plotting checklist, manual-mode instructions, and
hard-won gotchas. This file only summarizes the workflow.

## Workflow

1. **Coordinates first.** Turn the user's named stops into verified lat/lng
   before touching the browser: Nominatim for named places/huts/hotels,
   Overpass `[aerialway=station]` for lifts, Wikipedia infoboxes for peaks —
   cross-check two sources when they matter (a lift article once carried the
   summit's coords). Shaping waypoints (force a variant, avoid a lift) only
   need ~100 m accuracy.
2. **Visible session**: `start` if needed, then ensure the dedicated Chromium
   window is visible, unminimized, and foregrounded before driving the UI. A
   listening CDP port is not proof that the window is in view; ask the user to
   bring it forward if necessary. The user logs in there once. Then `open` and
   turn OFF Community Photos (`ui "Change map style" --click`, then `ui
   "Community Photos" --click`).
3. **Short-hop plotting**: `goto <lat> <lng> 15`, then connect named stops
   with shaping points at every decision and every 0.3–0.6 mi (0.5–1 km) on
   trails; never send a trail leg over 0.75 mi (1.2 km) as one route-builder
   click. Use individual `click`s or small `plot ... --delay 2000` batches.
   For a lift/hut POI marker that intercepts a click, use a point 30–100 m
   along the intended trail instead of its exact pin. Screenshot and read the
   resulting route before continuing.
4. **Verify like a skeptic.** Waypoints snap to Strava's routing graph, not to
   the click: `goto` each critical stop at z16.5 and confirm the orange line
   passes through the canvas center. Check total distance/elevation for
   sanity. If the router bypasses a real trail, use the manual-mode recipe in
   CLAUDE.md for that one leg.
5. **Save & iterate**: `save "Name" [--private] [--desc "..."]` prints the
   route URL. For revisions, plot + save the new version first, then
   `delete-route <old-url>` (auto-confirms; irreversible — only delete what
   this workflow created/superseded). Tell the user the URL; starred routes
   appear in their Strava app.

## Judgment calls that matter

- Rebuilding a route from scratch is usually cleaner than undo-surgery on a
  plotted one; `undo` miscounts silently (verify with printed distance).
- On Strava's "couldn't complete that action" / "more frequent waypoints"
  error, do not retry the same long leg. Screenshot and inspect the distance
  bar: tracked plot count includes attempts, so a zero-mile builder must be
  reopened and rebuilt with short hops; otherwise continue from the valid
  endpoint with closer on-trail shaping points.
- Routing prefs: Run + "Follow most popular" is right for trail runs; note in
  the route description when a leg is manual (straight line).
- The tool prints camera-step logs and `plot` prints the resulting distance —
  read them. Use the screenshot's distance bar to distinguish a retained route
  from an attempted click consumed by an error, popup, or marker.
- If a command errors about modals/overlays: `screenshot`, then dismiss via
  `ui "<button text>" --click`. Unknown failures: CLAUDE.md "How it works /
  debugging notes".
