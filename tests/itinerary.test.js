/* ── Tests for js/itinerary-render.js ──
   Node built-in runner, no dependencies:  node --test tests/*.test.js

   Covers the four things the UI layer must never get wrong:
     C1 cost computation (fuel / tolls / lodging / meals, all computed in JS)
     C2 per-day budget comparison (the rfBudgetDay{i} inputs actually drive it)
     C3 defensive parsing of malformed / partial model JSON
     C4 the old plain-text saved-route format still renders (no data loss)
   plus B9 (day totals sum to trip totals) and the invariance property:
   the computed itinerary is identical with and without the model. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const I = require(path.join(__dirname, '..', 'js', 'itinerary-render.js'));
const engine = require(path.join(__dirname, '..', 'js', 'route-engine.js'));

/* ── Fixtures ── */
function P(name, lat, lon, extra) {
    const p = { name: name, lat: lat, lon: lon, resolved: true, source: 'osm' };
    if (extra) for (const k in extra) p[k] = extra[k];
    return p;
}

const MADRID    = P('Madrid', 40.4168, -3.7038);
const ZARAGOZA  = P('Zaragoza', 41.6488, -0.8891);
const VALENCIA  = P('Valencia', 39.4699, -0.3763);
const BARCELONA = P('Barcelona', 41.3851, 2.1734);

function planFor(start, end, stops, days) {
    const places = [start].concat(stops, end ? [end] : []);
    const matrix = engine.haversineMatrix(places);
    return engine.planRoute({
        start: start, end: end, stops: stops, matrix: matrix,
        days: days, departureTime: '09:00', maxDriveMinPerDay: 360
    });
}

/* A translation stub: returns the key so missing keys are visible, but fills
   the templates the renderer relies on. */
const DICT = {
    'unit.hour': 'h', 'unit.minute': 'min', 'unit.km': 'km',
    'itin.dayN': 'Day {day}', 'itin.summary': 'Trip summary',
    'itin.totalKm': 'Total distance', 'itin.totalTime': 'Total drive time',
    'itin.totalCost': 'Estimated cost', 'itin.totalBudget': 'Total budget',
    'itin.overBudgetBy': 'Over budget by {amount}', 'itin.underBudgetBy': '{amount} left',
    'itin.sourceRoad': 'Road data', 'itin.sourceEstimated': 'Estimated',
    'itin.distance': 'Distance', 'itin.driveTime': 'Drive time',
    'itin.departureArrival': 'Departure / arrival', 'itin.arriveAt': 'arrive {time}',
    'itin.overnight': 'Overnight in {place}', 'itin.stops': 'Stops',
    'itin.restDay': 'Rest day', 'itin.restDayAt': 'Rest at {place}',
    'itin.longDay': 'Long drive',
    'itin.fuel': 'Fuel', 'itin.tolls': 'Tolls', 'itin.lodging': 'Lodging', 'itin.meals': 'Meals',
    'itin.total': 'Day total', 'itin.budget': 'Day budget',
    'itin.withinBudget': 'Within budget', 'itin.estimate': '(estimate)',
    'itin.activities': 'Activities', 'itin.mealsIdeas': 'Where to eat',
    'itin.meal_breakfast': 'Breakfast', 'itin.meal_lunch': 'Lunch', 'itin.meal_dinner': 'Dinner',
    'itin.lodgingIdea': 'Where to sleep', 'itin.tip': 'Local tip',
    'itin.enrichUnavailable': 'No recommendations available',
    'itin.enrichPartial': 'No recommendations for day(s) {days}',
    'itin.ratesNote': 'Fuel {consumption} L/100 km at EUR {price}/L, lodging {lodging}, meals {meals}',
    'notice.restDay': 'Day {day}: rest at {place}.',
    'notice.overCap': 'Day {day} drives {drive}, over {cap}.',
    'notice.duplicate': '"{name}" listed twice.',
    'notice.sameAsStart': '"{name}" is the start point.',
    'notice.sameAsEnd': '"{name}" is the end point.',
    'notice.unresolved': '"{name}" not located.',
    'notice.haversine': 'No road data.',
    'notice.roundTrip': 'Round trip back to {place}.',
    'notice.overBudget': 'Over budget on day(s) {days}.'
};
const CTX = { t: function (k) { return Object.prototype.hasOwnProperty.call(DICT, k) ? DICT[k] : k; } };

/* ═══════════════ C1 — cost computation ═══════════════ */

test('C1: fuel is km / 100 * consumption * price, computed in JS', function () {
    const plan = { days: [{ day: 1, km: 200, driveMin: 120, legs: [{}] }, { day: 2, km: 100, driveMin: 60, legs: [{}] }] };
    const c = I.computeCosts(plan, { consumption: 7, fuelPrice: 1.5, dailyBudget: 1000 });
    assert.strictEqual(c.days[0].fuel, 21);   // 200/100 * 7 * 1.50
    assert.strictEqual(c.days[1].fuel, 10.5); // 100/100 * 7 * 1.50
    assert.strictEqual(c.totalFuel, 31.5);
});

test('C1: consumption and fuel price are honoured, invalid values fall back to the defaults', function () {
    const plan = { days: [{ day: 1, km: 100, driveMin: 60, legs: [{}] }] };
    const custom = I.computeCosts(plan, { consumption: 5, fuelPrice: 2, dailyBudget: 500 });
    assert.strictEqual(custom.days[0].fuel, 10);
    assert.strictEqual(custom.rates.consumption, 5);

    const junk = I.computeCosts(plan, { consumption: 'abc', fuelPrice: -1, dailyBudget: 500 });
    assert.strictEqual(junk.rates.consumption, I.ITIN_DEFAULTS.consumption);
    assert.strictEqual(junk.rates.fuelPrice, I.ITIN_DEFAULTS.fuelPrice);
    assert.strictEqual(junk.days[0].fuel, 10.5);
});

test('C1: lodging is charged per night (days - 1), meals every day', function () {
    const plan = { days: [{ day: 1, km: 0, driveMin: 0, legs: [] }, { day: 2, km: 0, driveMin: 0, legs: [] }, { day: 3, km: 0, driveMin: 0, legs: [] }] };
    const c = I.computeCosts(plan, { lodgingPerNight: 60, mealsPerDay: 35, dailyBudget: 1000 });
    assert.deepStrictEqual(c.days.map(function (d) { return d.lodging; }), [60, 60, 0]);
    assert.deepStrictEqual(c.days.map(function (d) { return d.meals; }), [35, 35, 35]);
    assert.strictEqual(c.totalLodging, 120);
    assert.strictEqual(c.totalMeals, 105);
});

test('C1: tolls come from the model only, are flagged, and are zero when tolls are avoided', function () {
    const plan = { days: [{ day: 1, km: 100, driveMin: 60, legs: [{}] }, { day: 2, km: 100, driveMin: 60, legs: [{}] }] };
    const withTolls = I.computeCosts(plan, { dailyBudget: 1000, tolls: [12.5, 0], tollsEnabled: true });
    assert.strictEqual(withTolls.days[0].tolls, 12.5);
    assert.strictEqual(withTolls.days[1].tolls, 0);
    assert.strictEqual(withTolls.tollsEstimated, true, 'a model-supplied toll must be flagged as an estimate');

    const noTolls = I.computeCosts(plan, { dailyBudget: 1000, tolls: [12.5, 4], tollsEnabled: false });
    assert.strictEqual(noTolls.days[0].tolls, 0);
    assert.strictEqual(noTolls.totalTolls, 0);
    assert.strictEqual(noTolls.tollsEstimated, false);

    const noModel = I.computeCosts(plan, { dailyBudget: 1000 });
    assert.strictEqual(noModel.totalTolls, 0);
    assert.strictEqual(noModel.tollsEstimated, false);
});

test('C1/B9: day totals sum to the trip total (cost and distance)', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 4);
    const c = I.computeCosts(plan, { dailyBudget: 100 });
    let sumCost = 0, sumKm = 0, sumMin = 0;
    for (let i = 0; i < c.days.length; i++) {
        sumCost += c.days[i].total;
        sumKm += plan.days[i].km;
        sumMin += plan.days[i].driveMin;
    }
    assert.ok(Math.abs(sumCost - c.totalCost) < 0.02, 'costs must sum');
    assert.ok(Math.abs(sumKm - plan.totalKm) < 0.02, 'km must sum');
    assert.ok(Math.abs(sumMin - plan.totalMin) < 0.02, 'minutes must sum');
    assert.strictEqual(I.totalsConsistent(plan, c), true);
});

test('C1: every per-day component adds up to that day total', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const c = I.computeCosts(plan, { dailyBudget: 120, tolls: [5, 0, 3] });
    for (let i = 0; i < c.days.length; i++) {
        const d = c.days[i];
        assert.ok(Math.abs((d.fuel + d.tolls + d.lodging + d.meals) - d.total) < 0.02,
            'day ' + d.day + ' components must equal the total');
    }
});

/* ═══════════════ C2 — per-day budget comparison ═══════════════ */

test('C2: perDayBudgets falls back to the daily budget only where a custom value is missing', function () {
    assert.deepStrictEqual(I.perDayBudgets(3, 100, []), [100, 100, 100]);
    assert.deepStrictEqual(I.perDayBudgets(3, 100, [150, null, 0]), [150, 100, 0]);
    assert.deepStrictEqual(I.perDayBudgets(3, 100, ['', 'x', 80]), [100, 100, 80]);
    assert.deepStrictEqual(I.perDayBudgets(0, 100, []), []);
});

test('C2: the per-day budget inputs drive the comparison, not the global one', function () {
    const plan = { days: [{ day: 1, km: 100, driveMin: 60, legs: [{}] }, { day: 2, km: 100, driveMin: 60, legs: [{}] }] };
    /* day cost = fuel 10.5 + lodging 60 + meals 35 = 105.5 on day 1, 45.5 on day 2 */
    const c = I.computeCosts(plan, { dailyBudget: 200, budgets: [50, 200] });
    assert.strictEqual(c.days[0].budget, 50);
    assert.strictEqual(c.days[0].over, true);
    assert.strictEqual(c.days[0].overBy, 55.5);
    assert.strictEqual(c.days[1].over, false);
    assert.strictEqual(c.days[1].overBy, 0);
    assert.deepStrictEqual(c.overBudgetDays, [1]);
    assert.strictEqual(c.totalBudget, 250);
});

test('C2: an exactly-on-budget day is not flagged as over budget', function () {
    const plan = { days: [{ day: 1, km: 100, driveMin: 60, legs: [{}] }] };
    /* single day -> no lodging: fuel 10.5 + meals 35 = 45.5 */
    const c = I.computeCosts(plan, { dailyBudget: 45.5 });
    assert.strictEqual(c.days[0].total, 45.5);
    assert.strictEqual(c.days[0].over, false);
    assert.strictEqual(c.over, false);
});

test('C2: over-budget days are surfaced as a visible notice', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const costs = I.computeCosts(plan, { dailyBudget: 10 });
    const notices = I.buildNotices(plan, { costs: costs, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona' });
    const over = notices.filter(function (n) { return n.code === 'overBudget'; });
    assert.strictEqual(over.length, 1);
    assert.strictEqual(over[0].level, 'warn');
    assert.match(I.noticeText(over[0], CTX), /Over budget on day/);
});

/* ═══════════════ C3 — defensive parsing of model JSON ═══════════════ */

const GOOD_JSON = JSON.stringify({
    days: [
        { day: 1, activities: ['Walk the old town', 'Visit the cathedral'], meals: { breakfast: 'Cafe A', lunch: 'Bar B', dinner: 'Rest C' }, lodging: 'Hotel X', tip: 'Park outside the centre', tollsEur: 12 },
        { day: 2, activities: ['Beach'], meals: { breakfast: 'Hotel', lunch: 'Chiringuito', dinner: 'Tapas' }, lodging: 'Hostal Y', tip: 'Book ahead', tollsEur: 0 }
    ]
});

test('C3: clean JSON parses into per-day enrichment', function () {
    const e = I.parseEnrichment(GOOD_JSON, 2);
    assert.strictEqual(e.available, true);
    assert.strictEqual(e.error, null);
    assert.deepStrictEqual(e.missingDays, []);
    assert.strictEqual(e.days[0].activities.length, 2);
    assert.strictEqual(e.days[0].meals.length, 3);
    assert.strictEqual(e.days[0].lodging, 'Hotel X');
    assert.strictEqual(e.days[1].tolls, 0);
    assert.deepStrictEqual(I.tollsFromEnrichment(e), [12, 0]);
});

test('C3: markdown fences and chatty prose around the JSON are tolerated', function () {
    const fenced = '```json\n' + GOOD_JSON + '\n```';
    assert.strictEqual(I.parseEnrichment(fenced, 2).available, true);

    const chatty = 'Sure! Here is your itinerary:\n' + GOOD_JSON + '\nEnjoy the trip!';
    const e = I.parseEnrichment(chatty, 2);
    assert.strictEqual(e.available, true);
    assert.strictEqual(e.days[0].lodging, 'Hotel X');
});

test('C3: malformed JSON never throws and yields no enrichment', function () {
    const cases = ['{"days": [', 'not json at all', '', null, undefined, '{}', '[]', '{"days": "nope"}', '<html>502</html>'];
    for (let i = 0; i < cases.length; i++) {
        const e = I.parseEnrichment(cases[i], 3);
        assert.strictEqual(e.available, false, 'case ' + i);
        assert.strictEqual(e.days.length, 3, 'case ' + i + ' must still describe every day');
        assert.deepStrictEqual(e.missingDays, [1, 2, 3], 'case ' + i);
        assert.deepStrictEqual(I.tollsFromEnrichment(e), [0, 0, 0], 'case ' + i);
    }
});

test('C3: a partial answer keeps the days it delivered and reports the rest', function () {
    const partial = JSON.stringify({ days: [{ day: 2, activities: ['Museum'], tip: 'Go early' }] });
    const e = I.parseEnrichment(partial, 3);
    assert.strictEqual(e.available, true);
    assert.strictEqual(e.error, 'partial');
    assert.deepStrictEqual(e.missingDays, [1, 3]);
    assert.strictEqual(e.days[1].present, true);
    assert.strictEqual(e.days[0].present, false);
    assert.strictEqual(e.days[2].activities.length, 0);
});

test('C3: junk field types are coerced or dropped, never crash the renderer', function () {
    const junk = JSON.stringify({
        days: [
            { day: 1, activities: 'One thing\nAnother thing', meals: ['Solo meal'], lodging: { name: 'Hotel Obj' }, tip: 42, tollsEur: 'abc' },
            { day: 99, activities: [{ name: 'Nested' }, null, 7], meals: null, lodging: null, tip: null, tollsEur: -5 }
        ]
    });
    const e = I.parseEnrichment(junk, 2);
    assert.deepStrictEqual(e.days[0].activities, ['One thing', 'Another thing']);
    assert.strictEqual(e.days[0].meals[0].text, 'Solo meal');
    assert.strictEqual(e.days[0].lodging, 'Hotel Obj');
    assert.strictEqual(e.days[0].tip, '42');
    assert.strictEqual(e.days[0].tolls, null, 'unusable toll estimates are discarded');
    assert.deepStrictEqual(e.days[1].activities, ['Nested', '7']);
    assert.strictEqual(e.days[1].tolls, null, 'negative tolls are discarded');
    assert.deepStrictEqual(I.tollsFromEnrichment(e), [0, 0]);
});

test('C3: out-of-range and duplicate day numbers cannot corrupt the day list', function () {
    const weird = JSON.stringify({ days: [{ day: 7, activities: ['A'] }, { day: 0, activities: ['B'] }, { day: 2, activities: ['C'] }] });
    const e = I.parseEnrichment(weird, 2);
    assert.strictEqual(e.days.length, 2);
    assert.deepStrictEqual(e.days[0].activities, ['A'], 'day 7 falls back to its positional index');
    assert.deepStrictEqual(e.days[1].activities, ['C']);
    assert.strictEqual(e.days[0].day, 1);
    assert.strictEqual(e.days[1].day, 2);
});

test('C3: a bare array and an already-parsed object are both accepted', function () {
    const arr = JSON.stringify([{ day: 1, tip: 'From an array' }]);
    assert.strictEqual(I.parseEnrichment(arr, 1).days[0].tip, 'From an array');
    const obj = { days: [{ day: 1, tip: 'From an object' }] };
    assert.strictEqual(I.parseEnrichment(obj, 1).days[0].tip, 'From an object');
});

/* ═══════════════ INVARIANCE — the model cannot move the route ═══════════════ */

test('INV: the itinerary is byte-identical with the model stubbed out and enriched', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 4);
    const base = {
        plan: plan, requestedStops: ['Zaragoza', 'Valencia'],
        startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, VALENCIA, BARCELONA], matrixSource: 'osrm',
        maxDriveMin: 360, dailyBudget: 120, departureTime: '09:00', t: CTX.t
    };
    const plain = I.buildItineraryView(base);
    const enriched = I.buildItineraryView(Object.assign({}, base, {
        enrichment: I.parseEnrichment(JSON.stringify({
            days: [
                { day: 1, activities: ['A'], tip: 'T', tollsEur: 9 },
                { day: 2, activities: ['B'], tip: 'T', tollsEur: 9 },
                { day: 3, activities: ['C'], tip: 'T', tollsEur: 9 },
                { day: 4, activities: ['D'], tip: 'T', tollsEur: 9 }
            ]
        }), 4)
    }));

    const shape = function (v) {
        return v.plan.days.map(function (d) {
            return {
                day: d.day, km: d.km, driveMin: d.driveMin,
                from: d.startPlace && d.startPlace.name, to: d.endPlace && d.endPlace.name,
                stops: d.stops.map(function (s) { return s.name; }),
                start: d.startTime, end: d.endTime, over: d.overDriveCap
            };
        });
    };
    assert.deepStrictEqual(shape(enriched), shape(plain), 'days/route/distances/times must not move');
    assert.strictEqual(enriched.plan.totalKm, plain.plan.totalKm);
    assert.strictEqual(enriched.plan.totalMin, plain.plan.totalMin);
    assert.deepStrictEqual(
        enriched.plan.order.map(function (p) { return p.name; }),
        plain.plan.order.map(function (p) { return p.name; })
    );
    /* Only the toll estimate may differ, and it must be flagged as an estimate. */
    assert.strictEqual(plain.costs.tollsEstimated, false);
    assert.strictEqual(enriched.costs.tollsEstimated, true);
    assert.strictEqual(enriched.costs.totalTolls, 36);
    for (let i = 0; i < plain.costs.days.length; i++) {
        assert.strictEqual(enriched.costs.days[i].fuel, plain.costs.days[i].fuel);
        assert.strictEqual(enriched.costs.days[i].budget, plain.costs.days[i].budget);
    }
});

/* ═══════════════ C4 — old saved routes still render ═══════════════ */

test('C4: a legacy plain-text route is not mistaken for a structured one', function () {
    const legacy = { startPoint: 'Madrid', endPoint: 'Barcelona', duration: 3, result: 'DIA 1: Madrid...\nDIA 2: ...' };
    assert.strictEqual(I.isStructuredRoute(legacy), false);
    assert.strictEqual(I.viewFromSaved(legacy), null, 'the caller must fall back to the plain-text view');
    assert.strictEqual(I.isStructuredRoute(null), false);
    assert.strictEqual(I.isStructuredRoute({ structured: {} }), false);
    assert.strictEqual(I.isStructuredRoute({ structured: { version: 1, plan: { days: [] } } }), false);
    assert.strictEqual(I.isStructuredRoute({ structured: { version: 2, plan: { days: [] } } }), false,
        'an empty day list is not a usable structured route');
});

test('C4: a route saved by this version round-trips through Firestore-safe JSON', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 100, departureTime: '09:00', tripType: 'familiar', t: CTX.t
    });
    const doc = { startPoint: 'Madrid', endPoint: 'Barcelona', result: I.buildPlainSummary(view, CTX), structured: I.serialiseView(view) };

    /* Firestore rejects nested arrays and undefined — the serialised form has neither. */
    const json = JSON.parse(JSON.stringify(doc));
    assert.ok(json.result.length > 0, 'the plain-text mirror is still stored for old readers');
    assert.strictEqual(I.isStructuredRoute(json), true);

    const restored = I.viewFromSaved(json);
    assert.strictEqual(restored.plan.days.length, 3);
    assert.strictEqual(restored.plan.totalKm, plan.totalKm);
    assert.strictEqual(restored.costs.totalCost, view.costs.totalCost);
    const html = I.renderItineraryHtml(restored, CTX);
    assert.match(html, /Day 1/);
    assert.match(html, /Barcelona/);
});

/* ═══════════════ Notices — derived from the plan, always translatable ═══════════════ */

test('NOTICE: rest days, dropped duplicates and unresolved places are all surfaced', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, ZARAGOZA, MADRID, BARCELONA], 6);
    const ghost = P('Nowheresville', null, null, { resolved: false });
    const notices = I.buildNotices(plan, {
        requestedStops: ['Zaragoza', 'Zaragoza', 'Madrid', 'Barcelona'],
        startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, ghost, BARCELONA],
        matrixSource: 'haversine', maxDriveMin: 360,
        costs: I.computeCosts(plan, { dailyBudget: 10000 })
    });
    const codes = notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('duplicate') >= 0, 'the repeated destination must be reported');
    assert.ok(codes.indexOf('sameAsStart') >= 0, 'a destination equal to the start must be reported');
    assert.ok(codes.indexOf('sameAsEnd') >= 0, 'a destination equal to the end must be reported');
    assert.ok(codes.indexOf('restDay') >= 0, 'extra days become explicit rest days');
    assert.ok(codes.indexOf('unresolved') >= 0, 'a place that could not be geocoded must be reported');
    assert.ok(codes.indexOf('haversine') >= 0, 'a missing road graph must be reported');
    for (let i = 0; i < notices.length; i++) {
        const text = I.noticeText(notices[i], CTX);
        assert.ok(text && text.indexOf('{') === -1, 'notice ' + notices[i].code + ' left an unfilled placeholder: ' + text);
    }
});

test('NOTICE: an engine warning with no localized notice is still surfaced verbatim', function () {
    const plan = { days: [], order: [], warnings: ['matrix-size-mismatch: matrix is 3x3 but 5 places were supplied'] };
    const notices = I.buildNotices(plan, {});
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(notices[0].code, 'other');
    assert.match(I.noticeText(notices[0], CTX), /matrix-size-mismatch/);
});

test('NOTICE: an over-cap driving day is flagged', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 1);
    const notices = I.buildNotices(plan, { maxDriveMin: 360, costs: I.computeCosts(plan, { dailyBudget: 9999 }) });
    const over = notices.filter(function (n) { return n.code === 'overCap'; });
    assert.strictEqual(plan.days[0].overDriveCap, true);
    assert.strictEqual(over.length, 1);
    assert.match(I.noticeText(over[0], CTX), /over/);
});

/* ═══════════════ Rendering ═══════════════ */

test('RENDER: one card per day, with the stops, distances and cost table on each', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 3);
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Zaragoza', 'Valencia'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, VALENCIA, BARCELONA], matrixSource: 'osrm',
        maxDriveMin: 360, dailyBudget: 100, departureTime: '09:00', t: CTX.t
    });
    const html = I.renderItineraryHtml(view, CTX);
    const cards = html.split('class="day-card').length - 1;
    assert.strictEqual(cards, 3, 'exactly `duration` day cards (quality bar B3)');
    assert.strictEqual(html.indexOf('{day}'), -1, 'no unfilled templates');
    assert.strictEqual(html.indexOf('itin.'), -1, 'no raw i18n keys leaked into the markup');
    assert.match(html, /Day total/);
    assert.match(html, /Day budget/);
    assert.match(html, /Trip summary/);
    /* B1 — every destination appears */
    assert.ok(html.indexOf('Zaragoza') >= 0 && html.indexOf('Valencia') >= 0);
});

test('RENDER: a multi-stop day lists its legs; a single-hop day does not repeat itself', function () {
    const oneDay = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 1);
    const base = {
        requestedStops: ['Zaragoza', 'Valencia'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, VALENCIA, BARCELONA], matrixSource: 'osrm',
        maxDriveMin: 360, dailyBudget: 100, departureTime: '09:00', t: CTX.t
    };
    const crammed = I.renderItineraryHtml(I.buildItineraryView(Object.assign({ plan: oneDay }, base)), CTX);
    assert.strictEqual(crammed.split('class="leg "').length - 1 + (crammed.split('class="leg"').length - 1), 3,
        'a 3-leg day must list all three legs with their own arrival times');

    const spread = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 3);
    for (let i = 0; i < spread.days.length; i++) {
        assert.strictEqual(spread.days[i].legs.length, 1, 'fixture check: one hop per day');
    }
    const html = I.renderItineraryHtml(I.buildItineraryView(Object.assign({ plan: spread }, base)), CTX);
    assert.strictEqual(html.indexOf('leg-list'), -1,
        'a one-hop day is already described by its header and stats — no duplicate leg row');
    assert.match(html, /Overnight in/, 'the overnight place is always stated');
});

test('RENDER: user text is HTML-escaped, in both the itinerary and the enrichment', function () {
    const evil = P('<img src=x onerror=alert(1)>', 41.0, 1.0);
    const plan = planFor(MADRID, BARCELONA, [evil], 2);
    const view = I.buildItineraryView({
        plan: plan, requestedStops: [evil.name], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, evil, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 100, departureTime: '09:00', t: CTX.t,
        enrichment: I.parseEnrichment(JSON.stringify({ days: [{ day: 1, tip: '<script>alert(2)</script>' }] }), 2)
    });
    const html = I.renderItineraryHtml(view, CTX);
    assert.strictEqual(html.indexOf('<img src=x'), -1);
    assert.strictEqual(html.indexOf('<script>alert(2)'), -1);
    assert.ok(html.indexOf('&lt;img src=x') >= 0);
});

test('RENDER: a missing enrichment produces a notice, never a broken card', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const args = {
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 100, departureTime: '09:00', t: CTX.t
    };
    const failed = I.buildItineraryView(Object.assign({}, args, { enrichment: I.parseEnrichment('garbage', 2) }));
    const html = I.renderItineraryHtml(failed, CTX);
    assert.match(html, /No recommendations available/);
    assert.strictEqual(html.split('class="day-card').length - 1, 2);

    const partial = I.buildItineraryView(Object.assign({}, args, {
        enrichment: I.parseEnrichment(JSON.stringify({ days: [{ day: 1, tip: 'Only day one' }] }), 2)
    }));
    assert.match(I.renderItineraryHtml(partial, CTX), /No recommendations for day\(s\) 2/);
});

test('RENDER: arrival times accumulate from the departure time, per day', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, VALENCIA], 1);
    const times = I.legTimes(plan.days[0], '09:00');
    assert.strictEqual(times.length, plan.days[0].legs.length);
    for (let i = 0; i < times.length; i++) assert.match(times[i], /^\d\d:\d\d$/);
    assert.strictEqual(times[times.length - 1], I.formatClock(9 * 60 + plan.days[0].driveMin));
    assert.deepStrictEqual(I.legTimes({ legs: [] }, '09:00'), []);
    assert.deepStrictEqual(I.legTimes(null, '09:00'), []);
});

test('RENDER: formatting helpers are locale-driven and never emit NaN', function () {
    assert.strictEqual(I.formatDuration(200, CTX), '3 h 20 min');
    assert.strictEqual(I.formatDuration(60, CTX), '1 h');
    assert.strictEqual(I.formatDuration(0, CTX), '0 min');
    assert.strictEqual(I.formatDuration('x', CTX), '0 min');
    assert.strictEqual(I.formatKm(325.4, CTX), '325 km');
    assert.strictEqual(I.formatKm(3.44, CTX), '3.4 km');
    assert.strictEqual(I.formatMoney(12), 'EUR 12.00');
    assert.strictEqual(I.formatMoney(undefined), 'EUR 0.00');
});

test('RENDER: parseDestinations trims, drops empties and keeps the user order', function () {
    assert.deepStrictEqual(I.parseDestinations(' Santiago , Finisterre ,, A Coruna '), ['Santiago', 'Finisterre', 'A Coruna']);
    assert.deepStrictEqual(I.parseDestinations(''), []);
    assert.deepStrictEqual(I.parseDestinations(null), []);
    assert.deepStrictEqual(I.parseDestinations(',,,'), []);
});

test('RENDER: degenerate plans render without throwing', function () {
    const empty = { days: [], order: [], totalKm: 0, totalMin: 0, warnings: [] };
    const view = I.buildItineraryView({ plan: empty, dailyBudget: 100, t: CTX.t });
    assert.doesNotThrow(function () { I.renderItineraryHtml(view, CTX); });
    assert.strictEqual(I.renderItineraryHtml(null, CTX), '');
    assert.strictEqual(I.buildPlainSummary(null, CTX), '');
});

test('EXPORTS: the module loads in Node and in the browser without ES modules', function () {
    assert.strictEqual(typeof I.computeCosts, 'function');
    assert.strictEqual(typeof I.parseEnrichment, 'function');
    assert.strictEqual(typeof I.renderItineraryHtml, 'function');
    assert.strictEqual(typeof I.viewFromSaved, 'function');
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'js', 'itinerary-render.js'), 'utf8');
    assert.strictEqual(/^\s*(import|export)\s/m.test(src), false, 'no ES module syntax');
    assert.ok(src.indexOf('window.TravioItinerary') > 0, 'browser global is attached');
});
