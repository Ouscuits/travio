# Routing engine contract (v1)

Shared interface between `js/route-engine.js` (pure planner) and `js/geo-provider.js`
(network geocoding + road distances). Both files must work unchanged in the browser
(loaded as classic `<script>`, attaching to `window`) **and** in Node for tests, via:

```js
if (typeof module !== 'undefined' && module.exports) module.exports = { ... };
```

No ES module syntax, no bundler, no npm dependency in the shipped files.

## Types

```
Place    = { name: string, lat: number, lon: number, resolved: boolean, source: 'osm'|'ai'|'manual'|'cache' }
Matrix   = { km: number[][], min: number[][], source: 'osrm'|'mixed'|'haversine',
             osrmCells: number, filledCells: number }   // square, index-aligned to the Place[] passed in
Leg      = { from: Place, to: Place, km: number, min: number }
DayPlan  = { day: number, legs: Leg[], stops: Place[], driveMin: number, km: number,
             startPlace: Place, endPlace: Place, overDriveCap: boolean }
Plan     = { days: DayPlan[], order: Place[], totalKm: number, totalMin: number,
             roundTrip: boolean, warnings: string[] }
```

## `js/geo-provider.js` (Builder B)

- `geocodePlaces(names: string[], opts) -> Promise<Place[]>`
  Nominatim (`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=`),
  sequential with ≥1100 ms spacing (usage policy), `localStorage` cache keyed by
  normalised name, never more than one in-flight request. On failure return the Place
  with `resolved: false` — never throw, never drop the entry, preserve input order.
- `distanceMatrix(places: Place[]) -> Promise<Matrix>`
  OSRM public `table` service (`/table/v1/driving/{lon,lat;...}?annotations=duration,distance`).
  On any failure fall back to haversine × road factor and set the source flag.
  Symmetric, zero diagonal, no `null`/`Infinity` cells.

  **`source` must describe the whole matrix, not one lucky cell** (this was a real bug —
  a 70%-guessed matrix reported `'osrm'` and suppressed the engine's warning):
  - `'osrm'` — **every** off-diagonal cell came from the road graph (`filledCells === 0`)
  - `'mixed'` — some real, some haversine-filled (islands, ferries, unroutable pairs)
  - `'haversine'` — no cell came from the road graph
  `osrmCells` / `filledCells` carry the counts and are part of the contract, not extras.

  **The counters overlap; they are not a partition.** A cell carries two values (km and
  min) and they can have different provenance: OSRM's default `/table` reply annotates
  durations only, and a `distances`-only reply is equally possible. Such a cell is half
  real and half estimated, and it is counted in **both**. So:

  - `osrmCells`  = off-diagonal cells carrying **any** road-graph value
  - `filledCells` = off-diagonal cells carrying **any** estimated value
  - `0 <= osrmCells <= dim*(dim-1)` and `0 <= filledCells <= dim*(dim-1)`
  - their sum may exceed `dim*(dim-1)`; it must never be used as a consistency test

  The two laws that DO hold, and that the engine may rely on:

  - `filledCells === 0`  ⟺  `source === 'osrm'`
  - `osrmCells === 0`    ⟺  `source === 'haversine'`

  A matrix that violates either law is self-contradictory and the engine must warn
  rather than trust the label — the counters are the evidence, the label is the claim.

  Because of the overlap, a warning that reads "N of M cells are straight-line estimates"
  overstates the case when those cells still hold real distances. The engine's message
  must distinguish **partly** estimated cells from **entirely** estimated ones.

  **Speed calibration.** The haversine fallback must not manufacture false over-cap
  warnings. Measured against live OSRM on five long Spanish routes, a 1.25 road factor
  is well calibrated (−0.1% to +8.5% on distance) but 75 km/h is 22–26% pessimistic on
  time; real long-haul average is 87–92 km/h. The engine enforces `maxDriveMinPerDay` on
  `min`, so a pessimistic speed over-splits days — the exact bug class this project set
  out to fix.
- `routeGeometry(places: Place[]) -> Promise<[lat,lon][]>` — OSRM `route` overview
  polyline decoded to points, for the map. Falls back to straight lines between places.

## `js/route-engine.js` (Builder A)

`planRoute(input) -> Plan`, **pure and synchronous** — it receives an already-built
matrix and never touches the network, DOM, or `Date.now()`.

```
input = { start: Place, end: Place, stops: Place[], matrix: Matrix, days: number,
          maxDriveMinPerDay?: number (default 360), departureTime?: 'HH:MM' }
```

Rules — these are the bug fixes and are all machine-checkable:

1. **R1** `order` starts with `start`, ends with `end`, and contains every element of
   `stops` exactly once. No duplicates anywhere except the legitimate round-trip case.
2. **R2** Ordering minimises total travel: nearest-neighbour seeded from `start` with
   the endpoint pinned last, then 2-opt improvement until no swap helps. Deterministic
   (no randomness) — same input, same output.
3. **R3** `roundTrip` is true iff `end` is the same place as `start` (name match after
   normalisation, or within 5 km). The origin may reappear as the final stop **only**
   when `roundTrip` is true. When it is false, `start` must appear exactly once, at
   index 0 — the engine must never close the loop.
4. **R4** `days.length === input.days` exactly, for every input. Stops are distributed
   across days by cumulative drive time, not by naive `stops/days` division. Day *n*
   begins where day *n−1* ended (the overnight place), and that overnight place is not
   re-counted as a new stop.
5. **R5** No day may be empty while another day holds ≥2 stops; if there are fewer stops
   than days, extra days become explicit rest/exploration days at the current overnight
   place and are flagged in `warnings` — never silently dropped, and `days.length` still
   equals `input.days`.
6. **R6** If `stops.length + 1 > days`, days may legitimately hold multiple stops; the
   split still respects `maxDriveMinPerDay` where possible and sets `overDriveCap: true`
   plus a warning on any day that exceeds it.
7. **R7** `totalKm`/`totalMin` equal the sum of the per-day values, which equal the sum
   of that day's legs (float tolerance 0.01).
8. **R8** Degenerate inputs must not throw: 0 stops, 1 day, days > stops+2, duplicate
   destination names, unresolved places (`resolved: false` — fall back to matrix values
   which the provider guarantees to be finite).

## Test command

`npm test` is not available (no package.json in the app). Tests live in `tests/*.test.js`
and run with the Node built-in runner from the repo root:

```
node --test tests/*.test.js
```

Note: `node --test tests/` (directory positional) does **not** work on Node 24.14.1 —
it loads the directory as a module and fails with `MODULE_NOT_FOUND`. Use the glob.

Every rule above must have at least one assertion naming it (`R1`…`R8`).
