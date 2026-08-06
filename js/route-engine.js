/* ── Travio Routing Engine ── */
/* Pure, synchronous route planner. It receives an already-built distance matrix and
   never touches the network, the DOM, Date.now() or Math.random(). Same input always
   produces the same Plan. Implements rules R1..R8 of docs/ENGINE_CONTRACT.md.

   Wrapped in an IIFE so the classic <script> load order cannot collide with helper
   names defined by js/geo-provider.js. Exposed as window.TravioEngine (browser) and
   module.exports (Node). */

(function () {
    'use strict';

    /* ── Constants ── */
    const DEFAULT_MAX_DRIVE_MIN = 360;      // R6 — 6 h cap, Wanderlog bar B6
    const ROUND_TRIP_RADIUS_KM  = 5;        // R3 — origin/destination proximity match
    const ROAD_FACTOR           = 1.25;     // haversine -> road distance
    const FALLBACK_SPEED_KMH    = 75;       // haversine fallback average speed
    const EARTH_RADIUS_KM       = 6371.0088;
    const EPS                   = 1e-9;
    const MAX_DAYS              = 366;      // sanity clamp for absurd inputs (R8)
    const MAX_TWO_OPT_STOPS     = 60;       // above this the O(n^3) pass is skipped
    const MAX_TWO_OPT_PASSES    = 100;      // hard termination guard

    /* ── Small helpers ── */
    function round2(n) {
        if (!isFinite(n)) return 0;
        return Math.round(n * 100) / 100;
    }

    function isFiniteNumber(n) {
        return typeof n === 'number' && isFinite(n);
    }

    function normaliseName(name) {
        if (name === null || name === undefined) return '';
        let s = String(name).toLowerCase().trim();
        if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
        try {
            s = s.replace(/[\p{P}\p{S}]+/gu, ' ');
        } catch (e) {
            s = s.replace(/[.,;:!?'"()\[\]{}\/\\|_+*&%$#@~^<>=-]+/g, ' ');
        }
        return s.replace(/\s+/g, ' ').trim();
    }

    function hasCoords(p) {
        return !!p && isFiniteNumber(p.lat) && isFiniteNumber(p.lon);
    }

    function isPlaceLike(p) {
        if (!p || typeof p !== 'object') return false;
        if (typeof p.name === 'string' && p.name.trim() !== '') return true;
        return hasCoords(p);
    }

    function toRad(deg) {
        return (deg * Math.PI) / 180;
    }

    function haversineKm(a, b) {
        if (!hasCoords(a) || !hasCoords(b)) return NaN;
        const dLat = toRad(b.lat - a.lat);
        const dLon = toRad(b.lon - a.lon);
        const la1  = toRad(a.lat);
        const la2  = toRad(b.lat);
        const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /* Same place by name only — used for de-duplicating destinations, where two
       genuinely different sights can sit within a few km of each other. */
    function isSameName(a, b) {
        const na = normaliseName(a && a.name);
        const nb = normaliseName(b && b.name);
        if (!na || !nb) return false;
        return na === nb;
    }

    /* R3 — round-trip identity: normalised name match OR within ROUND_TRIP_RADIUS_KM. */
    function isSamePlace(a, b, radiusKm) {
        if (!a || !b) return false;
        if (a === b) return true;
        if (isSameName(a, b)) return true;
        const r = isFiniteNumber(radiusKm) ? radiusKm : ROUND_TRIP_RADIUS_KM;
        const d = haversineKm(a, b);
        return isFinite(d) && d <= r;
    }

    /* Offline matrix, identical in shape to the OSRM one produced by geo-provider.js.
       Exported so tests and the UI can plan without any network at all. */
    function haversineMatrix(places) {
        const list = Array.isArray(places) ? places : [];
        const km  = [];
        const min = [];
        for (let i = 0; i < list.length; i++) {
            km.push([]);
            min.push([]);
            for (let j = 0; j < list.length; j++) {
                if (i === j) {
                    km[i].push(0);
                    min[i].push(0);
                    continue;
                }
                const raw = haversineKm(list[i], list[j]);
                const d = isFinite(raw) ? raw * ROAD_FACTOR : 0;
                km[i].push(round2(d));
                min[i].push(round2((d / FALLBACK_SPEED_KMH) * 60));
            }
        }
        return { km: km, min: min, source: 'haversine' };
    }

    /* ── Time of day (optional, derived from input.departureTime) ── */
    function parseClock(value) {
        if (typeof value !== 'string') return null;
        const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(value);
        if (!m) return null;
        const h = parseInt(m[1], 10);
        const mi = parseInt(m[2], 10);
        if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
        return h * 60 + mi;
    }

    function formatClock(totalMin) {
        const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
        const h = Math.floor(m / 60);
        const r = m % 60;
        return (h < 10 ? '0' : '') + h + ':' + (r < 10 ? '0' : '') + r;
    }

    /* ── Input normalisation ── */
    function normaliseDayCount(value, warnings) {
        const n = Number(value);
        if (!isFinite(n) || n < 1) {
            warnings.push('days-clamped: day count "' + value + '" is not usable, planning 1 day.');
            return 1;
        }
        let d = Math.floor(n);
        if (d !== n) {
            warnings.push('days-clamped: day count ' + n + ' rounded down to ' + d + '.');
        }
        if (d > MAX_DAYS) {
            warnings.push('days-clamped: day count ' + d + ' exceeds the ' + MAX_DAYS + '-day limit.');
            d = MAX_DAYS;
        }
        return d;
    }

    function normaliseCap(value, warnings) {
        const n = Number(value);
        if (value === undefined || value === null || value === '') return DEFAULT_MAX_DRIVE_MIN;
        if (!isFinite(n) || n <= 0) {
            warnings.push('cap-default: maxDriveMinPerDay "' + value + '" is not usable, using ' +
                DEFAULT_MAX_DRIVE_MIN + ' min.');
            return DEFAULT_MAX_DRIVE_MIN;
        }
        return n;
    }

    /* ── Matrix access ──
       A node carries the place plus its row/column index in the matrix. Index resolution,
       in order: explicit place.matrixIndex, then the positional convention
       [start, ...stops, end] (or [start, ...stops] when the trip closes the loop or has
       no end point). Anything unusable falls back to haversine, then to 0 (R8: never throw). */
    function buildCostFn(matrix, dim, warnings, state) {
        const km  = matrix && Array.isArray(matrix.km) ? matrix.km : null;
        const min = matrix && Array.isArray(matrix.min) ? matrix.min : null;

        function cell(table, i, j) {
            if (!table || i < 0 || j < 0 || i >= dim || j >= dim) return NaN;
            const row = table[i];
            if (!Array.isArray(row)) return NaN;
            const v = row[j];
            return isFiniteNumber(v) ? v : NaN;
        }

        return function cost(a, b) {
            if (a === b || (a.mi >= 0 && a.mi === b.mi)) return { km: 0, min: 0 };
            let dk = cell(km, a.mi, b.mi);
            let dm = cell(min, a.mi, b.mi);
            if (isFinite(dk) && isFinite(dm)) return { km: dk, min: dm };

            const hav = haversineKm(a.place, b.place);
            if (isFinite(hav)) {
                if (!state.fellBack) {
                    state.fellBack = true;
                    warnings.push('distance-fallback: some distances were estimated from ' +
                        'straight-line coordinates, not from a road graph.');
                }
                const d = hav * ROAD_FACTOR;
                return { km: d, min: (d / FALLBACK_SPEED_KMH) * 60 };
            }

            if (!state.unknown) {
                state.unknown = true;
                warnings.push('unknown-distance: at least one leg has no distance data ' +
                    '(place not resolved and no matrix entry); it is counted as 0 km.');
            }
            return { km: 0, min: 0 };
        };
    }

    /* ── R2 — nearest neighbour seeded from the start ── */
    function nearestNeighbourOrder(startNode, stopNodes, cost) {
        const remaining = stopNodes.slice();
        const ordered = [];
        let current = startNode;
        while (remaining.length > 0) {
            let bestIdx = 0;
            let bestMin = Infinity;
            let bestKm = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                const c = cost(current, remaining[i]);
                // Deterministic tie-break: minutes, then km, then original input position.
                if (c.min < bestMin - EPS ||
                    (Math.abs(c.min - bestMin) <= EPS && c.km < bestKm - EPS)) {
                    bestIdx = i;
                    bestMin = c.min;
                    bestKm = c.km;
                }
            }
            current = remaining[bestIdx];
            ordered.push(current);
            remaining.splice(bestIdx, 1);
        }
        return ordered;
    }

    function sequenceMinutes(seq, cost) {
        let total = 0;
        for (let i = 0; i < seq.length - 1; i++) total += cost(seq[i], seq[i + 1]).min;
        return total;
    }

    /* ── R2 — deterministic 2-opt, endpoints pinned ──
       Segment reversals only; index 0 (the start) and, when an end point exists, the last
       index never move. The full sequence is re-costed for each candidate so that the
       improvement test is exact even if the matrix is asymmetric. First improvement wins,
       scanning in a fixed order, so the result is reproducible. */
    function twoOptImprove(seq, cost, endPinned) {
        const fixedTail = endPinned ? 1 : 0;
        let best = seq.slice();
        let bestCost = sequenceMinutes(best, cost);
        let improved = true;
        let passes = 0;
        while (improved && passes < MAX_TWO_OPT_PASSES) {
            improved = false;
            passes++;
            const last = best.length - 1 - fixedTail;
            for (let i = 1; i <= last - 1; i++) {
                for (let j = i + 1; j <= last; j++) {
                    const candidate = best.slice(0, i)
                        .concat(best.slice(i, j + 1).reverse())
                        .concat(best.slice(j + 1));
                    const c = sequenceMinutes(candidate, cost);
                    if (c < bestCost - 1e-6) {
                        best = candidate;
                        bestCost = c;
                        improved = true;
                    }
                }
            }
        }
        return best;
    }

    /* ── R4/R5/R6 — split the leg list into exactly dayCount contiguous chunks ──
       Contiguous means day n necessarily begins where day n−1 ended (the overnight place),
       and the split point is chosen by cumulative drive time, never by stops/days. */
    function splitLegsIntoDays(legs, dayCount, capMin) {
        const chunks = [];
        const total = legs.length;
        let d;

        if (total === 0) {
            for (d = 0; d < dayCount; d++) chunks.push([]);
            return chunks;
        }

        // R5 — fewer legs than days: at most one leg per day, spread evenly, the rest
        // become explicit rest days. No day can hold 2 stops while another holds none.
        if (total <= dayCount) {
            const dayOfLeg = [];
            for (let i = 0; i < total; i++) dayOfLeg.push(Math.floor((i * dayCount) / total));
            for (d = 0; d < dayCount; d++) {
                const chunk = [];
                for (let i = 0; i < total; i++) if (dayOfLeg[i] === d) chunk.push(legs[i]);
                chunks.push(chunk);
            }
            return chunks;
        }

        // R6 — more legs than days: balance cumulative drive time, honouring the cap
        // whenever the remaining time can physically fit under it.
        let pos = 0;
        let remainingMin = 0;
        for (let i = 0; i < total; i++) remainingMin += legs[i].min;

        for (d = 0; d < dayCount; d++) {
            const remainingDays = dayCount - d;
            const remainingLegs = total - pos;
            if (remainingDays === 1) {
                chunks.push(legs.slice(pos));
                pos = total;
                continue;
            }
            const maxTake = remainingLegs - (remainingDays - 1);
            let take = 0;
            let accum = 0;

            if (remainingMin <= EPS) {
                // No usable drive times at all — fall back to an even leg count.
                take = Math.ceil(remainingLegs / remainingDays);
                if (take > maxTake) take = maxTake;
            } else {
                const target = remainingMin / remainingDays;
                const capFeasible = remainingMin <= capMin * remainingDays + EPS;
                while (take < maxTake) {
                    const nextMin = legs[pos + take].min;
                    if (take > 0) {
                        if (capFeasible && accum + nextMin > capMin + EPS) break;
                        // Take the next leg only while it moves the day closer to target.
                        if (accum + nextMin / 2 > target) break;
                    }
                    accum += nextMin;
                    take++;
                }
            }
            if (take < 1) take = 1;
            chunks.push(legs.slice(pos, pos + take));
            pos += take;
            for (let k = 0; k < chunks[chunks.length - 1].length; k++) {
                remainingMin -= chunks[chunks.length - 1][k].min;
            }
        }
        return chunks;
    }

    /* ── Empty plan (no usable places at all) ── */
    function emptyPlan(dayCount, warnings) {
        const days = [];
        for (let d = 0; d < dayCount; d++) {
            days.push({
                day: d + 1,
                legs: [],
                stops: [],
                driveMin: 0,
                km: 0,
                startPlace: null,
                endPlace: null,
                overDriveCap: false,
                startTime: null,
                endTime: null
            });
        }
        return {
            days: days,
            order: [],
            totalKm: 0,
            totalMin: 0,
            roundTrip: false,
            warnings: warnings
        };
    }

    /* ── planRoute — the contract entry point ── */
    function planRoute(input) {
        const inp = input && typeof input === 'object' ? input : {};
        const warnings = [];
        const dayCount = normaliseDayCount(inp.days, warnings);
        const capMin = normaliseCap(inp.maxDriveMinPerDay, warnings);
        const departMin = parseClock(inp.departureTime);

        const rawStops = Array.isArray(inp.stops) ? inp.stops : [];
        let start = isPlaceLike(inp.start) ? inp.start : null;
        let end = isPlaceLike(inp.end) ? inp.end : null;

        if (!start && !end) {
            warnings.push('no-places: no usable start or end point was supplied.');
            return emptyPlan(dayCount, warnings);
        }
        if (!start) {
            warnings.push('missing-start: no usable start point, using the end point as origin.');
            start = end;
            end = null;
        }
        if (!end) {
            warnings.push('missing-end: no usable end point, the itinerary finishes at the last stop.');
        }

        /* R3 — round trip iff the end really is the origin. */
        const roundTrip = !!end && isSamePlace(start, end, ROUND_TRIP_RADIUS_KM);
        if (roundTrip) {
            warnings.push('round-trip: the end point matches the start point, so the itinerary ' +
                'returns to the origin.');
        }

        /* Matrix index convention. Positions come from the ORIGINAL stops array so that a
           matrix built by geo-provider.js from [start, ...stops, end] stays aligned even
           after duplicate stops are dropped below. */
        const matrix = inp.matrix && typeof inp.matrix === 'object' ? inp.matrix : null;
        const dim = matrix && Array.isArray(matrix.km) ? matrix.km.length : 0;
        if (!dim) {
            warnings.push('missing-matrix: no distance matrix supplied, distances are estimated ' +
                'from coordinates.');
        }
        if (matrix && matrix.source === 'haversine') {
            warnings.push('distance-source: haversine estimates (no road graph available).');
        }

        const nRaw = rawStops.length;
        const hasFullShape = dim === nRaw + 2;
        const hasLoopShape = dim === nRaw + 1 && (roundTrip || !end);
        if (dim && !hasFullShape && !hasLoopShape) {
            warnings.push('matrix-size-mismatch: matrix is ' + dim + '×' + dim + ' but ' +
                (nRaw + 2) + ' places were supplied; distances are estimated from coordinates.');
        }
        const positional = hasFullShape || hasLoopShape;

        function indexFor(place, pos) {
            if (place && Number.isInteger(place.matrixIndex) &&
                place.matrixIndex >= 0 && place.matrixIndex < dim) {
                return place.matrixIndex;
            }
            if (!positional) return -1;
            if (pos === 'end') return hasLoopShape ? 0 : nRaw + 1;
            return pos;
        }

        const startNode = { place: start, mi: indexFor(start, 0) };
        const endNode = end ? { place: end, mi: indexFor(end, 'end') } : null;

        /* R1 — every destination appears exactly once. Entries that duplicate the start,
           the end, or an earlier stop (by normalised name) are dropped and reported. */
        const stopNodes = [];
        const seen = {};
        for (let i = 0; i < nRaw; i++) {
            const p = rawStops[i];
            if (!isPlaceLike(p)) {
                warnings.push('stop-ignored: entry ' + (i + 1) + ' is not a usable place.');
                continue;
            }
            const key = normaliseName(p.name);
            if (isSameName(p, start)) {
                warnings.push('duplicate-stop-removed: "' + p.name + '" is the start point.');
                continue;
            }
            if (end && isSameName(p, end)) {
                warnings.push('duplicate-stop-removed: "' + p.name + '" is the end point.');
                continue;
            }
            if (key && seen[key]) {
                warnings.push('duplicate-stop-removed: "' + p.name + '" is listed more than once.');
                continue;
            }
            if (key) seen[key] = true;
            stopNodes.push({ place: p, mi: indexFor(p, i + 1) });
        }

        const allNodes = [startNode].concat(stopNodes);
        if (endNode) allNodes.push(endNode);
        for (let i = 0; i < allNodes.length; i++) {
            if (allNodes[i].place && allNodes[i].place.resolved === false) {
                warnings.push('unresolved-place: "' + (allNodes[i].place.name || '?') +
                    '" could not be geocoded; its distances are approximate.');
            }
        }

        const cost = buildCostFn(matrix, dim, warnings, { fellBack: false, unknown: false });

        /* R2 — nearest neighbour from the start, end pinned last, then 2-opt. */
        let seq;
        if (stopNodes.length === 0) {
            seq = endNode ? [startNode, endNode] : [startNode];
        } else {
            const ordered = nearestNeighbourOrder(startNode, stopNodes, cost);
            seq = [startNode].concat(ordered);
            if (endNode) seq.push(endNode);
            if (stopNodes.length > MAX_TWO_OPT_STOPS) {
                warnings.push('optimisation-limited: ' + stopNodes.length + ' stops exceed the ' +
                    MAX_TWO_OPT_STOPS + '-stop 2-opt limit; nearest-neighbour order kept.');
            } else {
                seq = twoOptImprove(seq, cost, !!endNode);
            }
        }

        /* R3 — a loop with no intermediate stop is not a trip; do not emit a 0 km leg
           from the origin to itself. */
        if (roundTrip && stopNodes.length === 0) {
            warnings.push('empty-trip: the start and end points are the same and there are no ' +
                'destinations, so there is nothing to drive.');
            seq = [startNode];
        }

        /* Legs (R7 — every number below is derived from these). */
        const legs = [];
        for (let i = 0; i < seq.length - 1; i++) {
            const c = cost(seq[i], seq[i + 1]);
            legs.push({
                from: seq[i].place,
                to: seq[i + 1].place,
                km: round2(c.km),
                min: round2(c.min)
            });
        }

        /* R4/R5/R6 — exactly dayCount days, split by cumulative drive time. */
        const chunks = splitLegsIntoDays(legs, dayCount, capMin);
        const days = [];
        let overnight = seq[0].place;
        let totalKm = 0;
        let totalMin = 0;

        for (let d = 0; d < dayCount; d++) {
            const chunk = chunks[d] || [];
            let dayKm = 0;
            let dayMin = 0;
            const stopsToday = [];
            for (let k = 0; k < chunk.length; k++) {
                dayKm += chunk[k].km;
                dayMin += chunk[k].min;
                stopsToday.push(chunk[k].to);
            }
            dayKm = round2(dayKm);
            dayMin = round2(dayMin);

            const startPlace = chunk.length ? chunk[0].from : overnight;
            const endPlace = chunk.length ? chunk[chunk.length - 1].to : overnight;
            const over = dayMin > capMin + EPS;

            if (chunk.length === 0) {
                warnings.push('rest-day: day ' + (d + 1) + ' has no driving — rest / explore ' +
                    (endPlace && endPlace.name ? endPlace.name : 'the current stop') +
                    ' (fewer destinations than days).');
            }
            if (over) {
                warnings.push('over-drive-cap: day ' + (d + 1) + ' drives ' + Math.round(dayMin) +
                    ' min, over the ' + Math.round(capMin) + ' min limit.');
            }

            days.push({
                day: d + 1,
                legs: chunk,
                stops: stopsToday,
                driveMin: dayMin,
                km: dayKm,
                startPlace: startPlace,
                endPlace: endPlace,
                overDriveCap: over,
                startTime: departMin === null ? null : formatClock(departMin),
                endTime: departMin === null ? null : formatClock(departMin + dayMin)
            });

            totalKm += dayKm;
            totalMin += dayMin;
            overnight = endPlace;
        }

        const order = [];
        for (let i = 0; i < seq.length; i++) order.push(seq[i].place);

        return {
            days: days,
            order: order,
            totalKm: round2(totalKm),
            totalMin: round2(totalMin),
            roundTrip: roundTrip,
            warnings: warnings
        };
    }

    /* ── Exports ── */
    const api = {
        planRoute: planRoute,
        haversineKm: haversineKm,
        haversineMatrix: haversineMatrix,
        normaliseName: normaliseName,
        isSamePlace: isSamePlace,
        DEFAULT_MAX_DRIVE_MIN: DEFAULT_MAX_DRIVE_MIN,
        ROUND_TRIP_RADIUS_KM: ROUND_TRIP_RADIUS_KM
    };

    if (typeof window !== 'undefined') {
        window.TravioEngine = api;
        window.planRoute = planRoute;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
