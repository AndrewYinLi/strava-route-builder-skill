# strava-map

Let Claude plot **Strava routes** for you — by driving the strava.com route
builder UI in a real browser. No Strava API keys, no OAuth app approval: you
log into Strava once in a dedicated Chrome window, and from then on Claude can
build, save, and manage routes on your account from plain-language requests
("plot my Seceda descent run with lunch at Rifugio Firenze").

Built as a [Claude Code](https://claude.com/claude-code) plugin: it bundles a
`strava-route` skill (the workflow Claude follows) and `strava.js` (a CLI that
drives the browser via CDP).

## Install (as a Claude Code plugin)

In Claude Code, from any directory:

```
/plugin marketplace add <owner>/strava-map
/plugin install strava-map
```

*(replace `<owner>` with the GitHub owner of this repo)*

Then just ask Claude: *"plot a Strava route from X to Y via Z"*. The skill
works from any directory once installed.

## Prerequisites

- **Node.js 18+**
- **Google Chrome** (or Chromium / Edge / Brave; set `STRAVA_MAP_BROWSER` to a
  browser binary to override detection)
- A **Strava account** (the route builder is a Strava subscription feature)

## First run

The first command that needs the browser will prompt you through this, but for
the record:

```bash
npm install --prefix <plugin-or-clone-dir>   # once, installs playwright-core
node <dir>/strava.js start                   # opens the dedicated Chrome window
# → log into strava.com in that window (once; the login persists)
node <dir>/strava.js open                    # route builder — you're in business
```

Your login, browser profile, and screenshots live in `~/.strava-map/` — never
in this repo, and nothing account-related is ever committed.

## Manual CLI use (without Claude)

The CLI is useful standalone:

```bash
node strava.js goto 46.5979 11.7244 15                    # aim the camera
node strava.js plot "46.5979,11.7244" "46.6006,11.7258"   # click waypoints
node strava.js save "My route" --private
node strava.js delete-route <url>
node strava.js            # full usage
```

See **[CLAUDE.md](CLAUDE.md)** for the complete command reference, the
plotting checklist, and how it works under the hood (Strava's map is a custom
WebGL engine — camera control is done closed-loop with real mouse inputs
against a read-only MapLibre mirror the page keeps for browser extensions).

## Notes

- Each user drives **their own** Strava account — whatever is logged into the
  dedicated browser window.
- This automates your personal browser session; be a good citizen (the tool
  paces its clicks, but don't script bulk operations against Strava).
- `delete-route` auto-confirms Strava's "cannot be undone" dialog — that's
  what makes scripted cleanup possible, so point it only at routes you mean
  to delete.
