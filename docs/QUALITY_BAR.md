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
