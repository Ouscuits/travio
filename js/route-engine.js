/* ── Travio Routing Engine ── */
/* Pure, synchronous route planner. It receives an already-built distance matrix and
   never touches the network, the DOM, Date.now() or Math.random(). Same input always
   produces the same Plan. Implements rules R1..R8 of docs/ENGINE_CONTRACT.md.

   Wrapped in an IIFE so the classic <script> load order cannot collide with helper
   names defined by js/geo-provider.js. Exposed as window.TravioEngine (browser) and
   module.exports (Node).

   Ordering: nearest neighbour seeded from the start, then 2-opt segment reversal, then
   or-opt segment relocation (1..3 stops, forward or reversed), alternated until neither
   helps. Every candidate is scored by an exact O(1) delta, so each pass is O(n^2). The
   result is always a 2-opt local optimum, but a local optimum is NOT the global optimum —
   on random 6-stop instances it lands above the true optimum roughly one time in five.
   It is deterministic, not exact.

   Day split: an exact DP over (day, split point) that minimises, in order, the total time
   over maxDriveMinPerDay, then the imbalance in drive time, then the imbalance in leg
   count. Feasibility therefore always beats balance — if any contiguous split keeps every
   day under the cap, the engine returns one.

   Matrix trust: matrix.source is the provider's claim and osrmCells/filledCells are the
   evidence for it. When they contradict each other the counters win and the contradiction
   is reported. Negative cells are rejected outright, never subtracted from the totals.

   Documented deviations from the contract (all reported through Plan.warnings):

   - R1  Destinations that duplicate the start, the end or an earlier stop (normalised
         name match) are dropped and reported as 'duplicate-stop-removed'. Keeping them
         would break R3 (origin appearing twice on a one-way trip).
   - R3  A round trip with no destinations returns order = [start] and 'empty-trip'
         instead of a 0 km leg from the origin to itself.
   - R4  input.days is coerced with Number(), so "5", " 4 ", [3] and true silently become
         5, 4, 3 and 1. Anything that is not a finite number >= 1 — 0, -4, NaN, Infinity,
         0.5, "5 days", null, undefined, {}, [] — collapses to a single day with a
         'days-clamped' warning. Fractional counts above 1 are floored (3.7 -> 3), and
         counts above MAX_DAYS (366) are clamped, both with a 'days-clamped' warning.
   - R2  Above MAX_TWO_OPT_STOPS (60) stops the improvement passes are skipped
         ('optimisation-limited') and the nearest-neighbour order is kept.
   - R6  Above MAX_SPLIT_DP_WORK the day split falls back to a linear cap-first greedy.
         It still honours the cap whenever a split under it exists; it just balances the
         days worse than the DP. The threshold is far beyond any real itinerary. */

(function () {
    'use strict';

    /* ── Constants ── */
    const DEFAULT_MAX_DRIVE_MIN = 360;      // R6 — 6 h cap, Wanderlog bar B6
    const ROUND_TRIP_RADIUS_KM  = 5;        // R3 — origin/destination proximity match
    const ROAD_FACTOR           = 1.25;     // haversine -> road distance
    /* 90 km/h, not 75: the contract's live-OSRM calibration measured 75 km/h as 22–26%
       pessimistic on long hauls (real average 87–92 km/h). A pessimistic speed inflates
       driveMin, which over-splits days and manufactures false over-cap warnings. */
    const FALLBACK_SPEED_KMH    = 90;       // haversine fallback average speed
    const EARTH_RADIUS_KM       = 6371.0088;
    const EPS                   = 1e-9;
    const MAX_DAYS              = 366;      // sanity clamp for absurd inputs (R8)
    const MAX_TWO_OPT_STOPS     = 60;       // above this the improvement passes are skipped
    const MAX_TWO_OPT_PASSES    = 100;      // hard termination guard
    /* Transition budget for the day-split DP (days x legs x legs). Beyond it the split
       falls back to a linear cap-first greedy — see splitLegsIntoDays. */
    const MAX_SPLIT_DP_WORK     = 5e6;

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

    /* Coordinates reach the engine from Firestore, from the AI enrichment and from form
       input, so they can legitimately arrive as numeric strings. Coerce, then reject
       anything outside the real world. */
    function geoNum(value, limit) {
        let n;
        if (typeof value === 'number') n = value;
        else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
        else return NaN;
        if (!isFinite(n) || Math.abs(n) > limit) return NaN;
        return n;
    }

    function latOf(p) {
        return p ? geoNum(p.lat, 90) : NaN;
    }

    function lonOf(p) {
        return p ? geoNum(p.lon, 180) : NaN;
    }

    function hasCoords(p) {
        return !!p && isFiniteNumber(latOf(p)) && isFiniteNumber(lonOf(p));
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
        const aLat = latOf(a);
        const aLon = lonOf(a);
        const bLat = latOf(b);
        const bLon = lonOf(b);
        const dLat = toRad(bLat - aLat);
        const dLon = toRad(bLon - aLon);
        const la1  = toRad(aLat);
        const la2  = toRad(bLat);
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
        const offDiagonal = list.length * (list.length - 1);
        return {
            km: km,
            min: min,
            source: 'haversine',
            osrmCells: 0,
            filledCells: offDiagonal
        };
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

        function flagNegative() {
            if (state.negative) return;
            state.negative = true;
            warnings.push('invalid-distance: the distance matrix contains negative values, ' +
                'which cannot be real distances or durations; those legs are ignored and ' +
                're-estimated from coordinates where possible.');
        }

        function cell(table, i, j) {
            if (!table || i < 0 || j < 0 || i >= dim || j >= dim) return NaN;
            const row = table[i];
            if (!Array.isArray(row)) return NaN;
            const v = row[j];
            if (!isFiniteNumber(v)) return NaN;
            /* A negative distance or duration is never a measurement, it is corrupt data.
               Left unchecked it subtracts from the trip totals and can even cancel the
               real legs out to ~0, which then surfaces as the wrong warning entirely.
               Treat it as missing so the fallback path handles it, and say so. */
            if (v < 0) {
                flagNegative();
                return NaN;
            }
            return v;
        }

        function flagUnknown() {
            if (state.unknown) return;
            state.unknown = true;
            warnings.push('unknown-distance: at least one leg has no usable distance data ' +
                '(place not resolved and no coordinates); it is counted as 0 km.');
        }

        return function cost(a, b) {
            if (a === b || (a.mi >= 0 && a.mi === b.mi)) return { km: 0, min: 0 };
            const dk = cell(km, a.mi, b.mi);
            const dm = cell(min, a.mi, b.mi);
            if (isFinite(dk) && isFinite(dm)) {
                /* A finite 0 between two different places is only believable when both
                   have usable coordinates — otherwise it is the provider's placeholder
                   for "unknown" and must not pass as a real 0 km leg. */
                if (dk <= 0 && dm <= 0 && !(hasCoords(a.place) && hasCoords(b.place))) flagUnknown();
                return { km: dk, min: dm };
            }

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

            flagUnknown();
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

    /* Prefix sums along a sequence, forward and backward, so that the cost of any
       contiguous run — in either direction — is an O(1) subtraction:
         fwd[k] = cost of seq[0]->..->seq[k]           run seq[i]..seq[j]  = fwd[j] - fwd[i]
         rev[k] = cost of seq[k]->..->seq[0]           the same run reversed = rev[j] - rev[i]
       Keeping both is what lets the improvement passes stay exact on an ASYMMETRIC matrix
       while costing O(1) per candidate instead of re-costing the whole sequence. */
    function directionalPrefix(seq, cost) {
        const m = seq.length;
        const fwd = new Float64Array(m);
        const rev = new Float64Array(m);
        for (let k = 0; k + 1 < m; k++) {
            fwd[k + 1] = fwd[k] + cost(seq[k], seq[k + 1]).min;
            rev[k + 1] = rev[k] + cost(seq[k + 1], seq[k]).min;
        }
        return { fwd: fwd, rev: rev };
    }

    /* ── R2 — deterministic 2-opt, endpoints pinned ──
       Segment reversals only; index 0 (the start) and, when an end point exists, the last
       index never move. Each candidate is scored by an exact delta — the two boundary
       edges plus the reversed interior, read off the directional prefix sums — instead of
       re-costing the whole sequence, which turned every O(n^2) pass into O(n^3) and made
       a 60-stop plan block the main thread for hundreds of milliseconds. The delta is the
       exact difference, asymmetric matrices included, so the accepted moves are the same
       ones the full re-cost accepted. First improvement wins, scanning in a fixed order,
       so the result is reproducible. */
    function twoOptImprove(seq, cost, endPinned) {
        const fixedTail = endPinned ? 1 : 0;
        let best = seq.slice();
        if (best.length < 3) return best;
        let pre = directionalPrefix(best, cost);
        let improved = true;
        let passes = 0;
        while (improved && passes < MAX_TWO_OPT_PASSES) {
            improved = false;
            passes++;
            const tail = best.length - 1;
            const last = tail - fixedTail;
            for (let i = 1; i <= last - 1; i++) {
                for (let j = i + 1; j <= last; j++) {
                    const hasNext = j < tail;
                    const removed = cost(best[i - 1], best[i]).min +
                        (pre.fwd[j] - pre.fwd[i]) +
                        (hasNext ? cost(best[j], best[j + 1]).min : 0);
                    const added = cost(best[i - 1], best[j]).min +
                        (pre.rev[j] - pre.rev[i]) +
                        (hasNext ? cost(best[i], best[j + 1]).min : 0);
                    if (added - removed < -1e-6) {
                        best = best.slice(0, i)
                            .concat(best.slice(i, j + 1).reverse())
                            .concat(best.slice(j + 1));
                        pre = directionalPrefix(best, cost);
                        improved = true;
                    }
                }
            }
        }
        return best;
    }

    /* ── R2 — or-opt: relocate a run of 1..3 stops elsewhere in the sequence ──
       2-opt can only reverse a segment in place, so a single stop sitting on the wrong
       side of the itinerary stays stuck. Scanning order is fixed and the first strict
       improvement wins, so the pass is deterministic. Endpoints never move.

       Each candidate is scored in O(1): the segment's own interior cost comes from the
       sequence's directional prefix sums, and everything outside it from a prefix sum
       built once per (length, position) pair over the remainder. */
    function findOrOptMove(seq, seqCost, cost, fixedTail) {
        const last = seq.length - 1 - fixedTail;   // last index that may move
        const pre = directionalPrefix(seq, cost);
        for (let len = 1; len <= 3 && len <= last; len++) {
            for (let i = 1; i + len - 1 <= last; i++) {
                const segStart = i;
                const segEnd = i + len - 1;
                const segFwd = pre.fwd[segEnd] - pre.fwd[segStart];
                const segRev = pre.rev[segEnd] - pre.rev[segStart];
                const segment = seq.slice(segStart, segEnd + 1);
                const rest = seq.slice(0, i).concat(seq.slice(i + len));
                const R = rest.length;
                /* restPrefix[k] = cost of rest[0]->..->rest[k]. */
                const restPrefix = new Float64Array(R);
                for (let k = 0; k + 1 < R; k++) {
                    restPrefix[k + 1] = restPrefix[k] + cost(rest[k], rest[k + 1]).min;
                }
                const restTotal = R > 0 ? restPrefix[R - 1] : 0;
                const maxPos = R - fixedTail;
                for (let pos = 1; pos <= maxPos; pos++) {
                    for (let rev = 0; rev < 2; rev++) {
                        if (rev === 1 && len === 1) continue;      // reversing 1 stop is a no-op
                        if (rev === 0 && pos === i) continue;      // same place, same order
                        const head = rev ? seq[segEnd] : seq[segStart];
                        const tail = rev ? seq[segStart] : seq[segEnd];
                        let c = restPrefix[pos - 1] +
                            cost(rest[pos - 1], head).min +
                            (rev ? segRev : segFwd);
                        if (pos < R) {
                            c += cost(tail, rest[pos]).min + (restTotal - restPrefix[pos]);
                        }
                        if (c < seqCost - 1e-6) {
                            const piece = rev ? segment.slice().reverse() : segment;
                            const candidate = rest.slice(0, pos).concat(piece).concat(rest.slice(pos));
                            return { seq: candidate, cost: c };
                        }
                    }
                }
            }
        }
        return null;
    }

    /* 2-opt and or-opt alternate until neither improves. The loop always exits on a
       sequence that 2-opt cannot improve, so the 2-opt local-optimum property holds. */
    function improveSequence(seq, cost, endPinned) {
        const fixedTail = endPinned ? 1 : 0;
        let best = twoOptImprove(seq, cost, endPinned);
        let bestCost = sequenceMinutes(best, cost);
        let rounds = 0;
        while (rounds < MAX_TWO_OPT_PASSES) {
            rounds++;
            const move = findOrOptMove(best, bestCost, cost, fixedTail);
            if (!move) break;
            const reopt = twoOptImprove(move.seq, cost, endPinned);
            const reoptCost = sequenceMinutes(reopt, cost);
            if (reoptCost >= bestCost - 1e-6) break;   // no strict gain: keep the 2-opt optimum
            best = reopt;
            bestCost = reoptCost;
        }
        return best;
    }

    /* ── R4/R5/R6 — split the leg list into exactly dayCount contiguous chunks ──
       Contiguous means day n necessarily begins where day n−1 ended (the overnight place),
       and the split point is chosen by cumulative drive time, never by stops/days.

       Feasibility beats balance. The earlier greedy chose each day's split point by how
       close it landed to the average day, which could veto taking a leg that the cap
       *required* the day to take; the leftovers then piled onto the last day, which was
       emitted with no cap test at all. On randomised realistic instances that produced an
       over-cap day in ~3% of cases where a split with every day under the cap provably
       existed — worst case an 8.8 h driving day where no day needed to exceed 6 h.

       So the split is now chosen by an exact DP over (day, split point) that minimises,
       lexicographically:
         1. total minutes over the cap  — zero whenever any feasible split exists, so a
            feasible split is always found when one exists;
         2. squared deviation of each day's drive time from the average day — balance,
            as a tie-break among feasible splits, never as a veto over feasibility;
         3. squared deviation of each day's leg count from the average — the tie-break of
            last resort, so a matrix with no usable times still spreads legs evenly.
       It is pure, synchronous and deterministic (ties resolve to the earliest split
       point, scanning in a fixed order). */

    /* Lexicographic (over cap, time imbalance, leg-count imbalance). */
    function compareSplitCost(aOver, aDev, aLen, bOver, bDev, bLen) {
        if (aOver < bOver - 1e-6) return -1;
        if (aOver > bOver + 1e-6) return 1;
        if (aDev < bDev - 1e-6) return -1;
        if (aDev > bDev + 1e-6) return 1;
        if (aLen < bLen - 1e-9) return -1;
        if (aLen > bLen + 1e-9) return 1;
        return 0;
    }

    /* Linear cap-first fallback for leg counts far beyond anything a trip planner sees.
       Fills each day up to the cap while reserving one leg per remaining day, which still
       finds a feasible split whenever one exists — it just balances worse than the DP. */
    function greedyCapSplit(legs, dayCount, capMin) {
        const chunks = [];
        const total = legs.length;
        let pos = 0;
        for (let d = 0; d < dayCount; d++) {
            const remainingDays = dayCount - d;
            const maxTake = (total - pos) - (remainingDays - 1);
            let take = 1;
            let accum = legs[pos].min;
            while (take < maxTake && accum + legs[pos + take].min <= capMin + EPS) {
                accum += legs[pos + take].min;
                take++;
            }
            chunks.push(legs.slice(pos, pos + take));
            pos += take;
        }
        return chunks;
    }

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

        // R6 — more legs than days: every day holds >= 1 leg. Exact DP, cap first.
        if (dayCount * total * total > MAX_SPLIT_DP_WORK) {
            return greedyCapSplit(legs, dayCount, capMin);
        }

        const prefix = new Float64Array(total + 1);
        for (let i = 0; i < total; i++) {
            prefix[i + 1] = prefix[i] + (isFiniteNumber(legs[i].min) ? legs[i].min : 0);
        }
        const targetMin = prefix[total] / dayCount;
        const targetLen = total / dayCount;

        const width = total + 1;
        const size = (dayCount + 1) * width;
        const over = new Float64Array(size).fill(Infinity);
        const dev = new Float64Array(size).fill(Infinity);
        const lenDev = new Float64Array(size).fill(Infinity);
        const back = new Int32Array(size).fill(-1);
        over[0] = 0;
        dev[0] = 0;
        lenDev[0] = 0;

        for (d = 1; d <= dayCount; d++) {
            const rowBase = d * width;
            const prevBase = (d - 1) * width;
            const maxPos = total - (dayCount - d);      // leave >= 1 leg per remaining day
            for (let pos = d; pos <= maxPos; pos++) {
                const here = rowBase + pos;
                for (let prev = d - 1; prev < pos; prev++) {
                    const from = prevBase + prev;
                    if (!isFinite(over[from])) continue;
                    const sum = prefix[pos] - prefix[prev];
                    const dMin = sum - targetMin;
                    const dLen = (pos - prev) - targetLen;
                    const cOver = over[from] + (sum > capMin ? sum - capMin : 0);
                    const cDev = dev[from] + dMin * dMin;
                    const cLen = lenDev[from] + dLen * dLen;
                    if (back[here] === -1 ||
                        compareSplitCost(cOver, cDev, cLen, over[here], dev[here], lenDev[here]) < 0) {
                        over[here] = cOver;
                        dev[here] = cDev;
                        lenDev[here] = cLen;
                        back[here] = prev;
                    }
                }
            }
        }

        if (back[dayCount * width + total] === -1) {
            return greedyCapSplit(legs, dayCount, capMin);   // unreachable, kept honest
        }
        let pos = total;
        for (d = dayCount; d >= 1; d--) {
            const prev = back[d * width + pos];
            chunks.push(legs.slice(prev, pos));
            pos = prev;
        }
        chunks.reverse();
        return chunks;
    }

    /* ── Empty plan (no usable places at all) ── */
    function emptyPlan(dayCount, warnings) {
        const days = [];
        for (let d = 0; d < dayCount; d++) {
            // R5 — an empty day is always an explicitly flagged rest day, never a silent gap.
            warnings.push('rest-day: day ' + (d + 1) + ' has no driving — there is nothing to ' +
                'plan (no usable places were supplied).');
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
        const nRaw = rawStops.length;
        let start = isPlaceLike(inp.start) ? inp.start : null;
        let end = isPlaceLike(inp.end) ? inp.end : null;
        const hadStart = !!start;
        const hadEnd = !!end;
        let promoted = null;        // where the origin came from: 'end' | 'stop' | null
        let promotedIndex = -1;

        if (!start && end) {
            warnings.push('missing-start: no usable start point, using the end point as origin.');
            start = end;
            end = null;
            promoted = 'end';
        }
        if (!start) {
            /* No start and no end: promote the first usable destination to origin rather
               than throwing every typed destination away (B1). */
            for (let i = 0; i < nRaw; i++) {
                if (isPlaceLike(rawStops[i])) { promotedIndex = i; break; }
            }
            if (promotedIndex === -1) {
                warnings.push('no-places: no usable start point, end point or destination was supplied.');
                return emptyPlan(dayCount, warnings);
            }
            start = rawStops[promotedIndex];
            promoted = 'stop';
            warnings.push('missing-start: no start or end point supplied, starting from "' +
                (start.name || '?') + '".');
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
        /* Matrix.source describes the WHOLE matrix: 'osrm' only when every off-diagonal
           cell came from the road graph. Anything else is degraded data and the user must
           be told — a 'mixed' matrix can hide a straight line drawn across open sea.

           The label is the provider's claim; osrmCells/filledCells are the evidence. They
           are part of the same contract, so when they contradict each other the counters
           win and the contradiction is reported. A matrix labelled 'osrm' while carrying
           filledCells > 0 is exactly how a guessed matrix once passed as clean road data
           and suppressed this warning — the label alone is not enough.

           The counters OVERLAP and are not a partition. A cell carries two values, km and
           min, which can have different provenance: OSRM's default /table reply annotates
           durations only, and a distances-only reply is equally possible, so such a cell
           is half real and half estimated and is counted in both. osrmCells + filledCells
           may therefore exceed the off-diagonal count and must never be used as a
           consistency test — doing so raised a false alarm on the commonest real OSRM
           reply. The two laws that do hold are:
               filledCells === 0  <=>  source === 'osrm'
               osrmCells   === 0  <=>  source === 'haversine'
           plus the range 0 <= counter <= off-diagonal. Only those are checked. */
        /* A 1x1 matrix has no off-diagonal cell, so there is no distance to characterise
           and nothing the counters could describe. Saying anything here is a false alarm. */
        if (matrix && dim > 1) {
            const src = matrix.source;
            const offDiagonal = dim * (dim - 1);
            const known = (src === 'osrm' || src === 'mixed' || src === 'haversine');
            const hasOsrm = Number.isInteger(matrix.osrmCells);
            const hasFilled = Number.isInteger(matrix.filledCells);
            const osrmCells = hasOsrm ? matrix.osrmCells : null;
            const filled = hasFilled ? matrix.filledCells : null;

            function inRange(v) {
                return v !== null && v >= 0 && v <= offDiagonal;
            }
            /* Present but not a whole number, negative, or larger than the matrix. */
            const outOfRange =
                (matrix.osrmCells !== undefined && (!hasOsrm || !inRange(osrmCells))) ||
                (matrix.filledCells !== undefined && (!hasFilled || !inRange(filled)));
            /* Every off-diagonal cell holds a km and a min, so every cell must be counted
               by at least one counter. Both zero on a non-trivial matrix is impossible. */
            const accountsForNothing =
                inRange(osrmCells) && inRange(filled) && offDiagonal > 0 &&
                osrmCells === 0 && filled === 0;
            const countersBroken = outOfRange || accountsForNothing;

            /* What the counters, on their own, say the matrix is — by the two laws only.
               A single counter is decisive only when it is zero; a non-zero one merely
               refutes one of the three labels, which is not enough to name the source. */
            let counted = null;
            if (!countersBroken) {
                if (inRange(osrmCells) && inRange(filled)) {
                    if (filled === 0) counted = 'osrm';
                    else if (osrmCells === 0) counted = 'haversine';
                    else counted = 'mixed';
                } else if (inRange(filled) && filled === 0) counted = 'osrm';
                else if (inRange(osrmCells) && osrmCells === 0) counted = 'haversine';
            }

            /* Cells whose km AND min are both estimates, versus cells that mix the two.
               |A n B| = |A| + |B| - offDiagonal, so entirely-estimated = offDiagonal - A
               and part-estimated = A + B - offDiagonal. No extra counter is needed. */
            let whollyEstimated = null;
            let partlyEstimated = null;
            if (inRange(osrmCells) && inRange(filled) && !countersBroken) {
                whollyEstimated = offDiagonal - osrmCells;
                partlyEstimated = Math.max(0, osrmCells + filled - offDiagonal);
            }

            if (countersBroken) {
                warnings.push('distance-source: the matrix counters (osrmCells ' +
                    String(matrix.osrmCells) + ', filledCells ' + String(matrix.filledCells) +
                    ') ' + (outOfRange
                        ? 'are not whole cell counts between 0 and ' + offDiagonal
                        : 'account for none of the ' + offDiagonal + ' off-diagonal cells') +
                    ', so the provenance of these distances cannot be confirmed.');
            } else if (counted && known && counted !== src) {
                warnings.push('distance-source: the matrix is labelled "' + src + '" but its ' +
                    'own counters say "' + counted + '" (' +
                    (osrmCells === null ? '?' : osrmCells) + ' road cells, ' +
                    (filled === null ? '?' : filled) + ' straight-line fills of ' + offDiagonal +
                    '); trusting the counters, not the label.');
            }

            /* Report on the evidence when there is any, otherwise on the label. */
            const effective = countersBroken ? src : (counted || src);
            if (effective === 'haversine') {
                warnings.push('distance-source: no road data at all — every distance is a ' +
                    'straight-line estimate, not a driving distance.');
            } else if (effective === 'mixed') {
                /* "N of M cells are straight-line estimates" overstates the damage when
                   those cells still carry a real road distance and only the duration was
                   estimated (or the reverse) — the commonest OSRM reply of all. Say which
                   cells are entirely guessed and which merely mix the two. */
                let detail;
                if (whollyEstimated === null) {
                    detail = 'some legs are straight-line estimates';
                } else if (partlyEstimated > 0 && whollyEstimated > 0) {
                    detail = whollyEstimated + ' of ' + offDiagonal + ' matrix cells are ' +
                        'straight-line estimates and ' + partlyEstimated + ' more carry a real ' +
                        'road value with an estimated one alongside it';
                } else if (partlyEstimated > 0) {
                    detail = partlyEstimated + ' of ' + offDiagonal + ' matrix cells carry a ' +
                        'real road value with an estimated one alongside it (the routing ' +
                        'service returned distances or durations, not both)';
                } else {
                    detail = whollyEstimated + ' of ' + offDiagonal + ' matrix cells are ' +
                        'straight-line estimates (unroutable pairs such as islands or ferries)';
                }
                warnings.push('distance-source: partial road data — ' + detail +
                    ', not measured driving data.');
            } else if (effective !== 'osrm') {
                warnings.push('distance-source: unknown matrix source "' + String(src) +
                    '"; the distances cannot be confirmed as road data.');
            }
            /* An unusable label is worth saying even when the counters rescue the verdict. */
            if (!known && counted && !countersBroken) {
                warnings.push('distance-source: unknown matrix source "' + String(src) +
                    '"; the distances cannot be confirmed as road data.');
            }
        }

        let layout = 'none';
        if (dim === nRaw + 2 && hadStart) layout = 'full';                                  // [start, ...stops, end]
        else if (dim === nRaw + 1 && hadStart && (roundTrip || !hadEnd)) layout = 'loop';   // [start, ...stops]
        else if (dim === nRaw + 1 && !hadStart && hadEnd) layout = 'no-start';              // [...stops, end]
        else if (dim === nRaw && nRaw > 0 && !hadStart && !hadEnd) layout = 'stops-only';   // [...stops]
        if (dim && layout === 'none') {
            warnings.push('matrix-size-mismatch: matrix is ' + dim + '×' + dim + ' but ' +
                (nRaw + (hadStart ? 1 : 0) + (hadEnd ? 1 : 0)) +
                ' places were supplied; distances are estimated from coordinates.');
        }

        function stopMatrixIndex(i) {
            return (layout === 'no-start' || layout === 'stops-only') ? i : i + 1;
        }

        function endMatrixIndex() {
            if (layout === 'loop') return 0;
            if (layout === 'no-start') return nRaw;
            return nRaw + 1;
        }

        function indexFor(place, kind, pos) {
            if (place && Number.isInteger(place.matrixIndex) &&
                place.matrixIndex >= 0 && place.matrixIndex < dim) {
                return place.matrixIndex;
            }
            if (layout === 'none') return -1;
            if (kind === 'start') {
                if (promoted === 'end') return endMatrixIndex();
                if (promoted === 'stop') return stopMatrixIndex(promotedIndex);
                return 0;
            }
            if (kind === 'end') return endMatrixIndex();
            return stopMatrixIndex(pos);
        }

        const startNode = { place: start, mi: indexFor(start, 'start') };
        const endNode = end ? { place: end, mi: indexFor(end, 'end') } : null;

        /* R1 — every destination appears exactly once. Entries that duplicate the start,
           the end, or an earlier stop (by normalised name) are dropped and reported. */
        const stopNodes = [];
        /* A Map, never a plain object: destination names such as "constructor",
           "toString" or "__proto__" would otherwise hit Object.prototype and be dropped
           as phantom duplicates. */
        const seen = new Map();
        for (let i = 0; i < nRaw; i++) {
            if (i === promotedIndex) continue;      // already promoted to origin
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
            if (key && seen.has(key)) {
                warnings.push('duplicate-stop-removed: "' + p.name + '" is listed more than once.');
                continue;
            }
            if (key) seen.set(key, true);
            stopNodes.push({ place: p, mi: indexFor(p, 'stop', i) });
        }

        const allNodes = [startNode].concat(stopNodes);
        if (endNode) allNodes.push(endNode);
        for (let i = 0; i < allNodes.length; i++) {
            if (allNodes[i].place && allNodes[i].place.resolved === false) {
                warnings.push('unresolved-place: "' + (allNodes[i].place.name || '?') +
                    '" could not be geocoded; its distances are approximate.');
            }
        }

        const cost = buildCostFn(matrix, dim, warnings,
            { fellBack: false, unknown: false, negative: false });

        /* R2 — nearest neighbour from the start, end pinned last, then 2-opt + or-opt. */
        let seq;
        if (stopNodes.length === 0) {
            seq = endNode ? [startNode, endNode] : [startNode];
        } else {
            const ordered = nearestNeighbourOrder(startNode, stopNodes, cost);
            seq = [startNode].concat(ordered);
            if (endNode) seq.push(endNode);
            if (stopNodes.length > MAX_TWO_OPT_STOPS) {
                warnings.push('optimisation-limited: ' + stopNodes.length + ' stops exceed the ' +
                    MAX_TWO_OPT_STOPS + '-stop optimisation limit; nearest-neighbour order kept.');
            } else {
                seq = improveSequence(seq, cost, !!endNode);
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

        /* A multi-stop itinerary that computes to 0 km is never a real answer — it means
           the coordinates or the matrix were unusable. Never present it silently. */
        if (legs.length > 0 && totalKm <= EPS && totalMin <= EPS) {
            warnings.push('zero-distance: the whole itinerary computes to 0 km — the ' +
                'coordinates or the distance matrix are unusable, so the numbers below ' +
                'are not real.');
        }

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
