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
/* The two modules the wiring puts on screen — loaded here so the W tests below
   exercise the real map and the real exporter, not a mock of them. */
const MAPMOD = require(path.join(__dirname, '..', 'js', 'route-map.js'));
const EXPMOD = require(path.join(__dirname, '..', 'js', 'route-export.js'));

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
    'itin.unknownValue': '—', 'itin.tollsNotEstimated': '(not estimated)',
    'itin.tollsNotApplicable': '(not applicable)',
    'itin.tollsCapped': '(estimate, capped)', 'itin.tollsNoDriving': '(no driving)',
    'itin.overBudgetByWithEstimate': 'Over budget by {amount}, a figure that includes {tolls} of AI-estimated tolls',
    'itin.atLeast': 'at least {amount}',
    'itin.withinBudgetIncomplete': 'Within budget for what is counted; the total is not complete',
    'itin.budgetNotAssessable': 'The budget cannot be assessed',
    'itin.overBudgetByEstimated': 'Over budget by {amount}, but only because of the AI-estimated toll ({tolls})',
    'itin.sourcePartial': 'Partial road data',
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
    'notice.mixed': 'Partial road data: {filled} of {total} are straight-line estimates.',
    'notice.mixedUnknownCount': 'Partial road data: some distances are straight-line estimates.',
    'notice.zeroDistance': 'The whole itinerary computes to 0 km, so the figures below are not real.',
    'notice.unknownDistance': 'At least one leg has no usable distance data.',
    'notice.tollsUnknown': 'Tolls could not be estimated and are not included in any total.',
    'notice.tollsNotAvoided': 'The route below was NOT re-planned to avoid tolls, so tolls are not applicable rather than zero and the cost shown is a minimum.',
    'notice.tollsClamped': 'The AI estimated EUR {value} of tolls on day {day} for {km}; capped at EUR {capped}.',
    'notice.roundTrip': 'Round trip back to {place}.',
    'notice.overBudget': 'Over budget on day(s) {days}.',
    'itin.geoTitle': 'Where each place was located',
    'itin.geoNote': 'These labels come from the geocoder, not from Travio.',
    'itin.geoNotLocated': 'could not be located',
    'itin.geoNoLabel': 'the geocoder returned no label',
    'itin.geoBadgeOutlier': '{km} from the rest of the trip',
    'itin.geoBadgeOutlierFar': 'far from the rest of the trip',
    'itin.geoBadgeMatches': '{count} places matched this name',
    'itin.geoBadgeMoved': 'not the first match: chosen for being nearer the rest of the trip',
    'notice.geoOutlier': '"{name}" was located at {label}, {km} from the rest of the trip.',
    'notice.geoOutlierNoDistance': '"{name}" was located at {label}, far from the rest of the trip.',
    'notice.geoRelocated': '"{name}" matched more than one place. {label} was used, chosen for being nearer the rest of the trip.',
    'notice.geoAmbiguous': '{count} of the names you typed matched more than one place ({names}).'
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
    assert.deepStrictEqual(e.days[1].activities, [],
        'the entry claimed day 99 of a 2-day trip: it is dropped, not re-homed onto day 2');
    assert.strictEqual(e.days[1].tolls, null, 'negative tolls are discarded');
    assert.deepStrictEqual(I.tollsFromEnrichment(e), [0, 0]);
});

test('C3: an out-of-range day number is DROPPED, never attached to the wrong city', function () {
    const weird = JSON.stringify({ days: [{ day: 7, activities: ['A'] }, { day: 0, activities: ['B'] }, { day: 2, activities: ['C'] }] });
    const e = I.parseEnrichment(weird, 2);
    assert.strictEqual(e.days.length, 2);
    assert.deepStrictEqual(e.days[0].activities, [],
        'day 7 of a 2-day trip is a claim about a day that does not exist — dropping it is the ' +
        'only honest option; mapping it onto day 1 puts the wrong city in the itinerary');
    assert.deepStrictEqual(e.days[1].activities, ['C'], 'the in-range entry is still delivered');
    assert.strictEqual(e.droppedEntries, 2, 'day 7 and day 0 are both reported as dropped');
    assert.strictEqual(e.days[0].day, 1);
    assert.strictEqual(e.days[1].day, 2);
    assert.deepStrictEqual(e.missingDays, [1], 'day 1 is reported as missing, not silently filled');
});

test('C3: an ABSENT day number still falls back to the position in the array', function () {
    /* Models routinely emit an ordered list with no `day` field at all; positional
       fallback is correct there, and only there. */
    const e = I.parseEnrichment(JSON.stringify({ days: [{ activities: ['First'] }, { activities: ['Second'] }] }), 2);
    assert.deepStrictEqual(e.days[0].activities, ['First']);
    assert.deepStrictEqual(e.days[1].activities, ['Second']);
    assert.strictEqual(e.droppedEntries, 0);
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
    /* 3 driving days x EUR 9. The 4th is a rest day: no driving, so its EUR 9 claim is
       discarded rather than added — that zero is computed, not asserted. */
    assert.strictEqual(enriched.costs.totalTolls, 27);
    assert.strictEqual(enriched.costs.days[3].km, 0);
    assert.strictEqual(enriched.costs.days[3].tolls, 0);
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

/* ═══════════════════════════════════════════════════════════════════════════════
   HONESTY — the app must not tell the user things that are not true.
   Every test below fails against the code that shipped before this suite existed.
   ═══════════════════════════════════════════════════════════════════════════════ */

/* Load the real js/i18n.js (a classic script, not a module) so these tests read the
   strings the browser actually shows, not a stub that can drift away from them. */
function loadI18n() {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
    const store = {};
    const localStorage = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); }
    };
    const document = { querySelectorAll: function () { return []; }, getElementById: function () { return null; } };
    const fn = new Function('localStorage', 'document', 'console',
        src + '\nreturn { TRANSLATIONS: TRANSLATIONS, t: t, tf: tf, setLanguage: setLanguage, ' +
        'onLanguageChange: onLanguageChange, lang: function () { return currentLang; } };');
    return fn(localStorage, document, console);
}
const LOCALES = ['es', 'en', 'ca', 'fr', 'zh'];

function flattenKeys(obj, prefix, out) {
    out = out || [];
    for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const key = prefix ? prefix + '.' + k : k;
        if (obj[k] && typeof obj[k] === 'object') flattenKeys(obj[k], key, out);
        else out.push(key);
    }
    return out;
}

/* ── I18N — every user-facing string exists in all five locales ── */

test('I18N: the five locales carry exactly the same key set, with no empty strings', function () {
    const i18n = loadI18n();
    const reference = flattenKeys(i18n.TRANSLATIONS.es).sort();
    assert.ok(reference.length >= 111,
        'the dictionary only ever grows: ' + reference.length + ' keys');
    for (let i = 0; i < LOCALES.length; i++) {
        const loc = LOCALES[i];
        const keys = flattenKeys(i18n.TRANSLATIONS[loc]).sort();
        const missing = reference.filter(function (k) { return keys.indexOf(k) === -1; });
        const extra = keys.filter(function (k) { return reference.indexOf(k) === -1; });
        assert.deepStrictEqual(missing, [], loc + ' is missing keys');
        assert.deepStrictEqual(extra, [], loc + ' has keys no other locale has');
        for (let k = 0; k < keys.length; k++) {
            const parts = keys[k].split('.');
            let v = i18n.TRANSLATIONS[loc];
            for (let p = 0; p < parts.length; p++) v = v[parts[p]];
            assert.strictEqual(typeof v, 'string', loc + '.' + keys[k] + ' must be a string');
            assert.ok(v.trim().length > 0, loc + '.' + keys[k] + ' must not be empty');
        }
    }
});

test('I18N: every key the renderer asks for resolves in all five locales', function () {
    const i18n = loadI18n();
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'js', 'itinerary-render.js'), 'utf8');
    const literal = (src.match(/'(itin|notice|unit)\.[a-zA-Z_]+'/g) || [])
        .map(function (s) { return s.slice(1, -1); });
    /* buildNotices emits 'notice.' + code — collect the codes it can produce. */
    const codes = (src.match(/code: '([a-zA-Z]+)'/g) || [])
        .map(function (s) { return s.replace(/code: '|'/g, ''); })
        .filter(function (c) { return c !== 'other'; })
        .map(function (c) { return 'notice.' + c; });
    /* and the meal labels, built as 'itin.meal_' + key */
    const meals = ['itin.meal_breakfast', 'itin.meal_lunch', 'itin.meal_dinner', 'itin.meal_other'];
    const needed = literal.concat(codes, meals)
        /* 'itin.meal_' is a prefix the renderer concatenates onto, not a key. */
        .filter(function (k) { return !/_$/.test(k); })
        .filter(function (k, i, a) { return a.indexOf(k) === i; });
    assert.ok(needed.length > 30, 'sanity: found ' + needed.length + ' keys in the renderer');

    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        for (let k = 0; k < needed.length; k++) {
            const v = i18n.t(needed[k]);
            assert.strictEqual(typeof v, 'string', LOCALES[i] + ' / ' + needed[k]);
            assert.notStrictEqual(v, needed[k],
                needed[k] + ' is not translated in ' + LOCALES[i] + ' (t() returned the key)');
        }
    }
});

/* ── DEFECT 1 — the banner must not claim the costs are complete ── */

test('D1: the enrichment banner never asserts that costs are complete, in any locale', function () {
    const i18n = loadI18n();
    /* The exact over-claim that shipped, per locale, plus the word for "complete". */
    const forbidden = {
        es: ['costes de abajo estan calculados y son completos', 'complet'],
        en: ['costs below are computed and complete', 'complete'],
        ca: ['costos de sota estan calculats i son complets', 'complet'],
        fr: ['couts ci-dessous sont calcules et complets', 'complet'],
        zh: ['费用均已计算完成且完整', '完整']
    };
    for (let i = 0; i < LOCALES.length; i++) {
        const loc = LOCALES[i];
        i18n.setLanguage(loc);
        const s = i18n.t('itin.enrichUnavailable');
        assert.ok(s.length > 0, loc + ' has no banner');
        for (let f = 0; f < forbidden[loc].length; f++) {
            assert.strictEqual(s.toLowerCase().indexOf(forbidden[loc][f].toLowerCase()), -1,
                loc + ' still claims the costs are complete: "' + s + '"');
        }
    }
});

test('D1: a toll with no estimate is UNKNOWN, not a computed zero', function () {
    const plan = { days: [{ day: 1, km: 300, driveMin: 180, legs: [{}] }, { day: 2, km: 300, driveMin: 180, legs: [{}] }] };

    /* Offline / proxy 500: the model delivered nothing at all. */
    const offline = I.computeCosts(plan, {
        dailyBudget: 400, tollsEnabled: true,
        tolls: I.tollEstimates(I.parseEnrichment(null, 2))
    });
    assert.strictEqual(offline.tollsUnknown, true, 'a whole cost component is missing');
    assert.deepStrictEqual(offline.unknownTollDays, [1, 2]);
    assert.strictEqual(offline.days[0].tollsKnown, false);
    assert.strictEqual(offline.incomplete, true, 'the trip total is a floor, not a total');

    /* "Avoid tolls" is a REQUEST, not an outcome — see the D1b tests below. */
    const avoided = I.computeCosts(plan, { dailyBudget: 400, tollsEnabled: false, tolls: [null, null] });
    assert.strictEqual(avoided.days[0].tollsBasis, 'not-avoided');
    assert.strictEqual(avoided.days[0].tollsKnown, false);
    assert.strictEqual(avoided.tollsUnknown, false, 'a different gap from "nobody estimated it"');
    assert.strictEqual(avoided.tollsNotAvoided, true);

    /* A model-supplied 0 is a real answer. */
    const answered = I.computeCosts(plan, { dailyBudget: 400, tollsEnabled: true, tolls: [0, 14] });
    assert.strictEqual(answered.tollsUnknown, false);
    assert.strictEqual(answered.days[0].tollsKnown, true);
    assert.strictEqual(answered.days[0].tollsBasis, 'estimated');
    assert.strictEqual(answered.days[0].tollsEstimated, true, 'it still came from the model');
    assert.strictEqual(answered.incomplete, false);

    /* The one zero this app can genuinely compute: a day with no driving. */
    const rest = I.computeCosts({ days: [{ day: 1, km: 0, driveMin: 0, legs: [] }] },
        { dailyBudget: 400, tollsEnabled: true, tolls: [9] });
    assert.strictEqual(rest.days[0].tollsBasis, 'none');
    assert.strictEqual(rest.days[0].tolls, 0, 'no road travelled, no toll incurred');
    assert.strictEqual(rest.days[0].incomplete, false);
    assert.strictEqual(rest.clampedTolls.length, 0, 'and no noisy clamp notice for it');
});

test('D1: an unknown toll is shown as unknown and blocks a "within budget" verdict', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const enrichment = I.parseEnrichment(null, 3);
    enrichment.error = 'unavailable';
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 500, tollsEnabled: true, tollPreference: 'with-tolls',
        departureTime: '09:00', t: CTX.t, enrichment: enrichment
    });
    /* Budget is generous, so the old code said "Within budget" with EUR 0.00 of tolls. */
    assert.strictEqual(view.costs.over, false, 'fixture: the known costs are inside the budget');
    assert.strictEqual(view.costs.tollsUnknown, true);
    assert.deepStrictEqual(view.costs.unknownTollDays, [1, 2],
        'fixture: days 1-2 drive, day 3 is a rest day with a genuinely computed zero');

    const html = I.renderItineraryHtml(view, CTX);
    /* Verdicts, in day order: the two driving days are withheld, the rest day — whose
       zero really is computed — keeps its clean verdict. */
    const verdicts = (html.match(/class="cost-flag [^"]*">[^<]*/g) || [])
        .map(function (s) { return s.replace(/class="cost-flag ([^"]*)">/, '$1|'); });
    assert.deepStrictEqual(verdicts, [
        'flag-unknown|Within budget for what is counted; the total is not complete',
        'flag-unknown|Within budget for what is counted; the total is not complete',
        'flag-ok|Within budget'
    ], 'a verdict that ignores a missing cost component must not be given');
    assert.match(html, /summary-flag flag-unknown">Within budget for what is counted/,
        'and the trip verdict is withheld too');
    assert.match(html, /\(not estimated\)/, 'the toll row is marked as not estimated');
    assert.match(html, /at least EUR/, 'a total that omits a component is labelled a minimum');
    assert.strictEqual(
        (html.match(/<tr class="cost-unknown"><td>Tolls <span class="est-flag">\(not estimated\)<\/span><\/td><td class="mono">—<\/td><\/tr>/g) || []).length, 2,
        'an unknown toll must never render as a computed EUR 0.00');
    const codes = view.notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('tollsUnknown') >= 0, 'the gap is stated, not just implied');
});

/* ══════════════ ROUND 4 ══════════════ */

/* ── DEFECT 1c — a document written by the FIRST structured build must still add up ──
   Round-1 v2 documents (commit 8699cd1) carry `tolls` and nothing else about it: no
   basis, no per-day provenance. Reading that as "not estimated / —" printed a cost
   table whose rows did not sum to their own stated total. ── */

/* The shape a round-1 build actually wrote. Only `tolls` — the fields the renderer
   later came to rely on simply do not exist. */
function round1CostDay(day, km, fuel, tolls, lodging, meals, budget) {
    const total = Math.round((fuel + tolls + lodging + meals) * 100) / 100;
    return {
        day: day, km: km, fuel: fuel, tolls: tolls, lodging: lodging, meals: meals,
        total: total, budget: budget, over: total > budget + 0.005,
        overBy: total > budget + 0.005 ? Math.round((total - budget) * 100) / 100 : 0
    };
}
function round1Doc(days, budget) {
    const costs = { days: days, totalFuel: 0, totalTolls: 0, totalLodging: 0, totalMeals: 0,
        totalCost: 0, totalBudget: 0, overBudgetDays: [], over: false, overBy: 0,
        tollsEstimated: false, rates: { consumption: 7, fuelPrice: 1.5, lodgingPerNight: 60, mealsPerDay: 35 } };
    for (let i = 0; i < days.length; i++) {
        costs.totalFuel += days[i].fuel; costs.totalTolls += days[i].tolls;
        costs.totalLodging += days[i].lodging; costs.totalMeals += days[i].meals;
        costs.totalCost += days[i].total; costs.totalBudget += days[i].budget;
        if (days[i].over) costs.overBudgetDays.push(days[i].day);
        if (days[i].tolls > 0) costs.tollsEstimated = true;
    }
    costs.over = costs.totalCost > costs.totalBudget + 0.005;
    costs.overBy = costs.over ? Math.round((costs.totalCost - costs.totalBudget) * 100) / 100 : 0;
    const plan = { days: days.map(function (d) {
            return { day: d.day, km: d.km, driveMin: d.km, legs: [{}], stops: [],
                startPlace: { name: 'A' }, endPlace: { name: 'B' } };
        }), order: [], totalKm: 0, totalMin: 0, roundTrip: false, warnings: [] };
    for (let i = 0; i < days.length; i++) { plan.totalKm += days[i].km; plan.totalMin += days[i].km; }
    /* version 2 with no `tollsBasis` anywhere — exactly what round 1 stored. */
    return { startPoint: 'Madrid', endPoint: 'Barcelona', result: 'DIA 1: ...',
        structured: { version: 2, plan: plan, costs: costs, enrichment: null, notices: [], meta: { matrixSource: 'osrm' } } };
}

/* Money out of a rendered cost cell. */
function moneyIn(s) { const n = Number(String(s).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; }
function costRows(html) {
    return (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).map(function (r) {
        return {
            label: (/<td>([\s\S]*?)<\/td>/.exec(r) || [, ''])[1].replace(/<[^>]+>/g, '').trim(),
            value: (/<td class="mono">([\s\S]*?)<\/td>/.exec(r) || [, ''])[1].replace(/<[^>]+>/g, '').trim(),
            cls: (/<tr class="([^"]*)"/.exec(r) || [, ''])[1]
        };
    }).filter(function (r) { return r.label && r.value; });
}

test('D1c: a round-1 saved route loads with a cost table whose rows sum to its total', function () {
    const doc = round1Doc([
        round1CostDay(1, 300, 31.50, 12.50, 0, 35, 200),
        round1CostDay(2, 300, 31.50, 0, 0, 35, 200)
    ], 200);
    assert.strictEqual(doc.structured.costs.days[0].tollsBasis, undefined,
        'fixture: a round-1 document has no toll provenance at all');
    assert.strictEqual(I.isStructuredRoute(doc), true);

    const view = I.viewFromSaved(doc);
    const html = I.renderItineraryHtml(view, CTX);
    const rows = costRows(html);

    /* Day 1 carries EUR 12.50 of toll money inside its stated total. It must render as
       money — the app cannot charge for it and deny estimating it in the same table. */
    const day1 = rows.slice(0, 6);
    const components = day1.filter(function (r) { return !/Day total|Day budget/.test(r.label); });
    const sum = components.reduce(function (a, r) { return a + moneyIn(r.value); }, 0);
    const stated = moneyIn((day1.filter(function (r) { return r.label === 'Day total'; })[0] || {}).value);
    assert.ok(Math.abs(sum - stated) < 0.005,
        'B9: rows sum to ' + sum.toFixed(2) + ' against a stated total of ' + stated.toFixed(2));
    assert.strictEqual(stated, 79.00);

    const tollRow = day1.filter(function (r) { return /^Tolls/.test(r.label); })[0];
    assert.strictEqual(tollRow.value, 'EUR 12.50', 'a toll the app HAS must not read "—"');
    assert.strictEqual(view.costs.days[0].tollsBasis, 'estimated');
    assert.strictEqual(view.costs.days[0].incomplete, false,
        'nothing is missing from this day, so its total is not a floor');
    assert.match(html, /cost-flag flag-ok">Within budget</,
        'and its verdict is given outright');
});

test('D1c: the round-1 zero it cannot explain is floored, and the day rows still sum', function () {
    const doc = round1Doc([
        round1CostDay(1, 300, 31.50, 12.50, 0, 35, 200),
        round1CostDay(2, 300, 31.50, 0, 0, 35, 200)
    ], 200);
    const view = I.viewFromSaved(doc);

    /* Round 1 stored the same 0 whether the model said zero, said nothing, or the user
       had asked to avoid tolls. That is not a settled figure. */
    assert.strictEqual(view.costs.days[1].tollsBasis, 'unknown');
    assert.strictEqual(view.costs.days[1].incomplete, true);
    assert.strictEqual(view.costs.tollsUnknown, true);
    assert.deepStrictEqual(view.costs.unknownTollDays, [2]);
    assert.strictEqual(view.costs.incomplete, true,
        'the trip flag must agree with the day flags, or the summary asserts what the rows withhold');

    const html = I.renderItineraryHtml(view, CTX);
    const rows = costRows(html);
    const day2 = rows.slice(6, 12);
    const sum = day2.filter(function (r) { return !/Day total|Day budget/.test(r.label); })
        .reduce(function (a, r) { return a + moneyIn(r.value); }, 0);
    assert.ok(Math.abs(sum - 66.50) < 0.005, 'an unknown of zero still leaves the rows summing');
    assert.match(html, /at least EUR/, 'the floor is stated');
    assert.ok(view.notices.map(function (n) { return n.code; }).indexOf('tollsUnknown') >= 0,
        'the reader is told why the verdict was withheld');
});

test('D1c: round-2/3 documents and legacy plain text are untouched by the migration', function () {
    /* A document written by TODAY's build must round-trip byte-identically. */
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const shapes = [
        { tollsEnabled: true, enrichment: I.parseEnrichment(JSON.stringify({ days: [
            { day: 1, tip: 'T', tollsEur: 12.5 }, { day: 2, tip: 'T', tollsEur: 0 }, { day: 3, tip: 'T', tollsEur: 4998 }] }), 3) },
        { tollsEnabled: true, enrichment: I.parseEnrichment(null, 3) },
        { tollsEnabled: false, tollPreference: 'without-tolls', enrichment: I.parseEnrichment(null, 3) }
    ];
    for (let i = 0; i < shapes.length; i++) {
        const view = I.buildItineraryView(Object.assign({
            plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
            places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
            dailyBudget: 200, departureTime: '09:00', t: CTX.t
        }, shapes[i]));
        const doc = JSON.parse(JSON.stringify({ structured: I.serialiseView(view) }));
        const restored = I.viewFromSaved(doc);
        assert.strictEqual(I.renderItineraryHtml(restored, CTX), I.renderItineraryHtml(view, CTX),
            'shape ' + i + ' does not round-trip identically');
        assert.deepStrictEqual(restored.costs.days.map(function (d) { return d.tollsBasis; }),
            view.costs.days.map(function (d) { return d.tollsBasis; }));
        assert.strictEqual(restored.notices.length, view.notices.length,
            'shape ' + i + ' gained or lost a notice on the load path');
    }
    /* And a pre-engine plain-text route is still not mistaken for a structured one. */
    const legacy = { startPoint: 'Madrid', endPoint: 'Barcelona', duration: 3, result: 'DIA 1: Madrid...' };
    assert.strictEqual(I.isStructuredRoute(legacy), false);
    assert.strictEqual(I.viewFromSaved(legacy), null);
});

/* ══════════════ ROUND 5 ══════════════ */

/* ── DEFECT 1d — migrating the money is not enough: migrate the RELIABILITY too ──
   viewFlags has two trip-level inputs. Round 4 rebuilt `costs`; the other is the notice
   list, and viewFromSaved took that verbatim from the stored document. Round 1 had no
   `zeroDistance` code (it stored the engine's English sentence as an untranslated
   {code:'other', level:'info'}) and had `unknown-distance` in COVERED_WARNINGS with
   nothing rendering it (it stored nothing at all). So a saved route reproduced the exact
   screen this piece was opened to eliminate. ── */

/* A round-1 document whose plan carries the given engine warnings. Everything else is
   the shape round 1 wrote: notices as that build understood them, no meta flag. */
function round1DocWithWarnings(warnings, storedNotices, opts) {
    const o = opts || {};
    const dayCount = o.days || 3;
    const days = [], costDays = [];
    for (let i = 0; i < dayCount; i++) {
        const km = o.km === undefined ? 0 : o.km;
        const fuel = Math.round((km / 100) * 7 * 1.5 * 100) / 100;
        const lodging = i < dayCount - 1 ? 60 : 0;
        const total = Math.round((fuel + lodging + 35) * 100) / 100;
        const budget = o.budget === undefined ? 120 : o.budget;
        days.push({ day: i + 1, km: km, driveMin: km, legs: km ? [{}] : [], stops: [],
            startPlace: { name: 'A' }, endPlace: { name: 'B' } });
        costDays.push({ day: i + 1, km: km, fuel: fuel, tolls: 0, lodging: lodging, meals: 35,
            total: total, budget: budget, over: total > budget + 0.005,
            overBy: total > budget + 0.005 ? Math.round((total - budget) * 100) / 100 : 0 });
    }
    const costs = { days: costDays, totalFuel: 0, totalTolls: 0, totalLodging: 0, totalMeals: 0,
        totalCost: 0, totalBudget: 0, overBudgetDays: [], over: false, overBy: 0,
        tollsEstimated: false, rates: { consumption: 7, fuelPrice: 1.5, lodgingPerNight: 60, mealsPerDay: 35 } };
    for (let i = 0; i < costDays.length; i++) {
        costs.totalFuel += costDays[i].fuel; costs.totalLodging += costDays[i].lodging;
        costs.totalMeals += costDays[i].meals; costs.totalCost += costDays[i].total;
        costs.totalBudget += costDays[i].budget;
        if (costDays[i].over) costs.overBudgetDays.push(costDays[i].day);
    }
    costs.over = costs.totalCost > costs.totalBudget + 0.005;
    costs.overBy = costs.over ? Math.round((costs.totalCost - costs.totalBudget) * 100) / 100 : 0;
    return { startPoint: 'A', endPoint: 'B', result: 'DIA 1: ...', structured: {
        version: 2,
        plan: { days: days, order: [], totalKm: (o.km || 0) * dayCount,
            totalMin: (o.km || 0) * dayCount, roundTrip: false, warnings: warnings },
        costs: costs, enrichment: null,
        notices: storedNotices || [],
        meta: { matrixSource: 'haversine', startName: 'A', endName: 'B' }   // no numbersUnreliable
    } };
}

const ZERO_DISTANCE_WARNING = 'zero-distance: the whole itinerary computes to 0 km — the ' +
    'coordinates or the distance matrix are unusable, so the numbers below are not real.';
const UNKNOWN_DISTANCE_WARNING = 'unknown-distance: at least one leg has no usable distance ' +
    'data (place not resolved and no coordinates); it is counted as 0 km.';

test('D1d: a round-1 zero-distance route no longer loads under a reassuring green verdict', function () {
    /* Exactly what round 1 stored: the sentence as untranslated 'other' prose. */
    const doc = round1DocWithWarnings(
        ['distance-source: no road data at all — every distance is a straight-line estimate.',
         UNKNOWN_DISTANCE_WARNING, ZERO_DISTANCE_WARNING],
        [{ code: 'restDay', level: 'info', params: { day: 3, place: 'B' } },
         { code: 'unresolved', level: 'warn', params: { name: 'A' } },
         { code: 'haversine', level: 'warn', params: {} },
         { code: 'other', level: 'info', params: { text: ZERO_DISTANCE_WARNING } }],
        { km: 0, budget: 120 });

    const view = I.viewFromSaved(doc);
    const codes = view.notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('zeroDistance') >= 0,
        'the evidence was in plan.warnings and the loader never looked at it');
    assert.ok(codes.indexOf('unknownDistance') >= 0,
        'round 1 stored no notice for this at all — the commonest under-migration');
    assert.strictEqual(codes.indexOf('other'), -1,
        'the untranslated English duplicate must be replaced, not printed alongside');
    assert.strictEqual(I.hasUnreliableNumbers(view.notices), true);
    assert.strictEqual(view.meta.numbersUnreliable, true);
    assert.strictEqual(view.notices[0].level, 'alert', 'and sorted above the yellows');

    const html = I.renderItineraryHtml(view, CTX);
    assert.match(html, /summary-card summary-unreliable/, 'the card must not be green');
    assert.match(html, /The budget cannot be assessed/);
    assert.strictEqual(html.indexOf('left in budget'), -1,
        'no "EUR 110.00 left in budget" over 0 km / 0 min');
    assert.strictEqual(html.indexOf('>Within budget<'), -1);
    assert.strictEqual(html.indexOf('zero-distance:'), -1,
        'the raw engine string must not reach the screen');
    assert.match(html, /notice-alert/);
    assert.ok(html.indexOf('notice-alert') < html.indexOf('summary-card'));
});

test('D1d: one unresolvable place — round 1 stored NO notice, so nothing was swallowed silently', function () {
    /* The common case: real distances elsewhere, so no zero-distance, but one leg has
       no usable data. Round 1 had unknown-distance in COVERED_WARNINGS and rendered
       nothing for it, so the stored array is simply missing it. */
    const doc = round1DocWithWarnings(
        ['unresolved-place: "Nowheresville" could not be geocoded; its distances are approximate.',
         UNKNOWN_DISTANCE_WARNING],
        [{ code: 'unresolved', level: 'warn', params: { name: 'Nowheresville' } }],
        { km: 300, budget: 400 });

    const view = I.viewFromSaved(doc);
    const codes = view.notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('unknownDistance') >= 0, 'it was swallowed entirely on the load path');
    assert.ok(codes.indexOf('zeroDistance') === -1, 'and only what the plan actually reported');
    assert.ok(codes.indexOf('unresolved') >= 0, 'the notices the document DID carry survive');
    assert.strictEqual(view.meta.numbersUnreliable, true);

    const html = I.renderItineraryHtml(view, CTX);
    assert.match(html, /The budget cannot be assessed/,
        'a leg counted as 0 km makes the cost figures incomplete, so the verdict is withheld');
    assert.strictEqual(html.indexOf('>Within budget<'), -1);
});

test('D1d: the derived alerts are translated in all five locales, on the load path', function () {
    const i18n = loadI18n();
    const doc = round1DocWithWarnings(
        [UNKNOWN_DISTANCE_WARNING, ZERO_DISTANCE_WARNING],
        [{ code: 'other', level: 'info', params: { text: ZERO_DISTANCE_WARNING } }],
        { km: 0, budget: 120 });
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const view = I.viewFromSaved(doc);
        const ctx = { t: i18n.t };
        const zero = view.notices.filter(function (n) { return n.code === 'zeroDistance'; })[0];
        const text = I.noticeText(zero, ctx);
        assert.notStrictEqual(text, 'notice.zeroDistance', LOCALES[i] + ' has no translation');
        assert.strictEqual(text.indexOf('zero-distance:'), -1,
            LOCALES[i] + ' shows the raw English engine string: ' + text);
        assert.strictEqual(text.indexOf('{'), -1);
        const html = I.renderItineraryHtml(view, ctx);
        assert.match(html, /summary-flag flag-unknown/, LOCALES[i] + ' still gives a budget verdict');
        assert.match(html, /summary-card summary-unreliable/, LOCALES[i] + ' still shows a green card');
    }
});

test('D1d: a HEALTHY round-1 document gains no spurious alert', function () {
    const doc = round1DocWithWarnings(
        ['rest-day: day 3 has no driving — rest / explore B (fewer destinations than days).'],
        [{ code: 'restDay', level: 'info', params: { day: 3, place: 'B' } }],
        { km: 300, budget: 400 });
    const view = I.viewFromSaved(doc);
    assert.strictEqual(view.notices.filter(function (n) { return n.level === 'alert'; }).length, 0);
    assert.strictEqual(I.hasUnreliableNumbers(view.notices), false);
    assert.strictEqual(view.meta.numbersUnreliable, false);
    const html = I.renderItineraryHtml(view, CTX);
    assert.strictEqual(html.indexOf('notice-alert'), -1);
    assert.strictEqual(html.indexOf('summary-unreliable'), -1);
    assert.strictEqual(html.indexOf('The budget cannot be assessed'), -1);
    /* The round-4 toll migration still applies: the zero it cannot explain is floored. */
    assert.match(html, /Within budget for what is counted/);
});

test('D1d: the migration copies — a loaded document must not be written back over', function () {
    const doc = round1DocWithWarnings(
        [UNKNOWN_DISTANCE_WARNING, ZERO_DISTANCE_WARNING],
        [{ code: 'other', level: 'info', params: { text: ZERO_DISTANCE_WARNING } }],
        { km: 0, budget: 120 });
    const before = JSON.stringify(doc);
    const view = I.viewFromSaved(doc);
    assert.ok(view.notices.length > doc.structured.notices.length,
        'fixture: the view really did gain notices');
    assert.strictEqual(view.meta.numbersUnreliable, true);
    assert.strictEqual(doc.structured.meta.numbersUnreliable, undefined,
        'the stored meta must not be mutated');
    assert.strictEqual(JSON.stringify(doc), before, 'the stored document was modified in place');
});

test('D1d: round-2/3 documents skip the notice migration entirely', function () {
    /* Including the one shape that exercises it: a live zero-distance view, which
       already carries the alerts and the meta flag. */
    const ghost = function (n) { return P(n, null, null, { resolved: false }); };
    const places = [ghost('A'), ghost('B'), ghost('C')];
    const zeros = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const plan = engine.planRoute({ start: places[0], end: places[2], stops: [places[1]],
        matrix: { km: zeros, min: zeros, source: 'haversine', osrmCells: 0, filledCells: 6 },
        days: 3, departureTime: '09:00', maxDriveMinPerDay: 360 });
    const live = I.buildItineraryView({ plan: plan, requestedStops: ['B'], startName: 'A', endName: 'C',
        places: places, matrixSource: 'haversine', matrixFilledCells: 6, matrixOsrmCells: 0,
        maxDriveMin: 360, dailyBudget: 120, tollsEnabled: true, t: CTX.t });
    const doc = JSON.parse(JSON.stringify({ structured: I.serialiseView(live) }));
    const restored = I.viewFromSaved(doc);
    assert.deepStrictEqual(restored.notices, live.notices, 'the notice list must be untouched');
    assert.strictEqual(restored.meta.numbersUnreliable, live.meta.numbersUnreliable);
    assert.strictEqual(I.renderItineraryHtml(restored, CTX), I.renderItineraryHtml(live, CTX));
});

/* ══════════════ ROUND 6 ══════════════ */

/* ── D6 — the reconciliation migrated the alerts but not their CONSEQUENCE ──
   Round 3 established the rule (withholding the verdict in the summary while asserting
   it in a notice is the same lie in a smaller font) and enforced it inside buildNotices,
   i.e. on the live path only. The load path derived the alerts, set numbersUnreliable and
   withheld every verdict — then passed the stored notice list through unfiltered, so a
   yellow notice judged the budget from numbers the same screen had just called fictional.

   The window is TWO builds wide: round 2 shipped the overBudget notice before round 3
   added the suppression, so both writers are covered below. The stored-notice arrays are
   exactly what each build emitted for this trip (verified against the real modules at
   8699cd1 and 19a08e8). ── */

const LEGACY_WRITERS = {
    /* commit 8699cd1 — no zeroDistance code at all: the engine sentence was stored as
       untranslated prose, and unknown-distance was in COVERED_WARNINGS with nothing
       rendering it. 'haversine' was pushed for EVERY non-osrm source. */
    'round 1': function (over) {
        const n = [{ code: 'unresolved', level: 'warn', params: { name: 'A' } },
                   { code: 'haversine', level: 'warn', params: {} }];
        if (over) n.push({ code: 'overBudget', level: 'warn', params: { days: '1, 2, 3', count: 3 } });
        n.push({ code: 'other', level: 'info', params: { text: ZERO_DISTANCE_WARNING } });
        return n;
    },
    /* commit 19a08e8 — the alert tier exists, but overBudget is still unconditional. */
    'round 2': function (over) {
        const n = [{ code: 'haversine', level: 'alert', params: {} },
                   { code: 'unknownDistance', level: 'alert', params: {} },
                   { code: 'zeroDistance', level: 'alert', params: {} },
                   { code: 'unresolved', level: 'warn', params: { name: 'A' } },
                   { code: 'tollsUnknown', level: 'warn', params: { days: '1, 2, 3' } }];
        if (over) n.push({ code: 'overBudget', level: 'warn', params: { days: '1, 2, 3', count: 3 } });
        return n;
    }
};

test('D6: a pre-round-3 document does not judge the budget it has just refused to judge', function () {
    for (const writer in LEGACY_WRITERS) {
        const doc = round1DocWithWarnings(
            [UNKNOWN_DISTANCE_WARNING, ZERO_DISTANCE_WARNING],
            LEGACY_WRITERS[writer](true), { km: 0, budget: 20 });
        assert.ok(doc.structured.notices.some(function (n) { return n.code === 'overBudget'; }),
            writer + ' fixture: the document really does carry the notice');
        assert.ok(doc.structured.costs.overBudgetDays.length > 0,
            writer + ' fixture: the fictional costs really do exceed the budget');

        const view = I.viewFromSaved(doc);
        const codes = view.notices.map(function (n) { return n.code; });
        assert.strictEqual(view.meta.numbersUnreliable, true, writer);
        assert.strictEqual(codes.indexOf('overBudget'), -1,
            writer + ': the summary and the day cards refuse to judge the budget, and a ' +
            'notice judges it anyway from the same numbers');

        const html = I.renderItineraryHtml(view, CTX);
        assert.match(html, /summary-flag flag-unknown/, writer + ': verdict must stay withheld');
        assert.strictEqual(html.indexOf('Over budget on day'), -1, writer);
        assert.strictEqual(html.indexOf('Over budget by'), -1, writer);
        assert.match(html, /The budget cannot be assessed/, writer);
    }
});

test('D6: the loaded document matches what the live path produces for the same trip', function () {
    /* The live path has emitted no overBudget notice for an unusable-numbers trip since
       round 3. Loading a saved one must not differ. */
    const ghost = function (n) { return P(n, null, null, { resolved: false }); };
    const places = [ghost('A'), ghost('B'), ghost('C')];
    const zeros = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const plan = engine.planRoute({ start: places[0], end: places[2], stops: [places[1]],
        matrix: { km: zeros, min: zeros, source: 'haversine', osrmCells: 0, filledCells: 6 },
        days: 3, departureTime: '09:00', maxDriveMinPerDay: 360 });
    const live = I.buildItineraryView({ plan: plan, requestedStops: ['B'], startName: 'A', endName: 'C',
        places: places, matrixSource: 'haversine', matrixFilledCells: 6, matrixOsrmCells: 0,
        maxDriveMin: 360, dailyBudget: 20, tollsEnabled: true, t: CTX.t });
    assert.ok(live.costs.overBudgetDays.length > 0, 'fixture: the arithmetic does say over budget');
    assert.strictEqual(live.notices.some(function (n) { return n.code === 'overBudget'; }), false,
        'fixture: and the live path already suppresses the notice');

    for (const writer in LEGACY_WRITERS) {
        const doc = round1DocWithWarnings([UNKNOWN_DISTANCE_WARNING, ZERO_DISTANCE_WARNING],
            LEGACY_WRITERS[writer](true), { km: 0, budget: 20 });
        const loaded = I.viewFromSaved(doc);
        assert.strictEqual(loaded.notices.some(function (n) { return n.code === 'overBudget'; }),
            live.notices.some(function (n) { return n.code === 'overBudget'; }),
            writer + ': the load path disagrees with the live path');
    }
});

test('D6: a HEALTHY pre-round-3 document still gets its over-budget notice and verdict', function () {
    for (const writer in LEGACY_WRITERS) {
        const stored = LEGACY_WRITERS[writer](true).filter(function (n) {
            return n.code !== 'other' && n.code !== 'zeroDistance' && n.code !== 'unknownDistance';
        });
        const doc = round1DocWithWarnings(
            ['rest-day: day 3 has no driving — rest / explore B.'], stored, { km: 300, budget: 40 });
        const view = I.viewFromSaved(doc);
        assert.strictEqual(view.meta.numbersUnreliable, false, writer);
        assert.ok(view.notices.map(function (n) { return n.code; }).indexOf('overBudget') >= 0,
            writer + ': suppression must be conditional, not blanket');
        const html = I.renderItineraryHtml(view, CTX);
        assert.match(html, /Over budget on day/, writer);
        assert.match(html, /summary-flag flag-over/, writer);
        assert.strictEqual(html.indexOf('The budget cannot be assessed'), -1, writer);
    }
});

test('D6: a pre-round-3 "mixed" matrix stops claiming there is no road data at all', function () {
    /* Builds before round 3 pushed 'haversine' for EVERY non-osrm source, so the stored
       notice says "no road data" while this build's summary source line, read from the
       same meta.matrixSource, says "partial road data". */
    const doc = round1DocWithWarnings(
        ['distance-source: partial road data — 2 of 6 matrix cells are straight-line estimates.'],
        [{ code: 'haversine', level: 'warn', params: {} }], { km: 300, budget: 400 });
    doc.structured.meta.matrixSource = 'mixed';

    const view = I.viewFromSaved(doc);
    const codes = view.notices.map(function (n) { return n.code; });
    assert.strictEqual(codes.indexOf('haversine'), -1,
        'a 70%-real matrix must not be reported as having no road data');
    assert.ok(codes.indexOf('mixedUnknownCount') >= 0,
        'round-1 meta carries no cell counts, so the countless variant is used');

    const html = I.renderItineraryHtml(view, CTX);
    assert.match(html, /Partial road data/);
    assert.strictEqual(html.indexOf('No road data'), -1, 'the card contradicted itself');

    /* With counts stored (round 2 onwards) the counted sentence is used. */
    const withCounts = round1DocWithWarnings(
        ['distance-source: partial road data — 2 of 6 matrix cells are straight-line estimates.'],
        [{ code: 'haversine', level: 'warn', params: {} }], { km: 300, budget: 400 });
    withCounts.structured.meta.matrixSource = 'mixed';
    withCounts.structured.meta.matrixFilledCells = 2;
    withCounts.structured.meta.matrixOsrmCells = 4;
    const counted = I.viewFromSaved(withCounts).notices.filter(function (n) { return n.code === 'mixed'; })[0];
    assert.ok(counted, 'the counts must be used when the document has them');
    assert.strictEqual(counted.params.filled, 2);
    assert.strictEqual(counted.params.total, 6);

    /* And a genuinely road-data-free document keeps its haversine notice. */
    const hav = round1DocWithWarnings(['distance-source: no road data at all.'],
        [{ code: 'haversine', level: 'warn', params: {} }], { km: 300, budget: 400 });
    assert.ok(I.viewFromSaved(hav).notices.map(function (n) { return n.code; }).indexOf('haversine') >= 0);
});

test('D6: prose without a matching warning now carries the severity, not just the text', function () {
    /* Defensive residue — no shipped writer produces it, since round 1 always stored
       plan.warnings and the prose only ever came from a warning. Closing it costs one
       branch: the prose carries its own `code:` prefix, which is the same evidence. */
    const doc = round1DocWithWarnings([], LEGACY_WRITERS['round 1'](true), { km: 0, budget: 20 });
    assert.deepStrictEqual(doc.structured.plan.warnings, [], 'fixture: warnings stripped');
    const view = I.viewFromSaved(doc);
    const codes = view.notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('zeroDistance') >= 0, 'the prose is evidence in its own right');
    assert.strictEqual(codes.indexOf('other'), -1, 'and it is not printed twice');
    assert.strictEqual(view.meta.numbersUnreliable, true);
    assert.strictEqual(codes.indexOf('overBudget'), -1, 'with the same consequence as any other route');
    assert.match(I.renderItineraryHtml(view, CTX), /The budget cannot be assessed/);
});

/* ── D5b — a trip verdict must not contradict the day card below it ── */

test('D5b: "only because of the estimate" is not claimed over a day that owns its overrun', function () {
    /* Days 1-2 go over only with their toll; day 3 is over by EUR 8.69 with no toll at
       all. Both statements were true at their own aggregate, which is what made the pair
       misleading to anyone scanning the summary and then the cards. */
    const plan = { days: [
        { day: 1, km: 400, driveMin: 240, legs: [{}] },
        { day: 2, km: 400, driveMin: 240, legs: [{}] },
        { day: 3, km: 0, driveMin: 0, legs: [] }
    ] };
    const c = I.computeCosts(plan, { dailyBudget: 150, budgets: [150, 150, 26.31],
        tollsEnabled: true, tolls: [150, 150, null] });
    assert.strictEqual(c.days[0].overDependsOnEstimate, true, 'fixture: day 1 needs its toll to go over');
    assert.strictEqual(c.days[2].over, true, 'fixture: day 3 is over');
    assert.strictEqual(c.days[2].tolls, 0, 'fixture: with no toll at all');
    assert.strictEqual(c.days[2].overDependsOnEstimate, false, 'fixture: so it owns its overrun');

    assert.strictEqual(c.over, true);
    assert.strictEqual(c.overDependsOnEstimate, false,
        'the trip cannot be over ONLY because of the estimate while a day is over without one');
    assert.strictEqual(c.overIncludesEstimate, true, 'the weaker, still-true sentence takes over');

    const html = I.renderItineraryHtml({ plan: plan, costs: c, notices: [], meta: {} }, CTX);
    const trip = /class="summary-flag[^"]*">([^<]*)</.exec(html)[1];
    assert.strictEqual(trip.indexOf('only because of'), -1,
        'trip verdict still contradicts a day card: ' + trip);
    assert.match(trip, /a figure that includes EUR 300\.00 of AI-estimated tolls/);
    /* The day cards keep their own, individually-correct verdicts. */
    const days = (html.match(/class="cost-flag [^"]*">[^<]*/g) || [])
        .map(function (s) { return s.replace(/class="cost-flag [^"]*">/, ''); });
    assert.match(days[0], /but only because of the AI-estimated toll/);
    assert.strictEqual(days[2], 'Over budget by EUR 8.69');
});

/* ── DEFECT 2c — five toll states must be five distinguishable labels ── */

function tollStateRow(basisCase, t) {
    const km = basisCase.km;
    const costs = I.computeCosts({ days: [{ day: 1, km: km, driveMin: 60, legs: km ? [{}] : [] }] },
        Object.assign({ dailyBudget: 500 }, basisCase.opts));
    const html = I.renderItineraryHtml({
        plan: { days: [{ day: 1, km: km, driveMin: 60, legs: [], startPlace: { name: 'A' }, endPlace: { name: 'B' } }] },
        costs: costs, notices: [], meta: {}
    }, { t: t });
    return { basis: costs.days[0].tollsBasis, row: (html.match(/<tr[^>]*><td>[^<]*Tolls[\s\S]*?<\/tr>/) ||
        html.match(/<tr[^>]*><td>[\s\S]{0,40}?<span class="est-flag">[\s\S]*?<\/tr>/) || ['(not found)'])[0] };
}

const TOLL_STATES = [
    { name: 'estimated',   km: 300, opts: { tollsEnabled: true, tolls: [25] } },
    { name: 'clamped',     km: 300, opts: { tollsEnabled: true, tolls: [9999] } },
    { name: 'none',        km: 0,   opts: { tollsEnabled: true, tolls: [9] } },
    { name: 'unknown',     km: 300, opts: { tollsEnabled: true, tolls: [null] } },
    { name: 'not-avoided', km: 300, opts: { tollsEnabled: false, tolls: [null] } }
];

test('D2c: each of the five toll states renders a distinguishable label', function () {
    const byMarker = {};
    for (let i = 0; i < TOLL_STATES.length; i++) {
        const got = tollStateRow(TOLL_STATES[i], CTX.t);
        assert.strictEqual(got.basis, TOLL_STATES[i].name, 'fixture for ' + TOLL_STATES[i].name);
        const marker = (/<span class="est-flag">([^<]*)<\/span>/.exec(got.row) || [, ''])[1];
        assert.ok(marker, TOLL_STATES[i].name + ' has no marker at all: ' + got.row);
        assert.ok(!byMarker[marker],
            TOLL_STATES[i].name + ' shares the marker "' + marker + '" with ' + byMarker[marker] +
            ' — the two are indistinguishable to anyone reading the table');
        byMarker[marker] = TOLL_STATES[i].name;
    }
    assert.strictEqual(Object.keys(byMarker).length, 5);
});

test('D2c: no state is distinguished by colour alone', function () {
    /* Strip every class attribute — which is all that .cost-unknown{color:#8a5a00} rides
       on — and the five rows must still be five different rows. A colour-blind reader,
       a printout and a screen reader all see this version. */
    const plain = {};
    for (let i = 0; i < TOLL_STATES.length; i++) {
        const got = tollStateRow(TOLL_STATES[i], CTX.t);
        const stripped = got.row.replace(/ class="[^"]*"/g, '');
        assert.ok(!plain[stripped],
            TOLL_STATES[i].name + ' is distinguished from ' + plain[stripped] +
            ' only by a class attribute: ' + stripped);
        plain[stripped] = TOLL_STATES[i].name;
    }
    /* And specifically: a computed zero must not be dressed as an AI guess. */
    const none = tollStateRow(TOLL_STATES[2], CTX.t);
    assert.match(none.row, /\(no driving\)/);
    assert.strictEqual(/\(estimate\)/.test(none.row), false,
        'a zero this app computes with certainty must not be presented as a model estimate');
});

test('D2c: the two new markers exist in all five locales and clash with nothing', function () {
    const i18n = loadI18n();
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const markers = ['itin.estimate', 'itin.tollsCapped', 'itin.tollsNoDriving',
            'itin.tollsNotEstimated', 'itin.tollsNotApplicable'].map(function (k) {
            const v = i18n.t(k);
            assert.notStrictEqual(v, k, LOCALES[i] + ' is missing ' + k);
            return v;
        });
        const uniq = markers.filter(function (m, n, a) { return a.indexOf(m) === n; });
        assert.strictEqual(uniq.length, 5,
            LOCALES[i] + ' reuses a marker across toll states: ' + JSON.stringify(markers));
        /* and the rendered rows in that locale are all different */
        const seen = {};
        for (let s = 0; s < TOLL_STATES.length; s++) {
            const row = tollStateRow(TOLL_STATES[s], i18n.t).row.replace(/ class="[^"]*"/g, '');
            assert.ok(!seen[row], LOCALES[i] + ': ' + TOLL_STATES[s].name + ' collides with ' + seen[row]);
            seen[row] = TOLL_STATES[s].name;
        }
    }
});

/* ── DEFECT 3b — a sub-cap invention inside a headline figure needs a caveat ── */

test('D3b2: an over-budget figure that is substantially model money says so', function () {
    /* 700 km: the cap is 200, so EUR 190 passes unclamped and lands in the headline.
       fuel 73.50 + tolls 190 + meals 35 = 298.50 against a EUR 100 budget: over by
       198.50, of which 190.00 is unverified. */
    const plan = { days: [{ day: 1, km: 700, driveMin: 420, legs: [{}] }] };
    const c = I.computeCosts(plan, { dailyBudget: 100, tollsEnabled: true, tolls: [190] });
    assert.strictEqual(c.days[0].tollsBasis, 'estimated', 'fixture: under the cap, unclamped');
    assert.strictEqual(c.days[0].over, true);
    assert.strictEqual(c.days[0].overDependsOnEstimate, false,
        'fixture: it is over budget for other reasons too, so the round-2 caveat stays silent');
    assert.strictEqual(c.days[0].overIncludesEstimate, true);

    const html = I.renderItineraryHtml({ plan: plan, costs: c, notices: [], meta: {} }, CTX);
    assert.match(html, /Over budget by EUR 198\.50, a figure that includes EUR 190\.00 of AI-estimated tolls/);
    assert.strictEqual(/Over budget by EUR 198\.50<\/div>/.test(html), false,
        'a flat verdict must not carry EUR 190 of model money without a caveat');
});

test('D3b2: a small estimate does not trigger the caveat, and the round-2 wording still wins', function () {
    const plan = { days: [{ day: 1, km: 700, driveMin: 420, legs: [{}] }] };

    /* EUR 5 of tolls in a EUR 113.50 total: removing it would not change what the
       figure tells the user. No caveat, no noise. */
    const small = I.computeCosts(plan, { dailyBudget: 100, tollsEnabled: true, tolls: [5] });
    assert.strictEqual(small.days[0].over, true);
    assert.strictEqual(small.days[0].overIncludesEstimate, false);
    assert.match(I.renderItineraryHtml({ plan: plan, costs: small, notices: [], meta: {} }, CTX),
        /cost-flag flag-over">Over budget by EUR 13\.50<\/div>/);

    /* And where the estimate is the ONLY reason, the stronger round-2 sentence is used
       rather than the weaker "includes" one. */
    const only = I.computeCosts(plan, { dailyBudget: 130, tollsEnabled: true, tolls: [40] });
    assert.strictEqual(only.days[0].overDependsOnEstimate, true);
    assert.strictEqual(only.days[0].overIncludesEstimate, false, 'the two must be mutually exclusive');
    assert.match(I.renderItineraryHtml({ plan: plan, costs: only, notices: [], meta: {} }, CTX),
        /but only because of the AI-estimated toll/);
});

test('D3b2: the caveat applies to the trip verdict too, in all five locales', function () {
    const i18n = loadI18n();
    const plan = { days: [
        { day: 1, km: 700, driveMin: 420, legs: [{}] },
        { day: 2, km: 700, driveMin: 420, legs: [{}] }
    ] };
    const c = I.computeCosts(plan, { dailyBudget: 100, tollsEnabled: true, tolls: [190, 190] });
    assert.strictEqual(c.over, true);
    assert.strictEqual(c.overDependsOnEstimate, false);
    assert.strictEqual(c.overIncludesEstimate, true);
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const s = i18n.tf('itin.overBudgetByWithEstimate', { amount: 'EUR 1.00', tolls: 'EUR 2.00' });
        assert.notStrictEqual(s, 'itin.overBudgetByWithEstimate', LOCALES[i] + ' is missing it');
        assert.strictEqual(s.indexOf('{'), -1, LOCALES[i] + ' left a placeholder');
        assert.notStrictEqual(s, i18n.tf('itin.overBudgetBy', { amount: 'EUR 1.00' }),
            LOCALES[i] + ' reuses the plain wording');
        const html = I.renderItineraryHtml({ plan: plan, costs: c, notices: [], meta: {} }, { t: i18n.t });
        assert.ok(html.indexOf('summary-flag flag-over">' + I.escapeText(
            i18n.tf('itin.overBudgetByWithEstimate',
                { amount: 'EUR ' + c.overBy.toFixed(2), tolls: 'EUR ' + c.totalTolls.toFixed(2) }))) >= 0,
            LOCALES[i] + ' trip verdict does not carry the caveat');
    }
});

/* ── DEFECT 1b (round 3) — "avoid tolls" is a request the pipeline never acts on ──
   Nothing adds exclude=toll to the road-graph calls, so choosing "without tolls"
   changes the route not at all. Printing EUR 0.00 there invents the one fact the app
   never established: either the toll line is wrong (the user drives the route shown)
   or the distances are (they really avoid tolls). ── */

function tollPrefViews(t) {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const base = {
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 500, departureTime: '09:00', t: t,
        enrichment: I.parseEnrichment(null, 3)
    };
    return {
        without: I.buildItineraryView(Object.assign({}, base,
            { tollsEnabled: false, tollPreference: 'without-tolls' })),
        with_: I.buildItineraryView(Object.assign({}, base,
            { tollsEnabled: true, tollPreference: 'with-tolls' }))
    };
}

test('D1b: "without tolls" does not re-plan the route, so it must not print a computed zero', function () {
    const v = tollPrefViews(CTX.t);

    /* The premise: the preference reaches the cost switch and the model prompt, and
       nothing else. Same stops, same order, same kilometres. */
    assert.deepStrictEqual(
        v.without.plan.order.map(function (p) { return p.name; }),
        v.with_.plan.order.map(function (p) { return p.name; }),
        'fixture: the route is identical, so the toll preference changed nothing');
    assert.strictEqual(v.without.plan.totalKm, v.with_.plan.totalKm);

    const days = v.without.costs.days;
    assert.strictEqual(days[0].tollsBasis, 'not-avoided');
    assert.strictEqual(days[0].tollsKnown, false, 'zero here was never established');
    assert.strictEqual(days[0].incomplete, true, 'so the day total is a floor');
    assert.strictEqual(v.without.costs.tollsNotAvoided, true);
    assert.deepStrictEqual(v.without.costs.notAvoidedTollDays, [1, 2],
        'the rest day is excluded: no driving really does mean no tolls');

    const html = I.renderItineraryHtml(v.without, CTX);
    assert.strictEqual(
        (html.match(/<tr class="cost-unknown"><td>Tolls <span class="est-flag">\(not applicable\)<\/span><\/td><td class="mono">—<\/td><\/tr>/g) || []).length, 2,
        'the toll line must read "not applicable", never a computed EUR 0.00');
    assert.strictEqual(html.indexOf('<td>Tolls</td><td class="mono">EUR 0.00'), -1);
    assert.match(html, /at least EUR/, 'the total is labelled a minimum');
    assert.match(html, /summary-flag flag-unknown/, 'and the trip verdict is withheld');

    const codes = v.without.notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('tollsNotAvoided') >= 0,
        'the screen must say the route was not re-planned — silence here is the lie');
    const notice = v.without.notices.filter(function (n) { return n.code === 'tollsNotAvoided'; })[0];
    assert.strictEqual(notice.level, 'warn');
});

test('D1b: the "without tolls" gap is a DIFFERENT gap from "nobody estimated it"', function () {
    const v = tollPrefViews(CTX.t);
    const w = v.without.costs, t = v.with_.costs;
    assert.strictEqual(w.tollsNotAvoided, true);
    assert.strictEqual(w.tollsUnknown, false);
    assert.strictEqual(t.tollsNotAvoided, false);
    assert.strictEqual(t.tollsUnknown, true, 'with tolls on and no model answer, it is unknown');
    /* Different explanation, different marker — the user can tell which one happened. */
    assert.notStrictEqual(
        I.noticeText(v.without.notices.filter(function (n) { return n.code === 'tollsNotAvoided'; })[0], CTX),
        I.noticeText(v.with_.notices.filter(function (n) { return n.code === 'tollsUnknown'; })[0], CTX));
});

test('D1b: the not-avoided explanation exists in all five locales', function () {
    const i18n = loadI18n();
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const s = i18n.t('notice.tollsNotAvoided');
        assert.notStrictEqual(s, 'notice.tollsNotAvoided', LOCALES[i] + ' is missing it');
        assert.notStrictEqual(i18n.t('itin.tollsNotApplicable'), 'itin.tollsNotApplicable', LOCALES[i]);
        assert.notStrictEqual(i18n.t('itin.tollsNotApplicable'), i18n.t('itin.tollsNotEstimated'),
            LOCALES[i] + ' reuses one marker for two different gaps');
        const v = tollPrefViews(i18n.t).without;
        assert.match(I.renderItineraryHtml(v, { t: i18n.t }), /flag-unknown/,
            LOCALES[i] + ' still shows a pass/fail verdict');
    }
});

/* ── DEFECT 2b (round 3) — the bound must not reject fixed-price crossings ──
   Real 2026 car prices, one way. A per-km-only cap calls the model a liar for being
   right about a flat charge that owes nothing to distance. ── */

const REAL_CROSSINGS = [
    ['Oresund bridge',    60, 60.00],
    ['Mont Blanc tunnel', 40, 49.60],
    ['Frejus tunnel',     45, 49.60],
    ['Great St Bernard',  30, 30.60],
    ['Storebaelt',        90, 33.00],
    /* the priciest realistic PAIR in one day: Copenhagen -> Malmo */
    ['Storebaelt + Oresund', 200, 93.00],
    /* and the Alpine pair */
    ['Mont Blanc + Frejus',  250, 99.20]
];

test('D2b: a real fixed-price crossing is not clamped and not called implausible', function () {
    for (let i = 0; i < REAL_CROSSINGS.length; i++) {
        const name = REAL_CROSSINGS[i][0], km = REAL_CROSSINGS[i][1], real = REAL_CROSSINGS[i][2];
        const c = I.computeCosts({ days: [{ day: 1, km: km, driveMin: km, legs: [{}] }] },
            { dailyBudget: 400, tollsEnabled: true, tolls: [real] });
        assert.strictEqual(c.days[0].tolls, real,
            name + ' (' + km + ' km, EUR ' + real + ') was clamped to EUR ' + c.days[0].tolls +
            ' — the model was right and the app called it implausible');
        assert.strictEqual(c.days[0].tollsBasis, 'estimated');
        assert.strictEqual(c.clampedTolls.length, 0, name + ' produced a false clamp notice');
        assert.strictEqual(c.days[0].incomplete, false, name + ' is a settled figure');
    }
});

test('D2b: the bound still rejects a hallucination by a wide margin', function () {
    const c = I.computeCosts({ days: [{ day: 1, km: 300, driveMin: 180, legs: [{}] }] },
        { dailyBudget: 400, tollsEnabled: true, tolls: [4998] });
    assert.ok(c.days[0].tolls <= 200, 'still bounded: ' + c.days[0].tolls);
    assert.strictEqual(c.clampedTolls.length, 1);
    /* The cap sits comfortably above every real price and far below the hallucination. */
    assert.ok(I.tollCapForDay(300) >= 99.20 * 1.5, 'headroom over the priciest real day');
    assert.ok(I.tollCapForDay(300) < 4998 / 20, 'and still an order of magnitude below the junk');
    assert.strictEqual(I.tollCapForDay(0), 0, 'no driving, no toll allowance');
});

test('D2b: a CLAMPED day is a floor, with its budget verdict withheld', function () {
    /* The shape of the old bug: clamping cuts the figure down, so the total lands
       inside the budget and a clean verdict is given on money that was reduced. */
    const plan = { days: [{ day: 1, km: 60, driveMin: 60, legs: [{}] }] };
    const c = I.computeCosts(plan, { dailyBudget: 200, tollsEnabled: true, tolls: [250] });
    assert.strictEqual(c.days[0].tollsBasis, 'clamped');
    assert.ok(c.days[0].tolls < 250, 'fixture: the figure really was cut down');
    assert.strictEqual(c.days[0].over, false, 'fixture: after the cut it looks affordable');
    assert.strictEqual(c.days[0].incomplete, true,
        'a reduced number must not be presented with the confidence of a computed one');
    assert.strictEqual(c.incomplete, true);

    const html = I.renderItineraryHtml({ plan: plan, costs: c, notices: [], meta: {} }, CTX);
    assert.strictEqual(html.indexOf('>Within budget<'), -1, 'no clean verdict on a reduced total');
    assert.match(html, /at least EUR/);
    assert.match(html, /cost-flag flag-unknown/);
    /* and the shown figure carries a marker of its own, not one shared with a plain
       estimate and not colour alone (see D2c) */
    assert.match(html, /<td>Tolls <span class="est-flag">\(estimate, capped\)<\/span>/);

    /* A floor verdict, by contrast, survives the cut: if the REDUCED total is already
       over budget, the real one is too. That one is still asserted. */
    const over = I.computeCosts(plan, { dailyBudget: 130, tollsEnabled: true, tolls: [250] });
    assert.strictEqual(over.days[0].over, true);
    assert.match(I.renderItineraryHtml({ plan: plan, costs: over, notices: [], meta: {} }, CTX),
        /cost-flag flag-over/);
});

/* ── DEFECT 2 — "the numbers below are not real" must be loud and translated ── */

function zeroDistanceView(t, days, dailyBudget) {
    const ghost = function (n) { return P(n, null, null, { resolved: false }); };
    const places = [ghost('A'), ghost('B'), ghost('C')];
    const zeros = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const matrix = { km: zeros, min: zeros, source: 'haversine', osrmCells: 0, filledCells: 6 };
    const plan = engine.planRoute({
        start: places[0], end: places[2], stops: [places[1]],
        matrix: matrix, days: days || 3, departureTime: '09:00', maxDriveMinPerDay: 360
    });
    return I.buildItineraryView({
        plan: plan, requestedStops: ['B'], startName: 'A', endName: 'C', places: places,
        matrixSource: 'haversine', matrixFilledCells: 6, matrixOsrmCells: 0,
        maxDriveMin: 360, dailyBudget: dailyBudget === undefined ? 120 : dailyBudget,
        tollsEnabled: true, t: t
    });
}

test('D2: a zero-distance itinerary is the loudest notice on the page, not a blue aside', function () {
    const view = zeroDistanceView(CTX.t);
    const zero = view.notices.filter(function (n) { return n.code === 'zeroDistance'; });
    assert.strictEqual(zero.length, 1, 'the engine warning must reach the user as a real notice');
    assert.strictEqual(zero[0].level, 'alert', 'not notice-info: these numbers are not real');
    assert.strictEqual(view.notices[0].level, 'alert', 'it is printed first, above the trivia');

    const text = I.noticeText(zero[0], CTX);
    assert.strictEqual(text.indexOf('zero-distance:'), -1,
        'the raw English engine string must not leak into the UI');
    assert.strictEqual(text.indexOf('{'), -1, 'no unfilled placeholder');

    const html = I.renderItineraryHtml(view, CTX);
    assert.match(html, /notice-alert/);
    assert.ok(html.indexOf('notice-alert') < html.indexOf('summary-card'),
        'the alert is above the summary card, not under it');
});

test('D2: unusable numbers suppress the budget verdict instead of dressing it in green', function () {
    const view = zeroDistanceView(CTX.t);
    const html = I.renderItineraryHtml(view, CTX);
    assert.strictEqual(html.indexOf('summary-card summary-over'), -1);
    assert.match(html, /summary-card summary-unreliable/, 'the summary card is not green');
    assert.strictEqual(html.indexOf('left'), -1, 'no "EUR 135.00 left of budget" reassurance');
    assert.strictEqual(html.indexOf('>Within budget<'), -1);
    assert.match(html, /The budget cannot be assessed/);
    assert.match(html, /flag-unknown/);
    assert.strictEqual(view.meta.numbersUnreliable, true);
});

test('D2: the unreliable-numbers notices are translated in all five locales', function () {
    const i18n = loadI18n();
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const view = zeroDistanceView(i18n.t);
        const ctx = { t: i18n.t };
        const zero = view.notices.filter(function (n) { return n.code === 'zeroDistance'; })[0];
        const text = I.noticeText(zero, ctx);
        assert.notStrictEqual(text, 'notice.zeroDistance', LOCALES[i] + ' has no translation');
        assert.strictEqual(text.indexOf('the whole itinerary computes to 0 km'),
            LOCALES[i] === 'en' ? text.indexOf('the whole itinerary computes to 0 km') : -1,
            LOCALES[i] + ' shows raw English: "' + text + '"');
        /* and the verdict is suppressed in that locale too */
        const html = I.renderItineraryHtml(view, ctx);
        assert.match(html, /flag-unknown/, LOCALES[i] + ' still shows a pass/fail budget verdict');
    }
});

test('D2: unknown-distance is surfaced too — it was covered but never rendered', function () {
    const plan = {
        days: [{ day: 1, km: 10, driveMin: 10, legs: [{}] }], order: [],
        totalKm: 10, totalMin: 10,
        warnings: ['unknown-distance: at least one leg has no usable distance data.']
    };
    const notices = I.buildNotices(plan, { costs: I.computeCosts(plan, { dailyBudget: 500 }) });
    const codes = notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('unknownDistance') >= 0,
        'the warning was in COVERED_WARNINGS with nothing covering it — silently swallowed');
    assert.strictEqual(notices.filter(function (n) { return n.code === 'unknownDistance'; })[0].level, 'alert');
    assert.strictEqual(I.hasUnreliableNumbers(notices), true);
});

test('D3b: an over-budget NOTICE is not asserted from numbers declared unusable', function () {
    const view = zeroDistanceView(CTX.t, 6, 20);
    assert.strictEqual(view.meta.numbersUnreliable, true);
    assert.ok(view.costs.overBudgetDays.length > 0,
        'fixture: the raw arithmetic does say every day is over budget');

    const codes = view.notices.map(function (n) { return n.code; });
    assert.strictEqual(codes.indexOf('overBudget'), -1,
        'withholding the verdict in the summary while asserting it in a notice is the ' +
        'same claim in a smaller font');

    const html = I.renderItineraryHtml(view, CTX);
    assert.strictEqual(html.indexOf('Over budget on day'), -1);
    assert.strictEqual(html.indexOf('Over budget by'), -1);
    assert.match(html, /The budget cannot be assessed/);

    /* Control: with usable distances the notice is still given. */
    const ok = I.buildItineraryView({
        plan: planFor(MADRID, BARCELONA, [ZARAGOZA], 2),
        requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 10, tollsEnabled: true, t: CTX.t
    });
    assert.ok(ok.notices.map(function (n) { return n.code; }).indexOf('overBudget') >= 0,
        'suppression must be conditional, not blanket');
});

/* ── DEFECT 4b (round 3) — units belong to the language the notice is READ in ── */

test('D4b: a notice built in one language carries no units from it into another', function () {
    const i18n = loadI18n();
    i18n.setLanguage('en');
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 1);   // one day -> over the drive cap
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 150, tollsEnabled: true, t: i18n.t,
        enrichment: I.parseEnrichment(JSON.stringify({ days: [{ day: 1, tip: 'x', tollsEur: 4998 }] }), 1)
    });
    const pick = function (code) {
        return view.notices.filter(function (n) { return n.code === code; })[0];
    };
    assert.ok(pick('overCap') && pick('tollsClamped'), 'fixture: both notices are present');

    /* Params are stored raw — a formatted string here is a unit frozen at build time. */
    assert.strictEqual(typeof pick('overCap').params.drive, 'number');
    assert.strictEqual(typeof pick('overCap').params.cap, 'number');
    assert.strictEqual(typeof pick('tollsClamped').params.km, 'number');

    const en = I.noticeText(pick('overCap'), { t: i18n.t });
    assert.match(en, /h/, 'fixture: English renders hours as "h"');

    i18n.setLanguage('zh');
    const zhCtx = { t: i18n.t };
    const zhCap = I.noticeText(pick('overCap'), zhCtx);
    const zhToll = I.noticeText(pick('tollsClamped'), zhCtx);
    assert.match(zhCap, /小时/, 'the hour unit must follow the language: ' + zhCap);
    assert.strictEqual(/\d\s*h\b/.test(zhCap), false, 'English "h" survived into zh: ' + zhCap);
    assert.match(zhToll, /公里/, 'the km unit must follow the language: ' + zhToll);
    assert.strictEqual(zhToll.indexOf(' km'), -1, 'English " km" survived into zh: ' + zhToll);
    assert.strictEqual(zhCap.indexOf('{'), -1);
    assert.strictEqual(zhToll.indexOf('{'), -1);

    /* Every locale, both notices, no placeholder and no foreign unit left behind. */
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const ctx = { t: i18n.t };
        const km = i18n.t('unit.km'), hour = i18n.t('unit.hour');
        assert.ok(I.noticeText(pick('tollsClamped'), ctx).indexOf(km) >= 0, LOCALES[i] + ' km unit');
        assert.ok(I.noticeText(pick('overCap'), ctx).indexOf(hour) >= 0, LOCALES[i] + ' hour unit');
    }
});

/* ── DEFECT 3 — 'mixed' is not 'haversine' ── */

test("D3: a partly-real matrix does not claim there is no road data at all", function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const base = {
        startName: 'Madrid', endName: 'Barcelona', requestedStops: ['Zaragoza'],
        maxDriveMin: 360, costs: I.computeCosts(plan, { dailyBudget: 500, tollsEnabled: false }), t: CTX.t
    };
    const mixed = I.buildNotices(plan, Object.assign({}, base, {
        matrixSource: 'mixed', matrixOsrmCells: 6, matrixFilledCells: 14
    }));
    const hav = I.buildNotices(plan, Object.assign({}, base, {
        matrixSource: 'haversine', matrixOsrmCells: 0, matrixFilledCells: 20
    }));

    const mixedCodes = mixed.map(function (n) { return n.code; });
    const havCodes = hav.map(function (n) { return n.code; });
    assert.notDeepStrictEqual(mixedCodes, havCodes,
        "'mixed' and 'haversine' produced identical notice codes");
    assert.ok(mixedCodes.indexOf('mixed') >= 0 && mixedCodes.indexOf('haversine') === -1);
    assert.ok(havCodes.indexOf('haversine') >= 0 && havCodes.indexOf('mixed') === -1);

    const mixedNotice = mixed.filter(function (n) { return n.code === 'mixed'; })[0];
    assert.strictEqual(mixedNotice.level, 'warn', 'partial data is a warning');
    assert.strictEqual(hav.filter(function (n) { return n.code === 'haversine'; })[0].level, 'alert',
        'no road data at all is more severe than some road data');

    /* the counts the engine computed must survive into the sentence */
    assert.strictEqual(mixedNotice.params.filled, 14);
    assert.strictEqual(mixedNotice.params.total, 20);
    const text = I.noticeText(mixedNotice, CTX);
    assert.match(text, /14/); assert.match(text, /20/);
    assert.strictEqual(text.indexOf('{'), -1);
});

test('D3: mixed and haversine read differently in all five locales, and so does the source line', function () {
    const i18n = loadI18n();
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const mixed = i18n.tf('notice.mixed', { filled: 14, total: 20 });
        const hav = i18n.t('notice.haversine');
        assert.notStrictEqual(mixed, hav, LOCALES[i] + ' reuses one string for both');
        assert.notStrictEqual(mixed, 'notice.mixed', LOCALES[i] + ' has no mixed translation');
        assert.strictEqual(mixed.indexOf('{'), -1, LOCALES[i] + ' left a placeholder');
        assert.ok(mixed.indexOf('14') >= 0 && mixed.indexOf('20') >= 0,
            LOCALES[i] + ' drops the counts');
        assert.notStrictEqual(i18n.t('itin.sourcePartial'), 'itin.sourcePartial');
        assert.notStrictEqual(i18n.t('itin.sourcePartial'), i18n.t('itin.sourceEstimated'));
    }
});

test('D3: a mixed matrix labels the summary source line as partial, not as "no road data"', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'mixed',
        matrixOsrmCells: 6, matrixFilledCells: 14, maxDriveMin: 360,
        dailyBudget: 500, tollsEnabled: false, t: CTX.t
    });
    const html = I.renderItineraryHtml(view, CTX);
    assert.match(html, /Partial road data/);
    assert.strictEqual(html.indexOf('>Estimated<'), -1);
});

/* ── DEFECT 4 — the one number the model supplies must be bounded and owned ── */

test('D4: an absurd model toll is capped, and the cap is reported', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const enrichment = I.parseEnrichment(JSON.stringify({
        days: [
            { day: 1, tip: 'x', tollsEur: 4998 },
            { day: 2, tip: 'x', tollsEur: 4998 },
            { day: 3, tip: 'x', tollsEur: 4998 }
        ]
    }), 3);
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Zaragoza'], startName: 'Madrid', endName: 'Barcelona',
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 120, tollsEnabled: true, t: CTX.t, enrichment: enrichment
    });
    for (let i = 0; i < view.costs.days.length; i++) {
        const d = view.costs.days[i];
        assert.ok(d.tolls <= I.tollCapForDay(d.km) + 0.005,
            'day ' + d.day + ' kept an unbounded ' + d.tolls);
        assert.ok(d.tolls < 4998, 'the model number went straight through');
        if (d.km > 0) {
            assert.ok(d.tollsClamped, 'the clamp must be recorded, not applied silently');
            assert.strictEqual(d.tollsBasis, 'clamped');
            assert.strictEqual(d.incomplete, true,
                'a REDUCED figure is a floor — it must not wear the confidence of a computed one');
        } else {
            assert.strictEqual(d.tolls, 0, 'a day with no driving incurs no toll');
            assert.strictEqual(d.tollsBasis, 'none');
        }
    }
    assert.ok(view.costs.totalCost < 1500,
        'a hallucinated toll must not be able to multiply the trip cost: ' + view.costs.totalCost);
    assert.strictEqual(view.costs.clampedTolls.length, 2, 'the two driving days');

    const codes = view.notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('tollsClamped') >= 0, 'the user is told a number was rejected');
    const clamp = view.notices.filter(function (n) { return n.code === 'tollsClamped'; })[0];
    const text = I.noticeText(clamp, CTX);
    assert.match(text, /4998\.00/, 'the rejected value is named');
    assert.strictEqual(text.indexOf('{'), -1);
});

test('D4: a verdict that only exists because of a model number says so', function () {
    /* Day 1: fuel 10.5 + lodging 60 + meals 35 = 105.5 against a 115 budget: inside.
       The model's 20 EUR toll (under the cap, so used as given) is the only thing
       that pushes it over. */
    const plan = { days: [{ day: 1, km: 100, driveMin: 60, legs: [{}] }, { day: 2, km: 100, driveMin: 60, legs: [{}] }] };
    const c = I.computeCosts(plan, { dailyBudget: 115, tollsEnabled: true, tolls: [20, 20] });
    assert.strictEqual(c.days[0].tolls, 20, 'fixture: this estimate is inside the plausible bound');
    assert.strictEqual(c.days[0].over, true);
    assert.strictEqual(c.days[0].overDependsOnEstimate, true,
        'without the estimate this day was inside its budget');

    const view = { plan: plan, costs: c, notices: [], meta: {}, enrichment: null };
    const html = I.renderItineraryHtml(view, CTX);
    assert.match(html, /but only because of the AI-estimated toll/,
        'the verdict must carry the dependency, not only the cost row');

    /* Same at trip level: 151 of computed cost against a 190 budget, over only once the
       model's 40 EUR of tolls are added — AND no day owns its overrun independently
       (day 1 goes over only with its toll, day 2 stays inside). See D5b: without that
       second condition the trip sentence contradicts a day card. */
    const trip = I.computeCosts(plan, { dailyBudget: 95, budgets: [120, 70], tollsEnabled: true, tolls: [20, 20] });
    assert.strictEqual(trip.over, true);
    assert.strictEqual(trip.days[0].over, true);
    assert.strictEqual(trip.days[0].overDependsOnEstimate, true);
    assert.strictEqual(trip.days[1].over, false);
    assert.strictEqual(trip.overDependsOnEstimate, true);
    assert.match(I.renderItineraryHtml({ plan: plan, costs: trip, notices: [], meta: {} }, CTX),
        /summary-flag flag-over">Over budget by[^<]*AI-estimated toll/);

    /* A day that is over budget on computed costs alone owns its verdict outright. */
    const solid = I.computeCosts(plan, { dailyBudget: 10, tollsEnabled: true, tolls: [20, 20] });
    assert.strictEqual(solid.days[0].over, true);
    assert.strictEqual(solid.days[0].overDependsOnEstimate, false);
    assert.strictEqual(solid.overDependsOnEstimate, false);
});

/* ── B9 — the displayed numbers add up ── */

test('B9: per-day figures sum exactly to the displayed trip totals', function () {
    /* Independent rounding of the raw total drifts from the sum of the rounded days
       (1682 vs 1681 was the worst observed). Round once. */
    for (let d = 2; d <= 6; d++) {
        for (let k = 0; k < 40; k++) {
            const plan = planFor(
                P('A', 40 + k * 0.13, -3 - k * 0.07), P('D', 39 + k * 0.05, 1 - k * 0.02),
                [P('B', 41 + k * 0.11, k * 0.05), P('C', 42 - k * 0.09, 2 + k * 0.03)], d);
            const totals = I.displayTotals(plan);
            let km = 0, min = 0;
            for (let i = 0; i < plan.days.length; i++) {
                const shown = I.formatKm(plan.days[i].km, CTX);
                km += Number(shown.replace(' km', ''));
                min += Math.round(plan.days[i].driveMin);
            }
            assert.ok(Math.abs(km - totals.km) < 0.001,
                'days=' + d + ' k=' + k + ': shown days sum to ' + km + ' but the total says ' + totals.km);
            assert.strictEqual(min, totals.min, 'days=' + d + ' k=' + k + ': minutes drift');
            assert.strictEqual(I.formatKmTotal(totals.km, CTX), km + ' km');
        }
    }
});

/* ── DEFECT 5 / 6 — the live UI layer, exercised for real ──
   route-form.js is a classic script full of globals; load it into a sandbox with a
   fake DOM so the generation guard and the language hook are tested as behaviour,
   not as a grep over the source. */
function loadRouteForm(opts) {
    const o = opts || {};
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'js', 'route-form.js'), 'utf8');
    const els = {};
    const created = [];          /* every element the wiring builds by hand */

    /* A DOM stub with just enough tree for the map legend and the notice the map
       appends to the itinerary's own notice list. */
    function node(tag, id) {
        const e = {
            id: id || '', tagName: String(tag || 'div').toUpperCase(),
            value: '', checked: false, disabled: false, textContent: '',
            className: '', title: '', href: '', download: '', style: {}, childNodes: [],
            addEventListener: function (name, fn) { (e.listeners[name] = e.listeners[name] || []).push(fn); },
            listeners: {},
            appendChild: function (c) { e.childNodes.push(c); return c; },
            removeChild: function (c) {
                const i = e.childNodes.indexOf(c);
                if (i >= 0) e.childNodes.splice(i, 1);
                return c;
            },
            insertBefore: function (c) { e.childNodes.unshift(c); return c; },
            click: function () { e.clicked = (e.clicked || 0) + 1; },
            querySelector: function (sel) { return findByClass(e, String(sel).replace(/^\./, '')); }
        };
        Object.defineProperty(e, 'firstChild', { get: function () { return e.childNodes[0] || null; } });
        /* Writing innerHTML replaces the children, exactly as the DOM does — without
           this the second render of a generation leaves the first render's appended
           nodes behind and the harness reports duplicates the browser never shows. */
        let html = '';
        Object.defineProperty(e, 'innerHTML', {
            get: function () { return html; },
            set: function (v) { html = String(v); e.childNodes.length = 0; }
        });
        return e;
    }
    function findByClass(root, cls) {
        for (let i = 0; i < root.childNodes.length; i++) {
            const c = root.childNodes[i];
            if ((' ' + c.className + ' ').indexOf(' ' + cls + ' ') >= 0) return c;
            const deep = findByClass(c, cls);
            if (deep) return deep;
        }
        return null;
    }
    const ids = ['rfStartPoint', 'rfEndPoint', 'rfDestinations', 'rfTripType', 'rfDuration',
        'rfDailyBudget', 'rfCustomBudget', 'rfTolls', 'rfDepartureTime', 'rfConsumption',
        'rfFuelPrice', 'rfLodging', 'rfMeals', 'generateBtn', 'clearBtn', 'saveRouteBtn',
        'resultEmpty', 'resultLoading', 'resultContent', 'resultError', 'resultHeader',
        'resultItinerary', 'resultBody', 'progressBar', 'progressStep', 'progressDetail',
        'progressNote', 'enrichStatus', 'budgetPerDayContainer', 'formMsg', 'advancedToggle',
        'advancedPanel', 'advancedIcon',
        /* the map + export surface */
        'routeMapPanel', 'routeMapTitle', 'routeMapSource', 'routeMapFigure', 'routeMapLegend',
        'exportBar', 'exportGpxBtn', 'exportIcsBtn', 'exportPrintBtn', 'exportStartDate', 'exportHint'];
    for (let i = 0; i < ids.length; i++) els[ids[i]] = node('div', ids[i]);
    const body = node('body');
    const document = {
        body: body,
        getElementById: function (id) { return els[id] || null; },
        createElement: function (tag) { const e = node(tag); created.push(e); return e; }
    };

    const i18n = loadI18n();
    let geometryCalls = 0;
    const windowObj = {
        TravioItinerary: I,
        TravioMap: o.noMap ? null : MAPMOD,
        TravioExport: o.noExport ? null : EXPMOD,
        planRoute: engine.planRoute,
        geocodePlaces: o.geocodePlaces || function (names) {
            return Promise.resolve(names.map(function (n) {
                const known = { Madrid: MADRID, Barcelona: BARCELONA, Zaragoza: ZARAGOZA }[n];
                return known || P(n, 41, 1);
            }));
        }
    };
    /* js/geo-provider.js is another builder's file and its outlier check may or may
       not be present. The wiring must consume it when it is there and stay silent
       when it is not, so the harness can supply either. */
    if (o.geo) windowObj.TravioGeo = o.geo;
    if (o.geometry !== 'absent') {
        windowObj.routeGeometry = function (places) {
            geometryCalls++;
            if (o.geometry === 'throw') return Promise.reject(new Error('offline'));
            const line = places.map(function (p) { return [p.lat, p.lon]; });
            if (o.geometry === 'road') {
                /* a denser line, so the simplifier and the day split have something
                   to work with, tagged the way geo-provider tags a verified one */
                const dense = [];
                for (let i = 0; i + 1 < line.length; i++) {
                    for (let k = 0; k < 8; k++) {
                        dense.push([line[i][0] + (line[i + 1][0] - line[i][0]) * k / 8,
                            line[i][1] + (line[i + 1][1] - line[i][1]) * k / 8]);
                    }
                }
                dense.push(line[line.length - 1]);
                Object.defineProperty(dense, 'source', { value: 'osrm', enumerable: false });
                return Promise.resolve(dense);
            }
            Object.defineProperty(line, 'source', { value: 'straight', enumerable: false });
            return Promise.resolve(line);
        };
    }

    const downloads = [];
    const saved = [];
    const revoked = [];
    const URLstub = {
        createObjectURL: function (blob) { return 'blob:' + (downloads.push(blob) - 1); },
        revokeObjectURL: function (url) { revoked.push(url); }
    };
    function BlobStub(parts, opts2) {
        this.text = (parts || []).join('');
        this.type = (opts2 && opts2.type) || '';
    }

    const fn = new Function(
        'document', 'window', 't', 'tf', 'currentLang', 'escapeHtml', 'geocodePlaces',
        'distanceMatrix', 'planRoute', 'fetch', 'console', 'onLanguageChange', 'setTimeout',
        'routeGeometry', 'URL', 'Blob', 'db', 'currentUser', 'fsSaveRoute', 'showView',
        'applyTranslations',
        src + '\nreturn { initRouteForm: initRouteForm, generateRoute: generateRoute, ' +
        'clearForm: clearForm, displayRoute: displayRoute, ' +
        'saveCurrentRoute: saveCurrentRoute, viewSavedRoute: viewSavedRoute, ' +
        'exportGpx: exportGpx, exportIcs: exportIcs, exportPrint: exportPrint, ' +
        'flattenGeometry: flattenGeometry, unflattenGeometry: unflattenGeometry, ' +
        'savedGeometry: savedGeometry, storedGeometryOf: storedGeometryOf, ' +
        'rerenderCurrentRoute: rerenderCurrentRoute, route: function () { return currentRoute; } };');

    const api = fn(
        document, windowObj,
        function (k) { return i18n.t(k); },
        function (k, p) { return i18n.tf(k, p); },
        i18n.lang(),
        function (s) { return I.escapeText(s); },
        windowObj.geocodePlaces,
        function (places) {
            return Promise.resolve(engine.haversineMatrix(places));
        },
        engine.planRoute,
        o.fetch || function () { return Promise.reject(new Error('offline')); },
        { warn: function () {}, error: function () {}, log: function () {} },
        i18n.onLanguageChange,
        o.instantTimers ? function (f) { f(); return 0; } : setTimeout,
        windowObj.routeGeometry,
        URLstub, BlobStub,
        { collection: function () { return { doc: function () { return {
            get: function () { return Promise.resolve({ exists: !!o.savedDoc, data: function () { return o.savedDoc; } }); }
        }; } }; } },
        { uid: 'u1' },
        function (doc) { saved.push(doc); return Promise.resolve('id1'); },
        function () {}, function () {}
    );
    api.els = els;
    api.i18n = i18n;
    api.created = created;
    api.downloads = downloads;
    api.revoked = revoked;
    api.savedDocs = saved;
    api.geometryCalls = function () { return geometryCalls; };
    api.noticeTexts = function () {
        const out = [];
        (function walk(n) {
            for (let i = 0; i < n.childNodes.length; i++) {
                const c = n.childNodes[i];
                if ((' ' + c.className + ' ').indexOf(' notice-text ') >= 0) out.push(c.textContent);
                walk(c);
            }
        })(els.resultItinerary);
        return out;
    };
    api.initRouteForm();     // wires the buttons AND the language re-render hook
    return api;
}

function fillForm(els) {
    els.rfStartPoint.value = 'Madrid';
    els.rfEndPoint.value = 'Barcelona';
    els.rfDestinations.value = 'Zaragoza';
    els.rfTripType.value = 'familiar';
    els.rfDuration.value = '3';
    els.rfDailyBudget.value = '150';
    els.rfTolls.value = 'with-tolls';
    els.rfDepartureTime.value = '09:00';
}

test('D6: clearing the form during enrichment does not resurrect the itinerary', function () {
    let release = null;
    const app = loadRouteForm({
        fetch: function () { return new Promise(function (res) { release = res; }); }
    });
    fillForm(app.els);

    const done = app.generateRoute();
    /* Let the synchronous computation (steps 1-5) finish and the fetch go out. */
    return new Promise(function (r) { setImmediate(r); })
        .then(function () { return new Promise(function (r) { setTimeout(r, 30); }); })
        .then(function () {
            assert.ok(app.els.resultItinerary.innerHTML.length > 0, 'fixture: step 5 rendered');
            assert.strictEqual(app.els.clearBtn.disabled, true,
                'Clear must not be clickable while a generation is in flight');

            /* The user clears anyway (keyboard, script, a race on the disable). */
            app.els.clearBtn.disabled = false;
            app.clearForm();
            assert.strictEqual(app.route(), null);
            assert.strictEqual(app.els.resultItinerary.innerHTML, '');

            /* Now the enrichment comes back. */
            release({ ok: true, json: function () { return Promise.resolve({ content: [{ type: 'text', text: '{"days":[]}' }] }); } });
            return done;
        })
        .then(function () {
            assert.strictEqual(app.route(), null,
                'the late enrichment wrote a dead route back over an empty form');
            assert.strictEqual(app.els.resultItinerary.innerHTML, '',
                'the cleared itinerary came back from the dead');
            assert.strictEqual(app.els.resultContent.style.display, 'none');
            assert.strictEqual(app.els.clearBtn.disabled, false, 'Clear is usable again afterwards');
        });
});

test('D6: loading a saved route during enrichment is not clobbered by the late write', function () {
    let release = null;
    const app = loadRouteForm({
        fetch: function () { return new Promise(function (res) { release = res; }); }
    });
    fillForm(app.els);
    const done = app.generateRoute();

    return new Promise(function (r) { setTimeout(r, 30); })
        .then(function () {
            /* viewSavedRoute() invalidates the generation before it writes; simulate the
               same sequence without Firestore. */
            app.clearForm();                       // the invalidation viewSavedRoute performs
            const saved = { formData: { startPoint: 'Loaded', endPoint: 'Route', duration: 1 },
                view: null, structured: null, result: 'A SAVED ROUTE' };
            app.displayRoute(saved);
            assert.strictEqual(app.els.resultBody.textContent, 'A SAVED ROUTE');

            release({ ok: true, json: function () { return Promise.resolve({ content: [{ type: 'text', text: '{"days":[]}' }] }); } });
            return done;
        })
        .then(function () {
            assert.strictEqual(app.els.resultBody.textContent, 'A SAVED ROUTE',
                "the in-flight generation overwrote the user's saved route");
        });
});

test('D5: switching language re-renders the whole itinerary, not just [data-i18n]', function () {
    const app = loadRouteForm({});
    fillForm(app.els);

    return app.generateRoute().then(function () {
        const es = app.els.resultItinerary.innerHTML;
        assert.ok(es.length > 0, 'fixture: an itinerary is on screen');
        assert.match(es, /Resumen del viaje/, 'fixture: it rendered in the default locale (es)');

        app.i18n.setLanguage('fr');
        const fr = app.els.resultItinerary.innerHTML;
        assert.notStrictEqual(fr, es, 'the result pane stayed frozen in the previous language');
        assert.match(fr, /Resume du voyage/, 'the summary title follows the language switch');
        assert.strictEqual(fr.indexOf('Resumen del viaje'), -1, 'Spanish left behind in the pane');
        assert.match(fr, /Jour 1/, 'day headings too');

        app.i18n.setLanguage('zh');
        assert.match(app.els.resultItinerary.innerHTML, /行程摘要/);

        app.i18n.setLanguage('es');
        assert.strictEqual(app.els.resultItinerary.innerHTML, es, 'switching back is lossless');
    });
});

test('D5: the notices and the budget verdict follow the language too', function () {
    const app = loadRouteForm({});
    fillForm(app.els);
    app.els.rfDailyBudget.value = '10';        // force an over-budget verdict + notice

    return app.generateRoute().then(function () {
        app.i18n.setLanguage('en');
        const en = app.els.resultItinerary.innerHTML;
        assert.match(en, /Over budget on day/, 'the notice is in English');
        assert.match(en, /Over budget by/, 'so is the verdict');

        app.i18n.setLanguage('ca');
        const ca = app.els.resultItinerary.innerHTML;
        assert.match(ca, /Pressupost superat/);
        assert.strictEqual(ca.indexOf('Over budget on day'), -1);
    });
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

/* ═══════════════════════════════════════════════════════════════════════════════
   W — THE WIRING (quality bar B8): the map and the exports, as the page runs them.
   The map may never change the itinerary, may never present an estimate as a
   measurement, and may never ask the road service for the same line twice.
   ═══════════════════════════════════════════════════════════════════════════════ */

function mapNoticeOf(app) {
    const wanted = [app.i18n.t('map.straightNotice'), app.i18n.t('map.savedNoGeometry')];
    return app.noticeTexts().filter(function (s) { return wanted.indexOf(s) >= 0; });
}

test('W1: verified road geometry draws a solid line and is captioned as road data', function () {
    const app = loadRouteForm({ geometry: 'road' });
    fillForm(app.els);
    return app.generateRoute().then(function () {
        const route = app.route();
        assert.strictEqual(app.geometryCalls(), 1, 'exactly one geometry request per generation');
        assert.ok(route.mapView, 'a map view was built');
        assert.strictEqual(route.mapView.geometryReal, true);
        assert.strictEqual(route.mapView.geometrySource, 'osrm');
        assert.strictEqual(route.mapView.days.length, route.view.plan.days.length,
            'one map day per itinerary day');
        const svg = app.els.routeMapFigure.innerHTML;
        assert.match(svg, /<svg /);
        assert.match(svg, /<path /);
        assert.strictEqual(/stroke-dasharray/.test(svg), false, 'road geometry must not be dashed');
        assert.strictEqual(app.els.routeMapSource.textContent, app.i18n.t('map.sourceRoad'));
        assert.strictEqual(app.els.routeMapSource.className.indexOf('map-source-estimate'), -1);
        assert.deepStrictEqual(mapNoticeOf(app), [], 'no estimate notice for real road data');
        assert.strictEqual(app.els.routeMapPanel.style.display, '');
        assert.strictEqual(app.els.exportBar.style.display, '');
    });
});

test('W2: a straight-line fallback is dashed, captioned as an estimate, AND in the notice list', function () {
    const app = loadRouteForm({ geometry: 'straight' });
    fillForm(app.els);
    return app.generateRoute().then(function () {
        const route = app.route();
        assert.strictEqual(route.mapView.geometryReal, false);
        const svg = app.els.routeMapFigure.innerHTML;
        assert.match(svg, /stroke-dasharray/, 'the picture itself has to say it is not a road');
        assert.strictEqual(app.els.routeMapSource.textContent, app.i18n.t('map.sourceStraight'));
        assert.ok(app.els.routeMapSource.className.indexOf('map-source-estimate') >= 0);
        assert.deepStrictEqual(mapNoticeOf(app), [app.i18n.t('map.straightNotice')],
            'the fallback must reach the notice list, not only the SVG');
    });
});

test('W3: the itinerary is byte-identical whatever the geometry does', function () {
    const outcomes = ['road', 'straight', 'throw', 'absent'];
    return Promise.all(outcomes.map(function (g) {
        const app = loadRouteForm({ geometry: g });
        fillForm(app.els);
        return app.generateRoute().then(function () { return app.route(); });
    })).then(function (routes) {
        const reference = JSON.stringify(routes[0].structured);
        for (let i = 1; i < routes.length; i++) {
            assert.strictEqual(JSON.stringify(routes[i].structured), reference,
                'geometry outcome "' + outcomes[i] + '" changed the computed itinerary');
            assert.strictEqual(routes[i].result, routes[0].result, 'the plain summary drifted');
        }
        for (let i = 0; i < routes.length; i++) assert.ok(routes[i].mapView, outcomes[i] + ': no map');
        assert.strictEqual(routes[0].mapView.geometryReal, true);
        for (let i = 1; i < routes.length; i++) {
            assert.strictEqual(routes[i].mapView.geometryReal, false, outcomes[i] + ' claimed road data');
        }
    });
});

test('W4: nothing re-requests the geometry — not exports, not a language switch', function () {
    const app = loadRouteForm({ geometry: 'road' });
    fillForm(app.els);
    return app.generateRoute().then(function () {
        assert.strictEqual(app.geometryCalls(), 1);
        app.els.exportStartDate.value = '2026-09-01';
        app.exportGpx();
        app.exportIcs();
        app.exportPrint();
        app.i18n.setLanguage('fr');
        app.i18n.setLanguage('es');
        assert.strictEqual(app.geometryCalls(), 1, 'the road service was asked again');
        assert.strictEqual(app.downloads.length, 3, 'three files were built locally');
    });
});

test('W5: saving stores the SIMPLIFIED line with its provenance, or explicit nulls', function () {
    const road = loadRouteForm({ geometry: 'road' });
    fillForm(road.els);
    return road.generateRoute()
        .then(function () { return road.saveCurrentRoute(); })
        .then(function () {
            const doc = road.savedDocs[0];
            assert.ok(Array.isArray(doc.geometry), 'the line was stored');
            assert.strictEqual(doc.geometrySource, 'osrm', 'provenance is an ordinary field');
            assert.strictEqual(doc.geometryPoints, doc.geometry.length / 2);
            for (let i = 0; i < doc.geometry.length; i++) {
                assert.strictEqual(typeof doc.geometry[i], 'number',
                    'a nested array leaked into the document — Firestore rejects those');
            }
            assert.deepStrictEqual(road.unflattenGeometry(doc.geometry), road.route().mapView.geometry,
                'the stored line is the simplified one, unchanged by the round trip');
            assert.ok(doc.geometry.length / 2 <= road.route().mapView.simplification.rawPoints,
                'the stored line is not longer than the raw one');
            for (const k in doc) {
                assert.notStrictEqual(doc[k], undefined, k + ' is undefined — Firestore rejects that');
            }
            const flat = loadRouteForm({ geometry: 'straight' });
            fillForm(flat.els);
            return flat.generateRoute()
                .then(function () { return flat.saveCurrentRoute(); })
                .then(function () {
                    assert.strictEqual(flat.savedDocs[0].geometry, null,
                        'an estimate is never stored as a line');
                    assert.strictEqual(flat.savedDocs[0].geometrySource, null);
                });
        });
});

test('W6: a saved route is exportable, and one without geometry says the map is an estimate', function () {
    const gen = loadRouteForm({ geometry: 'road' });
    fillForm(gen.els);
    return gen.generateRoute()
        .then(function () { return gen.saveCurrentRoute(); })
        .then(function () {
            const doc = gen.savedDocs[0];
            /* Every route saved by an earlier build looks like this. */
            const legacy = {};
            for (const k in doc) {
                if (k !== 'geometry' && k !== 'geometrySource' && k !== 'geometryPoints') legacy[k] = doc[k];
            }
            const app = loadRouteForm({ geometry: 'road', savedDoc: legacy });
            return app.viewSavedRoute('r1').then(function () {
                assert.strictEqual(app.geometryCalls(), 0,
                    'a saved route must not silently re-fetch its geometry');
                assert.strictEqual(app.route().mapView.geometryReal, false);
                assert.match(app.els.routeMapFigure.innerHTML, /stroke-dasharray/);
                assert.deepStrictEqual(mapNoticeOf(app), [app.i18n.t('map.savedNoGeometry')]);
                assert.strictEqual(app.els.exportBar.style.display, '');
                app.exportGpx();
                assert.strictEqual(app.downloads.length, 1);
                assert.match(app.downloads[0].text, /<gpx /);
            });
        });
});

test('W7: a stored line without provenance is never promoted to a measurement', function () {
    const gen = loadRouteForm({ geometry: 'road' });
    fillForm(gen.els);
    return gen.generateRoute()
        .then(function () { return gen.saveCurrentRoute(); })
        .then(function () {
            const doc = gen.savedDocs[0];
            const withProv = loadRouteForm({ savedDoc: doc, geometry: 'absent' });
            return withProv.viewSavedRoute('r1').then(function () {
                assert.strictEqual(withProv.route().mapView.geometryReal, true,
                    'a line saved WITH its provenance comes back as road data');
                assert.deepStrictEqual(mapNoticeOf(withProv), []);

                const stripped = {};
                for (const k in doc) if (k !== 'geometrySource') stripped[k] = doc[k];
                const noProv = loadRouteForm({ savedDoc: stripped, geometry: 'absent' });
                return noProv.viewSavedRoute('r1').then(function () {
                    assert.strictEqual(noProv.route().mapView.geometryReal, false,
                        'an unlabelled stored line was drawn as a measured road');
                    assert.deepStrictEqual(mapNoticeOf(noProv), [noProv.i18n.t('map.savedNoGeometry')]);
                });
            });
        });
});

test('W8: the three exports are built in the browser, and a track is only ever real', function () {
    const app = loadRouteForm({ geometry: 'road', instantTimers: true });
    fillForm(app.els);
    return app.generateRoute().then(function () {
        app.exportGpx();
        const gpx = app.downloads[0].text;
        assert.match(gpx, /<gpx /);
        assert.match(gpx, /<trk>/, 'verified geometry belongs in a track');
        assert.match(gpx, /<rte>/);

        /* No calendar without a start date — the module refuses to invent one. */
        app.els.exportStartDate.value = '';
        app.exportIcs();
        assert.strictEqual(app.downloads.length, 1, 'a calendar was offered with no date');
        assert.strictEqual(app.els.exportHint.textContent, app.i18n.t('exp.needDate'));

        app.els.exportStartDate.value = '2026-09-01';
        app.exportIcs();
        const ics = app.downloads[1].text;
        assert.match(ics, /BEGIN:VCALENDAR/);
        assert.match(ics, /DTSTART/);

        app.exportPrint();
        const html = app.downloads[2].text;
        assert.match(html, /<!DOCTYPE html>/);
        assert.match(html, /<svg /, 'the printed page carries the map');
        assert.match(html, /day-card/, 'and the itinerary');

        assert.strictEqual(app.revoked.length, 3, 'every object URL is released');
        const names = app.created.filter(function (e) { return e.tagName === 'A'; })
            .map(function (e) { return e.download; });
        assert.deepStrictEqual(names.map(function (n) { return n.split('.').pop(); }),
            ['gpx', 'ics', 'html']);

        /* An estimate must not become a <trk>. */
        const est = loadRouteForm({ geometry: 'straight' });
        fillForm(est.els);
        return est.generateRoute().then(function () {
            est.exportGpx();
            const flat = est.downloads[0].text;
            assert.strictEqual(/<trk>/.test(flat), false,
                'a straight-line estimate was exported as a travelled track');
            assert.match(flat, /<rte>/, 'the planned via points are still there');
        });
    });
});

test('W9: every map / export / progress key the wiring uses resolves in all five locales', function () {
    const i18n = loadI18n();
    const fs = require('node:fs');
    const sources = ['route-map.js', 'route-form.js', 'route-export.js']
        .map(function (f) { return fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'); })
        .join('\n');
    const keys = (sources.match(/'(map|exp|progress)\.[a-zA-Z]+'/g) || [])
        .map(function (s) { return s.slice(1, -1); })
        .filter(function (k, i, a) { return a.indexOf(k) === i; });
    assert.ok(keys.length >= 15, 'sanity: found ' + keys.length + ' keys');
    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        for (let k = 0; k < keys.length; k++) {
            const v = i18n.t(keys[k]);
            assert.strictEqual(typeof v, 'string', LOCALES[i] + ' / ' + keys[k]);
            assert.notStrictEqual(v, keys[k],
                keys[k] + ' is missing in ' + LOCALES[i] + ' — the raw key would render on screen');
        }
    }
});

test('W10: place names with markup in them cannot escape into the map', function () {
    const app = loadRouteForm({ geometry: 'straight' });
    fillForm(app.els);
    app.els.rfDestinations.value = 'L\'Hospitalet <b>&"x"</b>';
    return app.generateRoute().then(function () {
        const svg = app.els.routeMapFigure.innerHTML;
        assert.strictEqual(svg.indexOf('<b>'), -1, 'raw markup reached the SVG');
        assert.match(svg, /&lt;b&gt;/, 'the name is present, escaped');
        assert.ok(app.els.routeMapLegend.childNodes.length > 0, 'the legend describes what is drawn');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════
   G — WHERE THE PLACES ACTUALLY ARE
   ═══════════════════════════════════════════════════════════════════════════════
   A real user planned Barcelona -> Castellar del Valles via Santillana, Leon,
   Fisterra and Lugo and was told 24,179 km and 268 hours of driving. Nothing was
   broken. "Santillana de Mar" had geocoded to San Luis Potosi in MEXICO and "Leon"
   to Lyon in FRANCE; the itinerary was internally consistent, the warnings fired,
   the map drew it — and at no point did the screen say WHERE those places were.
   He tested twice and hit it twice.

   Every test below fails against the code that shipped before them.
   ═══════════════════════════════════════════════════════════════════════════════ */

/* The two places that ruined his trip, as the geocoder actually returned them. */
const SANTILLANA_MX = P('Santillana de Mar', 22.1565, -100.9855,
    { displayName: 'San Luis Potosi, Mexico', candidates: 4 });
const LEON_FR = P('Leon', 45.7640, 4.8357,
    { displayName: 'Lyon, Auvergne-Rhone-Alpes, France', candidates: 6 });
const BCN_ES = P('Barcelona', 41.3851, 2.1734,
    { displayName: 'Barcelona, Catalunya, Espana', candidates: 1 });
const CASTELLAR = P('Castellar del Valles', 41.6178, 2.0894,
    { displayName: 'Castellar del Valles, Barcelona, Catalunya, Espana', candidates: 1 });
const FISTERRA = P('Fisterra', 42.9070, -9.2637,
    { displayName: 'Fisterra, A Coruna, Galicia, Espana', candidates: 2 });
const LUGO = P('Lugo', 43.0121, -7.5559,
    { displayName: 'Lugo, Galicia, Espana', candidates: 3 });

/* What geocodeOutliers() reports for that trip: the Mexican village is thousands of
   kilometres from the median centre of everything else. */
const MX_OUTLIER = [{ name: 'Santillana de Mar', displayName: 'San Luis Potosi, Mexico', km: 8135 }];

function geoView(places, outliers) {
    return I.buildGeoView(places, [], outliers);
}

/* ── G1 — the single change that would have saved both of his tests ── */

test('G1: the itinerary states the full label of every place the geocoder chose', function () {
    const plan = planFor(BCN_ES, CASTELLAR, [SANTILLANA_MX, LEON_FR, FISTERRA, LUGO], 5);
    const view = I.buildItineraryView({
        plan: plan, requestedStops: ['Santillana de Mar', 'Leon', 'Fisterra', 'Lugo'],
        startName: 'Barcelona', endName: 'Castellar del Valles',
        places: [BCN_ES, SANTILLANA_MX, LEON_FR, FISTERRA, LUGO, CASTELLAR],
        geoOutliers: MX_OUTLIER,
        matrixSource: 'osrm', maxDriveMin: 360, dailyBudget: 150,
        departureTime: '09:00', t: CTX.t
    });
    const html = I.renderItineraryHtml(view, CTX);

    assert.ok(html.indexOf('San Luis Potosi, Mexico') >= 0,
        'the screen never said the village was in Mexico — that is the whole bug');
    assert.ok(html.indexOf('Lyon, Auvergne-Rhone-Alpes, France') >= 0,
        '"Leon" resolved to Lyon and the screen must say so');
    for (let i = 0; i < view.geo.places.length; i++) {
        assert.ok(html.indexOf(view.geo.places[i].displayName) >= 0,
            'every place carries its label, not just the suspicious ones');
    }

    /* And it is readable BEFORE the numbers it explains. */
    assert.ok(html.indexOf('geo-panel') < html.indexOf('summary-card'),
        'the labels have to be above the kilometres, not below them');

    /* The plain-text mirror is what an export and a copy/paste carry away. */
    const plain = I.buildPlainSummary(view, CTX);
    assert.ok(plain.indexOf('San Luis Potosi, Mexico') >= 0, 'the label travels with the export too');
});

test('G1: the geocoder label is never invented — an unlabelled place says so', function () {
    const nameOnly = P('Nowhere in particular', 41, 1);            /* resolved, no label */
    const ghost = P('Atlantis', null, null, { resolved: false });
    const geo = geoView([BCN_ES, nameOnly, ghost], []);
    assert.strictEqual(geo.places[1].displayName, '');
    assert.strictEqual(geo.places[2].displayName, '');

    const html = I.renderItineraryHtml({
        plan: { days: [], order: [] }, costs: I.computeCosts({ days: [] }, {}),
        notices: [], geo: geo, meta: {}
    }, CTX);
    assert.ok(html.indexOf('the geocoder returned no label') >= 0,
        'a resolved place with no label says the geocoder gave none');
    assert.ok(html.indexOf('could not be located') >= 0,
        'an unresolved place says it was not located');
    /* The typed name must never be echoed back into the label slot as if it were a
       match — that is exactly the false confidence this whole piece removes. */
    assert.strictEqual(html.indexOf('<span class="geo-label">Nowhere in particular'), -1);
});

test('G1: a trip the app knows nothing about renders no block at all', function () {
    /* Every place from a build that predates displayName: no labels, no candidate
       counts, no outliers. A list of blanks would be a claim in itself. */
    assert.strictEqual(geoView([MADRID, ZARAGOZA, BARCELONA], []), null);
    const view = I.buildItineraryView({
        plan: planFor(MADRID, BARCELONA, [ZARAGOZA], 2),
        places: [MADRID, ZARAGOZA, BARCELONA], matrixSource: 'osrm',
        dailyBudget: 200, t: CTX.t
    });
    assert.strictEqual(view.geo, null);
    assert.strictEqual(I.renderItineraryHtml(view, CTX).indexOf('geo-panel'), -1);
});

/* ── G2 — the odd one out is the loudest thing on the page ── */

test('G2: an outlier is an ALERT and is read before every other notice', function () {
    /* A day over the drive cap, a blown budget, and no road data — all three of the
       loud things this app already knew how to say, plus a place in Mexico. */
    const plan = planFor(BCN_ES, CASTELLAR, [SANTILLANA_MX, LEON_FR], 1);
    const costs = I.computeCosts(plan, { dailyBudget: 10 });
    const notices = I.buildNotices(plan, {
        geo: geoView([BCN_ES, SANTILLANA_MX, LEON_FR, CASTELLAR], MX_OUTLIER),
        maxDriveMin: 360, matrixSource: 'haversine', costs: costs,
        startName: 'Barcelona', endName: 'Castellar del Valles'
    });
    const codes = notices.map(function (n) { return n.code; });

    assert.strictEqual(codes[0], 'geoOutlier',
        'the most likely explanation for every absurd number must not be buried: ' + codes.join(','));
    assert.strictEqual(notices[0].level, 'alert');
    assert.ok(codes.indexOf('overCap') > 0 && codes.indexOf('overBudget') > 0,
        'fixture: the drive-cap and budget warnings are present and outranked');
    assert.ok(codes.indexOf('haversine') > codes.indexOf('geoOutlier'),
        'even the other alert comes after the one that explains it');

    const text = I.noticeText(notices[0], CTX);
    assert.ok(text.indexOf('Santillana de Mar') >= 0 && text.indexOf('San Luis Potosi, Mexico') >= 0,
        'the alert names the place AND where it landed: ' + text);
    assert.ok(text.indexOf('8135') >= 0, 'and how far away it is: ' + text);
    assert.strictEqual(text.indexOf('{'), -1, 'no unfilled placeholder');
});

test('G2: an outlier with no usable distance still alerts, without printing a NaN', function () {
    const junk = [{ name: 'Santillana de Mar', displayName: 'San Luis Potosi, Mexico', km: 'far away' }];
    const notices = I.buildNotices({ days: [], order: [] },
        { geo: geoView([BCN_ES, SANTILLANA_MX], junk) });
    assert.strictEqual(notices[0].code, 'geoOutlierNoDistance');
    assert.strictEqual(notices[0].level, 'alert');
    const text = I.noticeText(notices[0], CTX);
    assert.strictEqual(text.indexOf('NaN'), -1, 'a distance the app does not have is not printed as one');
    assert.strictEqual(text.indexOf('null'), -1);
    assert.ok(text.indexOf('San Luis Potosi, Mexico') >= 0);
});

test('G2: the outlier changes NOTHING it is not entitled to change', function () {
    const base = {
        plan: planFor(BCN_ES, CASTELLAR, [SANTILLANA_MX, LEON_FR], 3),
        requestedStops: ['Santillana de Mar', 'Leon'],
        startName: 'Barcelona', endName: 'Castellar del Valles',
        places: [BCN_ES, SANTILLANA_MX, LEON_FR, CASTELLAR],
        matrixSource: 'osrm', maxDriveMin: 360, dailyBudget: 150,
        departureTime: '09:00', t: CTX.t
    };
    const quiet = I.buildItineraryView(base);
    const loud = I.buildItineraryView(Object.assign({}, base, { geoOutliers: MX_OUTLIER }));

    assert.deepStrictEqual(loud.plan.days.map(function (d) { return [d.km, d.driveMin]; }),
        quiet.plan.days.map(function (d) { return [d.km, d.driveMin]; }),
        'flagging a place must not move a single kilometre');
    assert.deepStrictEqual(loud.costs.days.map(function (d) { return d.total; }),
        quiet.costs.days.map(function (d) { return d.total; }));
    assert.strictEqual(loud.costs.over, quiet.costs.over);

    /* The card stops looking calm; the verdict itself is still given, because the
       arithmetic is sound — it is the PREMISE that is in doubt. */
    const html = I.renderItineraryHtml(loud, CTX);
    assert.match(html, /summary-card summary-geo-outlier/);
    assert.strictEqual(html.indexOf('The budget cannot be assessed'), -1,
        'an outlier is not an excuse to withhold a verdict the numbers do support');
});

/* ── G3 — a choice made on the user's behalf, said out loud ── */

test('G3: a candidate preferred for being nearer the cluster is never silent', function () {
    const moved = P('Leon', 42.5987, -5.5671, {
        displayName: 'Leon, Castilla y Leon, Espana', candidates: 6, chosenByCluster: true });
    const geo = geoView([BCN_ES, moved, CASTELLAR], []);
    const notices = I.buildNotices({ days: [], order: [] }, { geo: geo });
    const hit = notices.filter(function (n) { return n.code === 'geoRelocated'; });
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].level, 'warn');
    const text = I.noticeText(hit[0], CTX);
    assert.ok(text.indexOf('Leon, Castilla y Leon, Espana') >= 0,
        'the user must be able to see WHICH one was taken: ' + text);
    assert.strictEqual(text.indexOf('{'), -1);

    const html = I.renderItineraryHtml({
        plan: { days: [], order: [] }, costs: I.computeCosts({ days: [] }, {}),
        notices: notices, geo: geo, meta: {}
    }, CTX);
    assert.ok(html.indexOf('geo-badge-moved') >= 0, 'and the list marks the place it happened to');
});

test('G3: plain ambiguity is reported once, listing the names, not once per place', function () {
    const geo = geoView([BCN_ES, SANTILLANA_MX, LEON_FR, FISTERRA, LUGO], []);
    assert.strictEqual(geo.ambiguous, 4, 'fixture: four names matched more than one place');
    const notices = I.buildNotices({ days: [], order: [] }, { geo: geo });
    const amb = notices.filter(function (n) { return n.code === 'geoAmbiguous'; });
    assert.strictEqual(amb.length, 1, 'four facts, one paragraph');
    assert.strictEqual(amb[0].level, 'info');
    const text = I.noticeText(amb[0], CTX);
    assert.ok(text.indexOf('Santillana de Mar') >= 0 && text.indexOf('Lugo') >= 0, text);
    assert.strictEqual(text.indexOf('{'), -1);

    /* Barcelona matched exactly one place and is not accused of ambiguity. */
    assert.strictEqual(text.indexOf('Barcelona'), -1);
});

test('G3: the loud notice wins — an outlier is not also reported as mere ambiguity', function () {
    const geo = geoView([BCN_ES, SANTILLANA_MX], MX_OUTLIER);
    const notices = I.buildNotices({ days: [], order: [] }, { geo: geo });
    const amb = notices.filter(function (n) { return n.code === 'geoAmbiguous'; });
    assert.strictEqual(amb.length, 0,
        '"it matched 4 places" under "it is in Mexico" is noise, not information');
    assert.strictEqual(notices.filter(function (n) { return n.code === 'geoOutlier'; }).length, 1);
});

/* ── G4 — the labels are untrusted input from an external service ── */

test('G4: geocoder labels and place names are escaped everywhere they are shown', function () {
    const evil = P('Sant "Joan" & Co <b>', 41.9, 2.1, {
        displayName: '<img src=x onerror=alert(1)>, "Mexico" & co',
        candidates: 3, chosenByCluster: true });
    const view = I.buildItineraryView({
        plan: planFor(BCN_ES, CASTELLAR, [evil], 2),
        requestedStops: [evil.name], startName: 'Barcelona', endName: 'Castellar del Valles',
        places: [BCN_ES, evil, CASTELLAR],
        geoOutliers: [{ name: evil.name, displayName: evil.displayName, km: 9000 }],
        matrixSource: 'osrm', maxDriveMin: 360, dailyBudget: 150, t: CTX.t
    });
    const html = I.renderItineraryHtml(view, CTX);
    assert.strictEqual(html.indexOf('<img src=x'), -1, 'a geocoder label reached innerHTML raw');
    assert.strictEqual(html.indexOf('<b>'), -1);
    assert.ok(html.indexOf('&lt;img src=x') >= 0, 'the label is still shown, escaped');
    assert.ok(html.indexOf('&quot;Mexico&quot;') >= 0);
    assert.ok(html.indexOf('&amp;') >= 0);
});

/* ── G5 — it survives the save, and an old document gains no claim ── */

test('G5: the labels round-trip through Firestore-safe JSON, byte for byte', function () {
    const view = I.buildItineraryView({
        plan: planFor(BCN_ES, CASTELLAR, [SANTILLANA_MX, LEON_FR], 4),
        requestedStops: ['Santillana de Mar', 'Leon'],
        startName: 'Barcelona', endName: 'Castellar del Valles',
        places: [BCN_ES, SANTILLANA_MX, LEON_FR, CASTELLAR],
        geoOutliers: MX_OUTLIER, matrixSource: 'osrm', maxDriveMin: 360,
        dailyBudget: 150, departureTime: '09:00', t: CTX.t
    });
    const doc = JSON.parse(JSON.stringify({
        startPoint: 'Barcelona', endPoint: 'Castellar del Valles',
        result: I.buildPlainSummary(view, CTX), structured: I.serialiseView(view)
    }));
    assert.strictEqual(I.isStructuredRoute(doc), true);

    const restored = I.viewFromSaved(doc);
    assert.strictEqual(I.renderItineraryHtml(restored, CTX), I.renderItineraryHtml(view, CTX),
        'a saved route must show exactly the same labels it was saved with');
    assert.strictEqual(restored.geo.outliers[0].displayName, 'San Luis Potosi, Mexico');
    /* The provenance rides on the places themselves too, for anything reading the plan. */
    const order = doc.structured.plan.order;
    let found = false;
    for (let i = 0; i < order.length; i++) {
        if (order[i].name === 'Santillana de Mar') {
            assert.strictEqual(order[i].displayName, 'San Luis Potosi, Mexico');
            assert.strictEqual(order[i].candidates, 4);
            assert.strictEqual(order[i].chosenByCluster, false);
            found = true;
        }
    }
    assert.ok(found, 'fixture: the place is in the saved order');
});

test('G5: a document written before any of this existed makes no claim about location', function () {
    const doc = round1Doc([
        round1CostDay(1, 300, 31.50, 12.50, 0, 35, 200),
        round1CostDay(2, 300, 31.50, 0, 0, 35, 200)
    ], 200);
    assert.strictEqual(doc.structured.geo, undefined, 'fixture: no geo section at all');
    const view = I.viewFromSaved(doc);
    assert.strictEqual(view.geo, null);
    const html = I.renderItineraryHtml(view, CTX);
    assert.strictEqual(html.indexOf('geo-panel'), -1, 'no block, and no blanks pretending to be one');
    for (let i = 0; i < view.notices.length; i++) {
        assert.strictEqual(String(view.notices[i].code).indexOf('geo'), -1,
            'a migration must not manufacture geocoding findings the document never had');
    }
});

/* ── G6 — five locales, and no sentence carrying another one's words ── */

test('G6: every geocoding string exists and fills in all five locales', function () {
    const i18n = loadI18n();
    const geo = geoView([BCN_ES, SANTILLANA_MX,
        P('Leon', 42.6, -5.57, { displayName: 'Leon, Castilla y Leon, Espana', candidates: 6, chosenByCluster: true }),
        FISTERRA, P('Anon', 41, 1)], MX_OUTLIER);
    const notices = I.buildNotices({ days: [], order: [] }, { geo: geo });
    const codes = notices.map(function (n) { return n.code; });
    assert.ok(codes.indexOf('geoOutlier') >= 0 && codes.indexOf('geoRelocated') >= 0 &&
        codes.indexOf('geoAmbiguous') >= 0, 'fixture covers all three: ' + codes.join(','));

    for (let i = 0; i < LOCALES.length; i++) {
        i18n.setLanguage(LOCALES[i]);
        const ctx = { t: i18n.t };
        for (let n = 0; n < notices.length; n++) {
            const text = I.noticeText(notices[n], ctx);
            assert.ok(text && text.length > 0, LOCALES[i] + ' / ' + notices[n].code);
            assert.strictEqual(text.indexOf('{'), -1,
                LOCALES[i] + ' / ' + notices[n].code + ' left a placeholder: ' + text);
            assert.strictEqual(text.indexOf('notice.'), -1,
                LOCALES[i] + ' / ' + notices[n].code + ' is untranslated');
        }
        const html = I.renderItineraryHtml({
            plan: { days: [], order: [] }, costs: I.computeCosts({ days: [] }, {}),
            notices: notices, geo: geo, meta: {}
        }, ctx);
        assert.strictEqual(html.indexOf('itin.geo'), -1, LOCALES[i] + ' leaked a raw key');
        assert.ok(html.indexOf('San Luis Potosi, Mexico') >= 0,
            LOCALES[i] + ' must still name the place it chose');
    }
});

test('G6: a label the app never had is filled in the language it is READ in', function () {
    const i18n = loadI18n();
    /* Built once and then re-read in another language — exactly what a language
       switch and a saved route do. The stand-in must follow the reader. */
    const notice = { code: 'geoOutlier', level: 'alert',
        params: { name: 'Santillana de Mar', label: '', km: 8135 } };
    i18n.setLanguage('fr');
    const fr = I.noticeText(notice, { t: i18n.t });
    i18n.setLanguage('zh');
    const zh = I.noticeText(notice, { t: i18n.t });
    i18n.setLanguage('fr');
    assert.strictEqual(fr, I.noticeText(notice, { t: i18n.t }), 'reading it must not mutate it');
    assert.notStrictEqual(fr, zh, 'the stand-in was baked in at build time');
    assert.strictEqual(fr.indexOf('{'), -1);
    assert.strictEqual(zh.indexOf('{'), -1);
    i18n.setLanguage('en');
    assert.ok(I.noticeText(notice, { t: i18n.t }).indexOf('the geocoder returned no label') >= 0);
});

/* ── G7 — the wiring, end to end, on the trip that started all of this ── */

function northSpainApp(opts) {
    const o = opts || {};
    const known = {
        'Barcelona': BCN_ES, 'Castellar del Valles': CASTELLAR,
        'Santillana de Mar': SANTILLANA_MX, 'Leon': LEON_FR,
        'Fisterra': FISTERRA, 'Lugo': LUGO
    };
    return loadRouteForm({
        geometry: 'straight',
        geocodePlaces: function (names) {
            return Promise.resolve(names.map(function (n) { return known[n] || P(n, 41, 1); }));
        },
        geo: o.noOutlierCheck ? {} : {
            geocodeOutliers: function () { return MX_OUTLIER; }
        }
    });
}

function fillNorthSpain(els) {
    els.rfStartPoint.value = 'Barcelona';
    els.rfEndPoint.value = 'Castellar del Valles';
    els.rfDestinations.value = 'Santillana de Mar, Leon, Fisterra, Lugo';
    els.rfTripType.value = 'moto';
    els.rfDuration.value = '5';
    els.rfDailyBudget.value = '120';
    els.rfTolls.value = 'with-tolls';
    els.rfDepartureTime.value = '09:00';
}

test('G7: the exact trip that broke now names Mexico on screen, at the top', function () {
    const app = northSpainApp();
    fillNorthSpain(app.els);
    return app.generateRoute().then(function () {
        const html = app.els.resultItinerary.innerHTML;
        assert.ok(html.indexOf('San Luis Potosi, Mexico') >= 0,
            'the screen that told him 24,179 km never said this word');
        assert.ok(html.indexOf('Lyon, Auvergne-Rhone-Alpes, France') >= 0);

        /* The first notice on the page, above every warning and above the numbers. */
        const first = /<div class="notice ([^"]*)"><span class="notice-icon">[^<]*<\/span><span class="notice-text">([^<]*)/.exec(html);
        assert.ok(first, 'fixture: notices rendered');
        assert.strictEqual(first[1], 'notice-alert');
        assert.ok(first[2].indexOf('Santillana de Mar') >= 0 &&
            first[2].indexOf('San Luis Potosi, Mexico') >= 0,
            'the first thing he reads is the reason: ' + first[2]);
        assert.ok(html.indexOf(first[2]) < html.indexOf('summary-card'),
            'and he reads it before the kilometres it explains');

        /* And the route he can act on is still there, unchanged and complete. */
        const route = app.route();
        assert.strictEqual(route.view.plan.days.length, 5);
        assert.strictEqual(route.view.geo.outliers.length, 1);
        assert.ok(route.structured.geo, 'saving it keeps the finding');
        assert.ok(route.result.indexOf('San Luis Potosi, Mexico') >= 0,
            'and so does the plain-text mirror');
    });
});

test('G7: the wiring survives a geo provider with no outlier check at all', function () {
    const app = northSpainApp({ noOutlierCheck: true });
    fillNorthSpain(app.els);
    return app.generateRoute().then(function () {
        const html = app.els.resultItinerary.innerHTML;
        assert.ok(html.indexOf('San Luis Potosi, Mexico') >= 0,
            'the labels are not conditional on the outlier check existing');
        const route = app.route();
        assert.strictEqual(route.view.geo.outliers.length, 0);
        assert.strictEqual(html.indexOf('geo-badge-outlier'), -1,
            'and nothing is accused on evidence the app does not have');
    });
});

test('G7: a language switch re-renders the labels without re-geocoding anything', function () {
    const app = northSpainApp();
    fillNorthSpain(app.els);
    return app.generateRoute().then(function () {
        const before = app.route().view.geo.places.map(function (p) { return p.displayName; });
        app.i18n.setLanguage('fr');
        const html = app.els.resultItinerary.innerHTML;
        assert.ok(html.indexOf('Ou chaque lieu a ete localise') >= 0, 'the block follows the language');
        assert.ok(html.indexOf('San Luis Potosi, Mexico') >= 0, 'the labels themselves do not');
        assert.deepStrictEqual(app.route().view.geo.places.map(function (p) { return p.displayName; }),
            before, 'nothing was looked up again');
        app.i18n.setLanguage('es');
    });
});
