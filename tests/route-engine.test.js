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

/* ── A chain of collinear places whose consecutive legs have known drive times ──
   Points sit west to east on the equator, so the optimiser keeps them in order and each
   consecutive pair's haversine distance is exact. The inverse of the engine's fallback
   (haversine x 1.25 road factor, 90 km/h) turns a wanted minute count into a longitude
   step, which lets a test state a leg distribution directly instead of hoping a set of
   cities happens to produce one. */
const EARTH_R_KM = 6371.0088;
function lonStepForMinutes(min) {
    const roadKm = (min / 60) * 90;
    const geoKm = roadKm / 1.25;
    return (360 / Math.PI) * Math.asin(geoKm / (2 * EARTH_R_KM));
}

function chain(legMinutes) {
    const places = [P('C0', 0, 0)];
    let lon = 0;
    for (let i = 0; i < legMinutes.length; i++) {
        lon += lonStepForMinutes(legMinutes[i]);
        places.push(P('C' + (i + 1), 0, lon));
    }
    const matrix = engine.haversineMatrix(places);
    // The minutes the engine will actually see, after its own 2-decimal rounding.
    const actual = [];
    for (let i = 0; i + 1 < places.length; i++) actual.push(matrix.min[i][i + 1]);
    return { places: places, matrix: matrix, legMin: actual };
}

function planChain(c, days, cap) {
    const input = {
        start: c.places[0],
        end: c.places[c.places.length - 1],
        stops: c.places.slice(1, c.places.length - 1),
        matrix: c.matrix,
        days: days
    };
    if (cap !== undefined) input.maxDriveMinPerDay = cap;
    return planRoute(input);
}

/* Exhaustive oracle: does ANY contiguous split into `days` non-empty chunks keep every
   chunk at or under `cap`? Independent of the engine — this is what R6 promises. */
function feasibleSplitExists(legMin, days, cap) {
    const n = legMin.length;
    const memo = new Map();
    function go(pos, d) {
        if (d === days) return pos === n;
        const key = pos + ':' + d;
        if (memo.has(key)) return memo.get(key);
        let acc = 0;
        let ok = false;
        for (let take = 1; pos + take <= n - (days - d - 1); take++) {
            acc += legMin[pos + take - 1];
            if (acc > cap + 1e-9) break;
            if (go(pos + take, d + 1)) { ok = true; break; }
        }
        memo.set(key, ok);
        return ok;
    }
    return go(0, 0);
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

test('R2: 2-opt + or-opt matches the brute-force optimum on THIS 4-stop fixture (local optimality only, not a general guarantee)', function () {
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

test('R6: a feasible cap is respected on UNEVEN legs, not only on evenly spaced ones', function () {
    /* The previous version of this test used six evenly spaced ~55 min legs — the one leg
       distribution a balance-first greedy always happens to handle — so it asserted a
       property that was false in general on a case selected to pass. These distributions
       are uneven, and each one has a contiguous split with every day under the cap. */
    const cases = [
        // The headline regression: the greedy ended day 1 at 229 because taking the 81 min
        // leg overshot the average, then dumped 317 + 156 = 473 min on an uncapped last day.
        { legs: [229, 81, 317, 156], days: 3, cap: 360, expect: [310, 317, 156] },
        { legs: [340, 40, 300, 40], days: 3, cap: 360, expect: [340, 40, 340] },
        { legs: [50, 50, 350, 50, 50], days: 3, cap: 360, expect: [100, 350, 100] },
        { legs: [200, 200, 200, 200, 200], days: 3, cap: 450, expect: [200, 400, 400] },
        { legs: [120, 240, 120, 240, 120], days: 3, cap: 380, expect: [120, 360, 360] },
        // Feasible only if the LAST day is the light one — the greedy's blind spot.
        { legs: [100, 100, 100, 340], days: 2, cap: 360, expect: [300, 340] },
        // ...and only if the FIRST day is.
        { legs: [340, 100, 100, 100], days: 2, cap: 360, expect: [340, 300] }
    ];

    cases.forEach(function (c) {
        const built = chain(c.legs);
        assert.ok(feasibleSplitExists(built.legMin, c.days, c.cap),
            'the fixture itself must admit a split under the cap: ' + c.legs.join('+'));

        const p = planChain(built, c.days, c.cap);
        assert.strictEqual(p.days.length, c.days, 'R4: ' + c.legs.join('+'));
        assert.deepStrictEqual(
            p.days.map(function (d) { return Math.round(d.driveMin); }),
            c.expect,
            'R6: ' + c.legs.join('+') + ' over ' + c.days + ' days, cap ' + c.cap);
        p.days.forEach(function (d) {
            assert.strictEqual(d.overDriveCap, false,
                'R6: day ' + d.day + ' drives ' + d.driveMin + ' min, cap ' + c.cap);
            assert.ok(d.driveMin <= c.cap + 0.01, 'R6: cap honoured when the schedule allows it');
        });
        assert.strictEqual(
            p.warnings.filter(function (w) { return w.indexOf('over-drive-cap:') === 0; }).length, 0,
            'R6: no over-cap warning when no day is over the cap');
        assertDayChain(p, 'feasible cap ' + c.legs.join('+'));
        assertSumsConsistent(p, 'feasible cap ' + c.legs.join('+'));
    });

    // The evenly spaced case the old test used still has to work.
    const even = chain([55, 55, 55, 55, 55, 55, 55]);
    const pe = planChain(even, 4, 240);
    pe.days.forEach(function (d) {
        assert.strictEqual(d.overDriveCap, false, 'R6: even legs, day ' + d.day);
    });
});

test('R6: whenever a split under the cap exists, the engine finds one (1200 random instances)', function () {
    /* A property test, not a lucky fixture: an independent exhaustive search decides
       whether a contiguous split with every day under the cap exists, and every instance
       where one does must come back with no day over the cap. Before the fix this failed
       on ~3% of feasible instances, the last day being the offender almost every time. */
    const rand = lcg(20260807);
    let feasible = 0;
    let violations = 0;
    let lastDayOffender = 0;
    let worstExcess = 0;
    const examples = [];

    for (let t = 0; t < 1200; t++) {
        const nLegs = 3 + Math.floor(rand() * 7);                  // 3..9 legs
        const legs = [];
        for (let i = 0; i < nLegs; i++) legs.push(Math.round(45 + rand() * 255));   // 45..300 min
        const days = 2 + Math.floor(rand() * Math.min(nLegs - 1, 5));
        const cap = [240, 300, 360, 420][Math.floor(rand() * 4)];
        if (days >= nLegs) continue;                               // that is the R5 branch

        const built = chain(legs);
        if (!feasibleSplitExists(built.legMin, days, cap)) continue;
        feasible++;

        const p = planChain(built, days, cap);
        assert.strictEqual(p.days.length, days, 'R4: instance ' + t);
        const over = p.days.filter(function (d) { return d.overDriveCap; });
        if (over.length) {
            violations++;
            if (p.days[days - 1].overDriveCap) lastDayOffender++;
            over.forEach(function (d) {
                worstExcess = Math.max(worstExcess, d.driveMin - cap);
            });
            if (examples.length < 3) {
                examples.push(legs.join('+') + ' over ' + days + ' days, cap ' + cap + ' -> [' +
                    p.days.map(function (d) { return Math.round(d.driveMin); }).join(', ') + ']');
            }
        }
        // Whatever the split, overDriveCap and the warning must agree with the numbers.
        assert.strictEqual(
            p.warnings.filter(function (w) { return w.indexOf('over-drive-cap:') === 0; }).length,
            over.length, 'R6: one warning per over-cap day, instance ' + t);
    }

    assert.ok(feasible > 300, 'the sweep must actually exercise feasible instances, got ' + feasible);
    assert.strictEqual(violations, 0,
        'R6: ' + violations + '/' + feasible + ' feasible instances still produced an over-cap day ' +
        '(last day in ' + lastDayOffender + ', worst excess ' + Math.round(worstExcess) + ' min). ' +
        'Examples: ' + examples.join(' | '));
});

test('R6: an impossible cap is spread evenly, never dumped on one day', function () {
    /* Feasibility cannot always be reached; balance is what is left, and it must not
       collapse into "one short day, one enormous day". */
    const rand = lcg(31337);
    for (let t = 0; t < 60; t++) {
        const nLegs = 4 + Math.floor(rand() * 6);
        const legs = [];
        for (let i = 0; i < nLegs; i++) legs.push(Math.round(200 + rand() * 300));
        const days = 2 + Math.floor(rand() * 3);
        if (days >= nLegs) continue;

        const built = chain(legs);
        assert.ok(!feasibleSplitExists(built.legMin, days, 360),
            'fixture ' + t + ' was meant to be infeasible');
        const p = planChain(built, days, 360);
        const lightest = Math.min.apply(null, p.days.map(function (d) { return d.driveMin; }));
        assert.ok(lightest > p.totalMin / (days * 4),
            'R6: instance ' + t + ' lightest day ' + Math.round(lightest) + ' min of ' +
            Math.round(p.totalMin) + ' over ' + days + ' days is not a balanced split');
        p.days.forEach(function (d) {
            assert.ok(d.legs.length >= 1, 'R5: no empty day when there are more legs than days');
        });
        assertSumsConsistent(p, 'impossible cap ' + t);
    }
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

/* ── D1: prototype pollution in the de-duplication map ── */

test('R1: destinations named after Object.prototype members are not phantom duplicates', function () {
    const tricky = ['constructor', 'Constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
    const stops = tricky.map(function (n, i) { return P(n, 39.5 + i * 0.35, -4 + i * 0.9); });
    const p = plan(MADRID, BARCELONA, stops, 3);

    // 'Constructor' really is a duplicate of 'constructor' after normalisation; the other
    // five are distinct destinations and must all survive.
    assert.strictEqual(nameCount(p.order, 'constructor'), 1, 'R1: "constructor" is a real destination');
    ['__proto__', 'toString', 'valueOf', 'hasOwnProperty'].forEach(function (n) {
        assert.strictEqual(nameCount(p.order, n), 1, 'R1: "' + n + '" must not be dropped');
    });
    assert.strictEqual(p.order.length, 7, 'R1: start + 5 unique stops + end');

    const dupes = p.warnings.filter(function (w) { return w.indexOf('duplicate-stop-removed:') === 0; });
    assert.strictEqual(dupes.length, 1, 'R1: exactly one genuine duplicate, no phantom warnings');
    assert.ok(dupes[0].indexOf('"Constructor"') !== -1, 'R1: the warning names the real duplicate');
    assertDayChain(p, 'prototype names');
});

test('R1: a lone destination called "constructor" survives and is never falsely reported', function () {
    const p = plan(P('Start', 40, -3), P('End', 41, 1), [P('Alpha', 40.5, -2), P('constructor', 40.8, -1)], 2);
    assert.deepStrictEqual(names(p.order), ['Start', 'Alpha', 'constructor', 'End']);
    assert.strictEqual(p.warnings.filter(function (w) {
        return w.indexOf('duplicate-stop-removed:') === 0;
    }).length, 0, 'R1: no false duplicate warning');
});

/* ── D2: start/end missing but destinations supplied ── */

test('R5: with no start and no end the destinations are still planned, not discarded', function () {
    const stops = [TOLEDO, SEGOVIA];
    const p = planRoute({ stops: stops, days: 3, matrix: engine.haversineMatrix(stops) });

    assert.strictEqual(p.days.length, 3, 'R4: three days');
    assert.strictEqual(p.order.length, 2, 'B1: both typed destinations appear');
    assert.strictEqual(nameCount(p.order, 'Toledo'), 1);
    assert.strictEqual(nameCount(p.order, 'Segovia'), 1);
    assert.ok(p.totalKm > 50, 'B1: real distances, not an all-zero itinerary');
    assert.ok(!p.warnings.some(function (w) { return w.indexOf('no-places:') === 0; }),
        'the plan must not claim there were no places');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('missing-start:') === 0; }),
        'the promotion of a destination to origin is reported');
    assert.ok(!p.warnings.some(function (w) { return w.indexOf('matrix-size-mismatch:') === 0; }),
        'a stops-only matrix is a recognised layout');

    const empty = p.days.filter(function (d) { return d.stops.length === 0; });
    assert.strictEqual(empty.length, 2, 'R5: one drive, two rest days');
    assert.strictEqual(p.warnings.filter(function (w) { return w.indexOf('rest-day:') === 0; }).length, 2,
        'R5: every empty day is an explicitly flagged rest day');
    assertDayChain(p, 'promoted origin');
    assertSumsConsistent(p, 'promoted origin');
});

test('R5: one destination and no endpoints still yields flagged rest days at that place', function () {
    const p = planRoute({ stops: [TOLEDO], days: 4, matrix: engine.haversineMatrix([TOLEDO]) });
    assert.strictEqual(p.days.length, 4);
    assert.deepStrictEqual(names(p.order), ['Toledo']);
    assert.strictEqual(p.warnings.filter(function (w) { return w.indexOf('rest-day:') === 0; }).length, 4);
    p.days.forEach(function (d) {
        assert.strictEqual(d.startPlace, TOLEDO, 'R5: the rest days happen at the only place we have');
        assert.strictEqual(d.endPlace, TOLEDO);
    });
});

test('R5: even a plan with no usable places at all flags every day as a rest day', function () {
    const p = planRoute({ days: 3, stops: [null, 'Toledo', 7] });
    assert.strictEqual(p.days.length, 3);
    assert.deepStrictEqual(p.order, []);
    assert.strictEqual(p.warnings.filter(function (w) { return w.indexOf('rest-day:') === 0; }).length, 3,
        'R5: no silent empty days, ever');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('no-places:') === 0; }));
});

/* ── D3: coordinates that are not plain numbers ── */

test('R8: string coordinates are coerced instead of collapsing to a silent 0 km trip', function () {
    const s = { name: 'Madrid', lat: '40.4168', lon: '-3.7038', resolved: true, source: 'osm' };
    const e = { name: 'Barcelona', lat: '41.3851', lon: '2.1734', resolved: true, source: 'osm' };
    const mid = { name: 'Zaragoza', lat: '41.6488', lon: '-0.8891', resolved: true, source: 'osm' };
    const p = plan(s, e, [mid], 2);

    assert.ok(p.totalKm > 500, 'R8: string coordinates must produce real distances, got ' + p.totalKm);
    assert.ok(!p.warnings.some(function (w) { return w.indexOf('unknown-distance:') === 0; }));
    assert.ok(!p.warnings.some(function (w) { return w.indexOf('zero-distance:') === 0; }));
    assert.ok(Math.abs(engine.haversineKm(s, MADRID)) < 0.01, 'string and number coordinates agree');
});

test('R8: coordinates that are unusable produce warnings, never a silent 0 km itinerary', function () {
    const a = { name: 'A', lat: 'not-a-number', lon: {}, resolved: true, source: 'ai' };
    const b = { name: 'B', lat: null, lon: undefined, resolved: true, source: 'ai' };
    const c = { name: 'C', lat: 999, lon: 999, resolved: true, source: 'ai' };   // out of range
    const p = plan(a, b, [c], 2);

    assert.strictEqual(p.totalKm, 0, 'nothing can be computed from these');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('unknown-distance:') === 0; }),
        'the missing distance data is reported');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('zero-distance:') === 0; }),
        'a 0 km itinerary is never presented silently');
    assert.strictEqual(p.days.length, 2);
    assertSumsConsistent(p, 'unusable coordinates');
});

/* ── Matrix source: 'osrm' | 'mixed' | 'haversine' ── */

function matrixWithSource(places, source, extra) {
    const m = engine.haversineMatrix(places);
    m.source = source;
    if (extra) for (const k in extra) m[k] = extra[k];
    return m;
}

test('B5: source "osrm" is clean road data and raises no distance warning', function () {
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);
    const m = matrixWithSource(places, 'osrm', { osrmCells: 30, filledCells: 0 });
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: m, days: 3 });
    assert.strictEqual(p.warnings.filter(function (w) { return w.indexOf('distance-source:') === 0; }).length, 0);
});

test('B5: source "mixed" is NOT clean road data and must warn with the filled-cell count', function () {
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);
    const m = matrixWithSource(places, 'mixed', { osrmCells: 24, filledCells: 6 });
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: m, days: 3 });
    const w = p.warnings.filter(function (x) { return x.indexOf('distance-source:') === 0; });
    assert.strictEqual(w.length, 1, 'B5: a partly guessed matrix must be flagged');
    assert.ok(w[0].indexOf('6 of 30') !== -1, 'B5: the user is told how many legs are estimates: ' + w[0]);
    assert.ok(/straight-line/.test(w[0]), 'B5: the warning says what "mixed" means');
});

test('B5: source "haversine" warns that there is no road data at all', function () {
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);
    const m = matrixWithSource(places, 'haversine', { osrmCells: 0, filledCells: 30 });
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: m, days: 3 });
    const w = p.warnings.filter(function (x) { return x.indexOf('distance-source:') === 0; });
    assert.strictEqual(w.length, 1);
    assert.ok(/no road data/.test(w[0]), 'B5: ' + w[0]);
});

test('B5: an absent or unknown matrix source is treated as unverified, not as road data', function () {
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);
    const m = matrixWithSource(places, undefined);
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: m, days: 3 });
    assert.ok(p.warnings.some(function (w) { return w.indexOf('distance-source: unknown matrix source') === 0; }));
});

/* ── D5: the label and the counters are one contract; the counters are the evidence ── */

test('B5: a matrix labelled "osrm" while its counters say otherwise is not trusted', function () {
    /* The round-1 bug was a guessed matrix labelled clean, which suppressed the warning.
       The contract puts the duty on the provider, but osrmCells/filledCells sit right
       next to the label and are part of the same contract — when they contradict it, the
       engine must not stay silent. Off-diagonal cells here: 6 x 5 = 30. */
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);

    // 'osrm' claimed, yet not one cell came from the road graph.
    const lying = matrixWithSource(places, 'osrm', { osrmCells: 0, filledCells: 30 });
    const a = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: lying, days: 3 });
    const wa = a.warnings.filter(function (w) { return w.indexOf('distance-source:') === 0; });
    assert.ok(wa.length >= 1, 'B5: a matrix labelled "osrm" with 30 filled cells must warn');
    assert.ok(wa.some(function (w) { return /labelled "osrm"/.test(w) && /counters/.test(w); }),
        'B5: the contradiction itself is reported: ' + wa.join(' // '));
    assert.ok(wa.some(function (w) { return /no road data/.test(w); }),
        'B5: and the counters, not the label, decide what the user is told: ' + wa.join(' // '));

    // 'osrm' claimed, but a fifth of the cells were guessed.
    const partly = matrixWithSource(places, 'osrm', { osrmCells: 24, filledCells: 6 });
    const b = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: partly, days: 3 });
    const wb = b.warnings.filter(function (w) { return w.indexOf('distance-source:') === 0; });
    assert.ok(wb.some(function (w) { return /counters say "mixed"/.test(w); }),
        'B5: partial road data mislabelled "osrm" is caught: ' + wb.join(' // '));
    assert.ok(wb.some(function (w) { return w.indexOf('6 of 30') !== -1; }),
        'B5: the user is still told how many legs are estimates: ' + wb.join(' // '));

    // The reverse lie is a lie too: real road data labelled as guesswork.
    const pessimistic = matrixWithSource(places, 'haversine', { osrmCells: 30, filledCells: 0 });
    const c = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: pessimistic, days: 3 });
    assert.ok(c.warnings.some(function (w) { return /labelled "haversine"/.test(w) && /counters say "osrm"/.test(w); }),
        'B5: a mislabelled-as-worse matrix is reported too');
    assert.ok(!c.warnings.some(function (w) { return /no road data at all/.test(w); }),
        'B5: the counters win, so the user is not told there is no road data');

    // Counters outside 0..30, or not whole numbers, make the provenance unverifiable.
    [{ osrmCells: 99, filledCells: 99 },
     { osrmCells: -1, filledCells: 30 },
     { osrmCells: 12.5, filledCells: 30 }].forEach(function (counters) {
        const broken = matrixWithSource(places, 'osrm', counters);
        const d = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: broken, days: 3 });
        assert.ok(d.warnings.some(function (w) {
            return w.indexOf('distance-source:') === 0 && /cannot be confirmed/.test(w);
        }), 'B5: out-of-range counters ' + JSON.stringify(counters) + ' are reported, not believed');
    });

    // And a matrix whose label and counters agree is still silent.
    const clean = matrixWithSource(places, 'osrm', { osrmCells: 30, filledCells: 0 });
    const e = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: clean, days: 3 });
    assert.strictEqual(e.warnings.filter(function (w) { return w.indexOf('distance-source:') === 0; }).length, 0,
        'B5: no false alarm on a genuinely clean matrix');
});

test('B5: the counters OVERLAP — their sum exceeding the cell count is not an error', function () {
    /* A cell holds a km and a min, and they can have different provenance: OSRM's default
       /table reply annotates durations only, and a distances-only reply is equally
       possible. Such a cell is counted in BOTH counters, so osrmCells + filledCells may
       exceed the off-diagonal count. Treating the sum as a partition raised a false alarm
       on the commonest real OSRM reply of all, and made the warning overstate the damage:
       "6 of 6 cells are straight-line estimates" when all 6 road distances were real. */
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);          // 6 places, 30 off-diagonal cells

    // Every cell has a real road distance and an estimated duration.
    const distancesOnly = matrixWithSource(places, 'mixed', { osrmCells: 30, filledCells: 30 });
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: distancesOnly, days: 3 });
    const w = p.warnings.filter(function (x) { return x.indexOf('distance-source:') === 0; });

    assert.ok(!w.some(function (x) { return /cannot be confirmed/.test(x); }),
        'B5: 30 + 30 > 30 is legitimate, not a counter inconsistency: ' + w.join(' // '));
    assert.ok(!w.some(function (x) { return /counters say/.test(x); }),
        'B5: label and counters agree here, so nothing is contradicted: ' + w.join(' // '));
    assert.strictEqual(w.length, 1, 'B5: exactly one distance-source warning: ' + w.join(' // '));
    assert.ok(!/matrix cells are straight-line estimates/.test(w[0]),
        'B5: the warning must not claim any cell is a pure straight-line estimate: ' + w[0]);
    assert.ok(/real road value with an estimated one/.test(w[0]),
        'B5: it must say these cells are PARTLY estimated: ' + w[0]);

    // A genuinely part-guessed, part-half-guessed matrix names both quantities.
    const both = matrixWithSource(places, 'mixed', { osrmCells: 24, filledCells: 12 });
    const q = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: both, days: 3 });
    const wq = q.warnings.filter(function (x) { return x.indexOf('distance-source:') === 0; })[0];
    // 30 - 24 = 6 cells are entirely estimated; 24 + 12 - 30 = 6 more are half estimated.
    assert.ok(/6 of 30 matrix cells are straight-line estimates/.test(wq),
        'B5: entirely-estimated cells are counted correctly: ' + wq);
    assert.ok(/6 more carry a real road value/.test(wq),
        'B5: part-estimated cells are reported separately: ' + wq);

    // The no-overlap case still reads exactly as before.
    const disjoint = matrixWithSource(places, 'mixed', { osrmCells: 24, filledCells: 6 });
    const r = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: disjoint, days: 3 });
    const wr = r.warnings.filter(function (x) { return x.indexOf('distance-source:') === 0; })[0];
    assert.ok(wr.indexOf('6 of 30') !== -1 && /unroutable pairs/.test(wr),
        'B5: a plain partly-filled matrix is unchanged: ' + wr);
    assert.ok(!/carry a real road value/.test(wr), 'B5: nothing is half-estimated here: ' + wr);

    // Both counters zero on a 30-cell matrix accounts for nothing and cannot be true.
    const nothing = matrixWithSource(places, 'mixed', { osrmCells: 0, filledCells: 0 });
    const s = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: nothing, days: 3 });
    assert.ok(s.warnings.some(function (x) {
        return x.indexOf('distance-source:') === 0 && /cannot be confirmed/.test(x);
    }), 'B5: counters that account for no cell at all are reported');

    // ...but a 1x1 matrix has no off-diagonal cell, so 0/0 there is correct and silent.
    const lone = planRoute({ stops: [TOLEDO], days: 4, matrix: engine.haversineMatrix([TOLEDO]) });
    assert.strictEqual(lone.warnings.filter(function (x) { return x.indexOf('distance-source:') === 0; }).length, 0,
        'B5: a single-place matrix has no distance to characterise and must not warn');
});

/* ── D6: negative matrix cells ── */

test('R7/R8: negative matrix cells are rejected, not subtracted from the trip', function () {
    /* cell() validated finiteness but not sign, so negative distances propagated straight
       into the totals: an all-negative matrix produced totalKm = -875 and the only
       warning was "the whole itinerary computes to 0 km" — the wrong message entirely. */
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);

    function negated(fraction) {
        const m = engine.haversineMatrix(places);
        m.source = 'osrm';
        m.osrmCells = 30;
        m.filledCells = 0;
        let flipped = 0;
        for (let i = 0; i < m.km.length; i++) {
            for (let j = 0; j < m.km.length; j++) {
                if (i === j) continue;
                if (!fraction || flipped < fraction) {
                    m.km[i][j] = -m.km[i][j];
                    m.min[i][j] = -m.min[i][j];
                    flipped++;
                }
            }
        }
        return m;
    }

    const all = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: negated(0), days: 3 });
    assert.ok(all.totalKm > 500, 'R8: a negative matrix must not produce a negative trip, got ' + all.totalKm);
    assert.ok(all.totalMin > 0, 'R7: totals stay positive, got ' + all.totalMin);
    assert.ok(all.warnings.some(function (w) { return w.indexOf('invalid-distance:') === 0; }),
        'R8: the corrupt matrix is named for what it is');
    assert.ok(!all.warnings.some(function (w) { return w.indexOf('zero-distance:') === 0; }),
        'R8: "computes to 0 km" is the wrong message for negative data');
    all.days.forEach(function (d) {
        assert.ok(d.km >= 0 && d.driveMin >= 0, 'R7: no negative day totals');
        d.legs.forEach(function (l) {
            assert.ok(l.km >= 0 && l.min >= 0, 'R7: no negative legs');
        });
    });
    assertSumsConsistent(all, 'all-negative matrix');

    // One poisoned cell hiding inside otherwise sound data must be caught too.
    const one = planRoute({ start: MADRID, end: BARCELONA, stops: FOUR_STOPS, matrix: negated(1), days: 3 });
    assert.ok(one.warnings.some(function (w) { return w.indexOf('invalid-distance:') === 0; }),
        'R8: a single negative cell is still reported');
    assert.ok(one.totalKm > 500 && one.totalMin > 0);
    assertSumsConsistent(one, 'one negative cell');

    // Only one warning however many cells are corrupt.
    assert.strictEqual(all.warnings.filter(function (w) { return w.indexOf('invalid-distance:') === 0; }).length, 1,
        'R8: the corruption is reported once, not once per leg');
});

test('B5: the engine fallback matrix carries the contract counters and a calibrated speed', function () {
    const places = placesOf(MADRID, BARCELONA, FOUR_STOPS);
    const m = engine.haversineMatrix(places);
    assert.strictEqual(m.source, 'haversine');
    assert.strictEqual(m.osrmCells, 0);
    assert.strictEqual(m.filledCells, 30, 'every off-diagonal cell is a fill');
    // 90 km/h, per the contract's live-OSRM calibration (75 km/h was 22-26% pessimistic).
    const kmh = (m.km[0][1] / m.min[0][1]) * 60;
    assert.ok(Math.abs(kmh - 90) < 0.5, 'fallback speed is ~90 km/h, got ' + kmh);
});

/* ── R4 day-count coercion, pinned ── */

test('R4: day counts that are not usable collapse to a single flagged day', function () {
    [0, -4, NaN, Infinity, -Infinity, 0.5, '5 days', null, undefined, {}, []].forEach(function (value) {
        const p = planRoute({ start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: value });
        assert.strictEqual(p.days.length, 1, 'R4: days=' + String(value) + ' must collapse to 1 day');
        assert.ok(p.warnings.some(function (w) { return w.indexOf('days-clamped:') === 0; }),
            'R4: the collapse is reported for days=' + String(value));
    });
});

test('R4: numeric-looking day counts are coerced silently and fractions are floored', function () {
    assert.strictEqual(planRoute({ start: MADRID, end: BARCELONA, stops: [], days: '5' }).days.length, 5);
    assert.strictEqual(planRoute({ start: MADRID, end: BARCELONA, stops: [], days: ' 4 ' }).days.length, 4);
    assert.strictEqual(planRoute({ start: MADRID, end: BARCELONA, stops: [], days: [3] }).days.length, 3);
    // true -> Number(true) -> 1 day, silently: a documented coercion, not a clamp.
    const bool = planRoute({ start: MADRID, end: BARCELONA, stops: [], days: true });
    assert.strictEqual(bool.days.length, 1);
    assert.ok(!bool.warnings.some(function (w) { return w.indexOf('days-clamped:') === 0; }));
    const frac = planRoute({ start: MADRID, end: BARCELONA, stops: [], days: 3.7 });
    assert.strictEqual(frac.days.length, 3, 'R4: 3.7 days is floored to 3');
    assert.ok(frac.warnings.some(function (w) { return w.indexOf('days-clamped:') === 0; }),
        'R4: flooring is reported');
    // Coercion of a clean numeric string is silent by design.
    assert.ok(!planRoute({ start: MADRID, end: BARCELONA, stops: [], days: '5' }).warnings
        .some(function (w) { return w.indexOf('days-clamped:') === 0; }));
});

test('R4: the day count is clamped at 366 with a warning', function () {
    const p = planRoute({ start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 5000 });
    assert.strictEqual(p.days.length, 366, 'R4: clamped, and this is a documented deviation');
    assert.ok(p.warnings.some(function (w) { return w.indexOf('days-clamped:') === 0 && /366/.test(w); }));
    const ok = planRoute({ start: MADRID, end: BARCELONA, stops: [ZARAGOZA], days: 366 });
    assert.strictEqual(ok.days.length, 366);
    assert.ok(!ok.warnings.some(function (w) { return w.indexOf('days-clamped:') === 0; }),
        'R4: exactly 366 days is not clamped');
});

/* ── D4: how good is the ordering, really ── */

function lcg(seed) {
    let s = seed >>> 0;
    return function () {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function indicesOf(order, places) {
    return order.map(function (p) { return places.indexOf(p); });
}

/* Independent re-implementation of the two neighbourhood checks, so the assertions do
   not depend on the engine's internals. */
function twoOptImproves(matrix, idx) {
    const base = pathMinutes(matrix, idx);
    for (let i = 1; i <= idx.length - 3; i++) {
        for (let j = i + 1; j <= idx.length - 2; j++) {
            const cand = idx.slice(0, i).concat(idx.slice(i, j + 1).reverse(), idx.slice(j + 1));
            if (pathMinutes(matrix, cand) < base - 1e-6) return true;
        }
    }
    return false;
}

function orOptImproves(matrix, idx) {
    const base = pathMinutes(matrix, idx);
    const last = idx.length - 2;
    for (let len = 1; len <= 3 && len <= last; len++) {
        for (let i = 1; i + len - 1 <= last; i++) {
            const seg = idx.slice(i, i + len);
            const rest = idx.slice(0, i).concat(idx.slice(i + len));
            for (let pos = 1; pos <= rest.length - 1; pos++) {
                for (let rev = 0; rev < 2; rev++) {
                    if (rev === 1 && len === 1) continue;
                    if (rev === 0 && pos === i) continue;
                    const piece = rev ? seg.slice().reverse() : seg;
                    const cand = rest.slice(0, pos).concat(piece, rest.slice(pos));
                    if (pathMinutes(matrix, cand) < base - 1e-6) return true;
                }
            }
        }
    }
    return false;
}

test('R2: the returned order is a 2-opt AND an or-opt local optimum on 40 random instances', function () {
    const rand = lcg(20260806);
    let worstGap = 0;
    let above = 0;
    for (let t = 0; t < 40; t++) {
        const stops = [];
        for (let i = 0; i < 6; i++) stops.push(P('S' + i, 36 + rand() * 8, -9 + rand() * 12));
        const start = P('Start', 40.4168, -3.7038);
        const end = P('End', 41.3851, 2.1734);
        const places = placesOf(start, end, stops);
        const matrix = engine.haversineMatrix(places);
        const p = planRoute({ start: start, end: end, stops: stops, matrix: matrix, days: 3 });

        const idx = indicesOf(p.order, places);
        assert.ok(idx.indexOf(-1) === -1, 'R2: every returned place belongs to the input');
        assert.strictEqual(idx.length, 8, 'R1: instance ' + t + ' keeps all stops');
        assert.strictEqual(idx[0], 0);
        assert.strictEqual(idx[idx.length - 1], places.length - 1);

        assert.ok(!twoOptImproves(matrix, idx), 'R2: instance ' + t + ' is not 2-opt optimal');
        assert.ok(!orOptImproves(matrix, idx), 'R2: instance ' + t + ' is not or-opt optimal');

        const perms = permutations([1, 2, 3, 4, 5, 6]);
        let best = Infinity;
        for (let k = 0; k < perms.length; k++) {
            best = Math.min(best, pathMinutes(matrix, [0].concat(perms[k]).concat([7])));
        }
        const got = pathMinutes(matrix, idx);
        const gap = (got - best) / best;
        if (gap > 1e-9) above++;
        worstGap = Math.max(worstGap, gap);
        // Honest ceiling: this is a heuristic, not an exact solver.
        assert.ok(gap <= 0.25, 'R2: instance ' + t + ' is ' + (gap * 100).toFixed(1) + '% above optimum');
    }
    // Documented, not asserted as a guarantee: some instances do land above the optimum.
    assert.ok(above <= 20, 'R2: most instances should reach the optimum, ' + above + '/40 did not');
    assert.ok(worstGap < 0.25, 'R2: worst observed gap ' + (worstGap * 100).toFixed(1) + '%');
});

test('R2: or-opt keeps the plan deterministic and never worse than nearest neighbour', function () {
    const rand = lcg(4242);
    for (let t = 0; t < 15; t++) {
        const stops = [];
        for (let i = 0; i < 7; i++) stops.push(P('S' + i, 36 + rand() * 8, -9 + rand() * 12));
        const start = P('Start', 40.4168, -3.7038);
        const end = P('End', 41.3851, 2.1734);
        const places = placesOf(start, end, stops);
        const matrix = engine.haversineMatrix(places);

        const a = planRoute({ start: start, end: end, stops: stops, matrix: matrix, days: 4 });
        const b = planRoute({ start: start, end: end, stops: stops, matrix: matrix, days: 4 });
        assert.deepStrictEqual(names(a.order), names(b.order), 'R2: deterministic on instance ' + t);

        const typed = pathMinutes(matrix, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert.ok(pathMinutes(matrix, indicesOf(a.order, places)) <= typed + 1e-6,
            'R2: never worse than the typed order');
        assertSumsConsistent(a, 'or-opt instance ' + t);
    }
});

test('R2: the improvement passes scale quadratically, not cubically, up to the 60-stop limit', function () {
    /* Both passes used to re-cost the whole sequence for every candidate, turning each
       O(n^2) scan into O(n^3): at the 60-stop optimisation limit one planRoute() took a
       median 81 ms on the dev machine (peaks past 230 ms) — a visible freeze in the
       browser. Scoring each candidate by an exact O(1) delta brings that to ~5 ms.

       An absolute millisecond budget would only measure the machine, so the assertion is
       on the SHAPE of the growth: doubling the stop count costs ~4x for a quadratic scan
       and ~8x for a cubic one. Measured here: 4.1x after the fix, 9.2x before it. */
    function instance(n) {
        const rand = lcg(4242);
        const stops = [];
        for (let i = 0; i < n; i++) stops.push(P('S' + i, 36 + rand() * 8, -9 + rand() * 12));
        const start = P('Start', 40.4168, -3.7038);
        const end = P('End', 41.3851, 2.1734);
        const places = placesOf(start, end, stops);
        const matrix = engine.haversineMatrix(places);
        return {
            places: places,
            matrix: matrix,
            input: { start: start, end: end, stops: stops, matrix: matrix, days: 7 }
        };
    }
    function timeMs(input) {
        const t0 = process.hrtime.bigint();
        planRoute(input);
        return Number(process.hrtime.bigint() - t0) / 1e6;
    }

    const small = instance(30);
    const large = instance(60);
    for (let w = 0; w < 3; w++) { planRoute(small.input); planRoute(large.input); }

    /* Both sizes are measured back to back inside each round and the ratio is taken per
       round, so JIT state, GC pauses and CPU frequency changes hit numerator and
       denominator together instead of skewing one of them. */
    const ratios = [];
    for (let r = 0; r < 9; r++) {
        const a = timeMs(small.input);
        const b = timeMs(large.input);
        ratios.push(b / a);
    }
    ratios.sort(function (a, b) { return a - b; });
    const ratio = ratios[4];

    const plan60 = planRoute(large.input);
    assert.strictEqual(plan60.order.length, 62,
        'R1: 60 stops is exactly the optimisation limit, and none are dropped');
    assert.ok(!plan60.warnings.some(function (w) { return w.indexOf('optimisation-limited:') === 0; }),
        'R2: 60 stops must still be optimised, not skipped');
    // The fast delta must land on the same local optimum a full re-cost would.
    const idx = indicesOf(plan60.order, large.places);
    assert.ok(!twoOptImproves(large.matrix, idx),
        'R2: the O(1) delta must reach a genuine 2-opt local optimum');
    assert.ok(!orOptImproves(large.matrix, idx),
        'R2: and a genuine or-opt local optimum');

    assert.ok(ratio < 7,
        'R2: doubling 30 -> 60 stops cost ' + ratio.toFixed(1) + 'x (median of ' +
        ratios.map(function (x) { return x.toFixed(1); }).join(', ') + '); ' +
        'that is cubic growth, the per-candidate full re-cost is back');
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
