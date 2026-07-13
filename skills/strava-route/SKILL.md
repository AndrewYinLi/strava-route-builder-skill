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
2. **Session**: `start` (if needed, user logs in once) → `open` → turn OFF the
   Community Photos layer (`ui "Change map style" --click`, `ui "Community
   Photos" --click`) → `goto <lat> <lng> 15` → `plot "lat,lng" "lat,lng" ...
   --delay 2000` → screenshot and READ it.
3. **Verify like a skeptic.** Waypoints snap to Strava's routing graph, not to
   the click: `goto` each critical stop at z16.5 and confirm the orange line
   passes through the canvas center. Check total distance/elevation for
   sanity. If the router bypasses a real trail, use the manual-mode recipe in
   CLAUDE.md for that one leg.
4. **Save & iterate**: `save "Name" [--private] [--desc "..."]` prints the
   route URL. For revisions, plot + save the new version first, then
   `delete-route <old-url>` (auto-confirms; irreversible — only delete what
   this workflow created/superseded). Tell the user the URL; starred routes
   appear in their Strava app.

## Judgment calls that matter

- Rebuilding a route from scratch is usually cleaner than undo-surgery on a
  plotted one; `undo` miscounts silently (verify with printed distance).
- Routing prefs: Run + "Follow most popular" is right for trail runs; note in
  the route description when a leg is manual (straight line).
- The tool prints camera-step logs and distances — read them; a click that
  didn't change distance did nothing (popup/popover ate it).
- If a command errors about modals/overlays: `screenshot`, then dismiss via
  `ui "<button text>" --click`. Unknown failures: CLAUDE.md "How it works /
  debugging notes".
