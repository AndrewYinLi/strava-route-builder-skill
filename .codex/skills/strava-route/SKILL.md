---
name: strava-route
description: Plot, inspect, save, edit, or delete Strava routes by driving the strava.com route-builder UI with this repo's persistent-browser strava.js CLI. Use when the user asks Codex to create a Strava route/map, plan a run, ride, hike, or walk in Strava, add route stops, revise a saved route, or delete one.
---

# Strava Route

Run the bundled CLI from the repository root:

```bash
node strava.js <command>
```

Read `CLAUDE.md` at the repository root before taking browser actions. It is
the authoritative command reference, route-builder checklist, manual-mode
recipe, and debugging guide.

## Workflow

1. Resolve every named destination to verified coordinates before touching the
   browser. Use Nominatim for huts, passes, and named places; use Overpass
   `aerialway=station` data for a lift's actual boarding or upper station.
   Cross-check consequential coordinates. Place shaping points on the intended
   trail; 30–100 m precision is sufficient because Strava snaps them.
2. Run `node strava.js status`; if needed run `start`. Ensure the dedicated
   Chromium window is visible, unminimized, and foregrounded before operating
   it. A reachable CDP port does not establish visibility. Ask the user to
   bring it forward when it is not visible or needs login.
3. Run `open`, turn off Community Photos, select the requested sport/routing
   preferences, and `goto` the route area at zoom 15.
4. Plot trail routes as short hops: add a shaping point at every meaningful
   junction and every 0.3–0.6 mi (0.5–1 km). Never send a trail leg farther
   than 0.75 mi (1.2 km) as one click. Use individual `click` commands or
   small `plot ... --delay 2000` batches. If a lift or hut marker swallows a
   click, use a point 30–100 m along the outgoing trail instead of the pin.
5. Screenshot after each batch. Confirm the distance is nonzero and inspect an
   overview; then `goto <critical-stop> 16.5` and verify that the orange line
   passes through the center. Check distance and elevation for plausibility.
6. Save with `save "Name" --private` unless the user requests public
   visibility. Report the saved route URL.

## Error recovery

- If Strava reports that it could not complete an action or requests more
  frequent waypoints, do not retry the same long leg. Screenshot and inspect
  the distance bar. The CLI's tracked plot count includes click attempts, so
  it does not prove that Strava retained them.
- If the distance is zero, reopen the builder and rebuild from the beginning
  with short on-trail hops. If it is nonzero, keep the valid portion and add
  closer shaping waypoints from its last confirmed endpoint.
- If routing snaps to the wrong trail, add a nearby on-trail shaping point. If
  the trail is truly absent from Strava's graph, use manual mode only for that
  short connector, note the straight-line segment in the route description,
  and return to snapped routing immediately afterward.
- If a modal, popup, or marker consumes input, inspect with `screenshot` and
  clear it with `ui` or a safe nearby waypoint; do not assume a successful
  command log means the route changed.
