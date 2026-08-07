# External Quality Bar

No bar was specified, so three genuinely-adjacent products were considered.

## Candidates

**1. Wanderlog** — multi-day, multi-stop trip planner. Day-by-day itinerary with stops
assigned to specific days, automatic drive distance/time between consecutive stops,
route optimisation (reorder stops to minimise travel time), per-day and per-trip budget
tracking with expense breakdown, map with the route drawn, offline/export access.

**2. Roadtrippers** — road-trip corridor planner. Strong at "what's worth stopping for
along this line" (POI discovery within a radius of the polyline), fuel-cost estimation
from vehicle MPG, waypoint drag-reorder. Weaker at multi-day allocation and per-day
budgeting — it thinks in corridors, not in days.

**3. TripIt** — itinerary organiser. Parses confirmation emails into a timeline. It does
not plan or optimise routes at all.

## Chosen bar: **Wanderlog**

**Why.** Travio's input is exactly Wanderlog's problem shape: a start, an end, a set of
intermediate destinations, a number of days, and a daily budget — output an ordered,
day-split itinerary with distances, times and costs. Wanderlog is the only candidate
that solves *all* of that in one artifact, and its three headline capabilities map
one-to-one onto the three reported bugs (stop sequencing → routing logic; stops assigned
to days → day/route calculation; explicit one-way vs round-trip handling → the
return-to-origin bug). It is also the strictest of the three: its numbers are computed
from a real routing graph, not narrated.

Roadtrippers is kept as a **secondary source of feature hints** (corridor POIs, fuel
cost from consumption) because Travio is car-centric. TripIt is rejected as not
comparable — different problem entirely.

## The bar, as testable criteria

A Travio itinerary must meet what a Wanderlog itinerary guarantees:

- **B1** Every destination the user typed appears exactly once in the itinerary.
- **B2** Stop order is computed to reduce total travel, not asserted by prose.
- **B3** The itinerary contains exactly `duration` days, each with ≥1 activity; no empty
  days unless the user asked for a rest day.
- **B4** The last stop of the trip is the user's end point. The origin appears again
  **only** if the user's end point is the origin (round trip).
- **B5** Consecutive stops carry a real distance and drive time from a routing graph,
  with a stated fallback when offline.
- **B6** Daily driving stays under a sane cap (default 6 h); the plan warns instead of
  silently producing a 14-hour day.
- **B7** Cost per day is computed (fuel from km × consumption × price, tolls, lodging,
  meals) and compared against that day's budget, with an explicit over-budget flag.
- **B8** The route is visible on a map and exportable (GPX / calendar / print).
- **B9** Numbers displayed are internally consistent — day totals sum to trip totals.

Criteria B1–B4, B6, B9 are machine-checkable and are enforced by the test suite; B5, B7,
B8 are verified by inspection against live output.

## Status against the bar

Checked on the branch, not asserted from memory. 405 tests, 0 failures.

| | criterion | status | evidence |
|---|---|---|---|
| B1 | every destination exactly once | **met** | R1, fuzzed over 22,184 origin/layout cases |
| B2 | order computed to reduce travel | **met** | nearest-neighbour + 2-opt + or-opt; 1.5–7.5% above the brute-forced optimum over 4,600 instances, median 0.00% |
| B3 | exactly `duration` days, no silent empty days | **met** | R4/R5; extra days become flagged rest days |
| B4 | ends at the end point; origin reappears only on a round trip | **met** | R3 |
| B5 | real distance and time from a routing graph, stated fallback | **met** | OSRM + Nominatim; nine review rounds; 69-route live fixture; snap-distance verification |
| B6 | daily driving cap, warns rather than hiding a 14-hour day | **met** | exact DP over (day, split point); 0 violations in 3,479 provably-feasible instances |
| B7 | cost per day computed and compared to budget, over-budget flag | **met** | fuel/tolls/lodging/meals, five toll provenance states, floored totals |
| B8 | route visible on a map and exportable | **modules built, not yet wired** | `js/route-map.js` (81 tests), `js/route-export.js` (108 tests) |
| B9 | displayed numbers internally consistent | **met** | day totals sum to trip totals; rounded once |

**Not met, and deliberately so:** Roadtrippers' corridor POI discovery was scoped out —
it needs a third network dependency (Overpass) with its own rate limits and failure
modes, and bundling it would have made the map piece impossible to judge on its own.

**Not achievable on this backend:** avoiding toll roads. The public OSRM returns
`400 InvalidValue "Exclude flag combination is not supported"` for `exclude=toll`,
`exclude=motorway` and `exclude=ferry`, on both `/route` and `/table` (measured). The UI
therefore states that the route was *not* re-planned rather than showing a toll figure
nobody computed. Real avoidance would need a self-hosted OSRM or a keyed provider behind
the existing Cloudflare Worker — an architectural change, not a feature toggle.

## What the bar did not predict

Wanderlog framed the problem as routing, days and cost. Those were the reported bugs and
they were fixed early. Ten review rounds went instead into **provenance** — whether a
number shown to the user was measured, estimated, capped, unknown or not applicable. The
recurring defect was never a wrong calculation; it was a correct calculation presented
with more confidence than the data supported, and the recurring cause was a bound fitted
to the cases someone had thought to measure. That is the part of the bar worth carrying
into any future work here.
