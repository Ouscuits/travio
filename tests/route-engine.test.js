/* ── Tests for js/route-engine.js ──
   Node built-in runner, no dependencies:  node --test tests/
   Every test name states the contract rule (R1..R8) or quality-bar criterion it covers. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const engine = require(path.join(__dirname, '..', 'js', 'route-engine.js'));
const planRoute = engine.planRoute;

/* ── Fixtures ── */
function P(name, lat, lon, extra) {
    const p = { name: name, lat: lat, lon: lon, resolved: true, source: 'osm' };
    if (extra) for (const k in extra) p[k] = extra[k];
    return p;
}

const MADRID      = P('Madrid', 40.4168, -3.7038);
const BARCELONA   = P('Barcelona', 41.3851, 2.1734);
const ZARAGOZA    = P('Zaragoza', 41.6488, -0.8891);
const VALENCIA    = P('Valencia', 39.4699, -0.3763);
const TARRAGONA   = P('Tarragona', 41.1189, 1.2445);
const TERUEL      = P('Teruel', 40.3456, -1.1065);
const CUENCA      = P('Cuenca', 40.0704, -2.1374);
const TOLEDO      = P('Toledo', 39.8628, -4.0273);
const SEGOVIA     = P('Segovia', 40.9429, -4.1088);
const SALAMANCA   = P('Salamanca', 40.9701, -5.6635);
const GUADALAJARA = P('Guadalajara', 40.6286, -3.1615);
const LLEIDA      = P('Lleida', 41.6176, 0.6200);
const GETAFE      = P('Getafe', 40.3082, -3.7325);          // ~12 km from Madrid centre
const ATOCHA      = P('Madrid Atocha', 40.4069, -3.6907);   // ~1.6 km from Madrid centre

const FOUR_STOPS = [ZARAGOZA, VALENCIA, TERUEL, TARRAGONA];
const EIGHT_STOPS = [ZARAGOZA, VALENCIA, TERUEL, TARRAGONA, CUENCA, TOLEDO, SEGOVIA, LLEIDA];

/* ── Helpers ── */
function placesOf(start, end, stops) {
    const list = [start].concat(stops);
    if (end) list.push(end);
    return list;
}

/* Builds the haversine fallback matrix in the positional convention the engine expects
   ([start, ...stops, end]) and plans. */
function plan(start, end, stops, days, opts) {
    const matrix = engine.haversineMatrix(placesOf(start, end, stops));
    const input = { start: start, end: end, stops: stops, matrix: matrix, days: days };
    if (opts) for (const k in opts) input[k] = opts[k];
    return planRoute(input);
}

function nameCount(places, name) {
    const target = engine.normaliseName(name);
    let n = 0;
    for (let i = 0; i < places.length; i++) {
        if (places[i] && engine.normaliseName(places[i].name) === target) n++;
    }
    return n;
}

function names(places) {
    return places.map(function (p) { return p ? p.name : null; });
}

function pathMinutes(matrix, indices) {
    let total = 0;
    for (let i = 0; i < indices.length - 1; i++) total += matrix.min[indices[i]][indices[i + 1]];
    return total;
}

function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        const sub = permutations(rest);
        for (let j = 0; j < sub.length; j++) out.push([arr[i]].concat(sub[j]));
    }
    return out;
}

/* R7 — legs sum to day totals, day totals sum to trip totals (tolerance 0.01). */
function assertSumsConsistent(p, label) {
    let sumDayKm = 0;
    let sumDayMin = 0;
    for (let d = 0; d < p.days.length; d++) {
        const day = p.days[d];
        let legKm = 0;
        let legMin = 0;
        for (let l = 0; l < day.legs.length; l++) {
            legKm += day.legs[l].km;
            legMin += day.legs[l].min;
            assert.ok(isFinite(day.legs[l].km) && isFinite(day.legs[l].min),
                label + ': leg carries a non-finite value');
        }
        assert.ok(Math.abs(legKm - day.km) <= 0.01,
            label + ': R7 day ' + day.day + ' km ' + day.km + ' != legs ' + legKm);
        assert.ok(Math.abs(legMin - day.driveMin) <= 0.01,
            label + ': R7 day ' + day.day + ' min ' + day.driveMin + ' != legs ' + legMin);
        sumDayKm += day.km;
        sumDayMin += day.driveMin;
    }
    assert.ok(Math.abs(sumDayKm - p.totalKm) <= 0.01,
        label + ': R7 totalKm ' + p.totalKm + ' != sum of days ' + sumDayKm);
    assert.ok(Math.abs(sumDayMin - p.totalMin) <= 0.01,
        label + ': R7 totalMin ' + p.totalMin + ' != sum of days ' + sumDayMin);
}

/* R4 — the day chain must be continuous and cover the whole order exactly once. */
function assertDayChain(p, label) {
    const chain = [];
    for (let d = 0; d < p.days.length; d++) {
        const day = p.days[d];
        if (d > 0) {
            assert.strictEqual(day.startPlace, p.days[d - 1].endPlace,
                label + ': R4 day ' + day.day + ' does not start where day ' + d + ' ended');
        }
        for (let l = 0; l < day.legs.length; l++) {
            assert.strictEqual(day.legs[l].from, d === 0 && l === 0 ? p.order[0] : chain[chain.length - 1],
                label + ': R4 leg chain is broken on day ' + day.day);
            chain.push(day.legs[l].to);
        }
        assert.strictEqual(day.endPlace, chain.length ? chain[chain.length - 1] : p.order[0],
            label + ': R4 day ' + day.day + ' endPlace is not the last place reached');
    }
    assert.deepStrictEqual(names([p.order[0]].concat(chain)), names(p.order),
        label + ': R4 the day-by-day chain does not reproduce the order');
}

/* ─────────────────────────────────────────────────────────────────────────── */

test('R1: every destination appears exactly once, start first and end last', function () {
    const p = plan(MADRID, BARCELONA, FOUR_STOPS, 5);
    assert.strictEqual(p.order.length, 6, 'start + 4 stops + end');
    assert.strictEqual(p.order[0], MADRID);
    assert.strictEqual(p.order[p.order.length - 1], BARCELONA);
    FOUR_STOPS.forEach(function (s) {
        assert.strictEqual(nameCount(p.order, s.name), 1, 'R1: ' + s.name + ' must appear once');
    });
});

test('R3: one-way trip never returns to the origin (Madrid -> Barcelona, 4 stops, 5 days)', function () {
    const p = plan(MADRID, BARCELONA, FOUR_STOPS, 5);
    assert.strictEqual(p.roundTrip, false, 'R3: Madrid -> Barcelona is not a round trip');
    assert.strictEqual(nameCount(p.order, 'Madrid'), 1, 'R3: the origin must appear exactly once');
    assert.strictEqual(engine.normaliseName(p.order[0].name), 'madrid', 'R3: origin at index 0');
    assert.strictEqual(p.order[p.order.length - 1].name, 'Barcelona', 'R3: the trip ends at the end point');
    // The origin must not resurface inside any day either.
    let seen = 0;
    p.days.forEach(function (d) { seen += nameCount(d.stops, 'Madrid'); });
    assert.strictEqual(seen, 0, 'R3: Madrid must never be an arrival stop on a one-way trip');
    assert.strictEqual(p.days.length, 5, 'R4: five days requested');
});

test('R3: round trip returns to the origin exactly twice, first and last', function () {
    const MADRID_END = P('Madrid', 40.4168, -3.7038);
    const p = plan(MADRID, MADRID_END, [TOLEDO, SEGOVIA, SALAMANCA], 4);
    assert.strictEqual(p.roundTrip, true, 'R3: identical name means round trip');
    assert.strictEqual(nameCount(p.order, 'Madrid'), 2, 'R3: origin appears exactly twice');
    assert.strictEqual(engine.normaliseName(p.order[0].name), 'madrid');
    assert.strictEqual(engine.normaliseName(p.order[p.order.length - 1].name), 'madrid');
    assert.strictEqual(p.order.length, 5, 'R1: start + 3 stops + return');
    assertDayChain(p, 'round trip');
    assertSumsConsistent(p, 'round trip');
});

test('R3: an end point within 5 km of the start under another name is a round trip', function () {
    const p = plan(MADRID, ATOCHA, [TOLEDO, SEGOVIA], 3);
    assert.strictEqual(p.roundTrip, true, 'R3: Madrid Atocha is ~1.6 km from Madrid');
    assert.strictEqual(p.order[p.order.length - 1], ATOCHA);
});

test('R3: a distinct end point more than 5 km away is NOT a round trip', function () {
    const p = plan(MADRID, GETAFE, [TOLEDO, SEGOVIA], 3);
    assert.strictEqual(p.roundTrip, false, 'R3: Getafe is ~12 km away, this is a one-way trip');
    assert.strictEqual(nameCount(p.order, 'Madrid'), 1, 'R3: origin appears once');
    assert.strictEqual(p.order[p.order.length - 1], GETAFE);
});

test('R2: the stop order is computed, not the order the user typed', function () {
    // Collinear points along the equator; the typed order is deliberately scrambled.
    const S  = P('S', 0, 0);
    const E  = P('E', 0, 5);
    const p1 = P('P3', 0, 3);
    const p2 = P('P1', 0, 1);
    const p3 = P('P4', 0, 4);
    const p4 = P('P2', 0, 2);
    const stops = [p1, p2, p3, p4];
    const p = plan(S, E, stops, 3);

    assert.deepStrictEqual(names(p.order), ['S', 'P1', 'P2', 'P3', 'P4', 'E'],
        'R2: stops must be resequenced west to east');

    const matrix = engine.haversineMatrix(placesOf(S, E, stops));
    const typedOrder = pathMinutes(matrix, [0, 1, 2, 3, 4, 5]);
    assert.ok(p.totalMin < typedOrder - 0.01,
        'R2: the computed order must beat the typed order (' + p.totalMin + ' vs ' + typedOrder + ')');
});

test('R2: the computed order is optimal for a 4-stop trip (brute-force check)', function () {
    const p = plan(MADRID, BARCELONA, FOUR_STOPS, 5);
    const matrix = engine.haversineMatrix(placesOf(MADRID, BARCELONA, FOUR_STOPS));
    const perms = permutations([1, 2, 3, 4]);
    let best = Infinity;
    for (let i = 0; i < perms.length; i++) {
        best = Math.min(best, pathMinutes(matrix, [0].concat(perms[i]).concat([5])));
    }
    assert.ok(p.totalMin <= best + 0.01,
        'R2: nearest-neighbour + 2-opt must reach the optimum (' + p.totalMin + ' vs ' + best + ')');
});

test('R2: planning is deterministic — identical input, identical plan', function () {
    const a = plan(MADRID, BARCELONA, EIGHT_STOPS, 4);
    const b = plan(MADRID, BARCELONA, EIGHT_STOPS, 4);
    assert.deepStrictEqual(names(a.order), names(b.order), 'R2: same order');
    assert.strictEqual(a.totalKm, b.totalKm);
    assert.strictEqual(a.totalMin, b.totalMin);
    assert.deepStrictEqual(a.warnings, b.warnings);
    assert.deepStrictEqual(a.days.map(function (d) { return d.driveMin; }),
        b.days.map(function (d) { return d.driveMin; }), 'R2: same day split');
});

test('R4: days.length always equals input.days (sweep 1..12)', function () {
    for (let d = 1; d <= 12; d++) {
        const p = plan(MADRID, BARCELONA, FOUR_STOPS, d);
        assert.strictEqual(p.days.length, d, 'R4: ' + d + ' days requested');
        for (let i = 0; i < p.days.length; i++) {
            assert.strictEqual(p.days[i].day, i + 1, 'R4: day numbers are 1-based and contiguous');
        }
        assertDayChain(p, d + ' days');
        assertSumsConsistent(p, d + ' days');
    }
});

test('R4: stops are distributed by drive time, not by stops/days division', function () {
    // One very long leg then three short ones. Naive 3-stops-over-2-days would put two
    // stops on day 1; a time-based split must isolate the long haul.
    const S = P('S', 0, 0);
    const A = P('A', 0, 5.0);
    const B = P('B', 0, 5.1);
    const C = P('C', 0, 5.2);
    const E = P('E', 0, 5.3);
    const p = plan(S, E, [A, B, C], 2, { maxDriveMinPerDay: 600 });

    assert.deepStrictEqual(names(p.order), ['S', 'A', 'B', 'C', 'E']);
    assert.strictEqual(p.days.length, 2);
    assert.strictEqual(p.days[0].stops.length, 1, 'R4: day 1 is the single long haul');
    assert.strictEqual(p.days[1].stops.length, 3, 'R4: day 2 mops up the three short legs');
    assert.strictEqual(p.days[1].startPlace, A, 'R4: day 2 starts at the overnight place');
    assert.ok(p.days[1].stops.indexOf(A) === -1, 'R4: the overnight place is not re-counted as a stop');
    assertSumsConsistent(p, 'time-based split');
});

test('R5: 2 stops over 7 days gives 7 days with flagged rest days and no lopsided day', function () {
    const p = plan(MADRID, BARCELONA, [ZARAGOZA, LLEIDA], 7);
    assert.strictEqual(p.days.length, 7, 'R5: never drop days');

    const empty = p.days.filter(function (d) { return d.stops.length === 0; });
    const maxStops = Math.max.apply(null, p.days.map(function (d) { return d.stops.length; }));
    assert.ok(empty.length > 0, 'R5: with 3 legs over 7 days there must be rest days');
    assert.ok(maxStops <= 1, 'R5: no day may hold 2+ stops while another day is empty');

    const restWarnings = p.warnings.filter(function (w) { return w.indexOf('rest-day:') === 0; });
    assert.strictEqual(restWarnings.length, empty.length, 'R5: every rest day is flagged in warnings');

    // Rest days sit at the previous night's place and drive nothing.
    p.days.forEach(function (d) {
        if (d.stops.length === 0) {
            assert.strictEqual(d.driveMin, 0);
            assert.strictEqual(d.km, 0);
            assert.strictEqual(d.startPlace, d.endPlace, 'R5: a rest day stays put');
        }
    });
    assertDayChain(p, 'rest days');
    assertSumsConsistent(p, 'rest days');
});

test('R5: 0 stops over 4 days still produces 4 days, one drive and three rest days', function () {
    const p = plan(MADRID, BARCELONA, [], 4);
    assert.strictEqual(p.days.length, 4);
    assert.strictEqual(p.order.length, 2, 'R1: start then end');
    const driving = p.days.filter(function (d) { return d.legs.length > 0; });
    assert.strictEqual(driving.length, 1, 'R5: exactly one driving day');
    assert.strictEqual(p.warnings.filter(function (w) { return w.indexOf('rest-day:') === 0; }).length, 3);
    assertDayChain(p, 'no stops');
});

test('R6: 8 stops over 2 days flags overDriveCap and warns instead of hiding it', function () {
    const p = plan(MADRID, BARCELONA, EIGHT_STOPS, 2);
    assert.strictEqual(p.days.length, 2, 'R4: two days');
    assert.strictEqual(p.order.length, 10, 'R1: start + 8 stops + end');

    const over = p.days.filter(function (d) { return d.overDriveCap; });
    assert.ok(over.length >= 1, 'R6: at least one day must exceed the 360 min cap');
    over.forEach(function (d) {
        assert.ok(d.driveMin > engine.DEFAULT_MAX_DRIVE_MIN,
            'R6: overDriveCap must only be set on days above the cap');
    });
    const capWarnings = p.warnings.filter(function (w) { return w.indexOf('over-drive-cap:') === 0; });
    assert.strictEqual(capWarnings.length, over.length, 'R6: one warning per over-cap day');

    // The impossible cap must not make the engine dump everything on the last day.
    assert.ok(p.days[0].driveMin > p.totalMin * 0.25,
        'R6: when the cap cannot be met the load must still be balanced');
    p.days.forEach(function (d) {
        assert.ok(d.stops.length >= 1, 'R5: no empty day when there are more stops than days');
    });
    assertDayChain(p, '8 stops 2 days');
    assertSumsConsistent(p, '8 stops 2 days');
});

test('R6: a feasible custom maxDriveMinPerDay is respected on every day', function () {
    // Six evenly spaced stops (~55 min per leg) over 4 days with a 240 min cap: feasible.
    const stops = [];
    for (let i = 1; i <= 6; i++) stops.push(P('K' + i, 0, i * 0.5));
    const S = P('S', 0, 0);
    const E = P('E', 0, 3.5);
    const p = plan(S, E, stops, 4, { maxDriveMinPerDay: 240 });

    assert.strictEqual(p.days.length, 4);
    p.days.forEach(function (d) {
        assert.strictEqual(d.overDriveCap, false, 'R6: day ' + d.day + ' drives ' + d.driveMin + ' min');
        assert.ok(d.driveMin <= 240 + 0.01, 'R6: cap honoured when the schedule allows it');
    });
    assert.strictEqual(p.warnings.filter(function (w) { return w.indexOf('over-drive-cap:') === 0; }).length, 0);
    assertSumsConsistent(p, 'feasible cap');
});

test('R7: totals equal the sum of days which equal the sum of legs (float tolerance 0.01)', function () {
    const cases = [
        plan(MADRID, BARCELONA, FOUR_STOPS, 5),
        plan(MADRID, BARCELONA, EIGHT_STOPS, 3),
        plan(MADRID, P('Madrid', 40.4168, -3.7038), [TOLEDO, CUENCA, GUADALAJARA], 6),
        plan(MADRID, BARCELONA, [], 1),
        plan(MADRID, null, [TOLEDO, SEGOVIA], 3)
    ];
    cases.forEach(function (p, i) {
        assertSumsConsistent(p, 'case ' + i);
        assert.ok(isFinite(p.totalKm) && isFinite(p.totalMin), 'R7: totals must be finite');
        assert.ok(p.totalKm >= 0 && p.totalMin >= 0, 'R7: totals must not be negative');
    });
});

test('R1: duplicate destination names are kept exactly once and reported', function () {
    const stops = [
        TOLEDO,
        P('toledo', 39.8628, -4.0273),
        P('  TOLEDO  ', 39.8628, -4.0273),
        SEGOVIA
    ];
    const p = plan(MADRID, BARCELONA, stops, 4);
    assert.strictEqual(nameCount(p.order, 'Toledo'), 1, 'R1: Toledo appears exactly once');
    assert.strictEqual(nameCount(p.order, 'Segovia'), 1);
    assert.strictEqual(p.order.length, 4, 'R1: start + 2 unique stops + end');
    const dupes = p.warnings.filter(function (w) { return w.indexOf('duplicate-stop-removed:') === 0; });
    assert.strictEqual(dupes.length, 2, 'R1: both duplicates reported, never silently dropped');
    assertDayChain(p, 'duplicates');
});

test('R1/R3: a destination equal to the start or the end point is not repeated', function () {
    const stops = [P('Madrid', 40.4168, -3.7038), ZARAGOZA, P('Barcelona', 41.3851, 2.1734)];
    const p = plan(MADRID, BARCELONA, stops, 3);
    assert.strictEqual(nameCount(p.order, 'Madrid'), 1, 'R3: origin still appears once only');
    assert.strictEqual(nameCount(p.order, 'Barcelona'), 1, 'R1: the end point is not duplicated');
    assert.deepStrictEqual(names(p.order), ['Madrid', 'Zaragoza', 'Barcelona']);
    assert.strictEqual(p.warnings.filter(function (w) {
        return w.indexOf('duplicate-stop-removed:') === 0;
    }).length, 2);
});

test('B5/R8: a haversine fallback matrix yields finite, non-zero, flagged distances', function () {
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);
    const matrix = engine.haversineMatrix(places);
    assert.strictEqual(matrix.source, 'haversine');
    assert.strictEqual(matrix.km.length, places.length);
    for (let i = 0; i < places.length; i++) {
        assert.strictEqual(matrix.km[i][i], 0, 'zero diagonal');
        for (let j = 0; j < places.length; j++) {
            assert.ok(isFinite(matrix.km[i][j]) && isFinite(matrix.min[i][j]), 'no NaN/Infinity cells');
            assert.ok(Math.abs(matrix.km[i][j] - matrix.km[j][i]) <= 0.01, 'symmetric');
        }
    }
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: matrix, days: 4 });
    assert.ok(p.totalKm > 500, 'B5: real distances are produced from the fallback');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('distance-source:') === 0; }),
        'B5: the fallback is stated, not hidden');
    assertSumsConsistent(p, 'haversine fallback');
});

test('R8: a loop-shaped matrix ([start, ...stops]) is still index-aligned', function () {
    const stops = [TOLEDO, SEGOVIA, SALAMANCA];
    const loopMatrix = engine.haversineMatrix([MADRID].concat(stops));   // no end column
    const fullMatrix = engine.haversineMatrix([MADRID].concat(stops).concat([MADRID]));
    const a = planRoute({ start: MADRID, end: P('Madrid', 40.4168, -3.7038), stops: stops, matrix: loopMatrix, days: 3 });
    const b = planRoute({ start: MADRID, end: P('Madrid', 40.4168, -3.7038), stops: stops, matrix: fullMatrix, days: 3 });
    assert.strictEqual(a.roundTrip, true);
    assert.deepStrictEqual(names(a.order), names(b.order), 'R8: both matrix shapes plan the same route');
    assert.ok(Math.abs(a.totalKm - b.totalKm) <= 0.01, 'R8: and produce the same distance');
    assert.ok(a.totalKm > 0, 'R8: the closing leg back to Madrid is counted');
    assert.ok(!a.warnings.some(function (w) { return w.indexOf('matrix-size-mismatch:') === 0; }));
});

test('R8: a wrongly sized matrix falls back to coordinates instead of throwing', function () {
    const bogus = { km: [[0, 1], [1, 0]], min: [[0, 1], [1, 0]], source: 'osrm' };
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: bogus, days: 3 });
    assert.strictEqual(p.days.length, 3);
    assert.ok(p.warnings.some(function (w) { return w.indexOf('matrix-size-mismatch:') === 0; }),
        'R8: the mismatch is reported');
    assert.ok(p.totalKm > 500, 'R8: coordinates rescue the plan');
    assertSumsConsistent(p, 'bad matrix');
});

test('R8: unresolved places never throw and never poison the numbers', function () {
    const ghost = { name: 'Nowhere-in-particular', lat: null, lon: null, resolved: false, source: 'ai' };
    const p = plan(MADRID, BARCELONA, [ZARAGOZA, ghost], 3);
    assert.strictEqual(p.days.length, 3);
    assert.strictEqual(nameCount(p.order, ghost.name), 1, 'R1: the unresolved stop is kept, not dropped');
    assert.ok(isFinite(p.totalKm) && isFinite(p.totalMin));
    assert.ok(p.warnings.some(function (w) { return w.indexOf('unresolved-place:') === 0; }),
        'R8: the unresolved place is reported');
    p.days.forEach(function (d) {
        d.legs.forEach(function (l) {
            assert.ok(isFinite(l.km) && isFinite(l.min) && l.km >= 0, 'R8: no NaN leg');
        });
    });
    assertSumsConsistent(p, 'unresolved place');
});

test('R8: degenerate inputs return a usable plan and never throw', function () {
    const cases = [
        { label: 'no stops, 1 day', input: { start: MADRID, end: BARCELONA, stops: [], days: 1 } },
        { label: 'days far above stops', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 12 } },
        { label: 'zero days', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 0 } },
        { label: 'negative days', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: -4 } },
        { label: 'NaN days', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: NaN } },
        { label: 'fractional days', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 3.7 } },
        { label: 'no matrix', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 2 } },
        { label: 'junk stops', input: { start: MADRID, end: BARCELONA, stops: [null, 42, {}, ZARAGOZA], days: 2 } },
        { label: 'stops not an array', input: { start: MADRID, end: BARCELONA, stops: 'Zaragoza', days: 2 } },
        { label: 'round trip, no stops', input: { start: MADRID, end: P('Madrid', 40.4168, -3.7038), stops: [], days: 3 } },
        { label: 'no end point', input: { start: MADRID, stops: [ZARAGOZA, LLEIDA], days: 2 } },
        { label: 'no start point', input: { end: BARCELONA, stops: [ZARAGOZA], days: 2 } },
        { label: 'no places at all', input: { stops: [], days: 2 } },
        { label: 'empty object', input: {} },
        { label: 'undefined', input: undefined },
        { label: 'null', input: null },
        { label: 'absurd day count', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 5000 } },
        { label: 'bad cap', input: { start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 2, maxDriveMinPerDay: -1 } }
    ];

    cases.forEach(function (c) {
        let p;
        assert.doesNotThrow(function () { p = planRoute(c.input); }, 'R8: ' + c.label + ' must not throw');
        assert.ok(Array.isArray(p.days) && p.days.length >= 1, 'R8: ' + c.label + ' has at least one day');
        assert.ok(Array.isArray(p.order), 'R8: ' + c.label + ' has an order array');
        assert.ok(Array.isArray(p.warnings), 'R8: ' + c.label + ' has warnings');
        assert.strictEqual(typeof p.roundTrip, 'boolean');
        assert.ok(isFinite(p.totalKm) && isFinite(p.totalMin), 'R8: ' + c.label + ' totals are finite');
        assertSumsConsistent(p, 'R8 ' + c.label);
        if (c.input && typeof c.input.days === 'number' && c.input.days >= 1 && c.input.days <= 366) {
            assert.strictEqual(p.days.length, Math.floor(c.input.days),
                'R4: ' + c.label + ' keeps the requested day count');
        }
    });
});

test('R8: a round trip with no destinations does not invent a 0 km leg to itself', function () {
    const p = planRoute({ start: MADRID, end: P('Madrid', 40.4168, -3.7038), stops: [], days: 2 });
    assert.strictEqual(p.order.length, 1, 'R3: nothing to drive');
    assert.strictEqual(p.totalKm, 0);
    assert.strictEqual(p.days.length, 2, 'R4: the requested days still exist');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('empty-trip:') === 0; }));
});

test('R4: the departure time produces per-day clock times without touching the system clock', function () {
    const a = plan(MADRID, BARCELONA, FOUR_STOPS, 3, { departureTime: '09:00' });
    const b = plan(MADRID, BARCELONA, FOUR_STOPS, 3, { departureTime: '09:00' });
    assert.deepStrictEqual(a.days.map(function (d) { return d.endTime; }),
        b.days.map(function (d) { return d.endTime; }), 'deterministic clock maths');
    a.days.forEach(function (d) {
        assert.strictEqual(d.startTime, '09:00');
        assert.match(d.endTime, /^\d{2}:\d{2}$/);
    });
    const noTime = plan(MADRID, BARCELONA, FOUR_STOPS, 3);
    assert.strictEqual(noTime.days[0].startTime, null, 'no departureTime, no invented time');
});

test('R2/R8: the engine exposes a browser-and-Node surface without ES modules', function () {
    assert.strictEqual(typeof engine.planRoute, 'function');
    assert.strictEqual(typeof engine.haversineKm, 'function');
    assert.strictEqual(typeof engine.haversineMatrix, 'function');
    assert.strictEqual(typeof engine.normaliseName, 'function');
    assert.strictEqual(typeof engine.isSamePlace, 'function');
    assert.strictEqual(engine.DEFAULT_MAX_DRIVE_MIN, 360);
    assert.strictEqual(engine.ROUND_TRIP_RADIUS_KM, 5);

    // Scan the executable source only: comments legitimately mention Math.random()
    // and Date.now() when documenting that the engine never calls them.
    const raw = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'js', 'route-engine.js'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(/function planRoute/.test(src), 'the comment stripper must keep the code');
    assert.ok(!/\bimport\s|\bexport\s/.test(src), 'no ES module syntax');
    assert.ok(!/Math\.random\(/.test(src), 'R2: no randomness');
    assert.ok(!/Date\.now\(|new Date\(/.test(src), 'purity: no clock reads');
});
