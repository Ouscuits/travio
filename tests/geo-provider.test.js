/* ── Tests: js/geo-provider.js ── NETWORK-FREE (every fetch is stubbed) ── */
/* Run: node --test tests/geo-provider.test.js   (or node --test tests/) */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROVIDER_PATH = path.join(__dirname, '..', 'js', 'geo-provider.js');
const geo = require(PROVIDER_PATH);

const {
    geocodePlaces, distanceMatrix, routeGeometry,
    decodePolyline, haversineKm, normalisePlaceName,
    clearGeoCache, resetGeoRateLimit
} = geo;

/* ── Test doubles ── */

/* Response-like object; `status` drives ok/failure. */
function jsonResponse(body, status) {
    const code = typeof status === 'number' ? status : 200;
    return {
        ok: code >= 200 && code < 300,
        status: code,
        json: async function () {
            if (body instanceof Error) throw body;
            return body;
        }
    };
}

/*
 * handler(url, init, callIndex) may return:
 *   - a plain object/array  -> 200 JSON body
 *   - a Response-like       -> used as-is
 *   - an Error instance     -> thrown (network failure)
 */
function makeFetch(handler) {
    const f = async function (url, init) {
        const idx = f.calls.length;
        f.calls.push(String(url));
        f.inFlight++;
        f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
        f.log.push('start:' + idx);
        try {
            await Promise.resolve();     // force a real async gap
            const r = await handler(String(url), init, idx);
            if (r instanceof Error) throw r;
            if (r && typeof r.json === 'function') return r;
            return jsonResponse(r);
        } finally {
            f.inFlight--;
            f.log.push('end:' + idx);
        }
    };
    f.calls = [];
    f.log = [];
    f.inFlight = 0;
    f.maxInFlight = 0;
    return f;
}

function makeStorage(seed) {
    const data = new Map();
    if (seed) for (const k in seed) data.set(k, seed[k]);
    return {
        getItem: function (k) { return data.has(k) ? data.get(k) : null; },
        setItem: function (k, v) { data.set(k, String(v)); },
        removeItem: function (k) { data.delete(k); },
        key: function (i) { const keys = Array.from(data.keys()); return i < keys.length ? keys[i] : null; },
        get length() { return data.size; },
        _data: data
    };
}

/* Controllable clock: sleepImpl advances it, so no test ever waits in real time. */
function makeClock(startAt) {
    const c = {
        t: typeof startAt === 'number' ? startAt : 1000000,
        sleeps: [],
        now: function () { return c.t; },
        sleep: function (ms) { c.sleeps.push(ms); c.t += ms; return Promise.resolve(); },
        advance: function (ms) { c.t += ms; }
    };
    return c;
}

/* Default opts for geocoding tests: never touches the real clock or network. */
function geoOpts(extra) {
    const base = { sleepImpl: function () { return Promise.resolve(); }, storage: null };
    if (extra) for (const k in extra) base[k] = extra[k];
    return base;
}

function nominatimHit(lat, lon, name) {
    return [{ lat: String(lat), lon: String(lon), display_name: name || 'Somewhere' }];
}

function cacheKeyFor(name) {
    return 'travio.geo.v1.' + normalisePlaceName(name);
}

function place(name, lat, lon) {
    return { name: name, lat: lat, lon: lon, resolved: lat !== null && lon !== null, source: 'osm' };
}

/* ── Shared invariant checker (the guarantee the engine depends on) ── */
function assertMatrixInvariants(m, n, label) {
    assert.ok(m && Array.isArray(m.km) && Array.isArray(m.min), label + ': matrix shape');
    assert.strictEqual(m.km.length, n, label + ': km rows');
    assert.strictEqual(m.min.length, n, label + ': min rows');
    assert.ok(m.source === 'osrm' || m.source === 'haversine', label + ': source flag');
    for (let i = 0; i < n; i++) {
        assert.strictEqual(m.km[i].length, n, label + ': km square row ' + i);
        assert.strictEqual(m.min[i].length, n, label + ': min square row ' + i);
        assert.strictEqual(m.km[i][i], 0, label + ': km zero diagonal ' + i);
        assert.strictEqual(m.min[i][i], 0, label + ': min zero diagonal ' + i);
        for (let j = 0; j < n; j++) {
            for (const [grid, tag] of [[m.km, 'km'], [m.min, 'min']]) {
                const v = grid[i][j];
                assert.strictEqual(typeof v, 'number', label + ': ' + tag + '[' + i + '][' + j + '] is a number');
                assert.ok(!Number.isNaN(v), label + ': ' + tag + '[' + i + '][' + j + '] not NaN');
                assert.ok(Number.isFinite(v), label + ': ' + tag + '[' + i + '][' + j + '] finite');
                assert.ok(v >= 0, label + ': ' + tag + '[' + i + '][' + j + '] non-negative');
                assert.strictEqual(grid[i][j], grid[j][i], label + ': ' + tag + ' symmetric ' + i + ',' + j);
            }
        }
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   Load-time safety
   ══════════════════════════════════════════════════════════════════════════ */

test('load: module loads in Node with no window and no localStorage', function () {
    assert.strictEqual(typeof globalThis.window, 'undefined', 'no window in the test env');
    assert.strictEqual(typeof globalThis.localStorage, 'undefined', 'no localStorage in the test env');
    assert.strictEqual(typeof geocodePlaces, 'function');
    assert.strictEqual(typeof distanceMatrix, 'function');
    assert.strictEqual(typeof routeGeometry, 'function');
});

test('load: fresh process with window/localStorage/fetch all absent does not throw and still returns a matrix', function () {
    const script = [
        'globalThis.fetch = undefined;',
        'globalThis.window = undefined;',
        'globalThis.localStorage = undefined;',
        'const g = require(' + JSON.stringify(PROVIDER_PATH) + ');',
        'if (typeof g.geocodePlaces !== "function") { process.exit(2); }',
        'g.distanceMatrix([',
        '  {name:"a",lat:40,lon:-3,resolved:true},',
        '  {name:"b",lat:41,lon:2,resolved:true}',
        ']).then(function (m) {',
        '  if (m.source !== "haversine") process.exit(3);',
        '  if (!isFinite(m.km[0][1]) || m.km[0][1] <= 0) process.exit(4);',
        '  return g.geocodePlaces(["x"]);',
        '}).then(function (p) {',
        '  if (p.length !== 1 || p[0].resolved !== false) process.exit(5);',
        '  console.log("ok");',
        '}).catch(function (e) { console.error(e); process.exit(6); });'
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(out.trim(), 'ok');
});

/* ══════════════════════════════════════════════════════════════════════════
   geocodePlaces
   ══════════════════════════════════════════════════════════════════════════ */

test('geocode: resolves places, preserves input order and index alignment', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function (url) {
        if (url.indexOf('Madrid') !== -1) return nominatimHit(40.4168, -3.7038, 'Madrid');
        if (url.indexOf('Sevilla') !== -1) return nominatimHit(37.3891, -5.9845, 'Sevilla');
        return nominatimHit(41.3874, 2.1686, 'Barcelona');
    });
    const out = await geocodePlaces(['Madrid', 'Barcelona', 'Sevilla'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out.map(p => p.name), ['Madrid', 'Barcelona', 'Sevilla']);
    assert.strictEqual(out[0].lat, 40.4168);
    assert.strictEqual(out[1].lon, 2.1686);
    assert.strictEqual(out[2].lat, 37.3891);
    out.forEach(function (p) {
        assert.strictEqual(p.resolved, true);
        assert.strictEqual(p.source, 'osm');
    });
    assert.strictEqual(fetchImpl.calls.length, 3);
    assert.ok(fetchImpl.calls[0].indexOf('format=jsonv2') !== -1, 'uses jsonv2');
    assert.ok(fetchImpl.calls[0].indexOf('limit=1') !== -1, 'uses limit=1');
});

test('geocode: cache hit avoids a second fetch', async function () {
    resetGeoRateLimit();
    const storage = makeStorage();
    const fetchImpl = makeFetch(function () { return nominatimHit(40.4168, -3.7038, 'Madrid'); });
    const opts = geoOpts({ fetchImpl: fetchImpl, storage: storage });

    const first = await geocodePlaces(['Madrid'], opts);
    assert.strictEqual(first[0].source, 'osm');
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.ok(storage._data.has(cacheKeyFor('Madrid')), 'entry written under the normalised key');

    /* Different casing / spacing / accents must hit the SAME cache entry. */
    const second = await geocodePlaces(['  MADRID '], opts);
    assert.strictEqual(fetchImpl.calls.length, 1, 'no second network call');
    assert.strictEqual(second[0].source, 'cache');
    assert.strictEqual(second[0].resolved, true);
    assert.strictEqual(second[0].lat, 40.4168);
    assert.strictEqual(second[0].name, '  MADRID ', 'the caller name is preserved verbatim');
});

test('geocode: repeated name inside one call is fetched once', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return nominatimHit(1, 2, 'Dup'); });
    const out = await geocodePlaces(['Dup', 'dup', 'DUP'], geoOpts({ fetchImpl: fetchImpl }));
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].source, 'osm');
    assert.strictEqual(out[1].source, 'cache');
    assert.strictEqual(out[2].source, 'cache');
    out.forEach(p => assert.strictEqual(p.lat, 1));
});

test('geocode: expired cache entry is discarded and refetched', async function () {
    resetGeoRateLimit();
    const clock = makeClock(5000000);
    const seed = {};
    seed[cacheKeyFor('Lisboa')] = JSON.stringify({ lat: 1, lon: 1, ts: 0 });   // ancient
    const storage = makeStorage(seed);
    const fetchImpl = makeFetch(function () { return nominatimHit(38.72, -9.14, 'Lisboa'); });

    const out = await geocodePlaces(['Lisboa'], geoOpts({
        fetchImpl: fetchImpl, storage: storage, now: clock.now, sleepImpl: clock.sleep, cacheTtlMs: 1000
    }));
    assert.strictEqual(fetchImpl.calls.length, 1, 'stale entry forced a refetch');
    assert.strictEqual(out[0].lat, 38.72);
    assert.strictEqual(out[0].source, 'osm');
});

test('geocode: corrupt cache entry is ignored, not fatal', async function () {
    resetGeoRateLimit();
    const seed = {};
    seed[cacheKeyFor('Oporto')] = '{not json';
    const storage = makeStorage(seed);
    const fetchImpl = makeFetch(function () { return nominatimHit(41.15, -8.61, 'Porto'); });
    const out = await geocodePlaces(['Oporto'], geoOpts({ fetchImpl: fetchImpl, storage: storage }));
    assert.strictEqual(out[0].resolved, true);
    assert.strictEqual(fetchImpl.calls.length, 1);
});

test('geocode: rate limiting serialises requests >=1100ms apart (stubbed clock)', async function () {
    resetGeoRateLimit();
    const clock = makeClock(2000000);
    const starts = [];
    const fetchImpl = makeFetch(function () {
        starts.push(clock.now());
        clock.advance(25);                       // simulated network latency
        return nominatimHit(10, 20, 'x');
    });

    await geocodePlaces(['A', 'B', 'C'], {
        fetchImpl: fetchImpl, storage: null, now: clock.now, sleepImpl: clock.sleep
    });

    assert.strictEqual(fetchImpl.calls.length, 3);
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'never more than one request in flight');
    assert.deepStrictEqual(
        fetchImpl.log,
        ['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2'],
        'requests do not overlap'
    );
    assert.strictEqual(clock.sleeps.length, 2, 'slept before request 2 and 3, not before the first');
    clock.sleeps.forEach(function (ms) { assert.ok(ms > 0, 'a real wait was requested'); });
    for (let i = 1; i < starts.length; i++) {
        assert.ok(starts[i] - starts[i - 1] >= 1100,
            'spacing ' + (starts[i] - starts[i - 1]) + 'ms >= 1100ms');
    }
});

test('geocode: concurrent calls still share the serial queue', async function () {
    resetGeoRateLimit();
    const clock = makeClock(3000000);
    const fetchImpl = makeFetch(function () { clock.advance(5); return nominatimHit(1, 1, 'y'); });
    const opts = { fetchImpl: fetchImpl, storage: null, now: clock.now, sleepImpl: clock.sleep };

    await Promise.all([
        geocodePlaces(['P1', 'P2'], opts),
        geocodePlaces(['P3', 'P4'], opts)
    ]);

    assert.strictEqual(fetchImpl.calls.length, 4);
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'one in flight across concurrent callers');
});

test('geocode: failures keep index alignment and resolved:false, and never throw', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function (url, init, i) {
        if (i === 0) return nominatimHit(40, -3, 'Ok place');
        if (i === 1) return new Error('socket hang up');       // network failure
        if (i === 2) return jsonResponse([], 500);             // HTTP failure
        if (i === 3) return [];                                // empty result set
        return { garbage: true };                              // malformed body
    });

    const names = ['Good', 'NetworkDead', 'ServerError', 'NoResults', 'Malformed'];
    const out = await geocodePlaces(names, geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out.length, names.length);
    assert.deepStrictEqual(out.map(p => p.name), names, 'order and every entry preserved');
    assert.strictEqual(out[0].resolved, true);
    for (let i = 1; i < out.length; i++) {
        assert.strictEqual(out[i].resolved, false, names[i] + ' unresolved');
        assert.strictEqual(out[i].lat, null);
        assert.strictEqual(out[i].lon, null);
        assert.ok(typeof out[i].source === 'string' && out[i].source.length > 0);
    }
});

test('geocode: failures are not cached', async function () {
    resetGeoRateLimit();
    const storage = makeStorage();
    let calls = 0;
    const fetchImpl = makeFetch(function () {
        calls++;
        return calls === 1 ? new Error('offline') : nominatimHit(5, 6, 'Later');
    });
    const opts = geoOpts({ fetchImpl: fetchImpl, storage: storage });

    const first = await geocodePlaces(['Flaky'], opts);
    assert.strictEqual(first[0].resolved, false);
    assert.strictEqual(storage._data.size, 0, 'nothing cached for a failed lookup');

    const second = await geocodePlaces(['Flaky'], opts);
    assert.strictEqual(second[0].resolved, true, 'retry succeeds after a transient failure');
});

test('geocode: works with no localStorage and with a throwing storage', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return nominatimHit(1, 2, 'z'); });

    const noStore = await geocodePlaces(['Nowhere'], geoOpts({ fetchImpl: fetchImpl, storage: null }));
    assert.strictEqual(noStore[0].resolved, true);

    const hostile = {
        getItem: function () { throw new Error('SecurityError'); },
        setItem: function () { throw new Error('QuotaExceeded'); },
        removeItem: function () { throw new Error('nope'); }
    };
    const out = await geocodePlaces(['Nowhere 2'], geoOpts({ fetchImpl: fetchImpl, storage: hostile }));
    assert.strictEqual(out[0].resolved, true, 'storage errors are swallowed');
});

test('geocode: degenerate input does not throw', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return nominatimHit(1, 1, 'q'); });
    const opts = geoOpts({ fetchImpl: fetchImpl });

    assert.deepStrictEqual(await geocodePlaces([], opts), []);
    assert.deepStrictEqual(await geocodePlaces(null, opts), []);

    const blanks = await geocodePlaces(['', '   ', null, undefined], opts);
    assert.strictEqual(blanks.length, 4);
    blanks.forEach(function (p) { assert.strictEqual(p.resolved, false); });
    assert.strictEqual(fetchImpl.calls.length, 0, 'blank names are never sent to Nominatim');
});

/* ══════════════════════════════════════════════════════════════════════════
   distanceMatrix
   ══════════════════════════════════════════════════════════════════════════ */

const MADRID = place('Madrid', 40.4168, -3.7038);
const BARCELONA = place('Barcelona', 41.3874, 2.1686);
const VALENCIA = place('Valencia', 39.4699, -0.3763);

test('matrix: OSRM success path parses distances and durations correctly', async function () {
    const fetchImpl = makeFetch(function (url) {
        assert.ok(url.indexOf('/table/v1/driving/') !== -1, 'uses the table service');
        assert.ok(url.indexOf('annotations=duration,distance') !== -1, 'requests both annotations');
        assert.ok(url.indexOf('-3.7038,40.4168') !== -1, 'lon,lat order');
        return {
            code: 'Ok',
            distances: [[0, 620000], [620000, 0]],   // metres
            durations: [[0, 21600], [21600, 0]]      // seconds
        };
    });

    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(m, 2, 'osrm');
    assert.strictEqual(m.source, 'osrm');
    assert.strictEqual(m.km[0][1], 620);
    assert.strictEqual(m.min[0][1], 360);
    assert.strictEqual(m.filledCells, 0);
    assert.strictEqual(fetchImpl.calls.length, 1);
});

test('matrix: asymmetric OSRM values are symmetrised by averaging', async function () {
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 100000], [110000, 0]],
            durations: [[0, 6000], [6600, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(m, 2, 'symmetrised');
    assert.strictEqual(m.km[0][1], 105);
    assert.strictEqual(m.min[0][1], 105);
});

test('matrix: total OSRM failure falls back to haversine with the source flag', async function () {
    const cases = [
        ['network error', function () { return new Error('ECONNRESET'); }],
        ['http 503', function () { return jsonResponse({}, 503); }],
        ['bad json', function () { return jsonResponse(new Error('Unexpected token')); }],
        ['osrm NoTable', function () { return { code: 'NoTable' }; }],
        ['missing grids', function () { return { code: 'Ok' }; }]
    ];

    for (const [label, handler] of cases) {
        const fetchImpl = makeFetch(handler);
        const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null });
        assertMatrixInvariants(m, 3, label);
        assert.strictEqual(m.source, 'haversine', label + ': source flag');
        assert.strictEqual(m.osrmCells, 0, label + ': no osrm cells');
        assert.ok(m.km[0][1] > 500 && m.km[0][1] < 800, label + ': Madrid-Barcelona plausible (' + m.km[0][1] + ' km)');
        /* haversine * 1.25 at 75 km/h */
        const expectedKm = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;
        assert.ok(Math.abs(m.km[0][1] - expectedKm) < 0.02, label + ': road factor applied');
        assert.ok(Math.abs(m.min[0][1] - (expectedKm / 75) * 60) < 0.2, label + ': 75 km/h applied');
    }
});

test('matrix: partial null cells are filled per-cell, real values kept', async function () {
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [
                [0, 620000, null],
                [620000, 0, 350000],
                [null, 350000, 0]
            ],
            durations: [
                [0, 21600, null],
                [21600, 0, 12600],
                [null, 12600, 0]
            ]
        };
    });

    const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(m, 3, 'partial');
    assert.strictEqual(m.source, 'osrm', 'real cells were used');
    assert.strictEqual(m.km[0][1], 620, 'real OSRM value kept');
    assert.strictEqual(m.min[1][2], 210, 'real OSRM value kept');
    assert.strictEqual(m.osrmCells, 2);
    assert.strictEqual(m.filledCells, 1, 'exactly the broken cell was filled');

    const expected = haversineKm(40.4168, -3.7038, 39.4699, -0.3763) * 1.25;
    assert.ok(Math.abs(m.km[0][2] - expected) < 0.02, 'null cell filled from haversine');
    assert.ok(m.min[0][2] > 0);
});

test('matrix: NaN / negative / string cells are treated as broken and filled', async function () {
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 'oops'], ['oops', 0]],
            durations: [[0, -5], [-5, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(m, 2, 'poison');
    assert.strictEqual(m.source, 'haversine');
    assert.strictEqual(m.filledCells, 1);
});

test('matrix: unresolved places still get finite cells (centroid strategy) and are not sent to OSRM', async function () {
    const ghost = place('Atlantis', null, null);
    const fetchImpl = makeFetch(function (url) {
        const coords = url.split('/driving/')[1].split('?')[0].split(';');
        assert.strictEqual(coords.length, 2, 'only the two resolved places are sent');
        assert.ok(url.indexOf('Atlantis') === -1);
        return { code: 'Ok', distances: [[0, 620000], [620000, 0]], durations: [[0, 21600], [21600, 0]] };
    });

    const m = await distanceMatrix([MADRID, ghost, BARCELONA], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(m, 3, 'unresolved');
    assert.strictEqual(m.source, 'osrm');
    assert.strictEqual(m.km[0][2], 620, 'the resolved pair keeps its road distance');
    assert.ok(Number.isFinite(m.km[0][1]) && m.km[0][1] > 0, 'ghost row is finite and positive');
    assert.ok(Number.isFinite(m.min[1][2]) && m.min[1][2] > 0);
    /* The ghost sits at the centroid of Madrid+Barcelona: both of its legs are
       about half the direct distance and within a few km of each other. */
    const direct = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;
    assert.ok(Math.abs(m.km[0][1] - m.km[1][2]) < 5, 'both ghost legs are near-equal');
    assert.ok(Math.abs(m.km[0][1] - direct / 2) < 5, 'ghost leg is ~half the direct distance');
});

test('matrix: every place unresolved yields a zero but finite matrix', async function () {
    const fetchImpl = makeFetch(function () { throw new Error('must not be called'); });
    const m = await distanceMatrix(
        [place('A', null, null), place('B', null, null), place('C', null, null)],
        { fetchImpl: fetchImpl, storage: null }
    );
    assertMatrixInvariants(m, 3, 'all unresolved');
    assert.strictEqual(m.source, 'haversine');
    assert.strictEqual(fetchImpl.calls.length, 0, 'no request without usable coordinates');
    assert.strictEqual(m.km[0][1], 0);
    assert.strictEqual(m.min[2][0], 0);
});

test('matrix: degenerate sizes and oversized inputs skip the network', async function () {
    const fetchImpl = makeFetch(function () { throw new Error('must not be called'); });

    const empty = await distanceMatrix([], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(empty, 0, 'empty');
    const one = await distanceMatrix([MADRID], { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(one, 1, 'single');
    const notArray = await distanceMatrix(null, { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(notArray, 0, 'null input');

    const many = [];
    for (let i = 0; i < 40; i++) many.push(place('P' + i, 40 + i * 0.1, -3 + i * 0.1));
    const big = await distanceMatrix(many, { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(big, 40, 'oversized');
    assert.strictEqual(big.source, 'haversine', 'too many places for the table service');
    assert.strictEqual(fetchImpl.calls.length, 0);
});

test('matrix: invariants hold on a larger mixed input (resolved + unresolved, partial OSRM)', async function () {
    const places = [
        place('A', 40.0, -3.0),
        place('B', null, null),
        place('C', 41.0, 2.0),
        place('D', 39.0, -0.4),
        place('E', null, null)
    ];
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 500000, null], [500000, 0, 350000], [null, 350000, 0]],
            durations: [[0, 18000, 30000], [18000, 0, null], [30000, null, 0]]
        };
    });
    const m = await distanceMatrix(places, { fetchImpl: fetchImpl, storage: null });
    assertMatrixInvariants(m, 5, 'mixed');
    assert.ok(m.osrmCells >= 1, 'some real road data survived');
    assert.ok(m.filledCells >= 1, 'the rest was filled');
});

/* ══════════════════════════════════════════════════════════════════════════
   routeGeometry + polyline decoding
   ══════════════════════════════════════════════════════════════════════════ */

test('polyline: decodes the canonical fixture exactly', function () {
    /* Google's reference example: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453) */
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    assert.deepStrictEqual(pts, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('polyline: handles empty and garbage input without throwing', function () {
    assert.deepStrictEqual(decodePolyline(''), []);
    assert.deepStrictEqual(decodePolyline(null), []);
    assert.deepStrictEqual(decodePolyline(undefined), []);
    assert.ok(Array.isArray(decodePolyline('????')));
    assert.ok(Array.isArray(decodePolyline('~~~~~~~~')));
});

test('geometry: OSRM route polyline is decoded', async function () {
    const fetchImpl = makeFetch(function (url) {
        assert.ok(url.indexOf('/route/v1/driving/') !== -1);
        assert.ok(url.indexOf('overview=full') !== -1);
        assert.ok(url.indexOf('geometries=polyline') !== -1);
        return { code: 'Ok', routes: [{ geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] };
    });
    const pts = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null });
    assert.strictEqual(pts.length, 3);
    assert.deepStrictEqual(pts[0], [38.5, -120.2]);
    assert.strictEqual(pts.source, 'osrm');
});

test('geometry: falls back to straight segments between places', async function () {
    const failures = [
        function () { return new Error('down'); },
        function () { return jsonResponse({}, 404); },
        function () { return { code: 'NoRoute' }; },
        function () { return { code: 'Ok', routes: [] }; },
        function () { return { code: 'Ok', routes: [{ geometry: '' }] }; }
    ];
    for (const handler of failures) {
        const fetchImpl = makeFetch(handler);
        const pts = await routeGeometry([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null });
        assert.deepStrictEqual(pts, [
            [40.4168, -3.7038], [41.3874, 2.1686], [39.4699, -0.3763]
        ]);
        assert.strictEqual(pts.source, 'straight');
    }
});

test('geometry: unresolved places are skipped and thin input needs no request', async function () {
    const fetchImpl = makeFetch(function () { throw new Error('must not be called'); });
    const none = await routeGeometry([], { fetchImpl: fetchImpl, storage: null });
    assert.deepStrictEqual(none, []);
    assert.strictEqual(none.source, 'none');

    const one = await routeGeometry([MADRID, place('Ghost', null, null)], { fetchImpl: fetchImpl, storage: null });
    assert.deepStrictEqual(one, [[40.4168, -3.7038]]);
    assert.strictEqual(one.source, 'straight');
    assert.strictEqual(fetchImpl.calls.length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   Utilities
   ══════════════════════════════════════════════════════════════════════════ */

test('utils: haversineKm is sane and safe', function () {
    const madBcn = haversineKm(40.4168, -3.7038, 41.3874, 2.1686);
    assert.ok(madBcn > 495 && madBcn < 515, 'Madrid-Barcelona ~505 km, got ' + madBcn);
    assert.strictEqual(haversineKm(10, 10, 10, 10), 0);
    assert.strictEqual(haversineKm(null, 1, 2, 3), 0, 'invalid input degrades to 0, never NaN');
    assert.ok(Number.isFinite(haversineKm('a', 'b', 'c', 'd')));
});

test('utils: normalisePlaceName strips case, accents and extra spacing', function () {
    assert.strictEqual(normalisePlaceName('  Málaga   Centro '), 'malaga centro');
    assert.strictEqual(normalisePlaceName('MÁLAGA centro'), 'malaga centro');
    assert.strictEqual(normalisePlaceName(null), '');
    assert.strictEqual(normalisePlaceName(undefined), '');
});

test('utils: clearGeoCache removes only Travio keys and tolerates no storage', function () {
    const seed = {};
    seed[cacheKeyFor('Madrid')] = JSON.stringify({ lat: 1, lon: 1, ts: Date.now() });
    seed['unrelated.key'] = 'keep me';
    const storage = makeStorage(seed);
    const removed = clearGeoCache({ storage: storage });
    assert.strictEqual(removed, 1);
    assert.strictEqual(storage._data.has('unrelated.key'), true);
    assert.strictEqual(storage._data.has(cacheKeyFor('Madrid')), false);
    assert.strictEqual(clearGeoCache({ storage: null }), 0);
});
