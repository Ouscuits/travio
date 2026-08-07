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
  - but **`osrmCells + filledCells >= dim*(dim-1)`**: every off-diagonal cell holds a km
    and a min, each of which is either road data or an estimate, so every cell must be
    attested by at least one counter. A shortfall means cells came from nowhere.

  That last line is a coverage floor, not a partition, and it is load-bearing. Given
  `M = dim*(dim-1)`, a consumer can derive the two quantities a user actually cares about:

  - wholly estimated cells = `M - osrmCells`
  - half-real cells (real km with an estimated min, or the reverse) = `osrmCells + filledCells - M`

  The second identity is `|A ∩ B|` and holds only when `|A ∪ B| = M`. Without the floor,
  a provider reporting `{ source: 'osrm', osrmCells: 1, filledCells: 0 }` on a 3-place
  matrix passes both laws in silence while five of six cells are unaccounted for — the
  same class of bug as a guessed matrix labelled clean. A consumer must check the floor
  and refuse to derive counts when it fails.

  The two laws that DO hold **for `dim >= 2`**, and that the engine may rely on:

  - `filledCells === 0`  ⟺  `source === 'osrm'`
  - `osrmCells === 0`    ⟺  `source === 'haversine'`

  A matrix that violates either law is self-contradictory and the engine must warn
  rather than trust the label — the counters are the evidence, the label is the claim.

  **`dim < 2` is carved out and must not warn.** With fewer than two places there is
  no off-diagonal cell at all, so both counters are 0 and the provider reports
  `'haversine'` — which falsifies the first law while being the only honest answer
  available. The engine must skip the whole source check when `dim <= 1`.

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

  Carries a `source` flag with the same law as the matrix:
  - `'osrm'` — every point came off the road graph **and** the line was verified to
    describe the journey requested: no waypoint snapped beyond `maxSnapKm`, every point
    a usable coordinate, line begins and ends at the places asked for
  - `'straight'` — **not** road geometry: the resolved place coordinates in order. An
    estimate. Deliberately collapses request failure, OSRM declining, too many places, a
    waypoint answered about somewhere else, and a garbage decode — four of which the
    matrix path already surfaces separately on the same trip, and the fifth carries no
    user action
  - `'none'` — no resolved coordinates; empty array

  **Known limitation, accepted:** the line is verified at its endpoints, not along its
  path. A polyline that starts and ends correctly but wanders absurdly in between still
  reports `'osrm'`. It requires a server returning a well-formed reply with a corrupt
  middle, which the public OSRM does not do. The guard, if it ever matters, is already
  affordable: compare the decoded polyline's summed length against `routes[0].distance`,
  which is in the response and already parsed. Not done on spec.

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

## Known limitation, accepted on severity (engine, closed after 5 review rounds)

When one counter is malformed (`"x"`, `NaN`, negative, fractional, out of range), the
engine discards the *other* counter's proof even when it is valid and decisive. So
`{ source: 'osrm', osrmCells: 0, filledCells: "x" }` reports only "provenance cannot be
confirmed", losing both the every-cell finding that `osrmCells: 0` proves outright and
the label contradiction. 84 of 1,372 swept combinations are affected.

This is accepted because it fails in the safe direction — the engine under-claims, never
over-claims, and every affected case still warns the user that the provenance is
untrustworthy. Nothing goes silent and no number is fabricated, which is what separates it
from the defects this branch was opened to kill.

Recorded because the reasoning first used to accept it was wrong: "a junk counter cannot be
a decisive zero" is false (the junk counter is not the one carrying the zero), and "the
sweep confirms the two never co-occur" is circular, since `noRoadProven` is itself gated on
`!outOfRange` and so makes non-co-occurrence true by construction. A sweep cannot falsify a
property its subject defines into existence. The acceptance stands on severity alone.

## Test command

`npm test` is not available (no package.json in the app). Tests live in `tests/*.test.js`
and run with the Node built-in runner from the repo root:

```
node --test tests/*.test.js
```

Note: `node --test tests/` (directory positional) does **not** work on Node 24.14.1 —
it loads the directory as a module and fails with `MODULE_NOT_FOUND`. Use the glob.

Every rule above must have at least one assertion naming it (`R1`…`R8`).
