/* ── Tests for js/route-map.js ──
   Node built-in runner, no dependencies:  node --test tests/*.test.js
   (`node --test tests/` — the directory positional — does NOT work on Node 24.14.1.)

   Every test name states the requirement it covers:
     M1  no library, no CDN, no dependency — inline SVG only
     M2  Web Mercator projection
     M3  Douglas-Peucker simplification is mandatory, at a measured tolerance
     M4  the simplifier is iterative — 11k+ points must not overflow the stack
     M5  what a caller persists is the SIMPLIFIED line (Firestore 1 MB limit)
     M6  every string reaching the SVG is escaped
     D   degenerate inputs must not throw
     S   day colouring stays in sync with the plan's days
     V   the SVG is valid, self-contained and scales
     F   the straight-line fallback is flagged, never presented as measured
     X   determinism — same input, same bytes
     B8  quality bar: the route is visible on a map and exportable */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const MAP_PATH = path.join(__dirname, '..', 'js', 'route-map.js');
const map = require(MAP_PATH);
const { project, simplify, buildMapView, renderMapSvg, maxDeviationKm,
        estimatePayloadBytes, kmPerUnit, DEFAULT_TOLERANCE_KM, DAY_COLORS } = map;

/* ── Fixtures ── */
function P(name, lat, lon) {
    return { name: name, lat: lat, lon: lon, resolved: true, source: 'osm' };
}

const MADRID    = P('Madrid', 40.4168, -3.7038);
const ZARAGOZA  = P('Zaragoza', 41.6488, -0.8891);
const TARRAGONA = P('Tarragona', 41.1189, 1.2445);
const BARCELONA = P('Barcelona', 41.3851, 2.1734);
const VALENCIA  = P('Valencia', 39.4699, -0.3763);

/* The three real destinations from this project's data that break unescaped markup. */
const AMP   = P('Sant Joan Despi & Cornella', 41.3670, 2.0570);
const ANGLE = P("L'Hospitalet <centre>", 41.3596, 2.0999);
const QUOTE = P('Zaragoza "La Seo"', 41.6560, -0.8760);

function haversineKm(a, b) {
    const R = 6371.0088;
    const toRad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* Build a Plan of the shape ENGINE_CONTRACT.md defines, from a list of
   per-day place sequences. Day n starts where day n-1 ended. */
function makePlan(dayPlaceLists) {
    const days = [];
    const order = [];
    let totalKm = 0, totalMin = 0;
    for (let d = 0; d < dayPlaceLists.length; d++) {
        const seq = dayPlaceLists[d];
        const legs = [];
        let km = 0, min = 0;
        for (let i = 0; i + 1 < seq.length; i++) {
            const from = seq[i], to = seq[i + 1];
            const legKm = (isFinite(from.lat) && isFinite(to.lat))
                ? haversineKm([from.lat, from.lon], [to.lat, to.lon]) * 1.25 : 0;
            legs.push({ from: from, to: to, km: legKm, min: legKm / 90 * 60 });
            km += legKm; min += legKm / 90 * 60;
        }
        days.push({
            day: d + 1, legs: legs, stops: seq.slice(1),
            driveMin: min, km: km,
            startPlace: seq[0], endPlace: seq[seq.length - 1],
            overDriveCap: false
        });
        totalKm += km; totalMin += min;
        for (let i = (d === 0 ? 0 : 1); i < seq.length; i++) order.push(seq[i]);
    }
    return {
        days: days, order: order, totalKm: totalKm, totalMin: totalMin,
        roundTrip: false, warnings: []
    };
}

const FOUR_DAY_PLAN = makePlan([
    [MADRID, ZARAGOZA],
    [ZARAGOZA, TARRAGONA],
    [TARRAGONA, BARCELONA],
    [BARCELONA, VALENCIA]
]);

/* ── Real-scale synthetic road geometry ──
   Madrid -> Zaragoza -> Tarragona -> Barcelona -> Valencia, ~875 km, sampled at
   whatever density is asked for. Deterministic (no Math.random): road curvature
   is a stack of sinusoids parameterised by DISTANCE ALONG THE ROUTE, so the
   wavelengths are physical — 22 km sweeps, 5 km bends, 1.2 km kinks — and the
   sub-tolerance wiggle is the part a 0.5 km simplification is meant to erase.

   Calibrated against the live-OSRM measurement in the brief: at 10,000 points
   this fixture is 192 KB of JSON (the real 11,344-point geometry was 199 KB) and
   0.5 km simplification keeps 280 points (the real one kept 252). Coordinates are
   rounded to 5 decimals because that is exactly what decodePolyline(geom, 5)
   produces in js/geo-provider.js — an unrounded fixture would double the byte
   count with 17 significant digits no road geometry ever carries. */
const ROAD_CURVATURE = [
    { a: 2.5,  L: 70,  p: 0 },      /* km amplitude, km wavelength, phase */
    { a: 0.8,  L: 22,  p: 1 },
    { a: 0.3,  L: 5.0, p: 2 },
    { a: 0.06, L: 1.2, p: 0.5 }
];

function syntheticGeometry(n) {
    const via = [
        [MADRID.lat, MADRID.lon], [ZARAGOZA.lat, ZARAGOZA.lon],
        [TARRAGONA.lat, TARRAGONA.lon], [BARCELONA.lat, BARCELONA.lon],
        [VALENCIA.lat, VALENCIA.lon]
    ];
    const segKm = [];
    let total = 0;
    for (let i = 0; i + 1 < via.length; i++) {
        const d = haversineKm(via[i], via[i + 1]);
        segKm.push(d);
        total += d;
    }
    const pts = [];
    for (let i = 0; i < n; i++) {
        const s = total * i / (n - 1);
        let acc = 0, li = 0, u = 0;
        for (let k = 0; k < segKm.length; k++) {
            if (s <= acc + segKm[k] || k === segKm.length - 1) {
                li = k;
                u = segKm[k] > 0 ? (s - acc) / segKm[k] : 0;
                break;
            }
            acc += segKm[k];
        }
        u = Math.min(1, Math.max(0, u));
        const a = via[li], b = via[li + 1];
        const lat = a[0] + (b[0] - a[0]) * u;
        const lon = a[1] + (b[1] - a[1]) * u;
        let dLatKm = 0, dLonKm = 0;
        for (let c = 0; c < ROAD_CURVATURE.length; c++) {
            const w = ROAD_CURVATURE[c];
            dLatKm += w.a * Math.sin(2 * Math.PI * s / w.L + w.p);
            dLonKm += w.a * 0.8 * Math.cos(2 * Math.PI * s / w.L + w.p * 1.7);
        }
        const nlat = lat + dLatKm / 111.32;
        const nlon = lon + dLonKm / (111.32 * Math.cos(lat * Math.PI / 180));
        pts.push([Math.round(nlat * 1e5) / 1e5, Math.round(nlon * 1e5) / 1e5]);
    }
    /* Pin the ends to the real waypoints, exactly as OSRM snaps its overview
       polyline to the requested origin and destination. */
    pts[0] = [via[0][0], via[0][1]];
    pts[pts.length - 1] = [via[via.length - 1][0], via[via.length - 1][1]];
    return pts;
}

const BIG_GEOMETRY = syntheticGeometry(10000);

/* Bytes of <path d="..."> a view actually ships inside the SVG. */
function pathBytes(view) {
    const svg = renderMapSvg(view, null);
    const ds = svg.match(/ d="[^"]*"/g) || [];
    let n = 0;
    for (let i = 0; i < ds.length; i++) n += ds[i].length;
    return n;
}

/* ── M1  no library, no CDN, no dependency ── */
test('M1 the module has no require(), no import and no external URL', function () {
    /* Comments are stripped first: the header explains WHY there is no Leaflet,
       and a scan that cannot tell an explanation from a dependency is worthless. */
    const code = fs.readFileSync(MAP_PATH, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!/\brequire\s*\(/.test(code), 'must not require anything');
    assert.ok(!/^\s*import\s/m.test(code), 'must not use ES module imports');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(code), 'must not reference any external origin');
    assert.ok(!/cdn|unpkg|jsdelivr|leaflet|mapbox|google/i.test(code), 'must not use a map library or CDN');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|localStorage|Date\.now|Math\.random/.test(code),
        'the module must stay pure: no network, no storage, no clock, no randomness');
    assert.ok(!/document\.|window\.(?!TravioMap)/.test(code), 'the module must not touch the DOM');
});

test('M1 the rendered SVG is self-contained: no script, no href, no external fetch', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    const svg = renderMapSvg(view, null);
    assert.ok(!/<script/i.test(svg));
    assert.ok(!/href/i.test(svg));
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(svg));
    assert.ok(!/<image/i.test(svg));
});

test('M1 the browser and Node export surfaces are the same object shape', function () {
    const expected = ['project', 'simplify', 'buildMapView', 'renderMapSvg',
        'maxDeviationKm', 'estimatePayloadBytes', 'renderPlanMap', 'escapeText'];
    for (let i = 0; i < expected.length; i++) {
        assert.strictEqual(typeof map[expected[i]], 'function', expected[i] + ' must be exported');
    }
});

/* ── M2  Web Mercator ── */
test('M2 project() is Web Mercator: (0,0) is the centre of the unit square', function () {
    const p = project(0, 0);
    assert.ok(Math.abs(p[0] - 0.5) < 1e-12);
    assert.ok(Math.abs(p[1] - 0.5) < 1e-12);
});

test('M2 project() maps the antimeridian to x=0 and x=1', function () {
    assert.ok(Math.abs(project(0, -180)[0] - 0) < 1e-12);
    assert.ok(Math.abs(project(0, 180)[0] - 1) < 1e-12);
});

test('M2 project() matches the stated formula exactly for a real city', function () {
    const lat = BARCELONA.lat, lon = BARCELONA.lon;
    const s = Math.sin(lat * Math.PI / 180);
    const x = (lon + 180) / 360;
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    const p = project(lat, lon);
    assert.ok(Math.abs(p[0] - x) < 1e-15);
    assert.ok(Math.abs(p[1] - y) < 1e-15);
});

test('M2 y grows southward, so no vertical flip is needed for SVG', function () {
    assert.ok(project(60, 0)[1] < project(40, 0)[1]);
    assert.ok(project(40, 0)[1] < project(-40, 0)[1]);
});

test('M2 Mercator distortion is real: 1 projected unit is fewer km at high latitude', function () {
    assert.ok(kmPerUnit(0) > kmPerUnit(41));
    assert.ok(kmPerUnit(41) > kmPerUnit(70));
    assert.ok(Math.abs(kmPerUnit(0) - 40075.016686) < 1e-6);
});

test('M2 project() clamps the poles instead of returning Infinity', function () {
    const north = project(90, 0), south = project(-90, 0);
    assert.ok(isFinite(north[0]) && isFinite(north[1]));
    assert.ok(isFinite(south[0]) && isFinite(south[1]));
    assert.ok(north[1] >= -0.001 && north[1] < 0.01);
    assert.ok(south[1] > 0.99 && south[1] <= 1.001);
});

test('M2 project() returns null for non-coordinates rather than NaN', function () {
    assert.strictEqual(project('abc', 0), null);
    assert.strictEqual(project(null, null), null);
    assert.strictEqual(project(undefined, 2), null);
    assert.strictEqual(project(NaN, 0), null);
    assert.strictEqual(project(120, 0), null);      // out of latitude range
});

test('M2 project() normalises out-of-range longitude instead of leaving the box', function () {
    const p = project(40, 200);       // == -160
    assert.ok(p[0] >= 0 && p[0] <= 1);
    assert.ok(Math.abs(p[0] - project(40, -160)[0]) < 1e-12);
});

/* ── M3  simplification ── */
test('M3 real-scale: the 10k-point fixture is the size the live measurement was', function () {
    /* Guards the fixture itself. If this drifts, every number below is measuring
       a toy route instead of a Spanish one. Live OSRM: 11,344 pts / 199 KB. */
    assert.strictEqual(BIG_GEOMETRY.length, 10000);
    const raw = estimatePayloadBytes(BIG_GEOMETRY);
    assert.ok(raw > 150 * 1024 && raw < 220 * 1024, 'fixture is ' + raw + ' bytes');
});

test('M3 real-scale: ~10k points simplify to an SVG payload under 5 KB at the default 0.5 km', function () {
    const simplified = simplify(BIG_GEOMETRY, DEFAULT_TOLERANCE_KM);
    const err = maxDeviationKm(BIG_GEOMETRY, simplified);
    assert.ok(simplified.length < BIG_GEOMETRY.length / 20,
        'expected >20x reduction, got ' + simplified.length + ' of ' + BIG_GEOMETRY.length);
    assert.ok(err <= DEFAULT_TOLERANCE_KM, 'max error ' + err + ' km exceeds tolerance');
    /* The line the SVG carries — 2-decimal viewBox units, ~12 bytes a point.
       This is the figure the brief measured as 2.8 KB. */
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    const drawn = pathBytes(view);
    assert.ok(drawn < 5120, 'the drawn path must be under 5 KB, got ' + drawn);
});

test('M3 real-scale: the persisted JSON line is ~5 KB, i.e. 0.5% of a Firestore document', function () {
    /* NOT the same number as the drawn path: JSON keeps 5-decimal lat/lon
       (~19 bytes a point), the SVG path keeps 2-decimal viewBox units (~12).
       Both are reported because only one of them is what Firestore stores. */
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.ok(view.geometryBytes < 8 * 1024, 'persisted line is ' + view.geometryBytes + ' bytes');
    assert.ok(view.geometryBytes < 0.01 * 1024 * 1024, 'must stay under 1% of the 1 MB limit');
    assert.ok(estimatePayloadBytes(BIG_GEOMETRY) > 0.15 * 1024 * 1024,
        'the raw line really would have eaten a fifth of the document');
});

test('M3 max error never exceeds the requested tolerance, at every measured setting', function () {
    const tols = [0.25, 0.5, 1.0];
    for (let i = 0; i < tols.length; i++) {
        const out = simplify(BIG_GEOMETRY, tols[i]);
        const err = maxDeviationKm(BIG_GEOMETRY, out);
        assert.ok(err <= tols[i], 'tol ' + tols[i] + ' km -> error ' + err + ' km');
    }
});

test('M3 a looser tolerance keeps strictly fewer points (monotonic, as measured)', function () {
    const a = simplify(BIG_GEOMETRY, 0.25).length;
    const b = simplify(BIG_GEOMETRY, 0.5).length;
    const c = simplify(BIG_GEOMETRY, 1.0).length;
    assert.ok(a > b, '0.25 km must keep more points than 0.5 km (' + a + ' vs ' + b + ')');
    assert.ok(b > c, '0.5 km must keep more points than 1 km (' + b + ' vs ' + c + ')');
});

test('M3 endpoints are always preserved exactly', function () {
    const out = simplify(BIG_GEOMETRY, 5);
    assert.deepStrictEqual(out[0], BIG_GEOMETRY[0]);
    assert.deepStrictEqual(out[out.length - 1], BIG_GEOMETRY[BIG_GEOMETRY.length - 1]);
});

test('M3 a straight run collapses to its two endpoints', function () {
    /* Due east: constant latitude is a straight line in Mercator. */
    const line = [];
    for (let i = 0; i <= 500; i++) line.push([41, -3 + i * 0.006]);
    assert.strictEqual(simplify(line, 0.5).length, 2);
});

test('M3 a lat/lon-linear run is NOT straight in Mercator and keeps its bow', function () {
    /* Stepping lat and lon by equal amounts is a rhumb line, which bows in
       Mercator by more than the tolerance over 200 km. Dropping the middle would
       be projecting in the wrong space — the bug requirement M2 exists to stop. */
    const line = [];
    for (let i = 0; i <= 500; i++) line.push([40 + i * 0.004, -3 + i * 0.004]);
    assert.ok(simplify(line, 0.5).length > 2);
});

test('M3 a detour larger than the tolerance is never erased', function () {
    /* 0.05 deg of latitude is ~5.5 km — an order of magnitude over tolerance. */
    const out = simplify([[40, -3], [40.05, -2.5], [40, -2]], 0.5);
    assert.strictEqual(out.length, 3);
});

test('M3 an explicit tolerance of 0 or below means no thinning at all', function () {
    const line = BIG_GEOMETRY.slice(0, 200);
    assert.strictEqual(simplify(line, 0).length, 200);
    assert.strictEqual(simplify(line, -1).length, 200);
});

test('M3 a junk tolerance falls back to the default, never to "ship everything"', function () {
    /* Requirement 3: simplification is mandatory. A caller passing "" or "abc"
       must not silently get the 199 KB line — the failure has to be in the safe
       direction, which is the small line, not the big one. */
    const line = BIG_GEOMETRY.slice(0, 4000);
    const def = simplify(line, DEFAULT_TOLERANCE_KM).length;
    assert.strictEqual(simplify(line, 'abc').length, def);
    assert.strictEqual(simplify(line, undefined).length, def);
    assert.strictEqual(simplify(line, null).length, def);
    assert.ok(def < 4000);
});

test('M3 simplification drops points, it never rewrites the ones it keeps', function () {
    /* Lossless by design: the persisted line must be a SUBSET of the road
       geometry, not a re-quantised approximation of it. */
    const out = simplify(BIG_GEOMETRY, DEFAULT_TOLERANCE_KM);
    let cursor = 0;
    for (let i = 0; i < out.length; i++) {
        while (cursor < BIG_GEOMETRY.length &&
               !(BIG_GEOMETRY[cursor][0] === out[i][0] && BIG_GEOMETRY[cursor][1] === out[i][1])) {
            cursor++;
        }
        assert.ok(cursor < BIG_GEOMETRY.length, 'kept point ' + i + ' is not an input point');
        cursor++;
    }
});

test('M3 the simplifier accepts both [lat,lon] pairs and {lat,lon} places', function () {
    const objs = BIG_GEOMETRY.slice(0, 400).map(function (p) { return { lat: p[0], lon: p[1] }; });
    const out = simplify(objs, 0.5);
    assert.ok(out.length >= 2 && out.length < 400);
    assert.ok(Array.isArray(out[0]) && out[0].length === 2);
});

test('M3 buildMapView simplifies by default and reports what it did', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.strictEqual(view.simplification.toleranceKm, DEFAULT_TOLERANCE_KM);
    assert.strictEqual(view.simplification.rawPoints, BIG_GEOMETRY.length);
    assert.ok(view.simplification.outputPoints < view.simplification.inputPoints / 10);
});

/* ── M4  iterative Douglas-Peucker ── */
test('M4 60,000 points do not overflow the stack (the recursive form does)', function () {
    const huge = syntheticGeometry(60000);
    let out = null;
    assert.doesNotThrow(function () { out = simplify(huge, 0.5); });
    assert.ok(out.length >= 2);
    assert.deepStrictEqual(out[0], huge[0]);
    assert.deepStrictEqual(out[out.length - 1], huge[huge.length - 1]);
});

test('M4 the pathological staircase — deepest possible recursion — does not throw', function () {
    /* Each split peels off exactly one point: the shape that makes a recursive
       Douglas-Peucker recurse once per input point. */
    const stair = [];
    for (let i = 0; i < 20000; i++) stair.push([40 + i * 0.0001, -3 + Math.pow(0.9999, i) * 0.5]);
    assert.doesNotThrow(function () { simplify(stair, 0.05); });
});

test('M4 an 11k-point route survives a full buildMapView + render', function () {
    const geom = syntheticGeometry(11344);   // the measured real-world count
    let svg = null;
    assert.doesNotThrow(function () {
        svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: geom }), null);
    });
    assert.ok(svg.indexOf('<svg') === 0);
});

/* ── M5  persist the simplified line ── */
test('M5 view.geometry is the simplified line, not the raw one', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.ok(view.geometry.length > 1);
    assert.ok(view.geometry.length < BIG_GEOMETRY.length / 10,
        'persisted line must be the small one: ' + view.geometry.length);
});

test('M5 the persisted payload is a rounding error against the Firestore 1 MB limit', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.strictEqual(view.geometryBytes, estimatePayloadBytes(view.geometry));
    assert.ok(view.geometryBytes < 20 * 1024,
        'persisted geometry is ' + view.geometryBytes + ' bytes');
    /* The raw line is the thing that would have eaten a fifth of the document. */
    assert.ok(estimatePayloadBytes(BIG_GEOMETRY) > 10 * view.geometryBytes);
});

test('M5 the persisted line carries no duplicated seam point between days', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    for (let i = 1; i < view.geometry.length; i++) {
        assert.ok(!(view.geometry[i][0] === view.geometry[i - 1][0] &&
                    view.geometry[i][1] === view.geometry[i - 1][1]),
            'duplicate point at index ' + i);
    }
});

test('M5 a tighter tolerance costs bytes, and the caller can see the price', function () {
    const loose = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY, toleranceKm: 1.0 });
    const tight = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY, toleranceKm: 0.25 });
    assert.ok(tight.geometryBytes > loose.geometryBytes);
    assert.ok(tight.geometry.length > loose.geometry.length);
});

/* ── M6  escaping ── */
test('M6 "Sant Joan Despi & Cornella" is escaped everywhere it appears', function () {
    const plan = makePlan([[MADRID, AMP], [AMP, BARCELONA]]);
    const svg = renderMapSvg(buildMapView({ plan: plan }), null);
    assert.ok(svg.indexOf('Sant Joan Despi &amp; Cornella') !== -1);
    assert.ok(svg.indexOf('Sant Joan Despi & Cornella') === -1, 'raw ampersand reached the SVG');
});

test('M6 "L\'Hospitalet <centre>" cannot inject a tag or break an attribute', function () {
    const plan = makePlan([[MADRID, ANGLE], [ANGLE, BARCELONA]]);
    const svg = renderMapSvg(buildMapView({ plan: plan }), null);
    assert.ok(svg.indexOf('L&#39;Hospitalet &lt;centre&gt;') !== -1);
    assert.ok(svg.indexOf('<centre>') === -1);
    assert.ok(svg.indexOf("L'Hospitalet") === -1);
});

test('M6 \'Zaragoza "La Seo"\' cannot terminate an attribute value', function () {
    const plan = makePlan([[MADRID, QUOTE], [QUOTE, BARCELONA]]);
    const svg = renderMapSvg(buildMapView({ plan: plan }), null);
    assert.ok(svg.indexOf('Zaragoza &quot;La Seo&quot;') !== -1);
    assert.ok(svg.indexOf('Zaragoza "La Seo"') === -1);
});

test('M6 a name carrying a full <script> payload is inert in the output', function () {
    const evil = P('<script>alert("x")</script>', 41.0, 1.0);
    const plan = makePlan([[MADRID, evil], [evil, BARCELONA]]);
    const svg = renderMapSvg(buildMapView({ plan: plan }), null);
    assert.ok(svg.indexOf('<script') === -1);
    assert.ok(svg.indexOf('&lt;script&gt;') !== -1);
});

test('M6 translated strings are escaped too, not just place names', function () {
    const ctx = { t: function (k) { return k === 'map.title' ? 'Ruta & mapa <b>' : k; } };
    const svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN }), ctx);
    assert.ok(svg.indexOf('Ruta &amp; mapa &lt;b&gt;') !== -1);
    assert.ok(svg.indexOf('<b>') === -1);
});

test('M6 the day <title> escapes both endpoint names', function () {
    const plan = makePlan([[AMP, QUOTE]]);
    const ctx = { t: function (k) { return k === 'map.dayLabel' ? 'Day {day}: {from} -> {to}' : k; } };
    const svg = renderMapSvg(buildMapView({ plan: plan }), ctx);
    assert.ok(svg.indexOf('Day 1: Sant Joan Despi &amp; Cornella -&gt; Zaragoza &quot;La Seo&quot;') !== -1);
});

/* ── D  degenerate inputs ── */
test('D no plan at all does not throw', function () {
    assert.doesNotThrow(function () {
        const v = buildMapView({});
        assert.strictEqual(v.empty, true);
        renderMapSvg(v, null);
    });
    assert.doesNotThrow(function () { buildMapView(); });
    assert.doesNotThrow(function () { buildMapView({ plan: null, geometry: null }); });
});

test('D zero stops (a plan with no days) yields an empty, still-valid SVG', function () {
    const view = buildMapView({ plan: { days: [], order: [], warnings: [] } });
    assert.strictEqual(view.days.length, 0);
    assert.strictEqual(view.markers.length, 0);
    assert.strictEqual(view.empty, true);
    const svg = renderMapSvg(view, null);
    assert.ok(svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') === svg.length - 6);
    assert.ok(svg.indexOf('map.noRoute') !== -1);
});

test('D one stop renders a single marker and no path', function () {
    const plan = makePlan([[MADRID]]);
    const view = buildMapView({ plan: plan });
    assert.strictEqual(view.markers.length, 1);
    assert.strictEqual(view.days.length, 1);
    assert.strictEqual(view.days[0].path.length, 0);
    assert.strictEqual(view.empty, false);
    const svg = renderMapSvg(view, null);
    assert.ok(svg.indexOf('Madrid') !== -1);
    assert.ok(svg.indexOf('<path') === -1);
    /* Centred, not parked in a corner. */
    assert.ok(Math.abs(view.markers[0].x - view.width / 2) < 1);
    assert.ok(Math.abs(view.markers[0].y - view.height / 2) < 1);
});

test('D identical coordinates for every stop do not divide by zero', function () {
    const A = P('A', 41.0, 2.0), B = P('B', 41.0, 2.0), C = P('C', 41.0, 2.0);
    const view = buildMapView({ plan: makePlan([[A, B], [B, C]]) });
    for (let i = 0; i < view.markers.length; i++) {
        assert.ok(isFinite(view.markers[i].x) && isFinite(view.markers[i].y));
    }
    const svg = renderMapSvg(view, null);
    assert.ok(svg.indexOf('NaN') === -1 && svg.indexOf('Infinity') === -1);
});

test('D antipodal and polar points stay inside the viewBox', function () {
    const N = P('North', 90, 0), S = P('South', -90, 180);
    const view = buildMapView({ plan: makePlan([[N, S]]) });
    const svg = renderMapSvg(view, null);
    assert.ok(svg.indexOf('NaN') === -1 && svg.indexOf('Infinity') === -1);
    for (let i = 0; i < view.markers.length; i++) {
        assert.ok(view.markers[i].x >= 0 && view.markers[i].x <= view.width);
        assert.ok(view.markers[i].y >= 0 && view.markers[i].y <= view.height);
    }
});

test('D a single-point geometry falls back to straight lines', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: [[40.4168, -3.7038]] });
    assert.strictEqual(view.geometryReal, false);
    assert.strictEqual(view.geometrySource, 'straight');
    assert.ok(view.markers.length >= 2);
});

test('D an empty geometry array falls back to straight lines', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: [] });
    assert.strictEqual(view.geometryReal, false);
    assert.ok(view.days[0].path.length >= 2, 'the straight fallback must still draw');
});

test('D non-numeric coordinates are dropped, never guessed', function () {
    const bad = [
        ['abc', 2], [null, null], [41.0, undefined], [NaN, 1], [41.5, 'x'],
        [41.2, 2.1], [41.3, 2.2], [41.4, 2.3]
    ];
    const out = simplify(bad, 0.5);
    assert.strictEqual(out.length, 2);           // 3 valid, collinear-ish -> 2 kept
    for (let i = 0; i < out.length; i++) {
        assert.ok(isFinite(out[i][0]) && isFinite(out[i][1]));
    }
});

test('D a place with unusable coordinates does not shift the other markers', function () {
    const broken = { name: 'Nowhere', lat: 'x', lon: null, resolved: false };
    const plan = makePlan([[MADRID, broken], [broken, BARCELONA]]);
    const view = buildMapView({ plan: plan });
    const names = view.markers.map(function (m) { return m.name; });
    assert.ok(names.indexOf('Nowhere') === -1);
    assert.ok(names.indexOf('Madrid') !== -1 && names.indexOf('Barcelona') !== -1);
    assert.doesNotThrow(function () { renderMapSvg(view, null); });
});

test('D rest days (0 km, no legs) keep their slot and draw nothing', function () {
    const plan = makePlan([[MADRID, ZARAGOZA], [ZARAGOZA], [ZARAGOZA, BARCELONA]]);
    const view = buildMapView({ plan: plan, geometry: BIG_GEOMETRY });
    assert.strictEqual(view.days.length, 3);
    assert.strictEqual(view.days[1].rest, true);
    assert.strictEqual(view.days[1].path.length, 0);
    assert.ok(view.days[0].path.length >= 2);
    assert.ok(view.days[2].path.length >= 2);
});

test('D a plan whose days hold no legs at all still shows its places', function () {
    const plan = makePlan([[MADRID], [MADRID]]);
    plan.order = [MADRID, BARCELONA];
    const view = buildMapView({ plan: plan });
    assert.strictEqual(view.days.length, 2);
    assert.ok(view.markers.length >= 1);
    assert.doesNotThrow(function () { renderMapSvg(view, null); });
});

test('D geometry entries in the wrong shape are ignored, not fatal', function () {
    const geom = [[41, 2], 'nonsense', null, { lat: 41.2, lon: 2.2 }, [41.4, 2.4], undefined];
    const view = buildMapView({ plan: makePlan([[MADRID, BARCELONA]]), geometry: geom });
    assert.doesNotThrow(function () { renderMapSvg(view, null); });
    assert.strictEqual(view.geometryReal, true);
});

test('D renderMapSvg tolerates a null, empty or hand-made view', function () {
    assert.strictEqual(renderMapSvg(null, null), '');
    assert.strictEqual(renderMapSvg(undefined, null), '');
    assert.strictEqual(renderMapSvg('nope', null), '');
    const svg = renderMapSvg({}, null);
    assert.ok(svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') !== -1);
});

test('D a zero or negative viewBox size falls back to the defaults', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, width: 0, height: -10 });
    assert.ok(view.width > 0 && view.height > 0);
    assert.ok(renderMapSvg(view, null).indexOf('viewBox="0 0 640 400"') !== -1);
});

/* ── S  day colouring in sync with the plan ── */
test('S view.days.length always equals plan.days.length', function () {
    const cases = [
        makePlan([[MADRID, ZARAGOZA]]),
        FOUR_DAY_PLAN,
        makePlan([[MADRID, ZARAGOZA], [ZARAGOZA], [ZARAGOZA], [ZARAGOZA, BARCELONA]]),
        { days: [], order: [] }
    ];
    for (let i = 0; i < cases.length; i++) {
        const v = buildMapView({ plan: cases[i], geometry: BIG_GEOMETRY });
        assert.strictEqual(v.days.length, cases[i].days.length, 'case ' + i);
    }
});

test('S each view day carries the plan day number and the palette colour for its index', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    for (let i = 0; i < view.days.length; i++) {
        assert.strictEqual(view.days[i].day, FOUR_DAY_PLAN.days[i].day);
        assert.strictEqual(view.days[i].index, i);
        assert.strictEqual(view.days[i].color, DAY_COLORS[i % DAY_COLORS.length]);
    }
});

test('S the palette cycles by day index and never runs off the end', function () {
    const seq = [];
    for (let i = 0; i < 12; i++) seq.push([i === 0 ? MADRID : BARCELONA, i % 2 ? MADRID : BARCELONA]);
    const view = buildMapView({ plan: makePlan(seq) });
    assert.strictEqual(view.days.length, 12);
    for (let i = 0; i < 12; i++) {
        assert.strictEqual(view.days[i].color, DAY_COLORS[i % DAY_COLORS.length]);
        assert.ok(typeof view.days[i].color === 'string' && view.days[i].color.charAt(0) === '#');
    }
});

test('S every marker names a day that exists in the plan', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    for (let i = 0; i < view.markers.length; i++) {
        const m = view.markers[i];
        assert.ok(m.day >= 0 && m.day < FOUR_DAY_PLAN.days.length, 'marker day out of range');
        assert.strictEqual(m.dayNumber, FOUR_DAY_PLAN.days[m.day].day);
        assert.strictEqual(m.color, DAY_COLORS[m.day % DAY_COLORS.length]);
    }
});

test('S every place in the plan gets exactly one marker, first is start and last is end', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.strictEqual(view.markers.length, 5);      // Madrid + 4 arrivals
    assert.strictEqual(view.markers[0].name, 'Madrid');
    assert.strictEqual(view.markers[0].kind, 'start');
    assert.strictEqual(view.markers[4].name, 'Valencia');
    assert.strictEqual(view.markers[4].kind, 'end');
});

test('S the day slices tile the route: consecutive days share their seam point', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    for (let d = 1; d < view.days.length; d++) {
        const prev = view.days[d - 1].points;
        const cur = view.days[d].points;
        if (!prev.length || !cur.length) continue;
        assert.deepStrictEqual(cur[0], prev[prev.length - 1],
            'day ' + (d + 1) + ' must start where day ' + d + ' ended');
    }
});

test('S the marker that ends a driving day is flagged as the overnight place', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    const overnight = view.markers.filter(function (m) { return m.overnight; })
        .map(function (m) { return m.name; });
    /* Three nights on a four-day trip; the final destination is not one of them. */
    assert.deepStrictEqual(overnight, ['Zaragoza', 'Tarragona', 'Barcelona']);
});

test('S the plan owns the day numbers: a non-sequential plan is not renumbered', function () {
    const plan = makePlan([[MADRID, ZARAGOZA], [ZARAGOZA, BARCELONA]]);
    plan.days[0].day = 3;
    plan.days[1].day = 4;
    const view = buildMapView({ plan: plan });
    assert.strictEqual(view.days[0].day, 3);
    assert.strictEqual(view.days[1].day, 4);
    assert.strictEqual(view.markers[1].dayNumber, 3);
    assert.strictEqual(view.markers[2].dayNumber, 4);
});

test('S a round trip keeps both the origin and the returning end marker', function () {
    const plan = makePlan([[MADRID, ZARAGOZA], [ZARAGOZA, MADRID]]);
    plan.roundTrip = true;
    const view = buildMapView({ plan: plan });
    assert.strictEqual(view.markers.length, 3);
    assert.strictEqual(view.markers[0].kind, 'start');
    assert.strictEqual(view.markers[2].kind, 'end');
    assert.strictEqual(view.markers[2].name, 'Madrid');
});

/* ── V  valid, self-contained, scalable SVG ── */
test('V the SVG has a viewBox and no pixel width or height', function () {
    const svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    assert.ok(/^<svg [^>]*viewBox="0 0 640 400"/.test(svg));
    assert.ok(!/^<svg[^>]*\swidth="\d/.test(svg), 'root must not fix a pixel width');
    assert.ok(!/px/.test(svg), 'no px units anywhere');
    assert.ok(svg.indexOf('xmlns="http://www.w3.org/2000/svg"') !== -1);
    assert.ok(svg.indexOf('preserveAspectRatio') !== -1);
});

test('V tags are balanced and every attribute value is quoted', function () {
    const svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    const names = ['svg', 'g', 'path', 'text', 'title', 'circle', 'rect', 'desc'];
    for (let i = 0; i < names.length; i++) {
        const open = (svg.match(new RegExp('<' + names[i] + '[\\s>]', 'g')) || []).length;
        const selfOrClose = (svg.match(new RegExp('</' + names[i] + '>', 'g')) || []).length +
            (svg.match(new RegExp('<' + names[i] + '[^>]*/>', 'g')) || []).length;
        assert.strictEqual(open, selfOrClose, names[i] + ' tags unbalanced');
    }
    /* No bare attribute values, which is what an unescaped quote would create. */
    assert.ok(!/=[^"'\s>]/.test(svg.replace(/>[^<]*</g, '><')));
});

test('V every coordinate printed into the SVG is a finite number', function () {
    const svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    const nums = svg.match(/-?\d+(\.\d+)?/g) || [];
    for (let i = 0; i < nums.length; i++) assert.ok(isFinite(Number(nums[i])));
    assert.ok(svg.indexOf('NaN') === -1);
    assert.ok(svg.indexOf('undefined') === -1);
    assert.ok(svg.indexOf('null') === -1);
});

test('V the drawn route stays inside the padded box', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    for (let d = 0; d < view.days.length; d++) {
        const p = view.days[d].path;
        for (let i = 0; i < p.length; i++) {
            assert.ok(p[i][0] >= -0.001 && p[i][0] <= view.width + 0.001, 'x out of box');
            assert.ok(p[i][1] >= -0.001 && p[i][1] <= view.height + 0.001, 'y out of box');
        }
    }
});

test('V a custom viewBox size is honoured and the aspect ratio is preserved', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY, width: 1000, height: 300 });
    const svg = renderMapSvg(view, null);
    assert.ok(svg.indexOf('viewBox="0 0 1000 300"') !== -1);
    const dx = view.bounds.maxX - view.bounds.minX, dy = view.bounds.maxY - view.bounds.minY;
    /* One scale factor for both axes: the shape is not stretched to fill. */
    assert.ok(dx * view.bounds.scale <= 1000 - 2 * view.padding + 0.001);
    assert.ok(dy * view.bounds.scale <= 300 - 2 * view.padding + 0.001);
});

test('V the projected bounding box matches the lat/lon bounding box', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.ok(view.bounds.minLat < view.bounds.maxLat);
    assert.ok(view.bounds.minLon < view.bounds.maxLon);
    /* Mercator y is inverted relative to latitude. */
    assert.ok(Math.abs(project(view.bounds.maxLat, 0)[1] - view.bounds.minY) < 1e-12);
    assert.ok(Math.abs(project(view.bounds.minLat, 0)[1] - view.bounds.maxY) < 1e-12);
});

/* ── F  the fallback is flagged ── */
test('F no geometry means geometryReal false and a straight-line source', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN });
    assert.strictEqual(view.geometryReal, false);
    assert.strictEqual(view.geometrySource, 'straight');
});

test('F the estimate is visible in the artefact: dashed stroke plus a printed note', function () {
    const svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN }), null);
    assert.ok(svg.indexOf('stroke-dasharray') !== -1, 'the fallback line must be dashed');
    assert.ok(svg.indexOf('map.straightLineNote') !== -1, 'the fallback must be captioned');
    assert.ok(svg.indexOf('map.sourceStraight') !== -1, 'the <desc> must state the source');
});

test('F real road geometry is solid, captioned as road data, and flagged real', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    const svg = renderMapSvg(view, null);
    assert.strictEqual(view.geometryReal, true);
    assert.strictEqual(view.geometrySource, 'osrm');
    assert.ok(svg.indexOf('stroke-dasharray') === -1);
    assert.ok(svg.indexOf('map.straightLineNote') === -1);
    assert.ok(svg.indexOf('map.sourceRoad') !== -1);
});

test("F geo-provider's non-enumerable source marker is honoured", function () {
    const arr = FOUR_DAY_PLAN.order.map(function (p) { return [p.lat, p.lon]; });
    Object.defineProperty(arr, 'source', { value: 'straight', enumerable: false });
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: arr });
    assert.strictEqual(view.geometryReal, false);
    assert.strictEqual(view.geometrySource, 'straight');
});

test('F an explicit geometrySource argument overrides the array marker', function () {
    const arr = BIG_GEOMETRY.slice();
    Object.defineProperty(arr, 'source', { value: 'osrm', enumerable: false });
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: arr, geometrySource: 'straight' });
    assert.strictEqual(view.geometryReal, false);
});

test('F the fallback still draws a usable route rather than nothing', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN });
    let drawn = 0;
    for (let d = 0; d < view.days.length; d++) if (view.days[d].path.length >= 2) drawn++;
    assert.strictEqual(drawn, 4);
    assert.strictEqual(view.empty, false);
});

/* ── X  determinism ── */
test('X the same input produces byte-identical SVG, twice', function () {
    const a = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    const b = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    assert.strictEqual(a, b);
    assert.ok(a.length > 200);
});

test('X the view is deep-equal across builds and JSON round-trips unchanged', function () {
    const a = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    const b = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.deepStrictEqual(a, b);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('X buildMapView does not mutate the plan or the geometry it was given', function () {
    const planCopy = JSON.parse(JSON.stringify(FOUR_DAY_PLAN));
    const geomCopy = BIG_GEOMETRY.slice(0, 500).map(function (p) { return p.slice(); });
    const before = JSON.stringify({ p: planCopy, g: geomCopy });
    buildMapView({ plan: planCopy, geometry: geomCopy });
    assert.strictEqual(JSON.stringify({ p: planCopy, g: geomCopy }), before);
});

test('X -0 never reaches the output as a distinct string', function () {
    const view = buildMapView({ plan: makePlan([[P('A', 0, 0), P('B', 0, 0)]]) });
    const svg = renderMapSvg(view, null);
    assert.ok(svg.indexOf('-0"') === -1 && svg.indexOf('-0 ') === -1);
});

/* ── B8  quality bar: visible on a map, and exportable ── */
test('B8 a four-day plan renders one visible coloured path per driving day', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    const svg = renderMapSvg(view, null);
    const paths = svg.match(/<path /g) || [];
    assert.strictEqual(paths.length, 4);
    for (let i = 0; i < 4; i++) {
        assert.ok(svg.indexOf('stroke="' + DAY_COLORS[i] + '"') !== -1, 'day ' + (i + 1) + ' colour missing');
    }
    assert.ok(svg.indexOf('travio-map-day-1') !== -1);
    assert.ok(svg.indexOf('travio-map-day-4') !== -1);
});

test('B8 every stop is labelled on the map, so nothing relies on colour alone', function () {
    const svg = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    const names = ['Madrid', 'Zaragoza', 'Tarragona', 'Barcelona', 'Valencia'];
    for (let i = 0; i < names.length; i++) {
        assert.ok(svg.indexOf('>' + names[i] + '<') !== -1, names[i] + ' is not labelled');
    }
});

test('B8 the exportable line is a plain [lat,lon] array a GPX writer can consume', function () {
    const view = buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY });
    assert.ok(Array.isArray(view.geometry));
    for (let i = 0; i < view.geometry.length; i++) {
        const p = view.geometry[i];
        assert.ok(Array.isArray(p) && p.length === 2);
        assert.ok(p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180);
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(view.geometry)), view.geometry);
});

test('B8 renderPlanMap is the one-call path from plan to SVG', function () {
    const direct = map.renderPlanMap({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }, null);
    const viaView = renderMapSvg(buildMapView({ plan: FOUR_DAY_PLAN, geometry: BIG_GEOMETRY }), null);
    assert.strictEqual(direct, viaView);
});
