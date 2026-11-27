# Taskmarket Live

A public, source-linked visualizer of **Taskmarket's** live market on **Tempo (4217)** and **Base (8453)** — built from the public API, rebuilt every hour, no keys, no tracking, no dependencies.

**Live:** https://arrijalu.github.io/taskmarket-live/

Taskmarket's own stats page counts workers and open tasks. This one follows the money: where the escrow goes, how fast agents take work, who posts it, and what winning actually costs in attempts.

## What it shows

| Section | Question it answers |
| --- | --- |
| The flow | Of every OUSD ever committed, how much was released, how much is still in escrow, how much died? |
| The pulse | Postings and claims over 24H / 7D / 30D / all time, plus committed OUSD per bucket. |
| Velocity | Time from posting to a worker taking the task — median, p90, distribution, by mode and reward tier. |
| Who posts | Distinct posters, top-10 concentration, HHI, and posters/workers per week. |
| Competition | Submissions per award, median and p90 submissions, tasks by mode, status and chain. |
| When the market wakes | Postings by weekday × UTC hour. |
| The feed | The most recent tasks the API returned at build time. |
| Methods | Endpoints, cadence, exact definitions, and what the API cannot tell us. |

## Stack

Deliberately boring, because it has to stay up for a month and load in under three seconds on a phone:

- **Build:** one Node script (`build.mjs`, no dependencies) that walks the API and aggregates.
- **Page:** one static HTML file — inline CSS and inline JS, no framework, no web fonts, no chart library, hand-drawn SVG. ~89 kB uncompressed, one request, no network calls from the browser.
- **Social card:** `tools/og.py` (Pillow) renders `docs/og.png` from the same snapshot.
- **Host:** GitHub Pages, served from `main:/docs`. Static, free, HTTPS, no server to fall over.
- **Refresh:** an hourly cron on the build host (`7 * * * *`, `flock`-guarded, `./deploy.sh`) commits the new snapshot; the GitHub Actions schedule at `:37` is a backup, not the primary. The page also re-derives every relative age in the browser, so a stale snapshot announces its own age instead of silently rotting.

## Data

Two endpoints, both public, no key:

```
GET https://taskmarket.dev/api/market/stats
GET https://taskmarket.dev/api/tasks?limit=100&cursor=…
```

The task list is walked to the end of its cursor on every build (~17 pages, ~1,650 tasks). One fetch per hour is the entire load this project puts on the API.

**Honesty rules:**

- Every number on the page comes from that fetch. Nothing is estimated, interpolated or invented; where a series is missing, the page says so instead of drawing a line.
- The public API exposes no history endpoint and no completion timestamp, so every time series is a **cohort** reconstructed from `createdAt` / `claimedAt` on the tasks returned. The page states this in Methods.
- The one genuinely longitudinal series is the *observed* one: each build appends a snapshot of the headline counters to `data/watch.json`, so "since we started watching" accrues over time.
- Derived metrics are defined on the page with their exact formula (committed, released, in escrow, claim latency, HHI).

## Run it

```bash
node build.mjs        # fetch + aggregate + render → docs/index.html
python3 tools/og.py   # social card → docs/og.png
```

Requires Node ≥ 18 (global `fetch`) and Python 3 with Pillow for the card. No `npm install` — there are no dependencies.

## Deploy

```bash
./deploy.sh
```

Builds, commits `docs/` and `data/`, pushes to `main`. GitHub Pages serves `main:/docs`, so a push is a deploy. This is exactly what the hourly host cron runs:

```cron
7 * * * * cd /path/to/taskmarket-live && /usr/bin/flock -n /tmp/taskmarket-live.lock ./deploy.sh >> refresh.log 2>&1
```


## Layout

```
build.mjs              fetch, aggregate, render (the whole pipeline)
src/index.html         the page template (data is inlined at build time)
tools/og.py            social card renderer
data/market.json       the snapshot the page was built from
data/watch.json        accrued headline counters, one point per build
docs/index.html        published page (generated — do not edit)
docs/og.png            published social card (generated)
.github/workflows/     backup refresh (primary is the host cron)
deploy.sh              one-command deploy
```

## Motion and design notes

The page is built to a design-engineering bar rather than a "dashboard template" bar:

- **Springs, not keyframes**, for anything that can be interrupted: range switches retarget mid-flight, chart points re-target left to right, numbers roll to their new value.
- **`prefers-reduced-motion`** swaps every spring to critical damping and drops the entrances — gentler, not zero.
- **GPU-only properties** — `transform` and `opacity`. Bar growth uses `scaleX` with `transform-origin: left`, never `width`.
- **Hover motion is gated** behind `@media (hover: hover) and (pointer: fine)`; taps get the same information through `pointerdown`.
- **Sub-300 ms UI**, custom easing curves, no `transition: all`, no animation on anything a keyboard repeats.
- The spring engine and the segmented-control/stat-card behaviours are adapted from DesignBookmark's [Segmented Control](https://designbookmark.com/motion#db-segmented-control) and [Stat Card](https://designbookmark.com/motion#db-stat-card) cards (MIT-friendly, source read from `designbookmark.com/motion-src/`), reimplemented in plain DOM instead of pulling React and Motion into a page this small.

## License

MIT — see [LICENSE](LICENSE). Data belongs to Taskmarket; this project only reads its public API.
